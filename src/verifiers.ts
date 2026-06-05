/**
 * Built-in request verifiers for {@link createScoreSubmitHandler} (#211).
 *
 * These turn the common "verify a JWT, derive the player id from a claim"
 * shape into a one-liner. They produce a function with the same signature as
 * the handler's `verify` callback, so they drop straight in:
 *
 * ```ts
 * import { createScoreSubmitHandler, verifySupabaseJwt } from 'scorezilla/server';
 *
 * createScoreSubmitHandler({
 *   secretKey, boardId,
 *   verify: verifySupabaseJwt({ supabaseUrl: process.env.SUPABASE_URL! }),
 * });
 * ```
 *
 * **`jose` is an optional peer dependency.** Only these verifiers use it, and
 * only via a lazy `import('jose')` — so consumers who use the public-key
 * client, the factory with their own `verify`, or a provider backend SDK never
 * install or load it. If you call a built-in verifier without `jose` present,
 * it throws a clear "install jose" error.
 */
import type { VerifiedIdentity } from './server';

/** Same shape as the handler's `verify` callback. */
export type RequestVerifier = (req: Request) => Promise<VerifiedIdentity | null>;

/** Options for the generic JWKS verifier {@link verifyJwt}. */
export interface VerifyJwtOptions {
  /** JWKS endpoint, e.g. `https://issuer/.well-known/jwks.json`. */
  readonly jwksUrl: string | URL;
  /** Expected `iss` claim — strongly recommended. */
  readonly issuer?: string | string[];
  /** Expected `aud` claim — strongly recommended. */
  readonly audience?: string | string[];
  /** Which claim becomes the `playerId`. Default `'sub'`. */
  readonly claim?: string;
  /** Custom `fetch` for retrieving the JWKS (proxy / self-host / testing). */
  readonly fetch?: typeof fetch;
}

/** Options for the Supabase preset {@link verifySupabaseJwt}. */
export interface VerifySupabaseJwtOptions {
  /** Your Supabase project URL, e.g. `https://abcd.supabase.co`. */
  readonly supabaseUrl: string;
  /** Which claim becomes the `playerId`. Default `'sub'`. */
  readonly claim?: string;
  /** Custom `fetch` for retrieving the JWKS (proxy / self-host / testing). */
  readonly fetch?: typeof fetch;
}

type JoseModule = typeof import('jose');

async function loadJose(): Promise<JoseModule> {
  try {
    return await import('jose');
  } catch (cause) {
    throw new Error(
      "scorezilla/server: the optional peer dependency 'jose' is required for " +
        'verifyJwt() / verifySupabaseJwt(). Install it with `npm i jose` ' +
        '(or your package manager).',
      { cause },
    );
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^bearer\s+/i.test(trimmed)) return null;
  return trimmed.replace(/^bearer\s+/i, '').trim() || null;
}

/**
 * Generic JWKS-backed JWT verifier. Verifies a `Bearer` token against the
 * given JWKS and returns `{ playerId }` from the configured claim (default
 * `sub`), or `null` if there's no token or verification fails.
 *
 * Covers the modern provider majority (Supabase, Clerk, Auth0, Firebase,
 * WorkOS, …) — they differ only by `jwksUrl` / `issuer` / `audience`.
 *
 * @since 0.3.0
 */
export function verifyJwt(options: VerifyJwtOptions): RequestVerifier {
  const claim = options.claim ?? 'sub';
  // Lazily built + memoized: the remote key set caches fetched keys and
  // refetches on unknown `kid`, so we create it once per verifier.
  let keySet: ReturnType<JoseModule['createRemoteJWKSet']> | null = null;

  return async (req: Request): Promise<VerifiedIdentity | null> => {
    const token = extractBearerToken(req);
    if (token === null) return null;

    // A missing `jose` surfaces here (not swallowed as a null/401) so the
    // misconfiguration is debuggable.
    const jose = await loadJose();
    if (keySet === null) {
      keySet = jose.createRemoteJWKSet(
        new URL(options.jwksUrl),
        options.fetch ? { [jose.customFetch]: options.fetch } : undefined,
      );
    }

    try {
      const { payload } = await jose.jwtVerify(token, keySet, {
        ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
        ...(options.audience !== undefined ? { audience: options.audience } : {}),
      });
      const id = payload[claim];
      return typeof id === 'string' && id.length > 0 ? { playerId: id } : null;
    } catch {
      // Bad signature / expired / wrong issuer-audience / unknown kid.
      return null;
    }
  };
}

