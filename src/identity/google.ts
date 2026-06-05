/**
 * Google provider for `useAuthProvider` — wraps Google Identity Services
 * (GIS) "One Tap" to produce a stable, opaque player id from the signed-in
 * Google account's `sub` claim.
 *
 * This module lives behind `useAuthProvider` in `../identity`. Consumers who
 * only use the non-OAuth presets (`useAnonymousPlayer`, etc.) tree-shake it
 * out entirely — the package sets `sideEffects: false` and this module has no
 * top-level side effects, so a bundler drops it when `useAuthProvider` is
 * unused. A size-limit gate (`.size-limit.cjs`) keeps that boundary honest.
 *
 * **What's bundled vs. fetched.** The heavyweight GIS library itself is NOT
 * bundled; it's loaded at runtime from `accounts.google.com` via an injected
 * `<script>` the first time sign-in runs. This module is just the thin
 * loader + One Tap orchestration + a tiny JWT-payload decoder.
 *
 * **Identity, not authorization.** The derived id is used purely as the
 * opaque `playerId` for leaderboard attribution. Score submission is still
 * authorized by the public key or the HMAC secure path — this module never
 * sends the Google credential to the Scorezilla API. We therefore decode the
 * ID token's payload client-side (no signature verification) solely to read
 * `sub`; the token arrives directly from Google's library over TLS.
 *
 * @module scorezilla/identity/google
 * @since 0.3.0-next.1
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GIS_LOAD_TIMEOUT_MS = 10_000;

interface GooglePromptNotification {
  readonly isNotDisplayed?: () => boolean;
  readonly isSkippedMoment?: () => boolean;
  readonly isDismissedMoment?: () => boolean;
  readonly getDismissedReason?: () => string;
}

interface GoogleCredentialResponse {
  readonly credential: string;
}

interface GoogleIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }): void;
  prompt(listener?: (notification: GooglePromptNotification) => void): void;
  disableAutoSelect(): void;
}

interface GoogleGlobal {
  readonly google?: { readonly accounts?: { readonly id?: GoogleIdApi } };
}

export interface GoogleSignInParams {
  readonly clientId: string;
  readonly autoSelect: boolean;
}

function getGoogleIdApi(): GoogleIdApi | undefined {
  return (globalThis as GoogleGlobal).google?.accounts?.id;
}

// Dedupes concurrent / retry-after-failure calls so the GIS <script> is never
// injected twice. Cleared once the load settles (success or failure), so a
// later sign-in starts clean — the `getGoogleIdApi()` fast-path covers the
// common "already loaded" case after the first success.
let gisLoadInFlight: Promise<GoogleIdApi> | null = null;

/**
 * Resolve the GIS `id` API, injecting the loader `<script>` on first use.
 * Resolves immediately if GIS is already present (returning visit within the
 * same page, or a host that preloads the script).
 *
 * **Host CSP.** The page must allow the GIS origin in its Content-Security-
 * Policy — at minimum `script-src https://accounts.google.com` (One Tap also
 * needs `frame-src`/`connect-src` for `https://accounts.google.com`). Without
 * it the browser blocks the script and sign-in rejects with the load error.
 */
function loadGoogleIdentityServices(): Promise<GoogleIdApi> {
  const existing = getGoogleIdApi();
  if (existing) return Promise.resolve(existing);

  if (typeof document === 'undefined') {
    return Promise.reject(
      new Error('scorezilla/identity: Google sign-in requires a browser environment.'),
    );
  }

  if (gisLoadInFlight) return gisLoadInFlight;
  gisLoadInFlight = injectGisScript().finally(() => {
    gisLoadInFlight = null;
  });
  return gisLoadInFlight;
}

