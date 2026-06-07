/**
 * GitHub provider for `useAuthProvider` — popup-based OAuth web flow with a
 * developer-deployed token-exchange endpoint, producing a stable, opaque
 * player id (`github:<numeric user id>`).
 *
 * **Why an exchange endpoint at all.** GitHub's token endpoint requires the
 * OAuth app's client secret and sends no CORS headers — the exchange cannot
 * happen in the browser (ADR 0009 decision 6). The flow:
 *
 *   1. this module opens a popup to GitHub's authorize URL, with
 *      `redirect_uri` pointing at the developer's `exchangeUrl` and a
 *      crypto-random `state`;
 *   2. GitHub redirects the popup to `exchangeUrl?code=&state=`;
 *   3. the endpoint (`createGitHubOAuthHandler` in `scorezilla/server`, or
 *      the developer's own ~30 lines) exchanges the code server-side,
 *      fetches the user id, and serves a page that `postMessage`s
 *      `{ source, state, id }` back to this window and closes the popup;
 *   4. this module validates the message **origin** (must match
 *      `exchangeUrl`'s origin) and the **state** echo, then resolves.
 *
 * **Identity, not authorization.** Identical posture to the Google provider:
 * the derived id is opaque leaderboard attribution. The GitHub access token
 * never reaches this module — it lives and dies inside the exchange
 * endpoint. See the trust-boundary note on `useAuthProvider`.
 *
 * Tree-shaking: like `./google`, this module has no top-level side effects
 * and drops out of bundles that never select the GitHub provider.
 *
 * **COOP caveat.** The popup posts to `window.opener`; a game page served
 * with `Cross-Origin-Opener-Policy: same-origin` severs that link and the
 * sign-in cannot complete. Use `same-origin-allow-popups` if you set COOP.
 *
 * @module scorezilla/identity/github
 * @since 0.3.0
 */

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

/** Marker the exchange endpoint's callback page must echo. Public contract
 *  between `scorezilla/identity` and `createGitHubOAuthHandler`. */
export const GITHUB_MESSAGE_SOURCE = 'scorezilla:github-oauth';

/** How often we check whether the player closed the popup unresolved. */
const POPUP_CLOSED_POLL_MS = 500;

/**
 * Hard ceiling on an unresolved sign-in. Generous — a player hunting for
 * their 2FA device must not get cut off — but bounded, so an unreachable
 * exchange endpoint can't leak the `message` listener forever.
 */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** The server half's only error vocabulary. Anything else arriving in a
 *  callback message is clamped before it can reach an Error message. */
const KNOWN_ERRORS = new Set(['access_denied', 'exchange_failed']);

/** Shape `createGitHubOAuthHandler` guarantees for `id` (a GitHub numeric
 *  user id, stringified). Anything else is a malformed endpoint. */
const ID_RE = /^\d{1,20}$/;

export interface GitHubSignInParams {
  readonly clientId: string;
  /** Absolute or page-relative URL of the deployed exchange endpoint. */
  readonly exchangeUrl: string;
}

/** Payload shape posted by the exchange endpoint's callback page. */
interface GitHubCallbackMessage {
  readonly source?: unknown;
  readonly state?: unknown;
  readonly id?: unknown;
  readonly error?: unknown;
}

/** Crypto-random, URL- and HTML-safe state (CSRF binding for the popup). */
function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  for (const b of bytes) out += alphabet[b & 63];
  return out;
}

/**
 * Run the popup flow. Resolves the GitHub numeric user id (as a string), or
 * `null` when the player declined (GitHub `access_denied`, or the popup was
 * closed before completing). Rejects on genuine failures: popup blocked, or
 * the exchange endpoint reporting an error.
 */
