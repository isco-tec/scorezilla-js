import { describe, expect, it } from 'vitest';
import {
  getLeaderboardPath,
  getPlayerRankPath,
  getWindowAroundPath,
  submitScorePath,
} from '../../src/paths';

describe('submitScorePath', () => {
  it('builds the canonical route', () => {
    expect(submitScorePath('board-abc')).toBe('/v1/boards/board-abc/scores');
  });

  it('URL-encodes special characters', () => {
    expect(submitScorePath('a/b?c')).toBe('/v1/boards/a%2Fb%3Fc/scores');
  });

  it('rejects empty boardId', () => {
    expect(() => submitScorePath('')).toThrow(/boardId must be a non-empty string/);
  });

  it('rejects non-string boardId', () => {
    // @ts-expect-error — undefined isn't a valid boardId
    expect(() => submitScorePath(undefined)).toThrow(/boardId must be a non-empty string/);
    // @ts-expect-error — null isn't a valid boardId
    expect(() => submitScorePath(null)).toThrow(/boardId must be a non-empty string/);
    // @ts-expect-error — number isn't a valid boardId
    expect(() => submitScorePath(123)).toThrow(/boardId must be a non-empty string/);
  });
});

describe('getLeaderboardPath', () => {
  it('omits the query string when no params are passed', () => {
    expect(getLeaderboardPath('bid')).toBe('/v1/boards/bid/leaderboard');
  });

  it('serializes only the provided params (defaults stay on the server)', () => {
    expect(getLeaderboardPath('bid', { top: 50 })).toBe('/v1/boards/bid/leaderboard?top=50');
    expect(getLeaderboardPath('bid', { offset: 100 })).toBe(
      '/v1/boards/bid/leaderboard?offset=100',
    );
    expect(getLeaderboardPath('bid', { top: 50, offset: 100 })).toBe(
      '/v1/boards/bid/leaderboard?top=50&offset=100',
    );
  });

  it('encodes the boardId', () => {
    expect(getLeaderboardPath('a b')).toBe('/v1/boards/a%20b/leaderboard');
  });
});

describe('getPlayerRankPath', () => {
  it('builds the canonical route', () => {
    expect(getPlayerRankPath('bid', 'alice')).toBe('/v1/boards/bid/players/alice/rank');
  });

  it('URL-encodes both segments independently', () => {
    expect(getPlayerRankPath('a/b', 'c?d')).toBe('/v1/boards/a%2Fb/players/c%3Fd/rank');
  });

  it('rejects empty playerId', () => {
    expect(() => getPlayerRankPath('bid', '')).toThrow(/playerId must be a non-empty string/);
  });
});

describe('getWindowAroundPath', () => {
  it('omits the query string by default', () => {
    expect(getWindowAroundPath('bid', 'alice')).toBe('/v1/boards/bid/players/alice/window');
  });

  it('serializes before+after when provided', () => {
    expect(getWindowAroundPath('bid', 'alice', { before: 3, after: 7 })).toBe(
      '/v1/boards/bid/players/alice/window?before=3&after=7',
    );
  });

  it('allows zero as an explicit value', () => {
    expect(getWindowAroundPath('bid', 'alice', { before: 0 })).toBe(
      '/v1/boards/bid/players/alice/window?before=0',
    );
  });

  it('rejects empty playerId', () => {
    expect(() => getWindowAroundPath('bid', '')).toThrow(/playerId must be a non-empty string/);
  });
});

describe('period (daily boards)', () => {
  it('getLeaderboardPath serializes period alone', () => {
    expect(getLeaderboardPath('bid', { period: '2026-10-30' })).toBe(
      '/v1/boards/bid/leaderboard?period=2026-10-30',
    );
  });

  it('getLeaderboardPath combines period with top + offset', () => {
    expect(getLeaderboardPath('bid', { top: 10, offset: 20, period: '2026-10-30' })).toBe(
      '/v1/boards/bid/leaderboard?top=10&offset=20&period=2026-10-30',
    );
  });

  it('getLeaderboardPath omits period when undefined', () => {
    expect(getLeaderboardPath('bid', { top: 10, period: undefined })).toBe(
      '/v1/boards/bid/leaderboard?top=10',
    );
  });

  it('getPlayerRankPath keeps the 2-arg form unchanged', () => {
    expect(getPlayerRankPath('bid', 'alice', {})).toBe('/v1/boards/bid/players/alice/rank');
    expect(getPlayerRankPath('bid', 'alice', { period: undefined })).toBe(
      '/v1/boards/bid/players/alice/rank',
    );
  });

  it('getPlayerRankPath serializes period', () => {
    expect(getPlayerRankPath('bid', 'alice', { period: '2026-10-30' })).toBe(
      '/v1/boards/bid/players/alice/rank?period=2026-10-30',
    );
  });

  it('getWindowAroundPath serializes period alone and with before + after', () => {
    expect(getWindowAroundPath('bid', 'alice', { period: '2026-10-30' })).toBe(
      '/v1/boards/bid/players/alice/window?period=2026-10-30',
    );
    expect(getWindowAroundPath('bid', 'alice', { before: 2, after: 3, period: '2026-10-30' })).toBe(
      '/v1/boards/bid/players/alice/window?before=2&after=3&period=2026-10-30',
    );
  });

  it('URL-encodes period (no client-side format validation — server is authoritative)', () => {
    expect(getLeaderboardPath('bid', { period: '2026/10 30&x=1' })).toBe(
      '/v1/boards/bid/leaderboard?period=2026%2F10+30%26x%3D1',
    );
    expect(getPlayerRankPath('bid', 'alice', { period: 'a&b' })).toBe(
      '/v1/boards/bid/players/alice/rank?period=a%26b',
    );
  });
});
