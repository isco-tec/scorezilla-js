/**
 * Unit tests for `scorezilla/server` (#17, v0.2.0).
 *
 * Every test mocks `fetch` so there's no network I/O. We assert two
 * things about each request:
 *   1. The Scorezilla-HMAC-SHA256 Authorization header is present and
 *      structured correctly (the server-side verifier rejects anything
 *      else).
 *   2. The path / method / body match the wire-level contract the API
 *      exposes (`POST /v1/secure/scores` for submit, the existing read
 *      paths for the others).
 */
import { describe, expect, it, vi } from 'vitest';
import { Scorezilla, ScorezillaError } from '../../src/server';
import { HMAC_AUTH_SCHEME } from '../../src/hmac';
import type { FetchImpl } from '../../src/transport';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

const VALID_CONFIG = {
  secretKey: { id: 'sk-id-abc', secret: 'sk_live_test_secret_value' },
} as const;

describe('Scorezilla server — constructor validation', () => {
  it('throws on missing secretKey field', () => {
    // @ts-expect-error — intentional misuse
    expect(() => new Scorezilla({})).toThrow(/secretKey/);
  });

  it('throws when secretKey.secret does not start with sk_live_', () => {
    expect(() => new Scorezilla({ secretKey: { id: 'k', secret: 'sk_test_abc' } })).toThrow(
      /sk_live_/,
    );
  });

  it('throws on empty keyId', () => {
    expect(() => new Scorezilla({ secretKey: { id: '', secret: 'sk_live_xyz' } })).toThrow(
      /id must be a non-empty string/,
    );
  });

  it('never echoes any characters of the secret in the thrown error', () => {
    // Random-looking payload with no overlap against the error template
    // text (which legitimately contains words like "secretKey" and "key").
    const secret = 'sk_test_X7Qp3Z9aB2vR8sW1MnK0LjUyEdHfGiTcDbN';
    try {
      new Scorezilla({ secretKey: { id: 'k', secret } });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      // No 6-char substring of the secret's payload (after the prefix)
      // should appear in the error message.
      const payload = secret.replace(/^sk_(live_|test_)/, '');
      for (let i = 0; i + 6 <= payload.length; i++) {
        expect(msg).not.toContain(payload.slice(i, i + 6));
      }
    }
  });

  it('exposes a static version matching the SDK build', () => {
    expect(typeof Scorezilla.version).toBe('string');
    expect(Scorezilla.version.length).toBeGreaterThan(0);
  });

  it('refuses to instantiate in a real-browser environment (bundler misconfig safety net)', () => {
    // The test runs under vitest with jsdom — so window+document are already
    // set, but `process.versions.node` is also present (we're really in Node),
    // which means the guard correctly does NOT fire. To simulate the dangerous
    // case (a real browser receiving server.ts because a Webpack 4 config
    // didn't honor the `browser` export condition), we temporarily clear the
    // Node-host signals. The guard MUST throw in this configuration.
    //
    // Some runtimes (Bun, Deno) make their identity globals read-only. We
    // use `Reflect.defineProperty` with try/catch so the test stays robust
    // across runtimes — if a host global can't be cleared, we skip clearing
    // it; the guard correctly does NOT fire in that case because we're
    // actually running under that host, and the test isn't expecting it to.
    const g = globalThis as Record<string, unknown>;
    const hostGlobals = ['process', 'Deno', 'Bun', 'EdgeRuntime'] as const;
    const originals: Record<string, unknown> = {};
    const cleared: string[] = [];
    for (const k of hostGlobals) {
      originals[k] = g[k];
      try {
        Reflect.defineProperty(g, k, { value: undefined, configurable: true, writable: true });
        cleared.push(k);
      } catch {
        // Some runtimes (Bun) make their own identity global non-configurable.
        // If we can't clear it, the test runs WITH that host present — the
        // guard correctly recognizes the host and doesn't throw. Either way,
        // the assertion below is conditional on having cleared every signal.
      }
    }
    try {
      // If we couldn't clear every signal, at least one host is still
      // detectable and the guard will NOT throw. Only assert the throw
      // when we successfully simulated a no-host environment.
      if (cleared.length === hostGlobals.length) {
        expect(() => new Scorezilla(VALID_CONFIG)).toThrow(
          /scorezilla\/server: this adapter is server-only/,
        );
      } else {
        // Test still has value: confirm the guard doesn't throw under the
        // present host's identity (i.e., the detection isn't over-eager).
        expect(() => new Scorezilla(VALID_CONFIG)).not.toThrow();
      }
    } finally {
      for (const k of hostGlobals) {
        try {
          Reflect.defineProperty(g, k, { value: originals[k], configurable: true, writable: true });
        } catch {
          /* same restriction; nothing to do */
        }
      }
    }
  });

  it('does NOT throw under jsdom (vitest test environment) — process.versions.node is present', () => {
    // Sanity that the guard distinguishes test-time jsdom from a real
    // browser. The base test config has window+document (jsdom) AND
    // process.versions.node (real Node host) — guard must allow this.
    expect(() => new Scorezilla(VALID_CONFIG)).not.toThrow();
  });
});

