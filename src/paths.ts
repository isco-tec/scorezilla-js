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

function buildQueryString(params: Record<string, number | undefined>): string {
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

/** Options for {@link getLeaderboardPath}. */
export interface LeaderboardQuery {
  /** Number of entries to return (the API caps at 1000). Defaults server-side to 100. */
  top?: number;
  /** Offset into the sorted board (the API caps at 1_000_000). Defaults server-side to 0. */
  offset?: number;
}

/** `GET /v1/boards/:boardId/leaderboard?top=&offset=` */
export function getLeaderboardPath(boardId: string, q?: LeaderboardQuery): string {
  return (
    `/v1/boards/${encodeSegment(boardId, 'boardId')}/leaderboard` +
    buildQueryString({ top: q?.top, offset: q?.offset })
  );
}

/** `GET /v1/boards/:boardId/players/:playerId/rank` */
export function getPlayerRankPath(boardId: string, playerId: string): string {
  return `/v1/boards/${encodeSegment(boardId, 'boardId')}/players/${encodeSegment(playerId, 'playerId')}/rank`;
}

/** Options for {@link getWindowAroundPath}. */
export interface WindowAroundQuery {
  /** Entries strictly above the player (the API caps at 100). Defaults server-side to 5. */
  before?: number;
  /** Entries strictly below the player (the API caps at 100). Defaults server-side to 5. */
  after?: number;
}

/** `GET /v1/boards/:boardId/players/:playerId/window?before=&after=` */
export function getWindowAroundPath(
  boardId: string,
  playerId: string,
  q?: WindowAroundQuery,
): string {
  return (
    `/v1/boards/${encodeSegment(boardId, 'boardId')}/players/${encodeSegment(playerId, 'playerId')}/window` +
    buildQueryString({ before: q?.before, after: q?.after })
  );
}
