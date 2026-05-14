/**
 * SDK configuration.
 *
 * The `ScorezillaConfig` is a TypeScript-level discriminated union of
 * `PublicKeyConfig` and `SecretKeyConfig`. The mutual-exclusivity (you may
 * pass `publicKey` OR `secretKey`, never both) is enforced at compile time:
 * passing both fields fails type-checking before the runtime check fires.
 *
 * The runtime check in {@link validateConfig} is the second line of defense
 * for consumers using plain JS or `as any` casts.
 */

import type { FetchImpl } from './transport';

/** Production API URL. Override via `baseUrl` in {@link ScorezillaConfig} to
 *  point at a development worker, staging environment, or a private
 *  deployment. */
export const DEFAULT_BASE_URL = 'https://api.scorezilla.dev';

/** Public key format: `pk_<slug>_<base62>`. Issued by the operator
 *  dashboard. Slug is the game slug; base62 is the random suffix. */
export const PUBLIC_KEY_PATTERN = /^pk_[a-z0-9-]+_[A-Za-z0-9]+$/;

/** Secret key prefix — secrets are `sk_live_<id>_<base62>`. Live-only for
 *  v0.1.0; the SDK doesn't yet support a `sk_test_*` tier. */
export const SECRET_KEY_PREFIX = 'sk_live_';

/** Shared options across both auth modes. */
export interface BaseConfig {
  /** API base URL (no trailing slash required). Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Custom fetch implementation — defaults to `globalThis.fetch`. Pass
   *  `node-fetch`, `undici`, or a mock here. The explicit signature
   *  (`(RequestInfo | URL, init?) => Promise<Response>`) is broader than
   *  `typeof fetch` so common polyfills typecheck cleanly. */
  fetch?: FetchImpl;
  /** Per-request timeout in milliseconds. Defaults to 30 s. */
  timeoutMs?: number;
  /** Maximum retry attempts on transient failures. Defaults to 2 (so the
   *  worst-case total request count is 3). */
  maxRetries?: number;
  /** Override the default `User-Agent` header (Node/Workers/Bun/Deno —
   *  browsers silently ignore the value). */
  userAgent?: string;
  /** Injectable sleep implementation for the retry loop's inter-attempt
   *  pause. Exists for tests that need deterministic, zero-delay retries
   *  rather than real wall-clock backoff. Production code should leave
   *  this unset to use the default exponential backoff with jitter.
   *  @internal */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Public-key auth: browser-safe path. The key is fingerprinted to a game
 *  on the server side via `pk_<gameSlug>_<base62>`. */
export type PublicKeyConfig = BaseConfig & {
  publicKey: string;
  secretKey?: never;
};

/** Secret-key auth: server-side HMAC. A single self-contained token of the
 *  shape `sk_live_<keyId>_<random>`. The SDK parses the keyId out and uses
 *  the whole string as the HMAC key. One value to copy, one to manage —
 *  matches Stripe's design and the public-key client's single-string shape.
 *
 *  Past versions of the SDK took `{ id, secret }` separately. That was an
 *  unnecessary cognitive tax — the id was always derivable from a properly-
 *  formatted secret. v0.1.0-next.2+ takes the single-string form. */
export type SecretKeyConfig = BaseConfig & {
  secretKey: string;
  publicKey?: never;
};

/** The top-level config type. The union is open for additional auth modes
 *  in future major releases. */
export type ScorezillaConfig = PublicKeyConfig | SecretKeyConfig;

/**
 * Internal post-validation shape. The client layer reads from this — every
 * field is non-optional with defaults applied, and `auth` is a clean
 * discriminated union (no leftover `publicKey?: never` cruft).
 */
export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly fetch: FetchImpl | undefined;
  readonly timeoutMs: number | undefined;
  readonly maxRetries: number | undefined;
  readonly sleepImpl: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly userAgent: string | undefined;
  readonly auth:
    | { kind: 'public'; key: string }
    | { kind: 'secret'; keyId: string; secret: string };
}

/**
 * Validate a `ScorezillaConfig` and return a normalized {@link ResolvedConfig}.
 *
 * Throws a plain `Error` (not `ScorezillaError`) on misuse — these are
 * caller bugs, not API failures, and shouldn't be confused with the
 * runtime error class.
 */