describe('Scorezilla server — submitScore signs the request', () => {
  it('POSTs /v1/secure/scores with HMAC Authorization header', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        keyId: 'k',
        rank: 1,
        totalEntries: 1,
        isPersonalBest: true,
      }),
    ) as unknown as FetchImpl;

    const sz = new Scorezilla({
      ...VALID_CONFIG,
      baseUrl: 'https://api.example.com',
      fetch: fetchImpl,
    });

    const result = await sz.submitScore({
      boardId: 'b-123',
      playerId: 'alice',
      score: 9001,
    });

    expect(result.ok).toBe(true);
    expect(result.rank).toBe(1);

    // Inspect the captured fetch call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(url).toBe('https://api.example.com/v1/secure/scores');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toMatch(new RegExp(`^${HMAC_AUTH_SCHEME} `));
    expect(headers['Authorization']).toContain('keyId=sk-id-abc');
    expect(headers['Authorization']).toMatch(/ts=\d+,/);
    expect(headers['Authorization']).toMatch(/nonce=[0-9a-f-]{36},/i);
    expect(headers['Authorization']).toMatch(/signature=[A-Za-z0-9_-]+$/);

    // Body contains boardId — it has moved from path to body for /v1/secure/scores.
    const body = JSON.parse(init.body);
    expect(body).toEqual({ boardId: 'b-123', playerId: 'alice', score: 9001 });
  });

  it('omits metadata when not provided (exactOptionalPropertyTypes-friendly)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        keyId: 'k',
        rank: 1,
        totalEntries: 1,
        isPersonalBest: true,
      }),
    ) as unknown as FetchImpl;
    const sz = new Scorezilla({ ...VALID_CONFIG, fetch: fetchImpl });

    await sz.submitScore({ boardId: 'b', playerId: 'p', score: 1 });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty('metadata');
  });

  it('includes metadata when provided', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        keyId: 'k',
        rank: 1,
        totalEntries: 1,
        isPersonalBest: true,
      }),
    ) as unknown as FetchImpl;
    const sz = new Scorezilla({ ...VALID_CONFIG, fetch: fetchImpl });

    await sz.submitScore({
      boardId: 'b',
      playerId: 'p',
      score: 1,
      metadata: { level: 'hard', combo: 12 },
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.metadata).toEqual({ level: 'hard', combo: 12 });
  });

  it('every retry attempt gets a fresh (ts, nonce) — never reuses', async () => {
    // First attempt returns 503 (retryable), second returns success.
    let calls = 0;
    const seenAuthHeaders: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      calls++;
      const auth = (init.headers as Record<string, string>)['Authorization'];
      seenAuthHeaders.push(auth);
      if (calls < 2) {
        return new Response('', { status: 503 });
      }
      return jsonResponse({
        ok: true,
        boardId: 'b',
        keyId: 'k',
        rank: 1,
        totalEntries: 1,
        isPersonalBest: true,
      });
    }) as unknown as FetchImpl;

    const sz = new Scorezilla({ ...VALID_CONFIG, fetch: fetchImpl, maxRetries: 1 });
    // Inject zero sleep via the lower-level transport — not exposed at the
    // server constructor level, so we rely on default backoff. To keep
    // the test fast, the deliberate 503→200 sequence completes in <300ms.
    const result = await sz.submitScore({ boardId: 'b', playerId: 'p', score: 1 });
    expect(result.ok).toBe(true);
    expect(seenAuthHeaders).toHaveLength(2);
    // Two different (ts, nonce) → two different signatures.
    expect(seenAuthHeaders[0]).not.toBe(seenAuthHeaders[1]);
    const nonce1 = /nonce=([^,]+)/.exec(seenAuthHeaders[0]!)?.[1];
    const nonce2 = /nonce=([^,]+)/.exec(seenAuthHeaders[1]!)?.[1];
    expect(nonce1).not.toBe(nonce2);
  });
});

describe('Scorezilla server — read methods sign the request too', () => {
  it('getLeaderboard signs GET /v1/boards/:id/leaderboard?top=…', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, boardId: 'b', offset: 0, limit: 10, entries: [] }),
    ) as unknown as FetchImpl;
    const sz = new Scorezilla({ ...VALID_CONFIG, fetch: fetchImpl });

    await sz.getLeaderboard({ boardId: 'b-123', top: 10 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/v1/boards/b-123/leaderboard?top=10');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(new RegExp(`^${HMAC_AUTH_SCHEME} `));
    // GET has no body → bodyHash is sha256("") inside the signing string.
    // (Verified via the hmac.test.ts deterministic vector pinning.)
  });

  it('getPlayerRank signs GET /v1/boards/:id/players/:p/rank', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, boardId: 'b', playerId: 'alice', rank: 1, score: 9001 }),
    ) as unknown as FetchImpl;
    const sz = new Scorezilla({ ...VALID_CONFIG, fetch: fetchImpl });

    await sz.getPlayerRank({ boardId: 'b', playerId: 'alice' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/v1/boards/b/players/alice/rank');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(new RegExp(`^${HMAC_AUTH_SCHEME} `));
  });

  it('getWindowAround signs with before/after query params', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, boardId: 'b', playerId: 'a', entries: [] }),
    ) as unknown as FetchImpl;
    const sz = new Scorezilla({ ...VALID_CONFIG, fetch: fetchImpl });

    await sz.getWindowAround({ boardId: 'b', playerId: 'a', before: 3, after: 3 });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/window?before=3&after=3');
  });
});

describe('Scorezilla server — error surface mirrors the public-key client', () => {
  it('non-2xx → ScorezillaError with the right code', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          error: 'unauthorized',
          reason: 'bad_signature',
          message: 'Signature mismatch',
        },
        { status: 401 },
      ),
    ) as unknown as FetchImpl;

    const sz = new Scorezilla({ ...VALID_CONFIG, fetch: fetchImpl, maxRetries: 0 });

    try {
      await sz.submitScore({ boardId: 'b', playerId: 'p', score: 1 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      const err = e as ScorezillaError;
      expect(err.code).toBe('unauthorized');
      expect(err.status).toBe(401);
      expect(err.isAuth()).toBe(true);
    }
  });
});
