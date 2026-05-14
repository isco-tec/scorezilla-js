import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  PUBLIC_KEY_PATTERN,
  SECRET_KEY_PREFIX,
  validateConfig,
} from '../../src/config';

describe('validateConfig — public-key path', () => {
  it('accepts a well-formed publicKey and applies defaults', () => {
    const r = validateConfig({ publicKey: 'pk_testgame_aBcDeFgHiJkLmNoPqR' });
    expect(r.auth).toEqual({
      kind: 'public',
      key: 'pk_testgame_aBcDeFgHiJkLmNoPqR',
    });
    expect(r.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(r.fetch).toBeUndefined();
    expect(r.timeoutMs).toBeUndefined();
    expect(r.maxRetries).toBeUndefined();
  });

  it('preserves custom baseUrl and strips trailing slashes', () => {
    const r = validateConfig({
      publicKey: 'pk_testgame_aBcDeFgHiJkLmNoPqR',
      baseUrl: 'https://localhost:8787///',
    });
    expect(r.baseUrl).toBe('https://localhost:8787');
  });

  it('rejects publicKey not matching the pattern', () => {
    expect(() => validateConfig({ publicKey: 'pk_invalid' })).toThrow(/publicKey must match/);
    expect(() => validateConfig({ publicKey: 'sk_live_abc' })).toThrow(/publicKey must match/);
    expect(() => validateConfig({ publicKey: '' })).toThrow(/publicKey must match/);
  });

  it('rejects non-string publicKey', () => {
    // @ts-expect-error — intentional runtime-only misuse to test the defensive check
    expect(() => validateConfig({ publicKey: 42 })).toThrow(/publicKey must match/);
  });
});

describe('validateConfig — secret-key path', () => {
  it('accepts a well-formed single-token secretKey', () => {
    const sk = 'sk_live_9493330f-a9e6-4bd6-914f-100f1e51ac36_abcdefGHIJKLmnopQRSTuv';
    const r = validateConfig({ secretKey: sk });
    expect(r.auth).toEqual({
      kind: 'secret',
      keyId: '9493330f-a9e6-4bd6-914f-100f1e51ac36',
      secret: sk,
    });
  });

  it('rejects secretKey lacking the embedded keyId (old `sk_live_<random>` format)', () => {
    expect(() => validateConfig({ secretKey: 'sk_live_abcdefGHIJKLmnopQRSTuv' })).toThrow(
      /must match/,
    );
  });

  it('rejects secretKey with the wrong prefix', () => {
    expect(() =>
      validateConfig({ secretKey: 'sk_test_9493330f-a9e6-4bd6-914f-100f1e51ac36_abc' }),
    ).toThrow(/must match/);
  });

  it('rejects pre-next.2 object form with a guiding error message', () => {
    expect(() =>
      // @ts-expect-error — legacy shape no longer accepted; runtime check catches it
      validateConfig({ secretKey: { id: 'x', secret: 'sk_live_abc' } }),
    ).toThrow(/single string/);
  });
});

describe('validateConfig — mutual exclusivity', () => {
  it('rejects passing both publicKey and secretKey', () => {
    expect(() =>
      // @ts-expect-error — discriminated union forbids both at compile time; runtime check is the second line of defense
      validateConfig({
        publicKey: 'pk_bloom_a',
        secretKey: 'sk_live_9493330f-a9e6-4bd6-914f-100f1e51ac36_a',
      }),
    ).toThrow(/must not contain both/);
  });

  it('rejects passing neither', () => {
    // @ts-expect-error — discriminated union requires one of publicKey or secretKey
    expect(() => validateConfig({})).toThrow(/must contain either/);
  });

  it('rejects non-object input', () => {
    // @ts-expect-error — intentional runtime-only misuse to test the defensive check
    expect(() => validateConfig(null)).toThrow(/must be an object/);
    // @ts-expect-error — undefined isn't a valid config value
    expect(() => validateConfig(undefined)).toThrow(/must be an object/);
    // @ts-expect-error — string isn't a valid config value
    expect(() => validateConfig('hello')).toThrow(/must be an object/);
  });
});

describe('validateConfig — baseUrl edge cases', () => {
  it('rejects empty-string baseUrl override', () => {
    expect(() => validateConfig({ publicKey: 'pk_bloom_a', baseUrl: '' })).toThrow(
      /baseUrl must be a non-empty string/,
    );
  });
});

describe('validateConfig — fetch polyfill compatibility', () => {
  it('a node-fetch-style polyfill typechecks against cfg.fetch', () => {
    // This test passes if it COMPILES. The function below mimics the shape
    // of `node-fetch`'s default export: it accepts `(RequestInfo | URL,
    // init?)` and returns `Promise<Response>`. Strict `typeof fetch` would
    // reject it (browsers' lib.dom.d.ts version is narrower); the SDK's
    // explicit FetchImpl shape accepts it.
    const nodeFetchLike = async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => new Response('');

    const r = validateConfig({
      publicKey: 'pk_testgame_aBcDeFgHiJkLmNoPqR',
      fetch: nodeFetchLike,
    });
    expect(r.fetch).toBe(nodeFetchLike);
  });

  it('a vi.fn() mock typechecks against cfg.fetch', () => {
    // Test stubs are the second-most-common polyfill shape. They produce a
    // function whose return type is `any` by default, but the SDK's
    // FetchImpl accepts that.
    const mockFetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(''))) satisfies (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    const r = validateConfig({ publicKey: 'pk_bloom_a', fetch: mockFetch });
    expect(r.fetch).toBe(mockFetch);
  });
});