export async function signInWithGitHub(params: GitHubSignInParams): Promise<string | null> {
  // Resolve the exchange URL against the page so relative paths work; its
  // origin doubles as the ONLY origin we accept callback messages from.
  const exchangeUrl = new URL(params.exchangeUrl, window.location.href);
  const state = randomState();

  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', params.clientId);
  authorize.searchParams.set('redirect_uri', exchangeUrl.toString());
  authorize.searchParams.set('state', state);
  // No `scope` param: the default grant reads public profile info only —
  // all we need is the numeric user id.

  // NOTE: deliberately NO `noopener` in the feature string — the callback
  // page delivers the result via `window.opener.postMessage`, so the opener
  // link is load-bearing. The flip side (the callback page can postMessage
  // anything at us) is exactly what the origin pin + source marker + state
  // echo in `onMessage` below defend against — that validation is the sole
  // trust boundary between this window and the popup.
  const popup = window.open(authorize.toString(), 'scorezilla-github-oauth', 'popup,width=600,height=700');
  if (popup === null) {
    throw new Error(
      'useAuthProvider: the GitHub sign-in popup was blocked. Call ' +
        'useAuthProvider from a user gesture (e.g. a click handler), or allow ' +
        'popups for this site.',
    );
  }

  return new Promise<string | null>((resolve, reject) => {
    // Player closed the popup without completing sign-in → decline. (The
    // callbacks fire long after `settle` below is initialized — closures
    // capture the binding, not the order of declaration.)
    const pollTimer = setInterval(() => {
      if (popup.closed) settle(() => resolve(null));
    }, POPUP_CLOSED_POLL_MS);

    // Leak guard: an unreachable exchange endpoint (or a popup frozen on a
    // dead page) must not hold the message listener open forever.
    const timeoutTimer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            'useAuthProvider: GitHub sign-in timed out. If this recurs, check ' +
              'that exchangeUrl is deployed and reachable.',
          ),
        ),
      );
    }, SIGN_IN_TIMEOUT_MS);

    const settle = (action: () => void): void => {
      window.removeEventListener('message', onMessage);
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      if (!popup.closed) popup.close();
      action();
    };

    const onMessage = (event: MessageEvent): void => {
      // Origin pin: only the exchange endpoint's origin may complete the
      // flow. Everything else is silently ignored (not an error — any page
      // can postMessage at us).
      if (event.origin !== exchangeUrl.origin) return;
      const data = event.data as GitHubCallbackMessage | null;
      if (data === null || typeof data !== 'object') return;
      if (data.source !== GITHUB_MESSAGE_SOURCE) return;
      // State echo: binds the callback to THIS sign-in attempt (CSRF /
      // replay). A mismatch is ignored, not fatal — a stale or forged
      // message must not be able to abort a legitimate flow.
      if (data.state !== state) return;

      if (typeof data.error === 'string' && data.error.length > 0) {
        if (data.error === 'access_denied') {
          // The player cancelled on GitHub's consent screen — a decline,
          // not a failure (ADR 0009 contract: resolve null).
          settle(() => resolve(null));
          return;
        }
        // Clamp to the handler's fixed vocabulary before the value can
        // reach an Error message — a buggy bespoke endpoint must not be
        // able to inject arbitrary text into error reporting.
        const safeError = KNOWN_ERRORS.has(data.error) ? data.error : 'exchange_failed';
        settle(() =>
          reject(
            new Error(
              `useAuthProvider: GitHub token exchange failed (${safeError}). ` +
                'Check the exchange endpoint logs and its GitHub OAuth app credentials.',
            ),
          ),
        );
        return;
      }

      // `createGitHubOAuthHandler` only ever emits a stringified numeric
      // user id; enforce that here too so a buggy bespoke endpoint can't
      // smuggle an arbitrary string into the persisted player id.
      if (typeof data.id === 'string' && ID_RE.test(data.id)) {
        settle(() => resolve(data.id as string));
        return;
      }
      // Marker + state matched but no (valid) id or error: malformed endpoint.
      settle(() =>
        reject(
          new Error(
            'useAuthProvider: the GitHub exchange endpoint posted a malformed ' +
              'callback message (missing or non-numeric id). Is exchangeUrl ' +
              'pointing at createGitHubOAuthHandler (or an equivalent implementation)?',
          ),
        ),
      );
    };

    window.addEventListener('message', onMessage);
  });
}
