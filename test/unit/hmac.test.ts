/**
 * Unit tests for the HMAC signing primitive (#17, v0.2.0).
 *
 * The API verifier (`apps/api/src/auth/hmac.ts` in the monorepo) and
 * this signer share an exact wire contract:
 *
 *   signing string = `${ts}\n${nonce}\n${METHOD}\n${pathAndQuery}\n${sha256_hex(body)}`
 *   signature      = base64url(HMAC-SHA256(secret, signing-string))
 *   header value   = `Scorezilla-HMAC-SHA256 keyId=<id>, ts=<n>, nonce=<n>, signature=<sig>`
 *
 * Any drift between the two sides means EVERY signed request rejects
 * with `bad_signature`. The pinned vectors below catch that immediately.
 */
import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  buildHmacAuthHeader,
  buildSigningString,
  generateNonce,
  hmacSha256B64u,
  HMAC_AUTH_SCHEME,
  HMAC_TIMESTAMP_WINDOW_SECONDS,
  sha256Hex,
} from '../../src/hmac';

describe('constants — wire contract', () => {
  it('AUTH_SCHEME matches what the API verifier expects', () => {
    // If this changes, the API stops accepting our requests.
    expect(HMAC_AUTH_SCHEME).toBe('Scorezilla-HMAC-SHA256');
  });
  it('exposes the timestamp window the API enforces', () => {
    expect(HMAC_TIMESTAMP_WINDOW_SECONDS).toBe(300);
  });
});

describe('sha256Hex', () => {
  it('hashes an empty string to the canonical SHA-256 of empty', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc" to the canonical SHA-256 fixture', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a long string deterministically (regression vector)', async () => {
    const msg = '{"boardId":"brd_42","playerId":"alice","score":9001}';
    const h = await sha256Hex(msg);
    expect(h.length).toBe(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Pinned to our WebCrypto-derived value. The API verifier uses the
    // same primitives, so this is the value the server side computes too.
    expect(h).toBe('6e1534eb467194637a5fb253673a7707ab805caca7b008d68cbbf605fa737896');
  });
});

describe('buildSigningString', () => {
  it('joins the five fields with literal newlines, body hashed', async () => {
    const s = await buildSigningString('post', '/v1/secure/scores', 1700000000, 'nonce-xyz', '{}');
    const expectedBodyHash = await sha256Hex('{}');
    expect(s).toBe(`1700000000\nnonce-xyz\nPOST\n/v1/secure/scores\n${expectedBodyHash}`);
  });

  it('uppercases the method (server compares uppercased)', async () => {
    const sigUpper = await buildSigningString('POST', '/x', 1, 'n', '');
    const sigLower = await buildSigningString('post', '/x', 1, 'n', '');
    expect(sigLower).toBe(sigUpper);
  });

  it('preserves the path-and-query verbatim — no canonicalization', async () => {
    // Critical: server signs over the raw query string. SDK helpers in
    // src/paths.ts must produce the exact spelling the server sees.
    const s = await buildSigningString(
      'GET',
      '/v1/boards/abc/leaderboard?top=10&offset=0',
      1,
      'n',
      '',
    );
    expect(s).toContain('/v1/boards/abc/leaderboard?top=10&offset=0');
  });
});

describe('hmacSha256B64u', () => {
  it('returns the canonical signature for (key="key", data="The quick brown fox …")', async () => {
    // Regression vector pinned to our WebCrypto-derived output. Same
    // primitives the API uses, so any drift here is a real bug — either
    // the signing or the encoding changed.
    const sig = await hmacSha256B64u('key', 'The quick brown fox jumps over the lazy dog');
    expect(sig).toBe('97yD9DBThCSxMpjmqm-xQ-9NWaFJRhdZl0edvC0aPNg');
    // Sanity: base64url length for a 32-byte digest = 43 chars (no padding).
    expect(sig.length).toBe(43);
  });

  it('produces base64url output (no +, /, =)', async () => {
    const sig = await hmacSha256B64u('s', 'm');
    expect(sig).not.toMatch(/[+/=]/);
  });
});

