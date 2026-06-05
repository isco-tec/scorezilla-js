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
 * **One Tap is an implementation detail.** v1 uses GIS "One Tap". Under
 * browser FedCM / third-party-cookie changes, One Tap availability and its
 * prompt-moment semantics can vary, so `signInWithGoogle` resolves `null`
 * (rather than throwing) whenever no credential is obtained — callers fall
 * back gracefully. The public contract (`sub` string or `null`) is
 * independent of the flow, leaving room to add a rendered-button fallback
 * later without an API change.
 *
 * @module scorezilla/identity/google
 * @since 0.3.0
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

/** Google OAuth Web client IDs always end with this suffix. */
const GOOGLE_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';

/**
 * True if `clientId` has the shape of a Google OAuth Web client ID. Used to
 * turn a typo'd id into an actionable error up front, rather than a silent
 * "One Tap couldn't be shown" → `null` further down.
 */
export function isGoogleClientId(clientId: string): boolean {
  return clientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX);
}

function getGoogleIdApi(): GoogleIdApi | undefined {
  return (globalThis as GoogleGlobal).google?.accounts?.id;
}

// Dedupes concurrent / retry-after-failure calls so the GIS <script> is never
// injected twice. Cleared once the load settles (success or failure), so a
// later sign-in starts clean. This relies on GIS being a page-level global:
// once loaded, `getGoogleIdApi()` sees it from any subsequent call, which is
// what makes clearing-on-settle safe (the fast-path covers "already loaded").
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
  try {
    if (notification.isNotDisplayed?.() === true) return true;
    if (notification.isSkippedMoment?.() === true) return true;
    if (notification.isDismissedMoment?.() === true) {
      // A dismissal with reason `credential_returned` is the SUCCESS path — the
      // credential callback already fired (or is about to). Don't treat it as a
      // "no credential" moment.
      return notification.getDismissedReason?.() !== 'credential_returned';
    }
  } catch {
    // Under FedCM these legacy moment-status methods are deprecated and can
    // throw. Treat that as "no credential from this moment" — the credential
    // callback still fires on success, so this only affects the no-sign-in
    // path, which resolves to a clean `null`.
    return true;
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

  // Read ONLY `sub`, behind a typeof guard. NEVER read any other claim here
  // (email, email_verified, aud, …) and NEVER use this value for an
  // authorization decision: the payload is unverified (no signature check), so
  // any other claim would be attacker-forgeable. `sub` is safe as an opaque
  // attribution id only. Reading just `sub` also sidesteps prototype-pollution
  // — `JSON.parse` doesn't mutate prototypes and nothing here propagates other
  // keys.
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
 * Best-effort: stop GIS auto-selecting this account on the next visit (the
 * counterpart to `auto_select`). No-op if GIS was never loaded — e.g. a return
 * visit that short-circuited on the persisted id and never injected the script.
 */
export function disableGoogleAutoSelect(): void {
  try {
    getGoogleIdApi()?.disableAutoSelect();
  } catch {
    // GIS not present / not loaded — nothing to disable.
  }
}

/**
 * Run the Google One Tap flow.
 *
 * - Resolves the account's `sub` claim on a successful sign-in.
 * - Resolves `null` when no credential is obtained — the user dismissed or
 *   declined One Tap, or it couldn't be displayed (no Google session,
 *   cookies/FedCM blocked, cooldown). "Didn't sign in" is not an error.
 * - **Throws** only on hard failures: the GIS script failing to load/timing
 *   out, or a malformed/empty credential.
 */
export async function signInWithGoogle(params: GoogleSignInParams): Promise<string | null> {
  const api = await loadGoogleIdentityServices();

  const credential = await new Promise<string | null>((resolve, reject) => {
    // The credential callback and the prompt moment-listener settle the same
    // promise independently, and GIS does not guarantee their ordering. Guard
    // against either firing after the other so a late "no credential" moment
    // can't override an already-successful sign-in (and vice versa).
    let settled = false;
    const finish = (value: string | null): void => {
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
          finish(response.credential);
        } else {
          fail('scorezilla/identity: Google returned an empty credential.');
        }
      },
    });

    api.prompt((notification) => {
      // A blocking moment means no credential is coming for this attempt.
      if (isBlockedMoment(notification)) finish(null);
    });
  });

  return credential === null ? null : decodeSubFromIdToken(credential);
}