function injectGisScript(): Promise<GoogleIdApi> {
  return new Promise<GoogleIdApi>((resolve, reject) => {
    // Reuse a tag the host page may already have added; only create (and later
    // clean up) one of our own when none exists.
    const existingTag = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existingTag ?? document.createElement('script');
    const isOurs = existingTag === null;

    const failWith = (message: string): void => {
      clearTimeout(timer);
      if (isOurs) script.remove();
      reject(new Error(message));
    };

    // `failWith` closes over `timer` but only runs in async callbacks, after
    // this `const` is initialized — so the forward reference is safe.
    const timer = setTimeout(() => {
      failWith('scorezilla/identity: timed out loading Google Identity Services.');
    }, GIS_LOAD_TIMEOUT_MS);

    script.addEventListener(
      'load',
      () => {
        clearTimeout(timer);
        const api = getGoogleIdApi();
        if (api) {
          resolve(api);
        } else {
          failWith(
            'scorezilla/identity: Google Identity Services loaded but ' +
              'window.google.accounts.id is unavailable.',
          );
        }
      },
      { once: true },
    );

    script.addEventListener(
      'error',
      () => failWith('scorezilla/identity: failed to load the Google Identity Services script.'),
      { once: true },
    );

    if (isOurs) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
}

/** True when a One Tap moment means "no credential is coming". */
function isBlockedMoment(notification: GooglePromptNotification): boolean {
  if (notification.isNotDisplayed?.() === true) return true;
  if (notification.isSkippedMoment?.() === true) return true;
  if (notification.isDismissedMoment?.() === true) {
    // A dismissal with reason `credential_returned` is the SUCCESS path — the
    // credential callback already fired (or is about to). Don't treat it as a
    // rejection.
    return notification.getDismissedReason?.() !== 'credential_returned';
  }
  return false;
}

/**
 * Decode a Google ID token's payload (no signature verification) and return
 * its `sub` claim — the stable, unique-per-account Google subject identifier.
 */
function decodeSubFromIdToken(idToken: string): string {
  const segments = idToken.split('.');
  const [, payloadSegment] = segments;
  if (segments.length !== 3 || !payloadSegment) {
    throw new Error('scorezilla/identity: malformed Google credential (expected a JWT).');
  }

  let payload: unknown;
  try {
    payload = base64UrlToJson(payloadSegment);
  } catch {
    throw new Error('scorezilla/identity: could not decode the Google credential payload.');
  }

  // Read only `sub`, behind a typeof guard. We never spread, merge, or index
  // the decoded payload with attacker-influenced keys, so a crafted payload
  // (e.g. one carrying a `__proto__` key) has no effect — `JSON.parse` does
  // not mutate prototypes, and nothing here propagates other claims.
  const sub = (payload as { sub?: unknown }).sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('scorezilla/identity: Google credential is missing the "sub" claim.');
  }
  return sub;
}

function base64UrlToJson(segment: string): unknown {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

/**
 * Run the Google One Tap flow and resolve with the account's `sub` claim.
 * Rejects if One Tap can't be shown, the user dismisses it, or the returned
 * credential is malformed.
 */
export async function signInWithGoogle(params: GoogleSignInParams): Promise<string> {
  const api = await loadGoogleIdentityServices();

  const credential = await new Promise<string>((resolve, reject) => {
    // The credential callback and the prompt moment-listener settle the same
    // promise independently, and GIS does not guarantee their ordering. Guard
    // against either firing after the other so a late blocking moment can't
    // reject an already-successful sign-in (and vice versa).
    let settled = false;
    const succeed = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    api.initialize({
      client_id: params.clientId,
      auto_select: params.autoSelect,
      cancel_on_tap_outside: false,
      callback: (response) => {
        if (response && typeof response.credential === 'string' && response.credential.length > 0) {
          succeed(response.credential);
        } else {
          fail('scorezilla/identity: Google returned an empty credential.');
        }
      },
    });

    api.prompt((notification) => {
      if (isBlockedMoment(notification)) {
        fail('scorezilla/identity: Google sign-in was dismissed or could not be displayed.');
      }
    });
  });

  return decodeSubFromIdToken(credential);
}