/**
 * Supabase preset over {@link verifyJwt}. Verifies a Supabase user JWT via the
 * project's JWKS and derives the `playerId` from `sub`.
 *
 * ```ts
 * verify: verifySupabaseJwt({ supabaseUrl: process.env.SUPABASE_URL! })
 * ```
 *
 * @since 0.3.0
 */
export function verifySupabaseJwt(options: VerifySupabaseJwtOptions): RequestVerifier {
  const base = options.supabaseUrl.replace(/\/+$/, '');
  return verifyJwt({
    jwksUrl: `${base}/auth/v1/.well-known/jwks.json`,
    issuer: `${base}/auth/v1`,
    audience: 'authenticated',
    ...(options.claim !== undefined ? { claim: options.claim } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
}

/** Options for the Clerk preset {@link verifyClerkJwt}. */
export interface VerifyClerkJwtOptions {
  /**
   * Your Clerk instance issuer (the token's `iss`), e.g.
   * `https://clerk.your-app.com` or `https://<slug>.clerk.accounts.dev`. The
   * JWKS URL is derived from it.
   */
  readonly issuer: string;
  /**
   * Expected `aud`. Clerk session tokens have **no** `aud` by default, so leave
   * this unset unless you added one via a custom JWT template.
   */
  readonly audience?: string | string[];
  /** Which claim becomes the `playerId`. Default `'sub'` (the Clerk user id). */
  readonly claim?: string;
  /** Custom `fetch` for retrieving the JWKS (proxy / self-host / testing). */
  readonly fetch?: typeof fetch;
}

/**
 * Clerk preset over {@link verifyJwt}. Verifies a Clerk session JWT against the
 * instance JWKS and derives the `playerId` from `sub` (the Clerk user id).
 *
 * @since 0.3.0
 */
export function verifyClerkJwt(options: VerifyClerkJwtOptions): RequestVerifier {
  const issuer = options.issuer.replace(/\/+$/, '');
  return verifyJwt({
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    issuer,
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.claim !== undefined ? { claim: options.claim } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
}

/** Options for the Auth0 preset {@link verifyAuth0Jwt}. */
export interface VerifyAuth0JwtOptions {
  /** Your Auth0 domain, e.g. `your-tenant.us.auth0.com` (scheme optional). */
  readonly domain: string;
  /** Your API identifier — the access token's `aud`. */
  readonly audience: string | string[];
  /** Which claim becomes the `playerId`. Default `'sub'`. */
  readonly claim?: string;
  /** Custom `fetch` for retrieving the JWKS (proxy / self-host / testing). */
  readonly fetch?: typeof fetch;
}

/**
 * Auth0 preset over {@link verifyJwt}. Note Auth0's issuer carries a trailing
 * slash (`https://<domain>/`) — the preset adds it for you.
 *
 * @since 0.3.0
 */
export function verifyAuth0Jwt(options: VerifyAuth0JwtOptions): RequestVerifier {
  const host = options.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return verifyJwt({
    jwksUrl: `https://${host}/.well-known/jwks.json`,
    issuer: `https://${host}/`,
    audience: options.audience,
    ...(options.claim !== undefined ? { claim: options.claim } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
}

/**
 * JWK-set endpoint for Firebase ID tokens (the `securetoken` system service
 * account). Google publishes a standard JWK set here — no x509 import needed.
 */
const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/** Options for the Firebase preset {@link verifyFirebaseIdToken}. */
export interface VerifyFirebaseIdTokenOptions {
  /** Your Firebase project id — both the token's `aud` and the issuer suffix. */
  readonly projectId: string;
  /** Which claim becomes the `playerId`. Default `'sub'` (the Firebase uid). */
  readonly claim?: string;
  /** Custom `fetch` for retrieving the JWKS (proxy / self-host / testing). */
  readonly fetch?: typeof fetch;
}

/**
 * Firebase Authentication preset over {@link verifyJwt}. Verifies a Firebase ID
 * token (`iss = https://securetoken.google.com/<projectId>`, `aud = projectId`)
 * and derives the `playerId` from `sub` (the Firebase uid).
 *
 * @since 0.3.0
 */
export function verifyFirebaseIdToken(options: VerifyFirebaseIdTokenOptions): RequestVerifier {
  return verifyJwt({
    jwksUrl: FIREBASE_JWKS_URL,
    issuer: `https://securetoken.google.com/${options.projectId}`,
    audience: options.projectId,
    ...(options.claim !== undefined ? { claim: options.claim } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
}
