/**
 * Type-level smoke tests for the SDK's wire types.
 *
 * The samples below are realistic response shapes from the documented
 * Scorezilla API. If TypeScript compiles this file, the SDK's types match
 * the API's documented contract.
 *
 * Runtime assertions on the type guards are below the type fixtures —
 * a small belt-and-suspenders pass over the discriminator logic.
 */

import { describe, expect, it } from 'vitest';
import type {
  ApiError,
  ApiResponse,
  ApiSuccess,
  LeaderboardResponse,
  PlayerRankResponse,
  RankedEntry,
  ScorezillaErrorCode,
  SubmitScoreResponse,
  WindowAroundResponse,
} from '../../src/types';
import { isApiError, isApiSuccess } from '../../src/types';

// ─────────────────────────────────────────────────────────────────────────
// Type-level fixtures — the assignments themselves are the test. If the
// shapes drift from the API contract, tsc fails before vitest even runs.
// ─────────────────────────────────────────────────────────────────────────

describe('wire type fixtures (compile-time)', () => {
  it('SubmitScoreResponse — first submission, personal best', () => {
    const sample: ApiSuccess<SubmitScoreResponse> = {
      ok: true,
      boardId: '7f1c-bid-abc',
      keyId: 'pk_testgame_aBcDeFgHiJkLmNoPqR',
      rank: 1,
      totalEntries: 1,
      isPersonalBest: true,
    };
    expect(sample.rank).toBe(1);
  });

  it('SubmitScoreResponse — repeated submit, lower score, no PB', () => {
    const sample: ApiSuccess<SubmitScoreResponse> = {
      ok: true,
      boardId: '7f1c-bid-abc',
      keyId: 'pk_testgame_aBcDeFgHiJkLmNoPqR',
      rank: 1,
      totalEntries: 1,
      isPersonalBest: false,
    };
    expect(sample.isPersonalBest).toBe(false);
  });

  it('LeaderboardResponse — three entries with metadata', () => {
    const sample: ApiSuccess<LeaderboardResponse> = {
      ok: true,
      boardId: '7f1c-bid-abc',
      offset: 0,
      limit: 100,
      entries: [
        {
          rank: 1,
          playerId: 'alice',
          score: 9001,
          submittedAt: 1_700_000_000_000,
        },
        {
          rank: 2,
          playerId: 'bob',
          score: 5000,
          submittedAt: 1_700_000_001_000,
          metadata: { level: 'hard' },
        },
        {
          rank: 3,
          playerId: 'carol',
          score: 100,
          submittedAt: 1_700_000_002_000,
        },
      ],
    };
    expect(sample.entries.map((e: RankedEntry) => e.rank)).toEqual([1, 2, 3]);
  });

  it('PlayerRankResponse', () => {
    const sample: ApiSuccess<PlayerRankResponse> = {
      ok: true,
      boardId: '7f1c-bid-abc',
      playerId: 'alice',
      rank: 1,
      score: 9001,
      submittedAt: 1_700_000_000_000,
      totalEntries: 3,
    };
    expect(sample.totalEntries).toBe(3);
  });

  it('WindowAroundResponse', () => {
    const sample: ApiSuccess<WindowAroundResponse> = {
      ok: true,
      boardId: '7f1c-bid-abc',
      playerId: 'bob',
      before: 1,
      after: 1,
      entries: [
        {
          rank: 1,
          playerId: 'alice',
          score: 9001,
          submittedAt: 1_700_000_000_000,
        },
        {
          rank: 2,
          playerId: 'bob',
          score: 5000,
          submittedAt: 1_700_000_001_000,
        },
        {
          rank: 3,
          playerId: 'carol',
          score: 100,
          submittedAt: 1_700_000_002_000,
        },
      ],
    };
    expect(sample.entries[1]?.playerId).toBe('bob');
  });

  it('ApiError — out_of_bounds with reason + bound', () => {
    const sample: ApiError = {
      ok: false,
      error: 'out_of_bounds',
      reason: 'above_max',
      bound: 1_000_000,
      message: 'Score 9999999 above board limit 1000000',
    };
    expect(sample.bound).toBe(1_000_000);
  });

  it('ApiError — rate_limited with retryAfter + layer', () => {
    const sample: ApiError = {
      ok: false,
      error: 'rate_limited',
      layer: 'L2',
      retryAfter: 30,
      message: 'Rate limit exceeded (L2). Retry after 30s.',
    };
    expect(sample.retryAfter).toBe(30);
  });

  it('ApiError — unauthorized (auth failure)', () => {
    const sample: ApiError = {
      ok: false,
      error: 'unauthorized',
      message: 'Invalid public key',
    };
    expect(sample.error).toBe('unauthorized');
  });

  it('ApiError — open code union accepts unknown future codes', () => {
    // A future server-side minor release could add a new error code; the
    // SDK must accept it at compile time (forward-compat).
    const sample: ApiError = {
      ok: false,
      error: 'maintenance_window' as ScorezillaErrorCode,
      message: 'API is in scheduled maintenance',
    };
    expect(sample.error).toBe('maintenance_window');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Runtime tests on the type guards.
// ─────────────────────────────────────────────────────────────────────────

describe('isApiSuccess', () => {
  it('returns true for a success envelope', () => {
    const r: ApiResponse<{ x: number }> = { ok: true, x: 1 };
    expect(isApiSuccess(r)).toBe(true);
  });

  it('returns false for an error envelope', () => {
    const r: ApiResponse<{ x: number }> = { ok: false, error: 'not_found' };
    expect(isApiSuccess(r)).toBe(false);
  });

  it('narrows to ApiSuccess<T> in the true branch', () => {
    const r: ApiResponse<{ value: string }> = { ok: true, value: 'hello' };
    if (isApiSuccess(r)) {
      // If this typechecks, the guard is doing its job.
      const v: string = r.value;
      expect(v).toBe('hello');
    }
  });
});

describe('isApiError', () => {
  it('returns true for a well-formed error envelope', () => {
    expect(isApiError({ ok: false, error: 'not_found' })).toBe(true);
  });

  it('returns true even with extra unknown fields (forward-compat)', () => {
    expect(
      isApiError({
        ok: false,
        error: 'maintenance_window',
        scheduledEnd: '2026-06-01T00:00:00Z',
      }),
    ).toBe(true);
  });

  it('returns false for a success envelope', () => {
    expect(isApiError({ ok: true, value: 'hi' })).toBe(false);
  });

  it('returns false for null / undefined / primitive', () => {
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError('not an object')).toBe(false);
    expect(isApiError(42)).toBe(false);
  });

  it('returns false when `error` is not a string', () => {
    // Malicious or malformed body — guard must reject so consumers don't
    // index into a non-string `code`.
    expect(isApiError({ ok: false, error: 42 })).toBe(false);
    expect(isApiError({ ok: false, error: null })).toBe(false);
    expect(isApiError({ ok: false })).toBe(false);
  });

  it('returns false when `ok` is missing', () => {
    expect(isApiError({ error: 'not_found' })).toBe(false);
  });
});
