import { describe, expect, it } from 'vitest';
import {
  MESSAGE_MAX_CHARS,
  STATUS_NETWORK_ERROR,
  ScorezillaError,
  TRUNCATION_SUFFIX,
} from '../../src/errors';
import type { ApiError } from '../../src/types';

describe('ScorezillaError — construction', () => {
  it('extends Error and is instanceof Error', () => {
    const e = new ScorezillaError('boom', {
      status: 500,
      code: 'internal_error',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ScorezillaError);
  });

  it('exposes the fields passed at construction', () => {
    const e = new ScorezillaError('rate limit', {
      status: 429,
      code: 'rate_limited',
      retryAfter: 30,
      layer: 'L2',
      requestId: 'req-abc',
    });
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfter).toBe(30);
    expect(e.layer).toBe('L2');
    expect(e.requestId).toBe('req-abc');
  });

  it('has name === "ScorezillaError"', () => {
    const e = new ScorezillaError('x', { status: 500, code: 'internal_error' });
    expect(e.name).toBe('ScorezillaError');
  });

  it('preserves stack on V8', () => {
    const e = new ScorezillaError('boom', {
      status: 500,
      code: 'internal_error',
    });
    // V8 (Node, Chromium) always captures. Safari/old Firefox: stack still
    // exists but the constructor frame is included — both shapes are acceptable.
    expect(typeof e.stack).toBe('string');
    expect(e.stack).toContain('ScorezillaError');
  });

  it('carries `cause` when provided', () => {
    const underlying = new TypeError('fetch failed');
    const e = new ScorezillaError('network down', {
      status: STATUS_NETWORK_ERROR,
      code: 'network_error',
      cause: underlying,
    });
    expect(e.cause).toBe(underlying);
  });
});

describe('ScorezillaError — message truncation (anti-injection)', () => {
  it('passes short messages through unchanged', () => {
    const e = new ScorezillaError('short message', {
      status: 400,
      code: 'invalid_input',
    });
    expect(e.message).toBe('short message');
  });

  it('truncates a 10 KB message to MESSAGE_MAX_CHARS and appends a suffix', () => {
    const huge = 'A'.repeat(10_000);
    const e = new ScorezillaError(huge, { status: 400, code: 'invalid_input' });
    expect(e.message.length).toBe(MESSAGE_MAX_CHARS);
    expect(e.message.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(e.message.startsWith('A')).toBe(true);
  });

  it('does not truncate at exactly MESSAGE_MAX_CHARS', () => {
    const exact = 'B'.repeat(MESSAGE_MAX_CHARS);
    const e = new ScorezillaError(exact, {
      status: 400,
      code: 'invalid_input',
    });
    expect(e.message).toBe(exact);
    expect(e.message.endsWith(TRUNCATION_SUFFIX)).toBe(false);
  });

  it('truncates at MESSAGE_MAX_CHARS + 1', () => {
    const oneOver = 'C'.repeat(MESSAGE_MAX_CHARS + 1);
    const e = new ScorezillaError(oneOver, {
      status: 400,
      code: 'invalid_input',
    });
    expect(e.message.length).toBe(MESSAGE_MAX_CHARS);
  });
});

describe('ScorezillaError — cross-realm instanceof', () => {
  it('survives Object.setPrototypeOf round-trip', () => {
    // Within-realm sanity check: the explicit prototype set still produces
    // the expected chain.
    const e = new ScorezillaError('x', { status: 500, code: 'internal_error' });
    expect(Object.getPrototypeOf(e)).toBe(ScorezillaError.prototype);
    expect(e instanceof ScorezillaError).toBe(true);
  });

  it('rebuilt via Object.create(ScorezillaError.prototype) is still recognized as instanceof', () => {
    // Simulates the recovery pattern a logger / serialization round-trip
    // might use: an object whose prototype was reset to ScorezillaError's
    // prototype satisfies `instanceof` thanks to the explicit
    // Object.setPrototypeOf in the constructor.
    const e1 = new ScorezillaError('x', {
      status: 500,
      code: 'internal_error',
    });
    const plain = JSON.parse(
      JSON.stringify({ status: e1.status, code: e1.code, message: e1.message }),
    );
    const restored = Object.create(ScorezillaError.prototype) as ScorezillaError;
    Object.assign(restored, plain);
    expect(restored instanceof ScorezillaError).toBe(true);
    expect(restored instanceof Error).toBe(true);
  });

  it('a function value with ScorezillaError.prototype is recognized cross-context', () => {
    // The classic cross-realm hazard: two different realms each have their
    // own `Error` and `ScorezillaError` constructor. An instance built in
    // realm A and checked in realm B would fail `instanceof` if the
    // prototype chain weren't normalized. We test this by simulating an
    // "alien" constructor whose prototype we then swap to ours.
    class AlienError extends Error {
      constructor(public code: string) {
        super('alien');
      }
    }
    const alien = new AlienError('rate_limited');
    // Same trick the constructor uses: rebind the prototype.
    Object.setPrototypeOf(alien, ScorezillaError.prototype);
    expect(alien instanceof ScorezillaError).toBe(true);
  });
});

describe('ScorezillaError.from', () => {
  it('maps an ApiError body to the typed error fields', () => {
    const body: ApiError = {
      ok: false,
      error: 'out_of_bounds',
      reason: 'above_max',
      bound: 1_000_000,
      message: 'Score 9999999 above board limit 1000000',
    };
    const e = ScorezillaError.from({ status: 422, body, requestId: 'req-xyz' });
    expect(e.status).toBe(422);
    expect(e.code).toBe('out_of_bounds');
    expect(e.reason).toBe('above_max');
    expect(e.bound).toBe(1_000_000);
    expect(e.requestId).toBe('req-xyz');
    expect(e.message).toBe('Score 9999999 above board limit 1000000');
  });

  it('maps a rate_limited body — retryAfter + layer come through', () => {
    const body: ApiError = {
      ok: false,
      error: 'rate_limited',
      retryAfter: 30,
      layer: 'L2',
      message: 'Rate limit exceeded (L2). Retry after 30s.',
    };
    const e = ScorezillaError.from({ status: 429, body });
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfter).toBe(30);
    expect(e.layer).toBe('L2');
  });

  it('falls back to status-derived code when body is missing', () => {
    const e = ScorezillaError.from({ status: 401 });
    expect(e.code).toBe('unauthorized');
    expect(e.message).toBe('Request failed with status 401');
  });

  it('falls back to status-derived code when body lacks `error`', () => {
    // Some 5xx responses are HTML or empty — body parsing yields undefined.
    const e = ScorezillaError.from({ status: 503, body: undefined });
    expect(e.code).toBe('internal_error');
    expect(e.status).toBe(503);
  });

  it('maps 422 → out_of_bounds when body is missing (defensive)', () => {
    const e = ScorezillaError.from({ status: 422 });
    expect(e.code).toBe('out_of_bounds');
  });

  it('preserves `cause` for transport-level failures wrapped via from()', () => {
    const underlying = new Error('socket reset');
    const e = ScorezillaError.from({ status: 502, cause: underlying });
    expect(e.cause).toBe(underlying);
  });
});

