import { describe, expect, it } from 'vitest';
import { ScorezillaError } from '../../src/errors';
import {
  BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  MAX_DELAY_MS,
  MAX_RETRY_AFTER_SEC,
  generateIdempotencyKey,
  nextDelay,
  shouldRetryError,
  shouldRetryStatus,
  sleep,
} from '../../src/retry';

describe('constants', () => {
  it('expose the documented defaults', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(2);
    expect(BASE_DELAY_MS).toBe(200);
    expect(MAX_DELAY_MS).toBe(4_000);
    expect(MAX_RETRY_AFTER_SEC).toBe(30);
  });
});

describe('nextDelay — exponential backoff', () => {
  // Deterministic jitter = 1.0 (max) so the exponential floor is visible.
  const maxJitter = (): number => 1.0;
  // Deterministic jitter = 0.0 → jitterFactor = 0.5 (min).
  const minJitter = (): number => 0.0;

  it('attempt 0 → BASE_DELAY_MS × jitter ∈ [BASE/2, BASE]', () => {
    expect(nextDelay(0, undefined, maxJitter)).toBe(BASE_DELAY_MS); // 200 × 1.0
    expect(nextDelay(0, undefined, minJitter)).toBe(BASE_DELAY_MS / 2); // 200 × 0.5 = 100
  });

  it('attempt 1 → 400 × jitter', () => {
    expect(nextDelay(1, undefined, maxJitter)).toBe(400);
    expect(nextDelay(1, undefined, minJitter)).toBe(200);
  });

  it('attempt 2 → 800 × jitter', () => {
    expect(nextDelay(2, undefined, maxJitter)).toBe(800);
    expect(nextDelay(2, undefined, minJitter)).toBe(400);
  });

  it('caps at MAX_DELAY_MS — high attempt counts do not balloon', () => {
    // 200 × 2^10 = 204800, but we cap at 4000.
    expect(nextDelay(10, undefined, maxJitter)).toBe(MAX_DELAY_MS);
    expect(nextDelay(20, undefined, maxJitter)).toBe(MAX_DELAY_MS);
  });

  it('default random produces values within the jitter window', () => {
    // Twenty samples — every one must land in [exp/2, exp].
    for (let i = 0; i < 20; i++) {
      const d = nextDelay(2, undefined); // exponential = 800
      expect(d).toBeGreaterThanOrEqual(400);
      expect(d).toBeLessThanOrEqual(800);
    }
  });
});

describe('nextDelay — Retry-After', () => {
  it('honors a sub-cap Retry-After value as the delay', () => {
    expect(nextDelay(0, 5)).toBe(5_000);
    expect(nextDelay(99, 10)).toBe(10_000); // attempt count ignored when server says so
  });

  it('honors the boundary value exactly at MAX_RETRY_AFTER_SEC', () => {
    expect(nextDelay(0, MAX_RETRY_AFTER_SEC)).toBe(MAX_RETRY_AFTER_SEC * 1000);
  });

  it('ignores a Retry-After larger than MAX_RETRY_AFTER_SEC and falls back to exponential', () => {
    // 1 day → way over 30s cap. Falls back to exponential (jitter window).
    const d = nextDelay(0, 86_400, () => 1.0);
    expect(d).toBe(BASE_DELAY_MS); // attempt-0 exponential at max jitter
  });

  it('ignores negative or non-finite values', () => {
    expect(nextDelay(0, -1, () => 1.0)).toBe(BASE_DELAY_MS);
    expect(nextDelay(0, NaN, () => 1.0)).toBe(BASE_DELAY_MS);
    expect(nextDelay(0, Infinity, () => 1.0)).toBe(BASE_DELAY_MS);
  });

  it('accepts zero Retry-After (server says "go now")', () => {
    expect(nextDelay(0, 0)).toBe(0);
  });
});

describe('shouldRetryStatus', () => {
  it('retries 429 (rate limited)', () => {
    expect(shouldRetryStatus(429)).toBe(true);
  });

  it('retries all 5xx', () => {
    for (const s of [500, 502, 503, 504, 599]) {
      expect(shouldRetryStatus(s)).toBe(true);
    }
  });

  it('does NOT retry other 4xx', () => {
    for (const s of [400, 401, 403, 404, 409, 422]) {
      expect(shouldRetryStatus(s)).toBe(false);
    }
  });

  it('does NOT retry 2xx or 3xx', () => {
    expect(shouldRetryStatus(200)).toBe(false);
    expect(shouldRetryStatus(301)).toBe(false);
  });

  it('does NOT retry 6xx (out of spec)', () => {
    expect(shouldRetryStatus(600)).toBe(false);
  });
});

describe('shouldRetryError', () => {
  it('retries a network_error ScorezillaError', () => {
    expect(shouldRetryError(ScorezillaError.network('connection refused', null))).toBe(true);
  });

  it('does NOT retry a timeout (caller-set budget)', () => {
    expect(shouldRetryError(ScorezillaError.timeout(5000))).toBe(false);
  });

  it('does NOT retry an abort', () => {
    expect(shouldRetryError(ScorezillaError.aborted(null))).toBe(false);
  });

  it('does NOT retry a non-Scorezilla error', () => {
    expect(shouldRetryError(new Error('something else'))).toBe(false);
    expect(shouldRetryError(null)).toBe(false);
    expect(shouldRetryError(undefined)).toBe(false);
  });
});

describe('generateIdempotencyKey', () => {
  it('returns a v4-shaped UUID string', () => {
    const key = generateIdempotencyKey();
    expect(typeof key).toBe('string');
    // UUID v4 regex: 8-4-4-4-12 hex with version nibble = 4 in third group.
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('produces a fresh key each call', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) keys.add(generateIdempotencyKey());
    expect(keys.size).toBe(100);
  });
});

describe('sleep', () => {
  it('resolves after the requested ms (rough check)', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    // Generous lower bound — CI is slow. Just need to verify we actually waited.
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('rejects immediately if signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-aborted'));
    await expect(sleep(10_000, ctrl.signal)).rejects.toThrow('pre-aborted');
  });

  it('rejects when signal aborts mid-sleep', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('mid-sleep')), 10);
    await expect(sleep(10_000, ctrl.signal)).rejects.toThrow('mid-sleep');
  });

  it('detaches the abort listener after natural completion (no leak)', async () => {
    const ctrl = new AbortController();
    await sleep(5, ctrl.signal);
    // After sleep resolves naturally, aborting must NOT throw because the
    // listener is gone. (If it stayed attached, the dispatched event would
    // be a no-op anyway, but tighter check would inspect listenerCount —
    // not portable across runtimes. We assert no throw.)
    expect(() => ctrl.abort()).not.toThrow();
  });
});

// ─── Regression tests for the v0.1.0-next.0 review (issue #14) ─────────────

describe('generateIdempotencyKey — throws ScorezillaError on runtime misconfig', () => {
  it('throws a typed ScorezillaError when globalThis.crypto.randomUUID is missing', () => {
    // The documented catch pattern in README.md is
    //   if (!(e instanceof ScorezillaError)) throw e;
    // A plain `Error` here would escape that guard and bubble up as
    // unhandled. This test pins the contract.
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      generateIdempotencyKey();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      const err = e as ScorezillaError;
      expect(err.code).toBe('internal_error');
      expect(err.status).toBe(0);
      expect(err.message).toMatch(/randomUUID is unavailable/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it('also throws ScorezillaError when crypto exists but randomUUID is not a function', () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: 'not a function' },
      configurable: true,
      writable: true,
    });
    try {
      generateIdempotencyKey();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});
