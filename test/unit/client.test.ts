/**
 * Tests for the `Scorezilla` public-key client.
 *
 * Coverage targets:
 *   • All four methods build the correct URL + method + body
 *   • Authorization: Bearer header is set on every call
 *   • User-Agent + X-Scorezilla-Client headers are present
 *   • Metadata validation: structural + size
 *   • Secret-key config in the public-key constructor is rejected
 *   • playerId-only input contract (compile-time check via @ts-expect-error)
 *   • createClient() is functionally equivalent to `new Scorezilla(…)`
 */

import { describe, expect, it, vi } from 'vitest';
import { METADATA_MAX_BYTES, Scorezilla, ScorezillaError, createClient } from '../../src/client';
import type { FetchImpl } from '../../src/transport';

const VALID_PUBLIC_KEY = 'pk_testgame_aBcDeFgHiJkLmNoPqR';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function makeClient(fetchImpl: FetchImpl): Scorezilla {
  return new Scorezilla({
    publicKey: VALID_PUBLIC_KEY,
    baseUrl: 'https://api.example.com',
    fetch: fetchImpl,
  });
}

describe('Scorezilla — construction', () => {
  it('exposes the SDK version as a static', () => {
    expect(typeof Scorezilla.version).toBe('string');
    // Build-time-injected — non-empty.
    expect(Scorezilla.version.length).toBeGreaterThan(0);
  });

  it('accepts a valid public-key config', () => {
    expect(() => new Scorezilla({ publicKey: VALID_PUBLIC_KEY })).not.toThrow();
  });

  it('rejects a secret-key config with a clear pointer to v0.2.0', () => {
    expect(
      () =>
        new Scorezilla({
          secretKey: 'sk_live_9493330f-a9e6-4bd6-914f-100f1e51ac36_abc',
        }),
    ).toThrow(/v0\.2\.0.*scorezilla\/server/i);
  });

  it('rejects an invalid publicKey at the validateConfig layer', () => {
    expect(() => new Scorezilla({ publicKey: 'not-a-real-pk' })).toThrow(/publicKey must match/);
  });
});

