/**
 * @vitest-environment node
 *
 * (jose's WebCrypto signing trips the cross-realm `Uint8Array` check under
 * jsdom; these verifiers are server-only, so node is the correct env anyway.)
 *
 * Tests for the built-in `verify` helpers (#211): `verifyJwt` + the Supabase
 * preset. We generate a real RS256 keypair, serve its public JWK through an
 * injected `fetch`, and sign real tokens — so verification exercises the true
 * jose path (signature, issuer/audience, expiry, kid lookup) without network.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  verifyAuth0Jwt,
  verifyClerkJwt,
  verifyFirebaseIdToken,
  verifyJwt,
  verifySupabaseJwt,
} from '../../src/server';

const KID = 'test-key-1';
const ISSUER = 'https://issuer.test';
const AUDIENCE = 'test-audience';
const JWKS_URL = 'https://issuer.test/.well-known/jwks.json';

let signKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwksFetch: typeof fetch;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  signKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwksFetch = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
});

interface SignOpts {
  issuer?: string;
  audience?: string;
  exp?: string | number;
  claims?: Record<string, unknown>;
}

async function sign({
  issuer = ISSUER,
  audience = AUDIENCE,
  exp = '5m',
  claims = {},
}: SignOpts = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(exp)
    .sign(signKey);
}

function reqWith(authorization: string | null): Request {
  const headers: Record<string, string> = {};
  if (authorization !== null) headers.Authorization = authorization;
  return new Request('https://api.test/score', { method: 'POST', headers });
}

function bearer(token: string): Request {
  return reqWith(`Bearer ${token}`);
}

describe('verifyJwt', () => {
  const verify = () =>
    verifyJwt({ jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE, fetch: jwksFetch });

  it('verifies a valid token and returns { playerId } from sub', async () => {
    const token = await sign({ claims: { sub: 'user-1' } });
    expect(await verify()(bearer(token))).toEqual({ playerId: 'user-1' });
  });

  it('returns null with no Authorization header', async () => {
    expect(await verify()(reqWith(null))).toBeNull();
  });

  it('returns null for a non-Bearer Authorization header', async () => {
    expect(await verify()(reqWith('Basic abc123'))).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const token = await sign({ claims: { sub: 'u' }, exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await verify()(bearer(token))).toBeNull();
  });

  it('returns null when the issuer does not match', async () => {
    const token = await sign({ claims: { sub: 'u' }, issuer: 'https://evil.test' });
    expect(await verify()(bearer(token))).toBeNull();
  });

  it('returns null when the audience does not match', async () => {
    const token = await sign({ claims: { sub: 'u' }, audience: 'other-audience' });
    expect(await verify()(bearer(token))).toBeNull();
  });

  it('returns null when the configured claim is missing', async () => {
    const token = await sign({ claims: {} });
    expect(await verify()(bearer(token))).toBeNull();
  });

  it('supports a custom claim → playerId mapping', async () => {
    const v = verifyJwt({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      audience: AUDIENCE,
      claim: 'user_id',
      fetch: jwksFetch,
    });
    const token = await sign({ claims: { sub: 'ignored', user_id: 'u-9' } });
    expect(await v(bearer(token))).toEqual({ playerId: 'u-9' });
  });
});

describe('verifySupabaseJwt', () => {
  const SUPABASE_URL = 'https://proj.supabase.co';

  it('verifies a Supabase-shaped token (issuer + audience) → playerId from sub', async () => {
    const verify = verifySupabaseJwt({ supabaseUrl: SUPABASE_URL, fetch: jwksFetch });
    const token = await sign({
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
      claims: { sub: 'sb-user' },
    });
    expect(await verify(bearer(token))).toEqual({ playerId: 'sb-user' });
  });

  it('rejects a token with the wrong issuer', async () => {
    const verify = verifySupabaseJwt({ supabaseUrl: SUPABASE_URL, fetch: jwksFetch });
    const token = await sign({
      issuer: 'https://attacker.supabase.co/auth/v1',
      audience: 'authenticated',
      claims: { sub: 'sb-user' },
    });
    expect(await verify(bearer(token))).toBeNull();
  });
});

describe('verifyClerkJwt', () => {
  const ISS = 'https://clerk.test.app';

  it('verifies a Clerk session token (no audience by default)', async () => {
    const verify = verifyClerkJwt({ issuer: ISS, fetch: jwksFetch });
    // Clerk session tokens carry no aud; the preset must not require one.
    const token = await sign({ issuer: ISS, audience: 'whatever', claims: { sub: 'clerk-user' } });
    expect(await verify(bearer(token))).toEqual({ playerId: 'clerk-user' });
  });

  it('rejects a token from a different Clerk issuer', async () => {
    const verify = verifyClerkJwt({ issuer: ISS, fetch: jwksFetch });
    const token = await sign({ issuer: 'https://clerk.evil.app', claims: { sub: 'u' } });
    expect(await verify(bearer(token))).toBeNull();
  });
});

describe('verifyAuth0Jwt', () => {
  it('verifies an Auth0 token (issuer gets the trailing slash, audience checked)', async () => {
    const verify = verifyAuth0Jwt({
      domain: 'tenant.us.auth0.com',
      audience: 'my-api',
      fetch: jwksFetch,
    });
    const token = await sign({
      issuer: 'https://tenant.us.auth0.com/', // Auth0 issuer has a trailing slash
      audience: 'my-api',
      claims: { sub: 'auth0-user' },
    });
    expect(await verify(bearer(token))).toEqual({ playerId: 'auth0-user' });
  });

  it('accepts a domain given with a scheme', async () => {
    const verify = verifyAuth0Jwt({
      domain: 'https://tenant.us.auth0.com',
      audience: 'my-api',
      fetch: jwksFetch,
    });
    const token = await sign({
      issuer: 'https://tenant.us.auth0.com/',
      audience: 'my-api',
      claims: { sub: 'auth0-user' },
    });
    expect(await verify(bearer(token))).toEqual({ playerId: 'auth0-user' });
  });

  it('rejects a token for the wrong audience', async () => {
    const verify = verifyAuth0Jwt({
      domain: 'tenant.us.auth0.com',
      audience: 'my-api',
      fetch: jwksFetch,
    });
    const token = await sign({
      issuer: 'https://tenant.us.auth0.com/',
      audience: 'other-api',
      claims: { sub: 'u' },
    });
    expect(await verify(bearer(token))).toBeNull();
  });
});

describe('verifyFirebaseIdToken', () => {
  const PROJECT = 'my-firebase-proj';

  it('verifies a Firebase ID token (issuer + audience scoped to projectId)', async () => {
    const verify = verifyFirebaseIdToken({ projectId: PROJECT, fetch: jwksFetch });
    const token = await sign({
      issuer: `https://securetoken.google.com/${PROJECT}`,
      audience: PROJECT,
      claims: { sub: 'fb-uid' },
    });
    expect(await verify(bearer(token))).toEqual({ playerId: 'fb-uid' });
  });

  it('rejects a token minted for a different project', async () => {
    const verify = verifyFirebaseIdToken({ projectId: PROJECT, fetch: jwksFetch });
    const token = await sign({
      issuer: 'https://securetoken.google.com/other-proj',
      audience: 'other-proj',
      claims: { sub: 'fb-uid' },
    });
    expect(await verify(bearer(token))).toBeNull();
  });
});