describe('constants', () => {
  it('PUBLIC_KEY_PATTERN accepts real public-key shapes', () => {
    expect(PUBLIC_KEY_PATTERN.test('pk_testgame_aBcDeFgHiJkLmNoPqR')).toBe(true);
    expect(PUBLIC_KEY_PATTERN.test('pk_my-game-123_AbCdEf')).toBe(true);
  });

  it('PUBLIC_KEY_PATTERN rejects garbage', () => {
    expect(PUBLIC_KEY_PATTERN.test('pk_')).toBe(false);
    expect(PUBLIC_KEY_PATTERN.test('public_key')).toBe(false);
    expect(PUBLIC_KEY_PATTERN.test('PK_GAME_ABC')).toBe(false); // case-sensitive on slug
  });

  it('SECRET_KEY_PREFIX is the live tier marker', () => {
    expect(SECRET_KEY_PREFIX).toBe('sk_live_');
  });

  it('DEFAULT_BASE_URL is a public vanity domain, not an operator-tied subdomain', () => {
    expect(DEFAULT_BASE_URL).toMatch(/^https:\/\//);
    // `workers.dev` catches every Cloudflare-account-tied URL shape
    // (`<account>.workers.dev`). The SDK's default should point at the
    // public vanity domain only.
    expect(DEFAULT_BASE_URL).not.toMatch(/workers\.dev/);
  });
});

// ─── Regression tests for the v0.1.0-next.0 review (issue #14) ─────────────

describe('validateConfig — never echoes key characters in errors', () => {
  it('redacts every character of the supplied key in the error message', () => {
    // Worst-case scenario: developer paste-mistakes a secret key into the
    // publicKey slot. The previous code echoed `pk.slice(0, 12)` which would
    // have leaked 12 characters of a real `sk_live_*` secret to whatever log
    // aggregator catches the thrown Error.
    const accidentalSecret = 'sk_live_supersensitiveXYZ_donotleakIVE';
    expect(() => validateConfig({ publicKey: accidentalSecret })).toThrow();
    try {
      validateConfig({ publicKey: accidentalSecret });
    } catch (e) {
      const msg = (e as Error).message;
      // The redaction is strict: no 6-char substring of the actual secret
      // payload (the bits after `sk_live_`) may appear in the error message.
      // 6 chars is comfortably above coincidental matches with the public
      // regex literal that's part of the error.
      const secretPayload = accidentalSecret.slice('sk_live_'.length);
      for (let i = 0; i + 6 <= secretPayload.length; i++) {
        const slice = secretPayload.slice(i, i + 6);
        expect(msg).not.toContain(slice);
      }
      // The error should still be useful — it tells you the type and length.
      expect(msg).toMatch(/string of length/);
    }
  });

  it('reports the typeof for non-string supplied keys', () => {
    // @ts-expect-error — intentional misuse to test the runtime path
    expect(() => validateConfig({ publicKey: 12345 })).toThrow(/got: number/);
    // @ts-expect-error — intentional misuse to test the runtime path
    expect(() => validateConfig({ publicKey: { not: 'a string' } })).toThrow(/got: object/);
  });
});