export function validateConfig(cfg: ScorezillaConfig): ResolvedConfig {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('scorezilla: config must be an object with publicKey or secretKey');
  }

  const hasPublic = 'publicKey' in cfg && cfg.publicKey !== undefined;
  const hasSecret = 'secretKey' in cfg && cfg.secretKey !== undefined;

  // Defensive runtime checks for consumers using `as any` or plain JS.
  if (hasPublic && hasSecret) {
    throw new Error('scorezilla: config must not contain both publicKey and secretKey');
  }
  if (!hasPublic && !hasSecret) {
    throw new Error('scorezilla: config must contain either publicKey or secretKey');
  }

  let auth: ResolvedConfig['auth'];
  if (hasPublic) {
    auth = { kind: 'public', key: validatePublicKeyValue((cfg as PublicKeyConfig).publicKey) };
  } else {
    const resolved = validateSecretKey(cfg as SecretKeyConfig);
    auth = { kind: 'secret', keyId: resolved.keyId, secret: resolved.secret };
  }

  const baseUrlRaw = cfg.baseUrl ?? DEFAULT_BASE_URL;
  if (typeof baseUrlRaw !== 'string' || baseUrlRaw.length === 0) {
    throw new Error('scorezilla: baseUrl must be a non-empty string when provided');
  }

  return {
    baseUrl: baseUrlRaw.replace(/\/+$/, ''),
    fetch: cfg.fetch,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
    sleepImpl: cfg.sleepImpl,
    userAgent: cfg.userAgent,
    auth,
  };
}

/**
 * Validate a `publicKey` string and return it. Throws a plain `Error` on
 * misuse — caller bug, not an API failure.
 *
 * Never echo any characters of the supplied key in the error message —
 * if a developer paste-mistakes a `sk_live_*` secret here, the previous
 * `pk.slice(0, 12)` would have leaked 12 chars of the secret to whatever
 * log aggregator catches the Error. Report only the shape.
 */
function validatePublicKeyValue(pk: unknown): string {
  if (typeof pk !== 'string' || !PUBLIC_KEY_PATTERN.test(pk)) {
    const shape = typeof pk === 'string' ? `string of length ${pk.length}` : typeof pk;
    throw new Error(
      `scorezilla: publicKey must match ${PUBLIC_KEY_PATTERN.toString()} (got: ${shape})`,
    );
  }
  return pk;
}

/** Exact shape of the new secret-key format:
 *
 *   `sk_live_<keyId>_<random>`
 *
 * - `<keyId>` is a UUID v4 (hyphenated, 36 chars). Used by the API for
 *   row lookup and as the `keyId=` parameter in HMAC Authorization
 *   headers. Non-sensitive; appears in logs and audit trails.
 * - `<random>` is a base62-encoded suffix from the operator dashboard's
 *   issuance flow (~32 chars). The HMAC key is the WHOLE plaintext
 *   string, so changing only the prefix doesn't weaken anything.
 *
 * Two-field `{ id, secret }` configs from pre-next.2 are NOT accepted —
 * `validateSecretKey` requires a single string.
 */
export const SECRET_KEY_PATTERN =
  /^sk_live_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9]+$/;

/**
 * Validate a {@link SecretKeyConfig} and return a normalized `{ keyId,
 * secret }`. The input is a single self-contained string; we parse the
 * keyId out of it via {@link SECRET_KEY_PATTERN}.
 *
 * Throws a plain `Error` on misuse. The error never echoes any characters
 * of the secret — only the shape and prefix sanity, just like the
 * public-key validator.
 *
 * @stability internal — exposed for `scorezilla/server`'s constructor
 *                       and unit tests. Not part of the public API.
 */
export function validateSecretKey(cfg: SecretKeyConfig): { keyId: string; secret: string } {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('scorezilla/server: config must be an object with a secretKey field');
  }
  const sk = cfg.secretKey;
  if (typeof sk !== 'string') {
    throw new Error(
      `scorezilla/server: secretKey must be a single string of the shape ${SECRET_KEY_PREFIX}<keyId>_<random> (got: ${typeof sk})`,
    );
  }
  const match = SECRET_KEY_PATTERN.exec(sk);
  if (!match) {
    // Never echo the value. A typo'd publicKey paste or a pre-next.2
    // `{ id, secret }` object lands here.
    const shape = `string of length ${sk.length}`;
    throw new Error(
      `scorezilla/server: secretKey must match ${SECRET_KEY_PATTERN.toString()} ` +
        `(got: ${shape}). v0.1.0-next.2 switched to a single-token format — if you have a pre-next.2 ` +
        `pair, issue a fresh key in the dashboard to upgrade.`,
    );
  }
  return { keyId: match[1]!, secret: sk };
}