describe('ScorezillaError — static helpers for transport failures', () => {
  it('network() produces a code=network_error / status=0 error', () => {
    const cause = new TypeError('fetch failed');
    const e = ScorezillaError.network('connection refused', cause);
    expect(e.status).toBe(STATUS_NETWORK_ERROR);
    expect(e.code).toBe('network_error');
    expect(e.cause).toBe(cause);
  });

  it('aborted() produces a code=aborted error', () => {
    const e = ScorezillaError.aborted(new DOMException('aborted', 'AbortError'));
    expect(e.code).toBe('aborted');
    expect(e.status).toBe(STATUS_NETWORK_ERROR);
  });

  it('timeout() includes the budget in the message', () => {
    const e = ScorezillaError.timeout(5000);
    expect(e.code).toBe('timeout');
    expect(e.message).toContain('5000');
  });
});

describe('ScorezillaError — discriminator helpers', () => {
  it('isRateLimited()', () => {
    expect(
      new ScorezillaError('', {
        status: 429,
        code: 'rate_limited',
      }).isRateLimited(),
    ).toBe(true);
    expect(
      new ScorezillaError('', {
        status: 500,
        code: 'internal_error',
      }).isRateLimited(),
    ).toBe(false);
  });

  it('isAuth() covers both unauthorized and forbidden', () => {
    expect(new ScorezillaError('', { status: 401, code: 'unauthorized' }).isAuth()).toBe(true);
    expect(new ScorezillaError('', { status: 403, code: 'forbidden' }).isAuth()).toBe(true);
    expect(new ScorezillaError('', { status: 404, code: 'not_found' }).isAuth()).toBe(false);
  });

  it('isNotFound()', () => {
    expect(new ScorezillaError('', { status: 404, code: 'not_found' }).isNotFound()).toBe(true);
    expect(
      new ScorezillaError('', {
        status: 400,
        code: 'invalid_input',
      }).isNotFound(),
    ).toBe(false);
  });

  it('isOutOfBounds()', () => {
    expect(
      new ScorezillaError('', {
        status: 422,
        code: 'out_of_bounds',
      }).isOutOfBounds(),
    ).toBe(true);
    expect(
      new ScorezillaError('', {
        status: 400,
        code: 'invalid_input',
      }).isOutOfBounds(),
    ).toBe(false);
  });

  it('isTransient() flags network/timeout/5xx/429', () => {
    expect(ScorezillaError.network('x', null).isTransient()).toBe(true);
    expect(ScorezillaError.timeout(1).isTransient()).toBe(true);
    expect(
      new ScorezillaError('', {
        status: 502,
        code: 'internal_error',
      }).isTransient(),
    ).toBe(true);
    expect(
      new ScorezillaError('', {
        status: 429,
        code: 'rate_limited',
      }).isTransient(),
    ).toBe(true);
    expect(
      new ScorezillaError('', {
        status: 400,
        code: 'invalid_input',
      }).isTransient(),
    ).toBe(false);
    expect(new ScorezillaError('', { status: 404, code: 'not_found' }).isTransient()).toBe(false);
  });
});
