/**
 * Unit tests for the HMAC signing primitive (#17, v0.2.0).
 *
 * The API verifier (`apps/api/src/auth/hmac.ts` in the monorepo) and this
 * signer share an exact wire contract. As of A-H4 (next.3), v=2 is the
 * default and binds the canonical signing string to the target host:
 *
 *   v=2 signing string =
 *     `${ts}\n${nonce}\n${METHOD}\n${host}\n${pathAndQuery}\n${sha256_hex(body)}`
 *   header value =
 *     `Scorezilla-HMAC-SHA256 keyId=<id>, ts=<n>, nonce=<n>, signature=<sig>, v=2`
 *
 * v=1 (legacy, pre-A-H4) is preserved for backward-compat tests below — the
 * verifier still accepts it during the rollout window, but the SDK no longer
 * emits it by default.
 *
 * Any drift between the two sides means EVERY signed request rejects with
 * `bad_signature`. The pinned vectors below catch that immediately.
 */
import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  buildHmacAuthHeader,
  buildSigningString,
  generateNonce,
  hmacSha256B64u,
  HMAC_AUTH_SCHEME,
  HMAC_SIGNING_VERSION_LATEST,
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
  it('latest signing version is 2 (host-bound)', () => {
    expect(HMAC_SIGNING_VERSION_LATEST).toBe(2);
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

describe('buildSigningString — v=2 (default, host-bound)', () => {
  it('joins six fields with literal newlines, host in slot 4, body hashed', async () => {
    const s = await buildSigningString(
      'post',
      '/v1/secure/scores',
      1700000000,
      'nonce-xyz',
      '{}',
      'api.scorezilla.dev',
    );
    const expectedBodyHash = await sha256Hex('{}');
    expect(s).toBe(
      `1700000000\nnonce-xyz\nPOST\napi.scorezilla.dev\n/v1/secure/scores\n${expectedBodyHash}`,
    );
  });

  it('lowercases the host (RFC 9110 §4.2.4 case-insensitive host)', async () => {
    const sUpper = await buildSigningString('POST', '/x', 1, 'n', '', 'API.SCOREZILLA.DEV');
    const sLower = await buildSigningString('POST', '/x', 1, 'n', '', 'api.scorezilla.dev');
    expect(sUpper).toBe(sLower);
  });

  it('different hosts produce different signing strings (the whole point of v=2)', async () => {
    const a = await buildSigningString('POST', '/x', 1, 'n', '', 'staging.scorezilla.dev');
    const b = await buildSigningString('POST', '/x', 1, 'n', '', 'api.scorezilla.dev');
    expect(a).not.toBe(b);
  });

  it('uppercases the method (server compares uppercased)', async () => {
    const sigUpper = await buildSigningString('POST', '/x', 1, 'n', '', 'h');
    const sigLower = await buildSigningString('post', '/x', 1, 'n', '', 'h');
    expect(sigLower).toBe(sigUpper);
  });

  it('preserves the path-and-query verbatim — no canonicalization', async () => {
    const s = await buildSigningString(
      'GET',
      '/v1/boards/abc/leaderboard?top=10&offset=0',
      1,
      'n',
      '',
      'api.scorezilla.dev',
    );
    expect(s).toContain('/v1/boards/abc/leaderboard?top=10&offset=0');
  });
});

describe('buildSigningString — v=1 (legacy, backward compat)', () => {
  it('omits host from the canonical string; matches pre-A-H4 format', async () => {
    const s = await buildSigningString(
      'POST',
      '/v1/secure/scores',
      1700000000,
      'nonce-xyz',
      '{}',
      'api.scorezilla.dev', // ignored at v=1
      1,
    );
    const expectedBodyHash = await sha256Hex('{}');
    expect(s).toBe(`1700000000\nnonce-xyz\nPOST\n/v1/secure/scores\n${expectedBodyHash}`);
  });
});

describe('hmacSha256B64u', () => {
  it('returns the canonical signature for (key="key", data="The quick brown fox …")', async () => {
    const sig = await hmacSha256B64u('key', 'The quick brown fox jumps over the lazy dog');
    expect(sig).toBe('97yD9DBThCSxMpjmqm-xQ-9NWaFJRhdZl0edvC0aPNg');
    expect(sig.length).toBe(43);
  });

  it('produces base64url output (no +, /, =)', async () => {
    const sig = await hmacSha256B64u('s', 'm');
    expect(sig).not.toMatch(/[+/=]/);
  });
});

describe('base64UrlEncode', () => {
  it('strips padding and converts the base64 alphabet to URL-safe', () => {
    expect(base64UrlEncode(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(base64UrlEncode(new TextEncoder().encode('M'))).toBe('TQ');
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xef, 0xfe]))).toBe('--_-');
  });
});

describe('buildHmacAuthHeader — v=2 default', () => {
  it('produces scheme prefix + 4 core params + v=2', async () => {
    const header = await buildHmacAuthHeader({
      keyId: 'sk-id-abc',
      secret: 'sk_live_xyz',
      method: 'POST',
      pathAndQuery: '/v1/secure/scores',
      host: 'api.scorezilla.dev',
      body: '{}',
      nowSeconds: 1700000000,
      nonce: 'fixed-nonce-test',
    });
    expect(header).toMatch(/^Scorezilla-HMAC-SHA256 /);
    expect(header).toContain('keyId=sk-id-abc');
    expect(header).toContain('ts=1700000000');
    expect(header).toContain('nonce=fixed-nonce-test');
    expect(header).toMatch(/signature=[A-Za-z0-9_-]+/);
    expect(header).toMatch(/, v=2$/);
  });

  it('two calls with the same inputs but different (ts, nonce) produce different signatures', async () => {
    const h1 = await buildHmacAuthHeader({
      keyId: 'k',
      secret: 's',
      method: 'GET',
      pathAndQuery: '/x',
      host: 'h',
      body: '',
      nowSeconds: 1,
      nonce: 'a',
    });
    const h2 = await buildHmacAuthHeader({
      keyId: 'k',
      secret: 's',
      method: 'GET',
      pathAndQuery: '/x',
      host: 'h',
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
      host: 'h',
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
      host: 'h',
      body: '',
      nowSeconds: 1,
    });
    const match = /nonce=([^,]+)/.exec(header);
    expect(match).toBeTruthy();
    expect(match![1]!).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('buildHmacAuthHeader — v=1 backward compat', () => {
  it('omits the v= field for byte-for-byte parity with pre-A-H4 SDKs', async () => {
    const header = await buildHmacAuthHeader({
      keyId: 'k1',
      secret: 'sk_live_test',
      method: 'POST',
      pathAndQuery: '/v1/secure/scores',
      host: 'ignored-at-v1',
      body: '{"boardId":"b","playerId":"p","score":1}',
      nowSeconds: 1700000000,
      nonce: 'n',
      version: 1,
    });
    // Pinned to the EXACT pre-A-H4 wire format. If this changes, we've
    // broken backward compat — the API's v=1 acceptance path would still
    // work but pre-next.3 SDKs would no longer match the format.
    expect(header).toBe(
      'Scorezilla-HMAC-SHA256 keyId=k1, ts=1700000000, nonce=n, signature=6ZJ9KZemDkX9S8OV6UnNsRvjR0UtH9aIJmqRkNTjbPU',
    );
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
