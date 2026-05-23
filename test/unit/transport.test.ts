/**
 * Unit tests for the HTTP transport.
 *
 * Every test injects a mock fetch (`vi.fn()`) so no real network I/O occurs.
 * Retry delays are zeroed via a stubbed `sleepImpl` so the suite stays fast.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScorezillaError } from '../../src/errors';
import { request, type FetchImpl, __resetDeprecationDedupe } from '../../src/transport';

// A pass-through sleep that yields to the microtask queue but doesn't wait —
// keeps the tests deterministic and instant.
const instantSleep = async (): Promise<void> => Promise.resolve();

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function emptyResponse(init?: ResponseInit): Response {
  return new Response('', init);
}

describe('request — happy path', () => {
  it('GET 200 returns the parsed JSON body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, value: 42 }),
    ) as unknown as FetchImpl;
    const r = await request<{ ok: true; value: number }>({
      baseUrl: 'https://api.example.com',
      path: '/v1/health',
      method: 'GET',
      fetchImpl,
      retry: { sleepImpl: instantSleep },
    });
    expect(r.value).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('POST 200 serializes body, sets Content-Type, attaches Idempotency-Key', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, rank: 1 }),
    ) as unknown as FetchImpl;
    await request({
      baseUrl: 'https://api.example.com',
      path: '/v1/boards/x/scores',
      method: 'POST',
      body: { playerId: 'alice', score: 9001 },
      headers: { Authorization: 'Bearer pk_abc' },
      fetchImpl,
      retry: { sleepImpl: instantSleep },
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer pk_abc');
    expect(headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(JSON.parse(init.body)).toEqual({ playerId: 'alice', score: 9001 });
  });

  it('strips trailing slash from baseUrl before joining path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as unknown as FetchImpl;
    await request({
      baseUrl: 'https://api.example.com/',
      path: '/v1/x',
      method: 'GET',
      fetchImpl,
      retry: { sleepImpl: instantSleep },
    });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/x');
  });

  it('GET does not attach Content-Type or Idempotency-Key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true })) as unknown as FetchImpl;
    await request({
      baseUrl: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      fetchImpl,
      retry: { sleepImpl: instantSleep },
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['Idempotency-Key']).toBeUndefined();
  });
});

describe('request — error mapping (no retry)', () => {
  it('401 → ScorezillaError code=unauthorized', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: 'unauthorized', message: 'Invalid public key' },
        { status: 401 },
      ),
    ) as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      }),
    ).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
      message: 'Invalid public key',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('422 out_of_bounds → carries reason + bound', async () => {
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
    try {
      await request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'POST',
        body: { score: 9999999 },
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
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

  it('reads X-Request-Id off the response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: false, error: 'internal_error' },
        { status: 500, headers: { 'X-Request-Id': 'req-trace-xyz' } },
      ),
    ) as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ requestId: 'req-trace-xyz' });
  });

  it('500 with empty body still produces a typed error', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse({ status: 500 })) as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ code: 'internal_error', status: 500 });
  });
});

describe('request — retry loop', () => {
  it('retries 503 → 503 → 200 and returns success', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) return emptyResponse({ status: 503 });
      return jsonResponse({ ok: true, settled: true });
    }) as unknown as FetchImpl;
    const r = await request<{ ok: true; settled: boolean }>({
      baseUrl: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      fetchImpl,
      retry: { sleepImpl: instantSleep, maxRetries: 2 },
    });
    expect(r.settled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting retries on persistent 503', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse({ status: 503 })) as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 2 },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry 4xx other than 429', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'invalid_input' }, { status: 400 }),
    ) as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'POST',
        body: { x: 1 },
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 5 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 — honors Retry-After header', async () => {
    const sleeps: number[] = [];
    const trackingSleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(
          { ok: false, error: 'rate_limited', retryAfter: 2, layer: 'L2' },
          { status: 429, headers: { 'Retry-After': '2' } },
        );
      }
      return jsonResponse({ ok: true });
    }) as unknown as FetchImpl;
    await request({
      baseUrl: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      fetchImpl,
      retry: { sleepImpl: trackingSleep, maxRetries: 1 },
    });
    expect(sleeps).toEqual([2000]); // Retry-After: 2 seconds
  });

  it('POST retries — same Idempotency-Key on every attempt', async () => {
    const seenKeys: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seenKeys.push(headers['Idempotency-Key']);
      calls++;
      if (calls < 3) return emptyResponse({ status: 503 });
      return jsonResponse({ ok: true });
    }) as unknown as FetchImpl;
    await request({
      baseUrl: 'https://api.example.com',
      path: '/v1/x',
      method: 'POST',
      body: { x: 1 },
      fetchImpl,
      retry: { sleepImpl: instantSleep, maxRetries: 2 },
    });
    expect(seenKeys).toHaveLength(3);
    expect(new Set(seenKeys).size).toBe(1); // same key reused
    expect(seenKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('subsequent POST calls get fresh Idempotency-Keys', async () => {
    const seenKeys: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seenKeys.push(headers['Idempotency-Key']);
      return jsonResponse({ ok: true });
    }) as unknown as FetchImpl;
    for (let i = 0; i < 3; i++) {
      await request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'POST',
        body: { i },
        fetchImpl,
        retry: { sleepImpl: instantSleep },
      });
    }
    expect(new Set(seenKeys).size).toBe(3); // three distinct keys
  });
});

describe('request — network failures', () => {
  it('fetch rejection → ScorezillaError code=network_error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });

  it('retries on a network error then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse({ ok: true });
    }) as unknown as FetchImpl;
    await request({
      baseUrl: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      fetchImpl,
      retry: { sleepImpl: instantSleep, maxRetries: 1 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('request — abort', () => {
  it('rejects with code=aborted when caller signal fires before fetch', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      // fetch should see the aborted signal and throw — real fetch does so;
      // mock it here.
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return jsonResponse({ ok: true });
    }) as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        signal: ctrl.signal,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('request — timeout', () => {
  it('rejects with code=timeout when fetch hangs past timeoutMs', async () => {
    // A realistic fetch mock: rejects with AbortError when its signal fires
    // (this is what every real fetch impl does — node, browsers, Bun, Deno).
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('test bug: no signal'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    ) as unknown as FetchImpl;

    const start = Date.now();
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        timeoutMs: 80, // short — keeps test fast
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      }),
    ).rejects.toMatchObject({ code: 'timeout', status: 0 });

    // Sanity: we actually waited for the timeout to fire (not instant).
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});

describe('request — abort during retry sleep (regression)', () => {
  it('abort during retry pause surfaces as ScorezillaError.aborted, not the raw rejection', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse({ status: 503 })) as unknown as FetchImpl;
    const ctrl = new AbortController();
    const sleepImpl = async (_ms: number, signal?: AbortSignal): Promise<void> => {
      // Simulate caller aborting DURING the inter-attempt sleep.
      ctrl.abort(new Error('mid-retry-abort'));
      throw signal?.reason ?? new Error('mid-retry-abort');
    };
    try {
      await request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        signal: ctrl.signal,
        retry: { sleepImpl, maxRetries: 2 },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      expect((e as ScorezillaError).code).toBe('aborted');
      // The original cause is preserved for debugging.
      expect((e as ScorezillaError).cause).toBeDefined();
    }
  });
});

describe('request — timeoutMs validation', () => {
  it('rejects negative timeoutMs', async () => {
    const fetchImpl = vi.fn() as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        timeoutMs: -1,
        retry: { sleepImpl: instantSleep },
      }),
    ).rejects.toThrow(/timeoutMs must be a positive finite number/);
  });

  it('rejects zero timeoutMs (would fire instantly)', async () => {
    const fetchImpl = vi.fn() as unknown as FetchImpl;
    await expect(
      request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        timeoutMs: 0,
        retry: { sleepImpl: instantSleep },
      }),
    ).rejects.toThrow(/timeoutMs must be a positive finite number/);
  });

  it('rejects NaN / Infinity timeoutMs', async () => {
    const fetchImpl = vi.fn() as unknown as FetchImpl;
    for (const bogus of [NaN, Infinity, -Infinity]) {
      await expect(
        request({
          baseUrl: 'https://api.example.com',
          path: '/v1/x',
          method: 'GET',
          fetchImpl,
          timeoutMs: bogus,
          retry: { sleepImpl: instantSleep },
        }),
      ).rejects.toThrow(/timeoutMs must be a positive finite number/);
    }
  });
});

describe('request — message truncation end-to-end', () => {
  it('a 10 KB error message from the server is truncated to 500 chars in the thrown error', async () => {
    const huge = 'A'.repeat(10_000);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'invalid_input', message: huge }, { status: 400 }),
    ) as unknown as FetchImpl;
    try {
      await request({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'POST',
        body: { x: 1 },
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      const err = e as ScorezillaError;
      expect(err.code).toBe('invalid_input');
      expect(err.message.length).toBe(500);
      expect(err.message).toMatch(/^A+.*\[truncated\]$/);
    }
  });
});

describe('request — fetch availability', () => {
  it('throws a clear error when neither fetchImpl nor globalThis.fetch is available', async () => {
    const original = globalThis.fetch;
    // @ts-expect-error — intentional removal to simulate ancient runtime
    delete globalThis.fetch;
    try {
      await expect(
        request<{ ok: true }>({
          baseUrl: 'https://api.example.com',
          path: '/v1/x',
          method: 'GET',
          retry: { sleepImpl: instantSleep, maxRetries: 0 },
        }),
      ).rejects.toThrow(/globalThis\.fetch is unavailable/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ─── Regression tests for the v0.1.0-next.0 review (issue #14) ─────────────

describe('request — per-attempt signal cleanup (regression)', () => {
  it('removes every abort listener it adds, across multiple retries', async () => {
    // The scenario: a caller passes a long-lived AbortSignal (e.g. tied to
    // a page navigation). The transport adds an abort-listener on every
    // retry attempt. Before the try/finally refactor, an early exit
    // between the fetch and the catch could skip cleanup and leak a
    // listener per attempt — undetectable in normal tests because the next
    // attempt still produces the right behavior, but pathological under
    // thousands of submissions on the same signal.
    const callerCtrl = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const origAdd = callerCtrl.signal.addEventListener.bind(callerCtrl.signal);
    const origRemove = callerCtrl.signal.removeEventListener.bind(callerCtrl.signal);
    callerCtrl.signal.addEventListener = ((
      ...args: Parameters<typeof origAdd>
    ): ReturnType<typeof origAdd> => {
      if (args[0] === 'abort') addCount++;
      return origAdd(...args);
    }) as typeof origAdd;
    callerCtrl.signal.removeEventListener = ((
      ...args: Parameters<typeof origRemove>
    ): ReturnType<typeof origRemove> => {
      if (args[0] === 'abort') removeCount++;
      return origRemove(...args);
    }) as typeof origRemove;

    // Persistent 503 — initial + 2 retries = 3 attempts.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'internal_error' }, { status: 503 }),
    ) as unknown as FetchImpl;

    await expect(
      request<{ ok: true }>({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        signal: callerCtrl.signal,
        retry: { sleepImpl: instantSleep, random: () => 0.5, maxRetries: 2 },
      }),
    ).rejects.toBeInstanceOf(ScorezillaError);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(addCount).toBeGreaterThan(0);
    // Every `addEventListener('abort', …)` on the caller signal must have
    // a matching `removeEventListener('abort', …)`. Off-by-one here would
    // mean we're slowly leaking listeners on long-lived callers.
    expect(removeCount).toBe(addCount);
  });

  it('cleans up the per-attempt signal on the success path', async () => {
    const callerCtrl = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const origAdd = callerCtrl.signal.addEventListener.bind(callerCtrl.signal);
    const origRemove = callerCtrl.signal.removeEventListener.bind(callerCtrl.signal);
    callerCtrl.signal.addEventListener = ((
      ...args: Parameters<typeof origAdd>
    ): ReturnType<typeof origAdd> => {
      if (args[0] === 'abort') addCount++;
      return origAdd(...args);
    }) as typeof origAdd;
    callerCtrl.signal.removeEventListener = ((
      ...args: Parameters<typeof origRemove>
    ): ReturnType<typeof origRemove> => {
      if (args[0] === 'abort') removeCount++;
      return origRemove(...args);
    }) as typeof origRemove;

    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, value: 1 }),
    ) as unknown as FetchImpl;

    await request<{ ok: true; value: number }>({
      baseUrl: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      fetchImpl,
      signal: callerCtrl.signal,
      retry: { sleepImpl: instantSleep },
    });

    expect(removeCount).toBe(addCount);
  });
});

describe('request — invalid_json on contract drift', () => {
  it('throws invalid_json on a non-object 200 (e.g., literal 42)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('42', {
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as FetchImpl;
    try {
      await request<{ ok: true }>({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      const err = e as ScorezillaError;
      expect(err.code).toBe('invalid_json');
      expect(err.message).toMatch(/not a JSON object/);
    }
  });

  it('throws invalid_json on a null 200', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('null', {
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as FetchImpl;
    try {
      await request<{ ok: true }>({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      expect((e as ScorezillaError).code).toBe('invalid_json');
    }
  });

  it('throws invalid_json when 2xx body is missing the `ok: true` discriminator', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: 42 })) as unknown as FetchImpl;
    try {
      await request<{ ok: true; value: number }>({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      const err = e as ScorezillaError;
      expect(err.code).toBe('invalid_json');
      expect(err.message).toMatch(/discriminator/);
    }
  });

  it('throws invalid_json when 2xx body has ok: false (impossible-but-defensive)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'something_wrong' }),
    ) as unknown as FetchImpl;
    try {
      await request<{ ok: true }>({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      expect((e as ScorezillaError).code).toBe('invalid_json');
    }
  });
});

describe('PR R — Sunset / Deprecation header warning', () => {
  // The transport observes RFC 8594 Sunset + IETF Deprecation headers
  // on every 2xx response and logs a once-per-process warning so SDK
  // consumers see deprecation signals during dev without spamming the
  // console in prod loops.

  afterEach(() => {
    __resetDeprecationDedupe();
    vi.restoreAllMocks();
  });

  it('emits a console.warn the FIRST time a Sunset header is observed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: true, value: 1 },
        {
          headers: {
            Deprecation: 'true',
            Sunset: 'Sat, 22 Aug 2026 00:00:00 GMT',
            Link: '<https://docs.scorezilla.dev/upgrade>; rel="deprecation"',
          },
        },
      ),
    ) as unknown as FetchImpl;
    await request<{ ok: true; value: number }>({
      baseUrl: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      fetchImpl,
      retry: { sleepImpl: instantSleep, maxRetries: 0 },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0];
    expect(msg).toContain('Sunset');
    expect(msg).toContain('docs.scorezilla.dev/upgrade');
  });

  it('DOES NOT re-emit on subsequent identical responses (dedupe by signal)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { ok: true, value: 1 },
        { headers: { Deprecation: 'true', Sunset: 'Sat, 22 Aug 2026 00:00:00 GMT' } },
      ),
    ) as unknown as FetchImpl;
    for (let i = 0; i < 5; i++) {
      await request<{ ok: true; value: number }>({
        baseUrl: 'https://api.example.com',
        path: '/v1/x',
        method: 'GET',
        fetchImpl,
        retry: { sleepImpl: instantSleep, maxRetries: 0 },
      });
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when no Sunset/Deprecation header is present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, value: 1 }),
    ) as unknown as FetchImpl;
    await request<{ ok: true; value: number }>({
      baseUrl: 'https://api.example.com',
      path: '/v1/x',
      method: 'GET',
      fetchImpl,
      retry: { sleepImpl: instantSleep, maxRetries: 0 },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
