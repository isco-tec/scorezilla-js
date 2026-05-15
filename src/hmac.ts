/**
 * HMAC-SHA256 request signing for the secret-key path (`scorezilla/server`).
 *
 * The SDK side here MUST stay in lockstep with the API's verifier
 * (`apps/api/src/auth/hmac.ts` in the monorepo). The contract:
 *
 *   Wire format
 *   -----------
 *   Authorization: Scorezilla-HMAC-SHA256 keyId=<id>, ts=<unix-seconds>,
 *                    nonce=<random>, signature=<base64url>
 *
 *   Canonical signing string (newline-separated, 5 lines)
 *   -----------------------------------------------------
 *     {ts}\n{nonce}\n{METHOD}\n{pathAndQuery}\n{sha256_hex(body)}
 *
 *   Algorithm: HMAC-SHA256 of the signing string with the raw secret
 *   bytes as the key. Output: base64url (no padding).
 *
 * Everything is built on WebCrypto (`crypto.subtle`) — works in browsers,
 * Node ≥ 20, Workers, Bun, and Deno without a Node-only dependency.
 *
 * Stability: this module is internal — exported only for tests and the
 * server adapter. Consumers should always use `Scorezilla` from
 * `scorezilla/server` (which calls into here).
 */

const enc = new TextEncoder();

/** Auth-scheme prefix. Mirrors the API's `AUTH_SCHEME` constant exactly. */
export const HMAC_AUTH_SCHEME = 'Scorezilla-HMAC-SHA256';

/** Maximum drift, in seconds, between the SDK's clock and the API's. The
 *  server-side window is ±5 minutes; we publish that here so SDK callers
 *  can surface friendly errors when their host clock is wildly off. */
export const HMAC_TIMESTAMP_WINDOW_SECONDS = 300;

/** Latest signing-string format version this SDK emits. The API verifier
 *  also accepts v=1 (legacy, no host binding) during the rollout window —
 *  see `apps/api/src/auth/hmac.ts` in the monorepo. */
export const HMAC_SIGNING_VERSION_LATEST = 2 as const;

/**
 * Construct the canonical signing string. Pure — no I/O. Both sender
 * (this module) and verifier (the API) call this with the same inputs
 * and must produce identical output.
 *
 * `pathAndQuery` is signed verbatim. If the SDK ever URL-encodes path
 * segments differently than the server does, signatures will mismatch.
 *
 * `host` MUST be the host portion of the URL the request is being sent
 * to. It's lowercased here per RFC 9110 §4.2.4 (case-insensitive host
 * comparison). With v=2 (current default), `host` is the 4th line of
 * the canonical string and binds the signature to the target origin so
 * a signature minted against staging cannot replay against prod.
 *
 * `version` defaults to {@link HMAC_SIGNING_VERSION_LATEST}. v=1 (legacy,
 * pre-A-H4) omits `host` from the canonical string — kept for compat
 * tests; production callers should not pass v=1.
 */
export async function buildSigningString(
  method: string,
  pathAndQuery: string,
  ts: number,
  nonce: string,
  body: string,
  host: string,
  version: number = HMAC_SIGNING_VERSION_LATEST,
): Promise<string> {
  const bodyHash = await sha256Hex(body);
  const upperMethod = method.toUpperCase();
  if (version === 1) {
    return `${ts}\n${nonce}\n${upperMethod}\n${pathAndQuery}\n${bodyHash}`;
  }
  return `${ts}\n${nonce}\n${upperMethod}\n${host.toLowerCase()}\n${pathAndQuery}\n${bodyHash}`;
}

/** HMAC-SHA-256 of `message` with `secret` (UTF-8 encoded), base64url. */
export async function hmacSha256B64u(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

/** SHA-256 of `message` (UTF-8), lowercase hex. Used inside the signing
 *  string to hash the request body. */
export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(message));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the `Authorization` header value for a single request.
 *
 * Each call generates a fresh `ts` and `nonce`. Retries MUST call this
 * again — reusing a (ts, nonce) is what the server's replay protection
 * rejects.
 *
 * Emits v=2 by default (host-bound). The API verifier still accepts v=1
 * (no host binding) for pre-A-H4 SDK builds during the rollout window;
 * see `apps/api/src/auth/hmac.ts:parseAuthHeader`. New code paths should
 * use v=2 — the v=1 escape hatch exists only for legacy interop.
 *
 * @returns the full header value (including the scheme prefix)
 */
export async function buildHmacAuthHeader(args: {
  keyId: string;
  secret: string;
  method: string;
  pathAndQuery: string;
  /** Host portion of the request URL (e.g. `new URL(baseUrl).host`). v=2
   *  signatures bind to this; v=1 ignores it. */
  host: string;
  body: string;
  /** Injectable for tests; defaults to `Math.floor(Date.now() / 1000)`. */
  nowSeconds?: number;
  /** Injectable for tests; defaults to `crypto.randomUUID()`. */
  nonce?: string;
  /** Signing-string version. Defaults to {@link HMAC_SIGNING_VERSION_LATEST}.
   *  v=1 omits both the host from the canonical string AND the `v=` param
   *  from the header (for byte-for-byte parity with pre-A-H4 SDKs). */
  version?: 1 | 2;
}): Promise<string> {
  const ts = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const nonce = args.nonce ?? generateNonce();
  const version = args.version ?? HMAC_SIGNING_VERSION_LATEST;
  const signingString = await buildSigningString(
    args.method,
    args.pathAndQuery,
    ts,
    nonce,
    args.body,
    args.host,
    version,
  );
  const signature = await hmacSha256B64u(args.secret, signingString);
  // v=1: omit the `v=` param (back-compat byte parity).
  // v=2 (default): append `v=2` so the verifier knows to include host in
  // the canonical string. Future versions follow the same pattern.
  const vParam = version === 1 ? '' : `, v=${version}`;
  return `${HMAC_AUTH_SCHEME} keyId=${args.keyId}, ts=${ts}, nonce=${nonce}, signature=${signature}${vParam}`;
}

/**
 * Cryptographically-random nonce. The server enforces no-reuse within a
 * 10-minute window (per keyId), so a fresh random value per request is
 * required for retry correctness — if the same (keyId, nonce) pair lands
 * twice the second is rejected as a replay.
 */
export function generateNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c || typeof c.randomUUID !== 'function') {
    // Same posture as `generateIdempotencyKey` in retry.ts — runtime
    // misconfiguration, surface a typed error consumers can branch on.
    throw new Error(
      'scorezilla: globalThis.crypto.randomUUID is unavailable. ' +
        'The HMAC server adapter requires Node ≥ 20 or a modern runtime.',
    );
  }
  return c.randomUUID();
}

/** URL-safe base64 without padding. Matches the API's `base64UrlEncode`. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