describe('Scorezilla — auth + UA headers', () => {
  it('attaches Authorization: Bearer <publicKey> on every request', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        offset: 0,
        limit: 100,
        entries: [],
      }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    await sz.getLeaderboard({ boardId: 'b' });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${VALID_PUBLIC_KEY}`);
  });

  it('sets both User-Agent (Node etc) and X-Scorezilla-Client (browser-honored)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        offset: 0,
        limit: 100,
        entries: [],
      }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    await sz.getLeaderboard({ boardId: 'b' });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    // Allow the pre-release `-test` suffix the vitest setup file injects.
    expect(headers['User-Agent']).toMatch(/^scorezilla-js\/[\w.+-]+ \(/);
    expect(headers['X-Scorezilla-Client']).toBe(headers['User-Agent']);
  });

  it('respects a custom userAgent override from config', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        offset: 0,
        limit: 100,
        entries: [],
      }),
    ) as unknown as FetchImpl;
    const sz = new Scorezilla({
      publicKey: VALID_PUBLIC_KEY,
      baseUrl: 'https://api.example.com',
      fetch: fetchImpl,
      userAgent: 'my-game/2.0',
    });
    await sz.getLeaderboard({ boardId: 'b' });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('my-game/2.0');
    expect(headers['X-Scorezilla-Client']).toBe('my-game/2.0');
  });
});

describe('Scorezilla.submitScore', () => {
  it('POSTs to the right URL with playerId + score + metadata in the body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        keyId: 'pk-id',
        rank: 1,
        totalEntries: 1,
        isPersonalBest: true,
      }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    const r = await sz.submitScore({
      boardId: 'board-uuid',
      playerId: 'alice',
      score: 9001,
      metadata: { level: 'hard' },
    });
    expect(r.rank).toBe(1);
    expect(r.isPersonalBest).toBe(true);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/boards/board-uuid/scores');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      playerId: 'alice',
      score: 9001,
      metadata: { level: 'hard' },
    });
  });

  it('omits metadata from the body when not provided', async () => {
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
    const sz = makeClient(fetchImpl);
    await sz.submitScore({ boardId: 'b', playerId: 'alice', score: 100 });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ playerId: 'alice', score: 100 });
  });

  it('URL-encodes the boardId', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'a/b',
        keyId: 'k',
        rank: 1,
        totalEntries: 1,
        isPersonalBest: true,
      }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    await sz.submitScore({ boardId: 'a/b', playerId: 'alice', score: 100 });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/boards/a%2Fb/scores');
  });

  it('attaches Idempotency-Key (POST method)', async () => {
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
    const sz = makeClient(fetchImpl);
    await sz.submitScore({ boardId: 'b', playerId: 'alice', score: 100 });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('throws ScorezillaError on 429 rate_limited and carries retryAfter+layer', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: 'rate_limited', retryAfter: 5, layer: 'L2' },
        { status: 429, headers: { 'Retry-After': '5' } },
      ),
    ) as unknown as FetchImpl;
    // Configure the client with maxRetries: 0 to surface the rate-limit
    // error directly instead of waiting through the retry loop.
    const sz = new Scorezilla({
      publicKey: VALID_PUBLIC_KEY,
      baseUrl: 'https://api.example.com',
      fetch: fetchImpl,
      maxRetries: 0,
    });
    try {
      await sz.submitScore({ boardId: 'b', playerId: 'alice', score: 100 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      const err = e as ScorezillaError;
      expect(err.code).toBe('rate_limited');
      expect(err.retryAfter).toBe(5);
      expect(err.layer).toBe('L2');
      expect(err.isRateLimited()).toBe(true);
      expect(err.isTransient()).toBe(true);
    }
  });

  it('throws ScorezillaError on 422 out_of_bounds and carries reason+bound', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          error: 'out_of_bounds',
          reason: 'above_max',
          bound: 1_000_000,
        },
        { status: 422 },
      ),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    try {
      await sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 9_999_999,
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      const err = e as ScorezillaError;
      expect(err.code).toBe('out_of_bounds');
      expect(err.reason).toBe('above_max');
      expect(err.bound).toBe(1_000_000);
    }
  });
});

describe('Scorezilla — metadata validation', () => {
  // Use a stub fetch that never gets called — validation should fail before transport.
  function clientWithUnusedFetch(): Scorezilla {
    return makeClient(vi.fn() as unknown as FetchImpl);
  }

  it('rejects metadata containing a function', async () => {
    const sz = clientWithUnusedFetch();
    await expect(
      sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 1,
        metadata: { cb: () => 'nope' as string },
      }),
    ).rejects.toThrow(/may not contain functions/);
  });

  it('rejects metadata containing a symbol', async () => {
    const sz = clientWithUnusedFetch();
    await expect(
      sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 1,
        metadata: { s: Symbol('x') } as Record<string, unknown>,
      }),
    ).rejects.toThrow(/may not contain symbols/);
  });

  it('rejects metadata containing a BigInt', async () => {
    const sz = clientWithUnusedFetch();
    await expect(
      sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 1,
        metadata: { n: BigInt(42) } as Record<string, unknown>,
      }),
    ).rejects.toThrow(/may not contain BigInt/);
  });

  it('rejects circular references with a clear message', async () => {
    const sz = clientWithUnusedFetch();
    type Cycle = { self?: Cycle };
    const cycle: Cycle = {};
    cycle.self = cycle;
    await expect(
      sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 1,
        metadata: cycle as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/circular references/);
  });

  it('rejects metadata over the 4 KB UTF-8 byte cap', async () => {
    const sz = clientWithUnusedFetch();
    const huge = 'x'.repeat(METADATA_MAX_BYTES);
    await expect(
      sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 1,
        metadata: { blob: huge },
      }),
    ).rejects.toThrow(/exceeds 4096 bytes/);
  });

  it('counts UTF-8 BYTES, not characters (emoji weigh more)', async () => {
    const sz = clientWithUnusedFetch();
    // 1024 four-byte emoji = 4096 bytes of content + JSON overhead → over cap.
    const emoji = '🦖'.repeat(1024);
    await expect(
      sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 1,
        metadata: { e: emoji },
      }),
    ).rejects.toThrow(/exceeds 4096 bytes/);
  });

  it('accepts metadata just under the cap', async () => {
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
    const sz = makeClient(fetchImpl);
    // Build a payload whose JSON encoding is just under 4 KB.
    const filler = 'x'.repeat(METADATA_MAX_BYTES - 50);
    await expect(
      sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 1,
        metadata: { data: filler },
      }),
    ).resolves.toBeDefined();
  });

  it('rejects array (must be a plain object)', async () => {
    const sz = clientWithUnusedFetch();
    await expect(
      sz.submitScore({
        boardId: 'b',
        playerId: 'alice',
        score: 1,
        metadata: ['a', 'b'] as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/must be a plain object/);
  });
});

describe('Scorezilla.getLeaderboard', () => {
  it('GETs the canonical URL with optional query params', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        offset: 0,
        limit: 25,
        entries: [],
      }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    await sz.getLeaderboard({ boardId: 'b', top: 25 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/boards/b/leaderboard?top=25');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('omits query params when neither top nor offset is provided', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        offset: 0,
        limit: 100,
        entries: [],
      }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    await sz.getLeaderboard({ boardId: 'b' });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/boards/b/leaderboard');
  });
});

describe('Scorezilla.getPlayerRank', () => {
  it('GETs the canonical URL', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        playerId: 'alice',
        rank: 1,
        score: 9001,
        submittedAt: 1,
        totalEntries: 3,
      }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    const r = await sz.getPlayerRank({ boardId: 'b', playerId: 'alice' });
    expect(r.rank).toBe(1);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/boards/b/players/alice/rank');
  });

  it('throws ScorezillaError.code = not_found when the player has no entry', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'not_found' }, { status: 404 }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    await expect(sz.getPlayerRank({ boardId: 'b', playerId: 'noone' })).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});

describe('Scorezilla.getWindowAround', () => {
  it('GETs the canonical URL with before+after params', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        playerId: 'alice',
        before: 2,
        after: 2,
        entries: [],
      }),
    ) as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    await sz.getWindowAround({
      boardId: 'b',
      playerId: 'alice',
      before: 2,
      after: 2,
    });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/boards/b/players/alice/window?before=2&after=2');
  });
});

describe('Scorezilla — playerId-only contract (type-level)', () => {
  it('rejects a `player` alias at compile time (this test passes if it COMPILES)', async () => {
    // Compile-time assertion: the `@ts-expect-error` directive demands that
    // the following call FAILS to typecheck. If a future regression makes
    // `player` accepted as an alias, the directive becomes a lint error.
    const fetchImpl = vi.fn() as unknown as FetchImpl;
    const sz = makeClient(fetchImpl);
    // @ts-expect-error — `player` is not a valid key; SDK accepts `playerId` only
    void (() => sz.submitScore({ boardId: 'b', player: 'alice', score: 1 }));
    expect(true).toBe(true);
  });
});

describe('createClient', () => {
  it('is functionally equivalent to `new Scorezilla(…)`', () => {
    const sz1 = new Scorezilla({ publicKey: VALID_PUBLIC_KEY });
    const sz2 = createClient({ publicKey: VALID_PUBLIC_KEY });
    expect(sz2).toBeInstanceOf(Scorezilla);
    // Both should have the same SDK_VERSION static.
    expect(Scorezilla.version).toBe(sz2.constructor.prototype.constructor.version);
    void sz1;
  });
});
