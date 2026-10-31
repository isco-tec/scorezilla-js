/**
 * URL path builders for the Scorezilla API at `/v1`.
 *
 * Every helper:
 *   • URL-encodes segments via `encodeURIComponent` (boardIds and
 *     playerIds may contain `/`, `#`, `?`, etc.).
 *   • Rejects empty or non-string segments with a thrown `Error` (caller
 *     bug, not an API failure — `ScorezillaError` is reserved for
 *     network-layer outcomes).
 *
 * Each returned path:
 *   • Starts with `/v1/`
 *   • Has no trailing slash
 *   • Includes the query string (if any) joined with `?`
 *
 * The transport's `buildUrl` strips any trailing slash from `baseUrl`
 * before joining, so the two never collide into `//`.
 */

function encodeSegment(value: unknown, label: 'boardId' | 'playerId' | 'gameId'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`scorezilla: ${label} must be a non-empty string`);
  }
  return encodeURIComponent(value);
}

function buildQueryString(params: Record<string, number | string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs.length > 0 ? `?${qs}` : '';
}

/** `POST /v1/boards/:boardId/scores` */
export function submitScorePath(boardId: string): string {
  return `/v1/boards/${encodeSegment(boardId, 'boardId')}/scores`;
}

/** `POST /v1/secure/scores` — the HMAC-signed submission endpoint used by
 *  the `scorezilla/server` adapter. The boardId moves into the request
 *  body rather than the path: every submission here signs over the body
 *  hash, so the API resolves the board from the body and authorizes via
 *  the verified keyId in the Authorization header. */
export function submitScoreSecurePath(): string {
  return '/v1/secure/scores';
}

/** Options for {@link getLeaderboardPath}. */
export interface LeaderboardQuery {
  /** Number of entries to return (the API caps at 1000). Defaults server-side to 100. */
  top?: number;
  /** Offset into the sorted board (the API caps at 1_000_000). Defaults server-side to 0. */
  offset?: number;
  /**
   * UTC day to read, as `YYYY-MM-DD`. **Daily boards only** (`period:
   * 'daily_utc'`). Omit it to read today (UTC) — the server's default.
   * Only today and the 30 days before it are accepted; a malformed, future,
   * or older day — or any `period` on an all-time board — is rejected with
   * `400 invalid_input`. Not validated client-side: the server is authoritative.
   */
  period?: string;
}

/** `GET /v1/boards/:boardId/leaderboard?top=&offset=&period=` */
export function getLeaderboardPath(boardId: string, q?: LeaderboardQuery): string {
  return (
    `/v1/boards/${encodeSegment(boardId, 'boardId')}/leaderboard` +
    buildQueryString({ top: q?.top, offset: q?.offset, period: q?.period })
  );
}

/** Options for {@link getPlayerRankPath}. */
export interface RankQuery {
  /**
   * UTC day to read, as `YYYY-MM-DD`. **Daily boards only** (`period:
   * 'daily_utc'`). Omit it to read today (UTC) — the server's default.
   * Only today and the 30 days before it are accepted; a malformed, future,
   * or older day — or any `period` on an all-time board — is rejected with
   * `400 invalid_input`. Not validated client-side: the server is authoritative.
   */
  period?: string;
}

/** `GET /v1/boards/:boardId/players/:playerId/rank?period=` */
export function getPlayerRankPath(boardId: string, playerId: string, q?: RankQuery): string {
  return (
    `/v1/boards/${encodeSegment(boardId, 'boardId')}/players/${encodeSegment(playerId, 'playerId')}/rank` +
    buildQueryString({ period: q?.period })
  );
}

/** Options for {@link getWindowAroundPath}. */
export interface WindowAroundQuery {
  /** Entries strictly above the player (the API caps at 100). Defaults server-side to 5. */
  before?: number;
  /** Entries strictly below the player (the API caps at 100). Defaults server-side to 5. */
  after?: number;
  /**
   * UTC day to read, as `YYYY-MM-DD`. **Daily boards only** (`period:
   * 'daily_utc'`). Omit it to read today (UTC) — the server's default.
   * Only today and the 30 days before it are accepted; a malformed, future,
   * or older day — or any `period` on an all-time board — is rejected with
   * `400 invalid_input`. Not validated client-side: the server is authoritative.
   */
  period?: string;
}

/** `GET /v1/boards/:boardId/players/:playerId/window?before=&after=&period=` */
export function getWindowAroundPath(
  boardId: string,
  playerId: string,
  q?: WindowAroundQuery,
): string {
  return (
    `/v1/boards/${encodeSegment(boardId, 'boardId')}/players/${encodeSegment(playerId, 'playerId')}/window` +
    buildQueryString({ before: q?.before, after: q?.after, period: q?.period })
  );
}