describe('base64UrlEncode', () => {
  it('strips padding and converts the base64 alphabet to URL-safe', () => {
    // Bytes for "Man" → base64 "TWFu" — no padding, no special chars
    expect(base64UrlEncode(new TextEncoder().encode('Man'))).toBe('TWFu');
    // Bytes ending without 3-byte alignment → padded in std base64
    expect(base64UrlEncode(new TextEncoder().encode('M'))).toBe('TQ');
    // Bytes that produce + in std base64 → must become -
    // The byte sequence below produces "++/+" in standard base64.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xef, 0xfe]))).toBe('--_-');
  });
});

describe('buildHmacAuthHeader', () => {
  it('produces the canonical scheme prefix + 4 named params', async () => {
    const header = await buildHmacAuthHeader({
      keyId: 'sk-id-abc',
      secret: 'sk_live_xyz',
      method: 'POST',
      pathAndQuery: '/v1/secure/scores',
      body: '{}',
      nowSeconds: 1700000000,
      nonce: 'fixed-nonce-test',
    });
    expect(header).toMatch(/^Scorezilla-HMAC-SHA256 /);
    expect(header).toContain('keyId=sk-id-abc');
    expect(header).toContain('ts=1700000000');
    expect(header).toContain('nonce=fixed-nonce-test');
    expect(header).toMatch(/signature=[A-Za-z0-9_-]+$/);
  });

  it('produces deterministic output for identical inputs (regression)', async () => {
    // Pinned: if any encoding / algorithm detail changes, this fails.
    // Pre-computed against the exact same WebCrypto primitives the API
    // uses, so the API will accept this header verbatim.
    const header = await buildHmacAuthHeader({
      keyId: 'k1',
      secret: 'sk_live_test',
      method: 'POST',
      pathAndQuery: '/v1/secure/scores',
      body: '{"boardId":"b","playerId":"p","score":1}',
      nowSeconds: 1700000000,
      nonce: 'n',
    });
    // The header is determined by signing string =
    //   "1700000000\nn\nPOST\n/v1/secure/scores\n<sha256_hex of body>"
    // HMACed with "sk_live_test" → fixed base64url signature.
    expect(header).toBe(
      'Scorezilla-HMAC-SHA256 keyId=k1, ts=1700000000, nonce=n, signature=6ZJ9KZemDkX9S8OV6UnNsRvjR0UtH9aIJmqRkNTjbPU',
    );
  });

  it('two calls with the same inputs but different (ts, nonce) produce different signatures', async () => {
    const h1 = await buildHmacAuthHeader({
      keyId: 'k',
      secret: 's',
      method: 'GET',
      pathAndQuery: '/x',
      body: '',
      nowSeconds: 1,
      nonce: 'a',
    });
    const h2 = await buildHmacAuthHeader({
      keyId: 'k',
      secret: 's',
      method: 'GET',
      pathAndQuery: '/x',
      body: '',
      nowSeconds: 2,
      nonce: 'a',
    });
    expect(h1).not.toBe(h2);
  });

  it('defaults nowSeconds to Date.now()-ish when not provided', async () => {
    const before = Math.floor(Date.now() / 1000);
    const header = await buildHmacAuthHeader({
      keyId: 'k',
      secret: 's',
      method: 'GET',
      pathAndQuery: '/x',
      body: '',
      nonce: 'n',
    });
    const after = Math.floor(Date.now() / 1000);
    const match = /ts=(\d+)/.exec(header);
    expect(match).toBeTruthy();
    const ts = Number.parseInt(match![1]!, 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('defaults nonce via generateNonce() when not provided', async () => {
    const header = await buildHmacAuthHeader({
      keyId: 'k',
      secret: 's',
      method: 'GET',
      pathAndQuery: '/x',
      body: '',
      nowSeconds: 1,
    });
    const match = /nonce=([^,]+)/.exec(header);
    expect(match).toBeTruthy();
    // randomUUID produces a 36-char hyphenated UUID.
    expect(match![1]!).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('generateNonce', () => {
  it('returns a UUID v4 shape', () => {
    const n = generateNonce();
    expect(n).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns distinct values on consecutive calls', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
