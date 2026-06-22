/**
 * Wire types for the Scorezilla API at /v1.
 *
 * Mirrors the documented response shapes. TypeScript's structural typing
 * means additional fields the server adds in a minor release won't break
 * consumers — see VERSIONING.md for the full SemVer contract.
 *
 * No Zod or other runtime validators in v0.1.0 — keeps the bundle small.
 * Narrow untrusted input with the {@link isApiSuccess} / {@link isApiError}
 * type guards exported below.
 */

/**
 * Machine-stable error codes returned by the API.
 *
 * Consumers MUST branch on this `code` rather than the human-readable
 * `message` — message text is English-only and explicitly NOT part of the
 * SemVer contract.
 *
 * The union is intentionally open (`| (string & {})`) so unknown future
 * codes from a server-side minor release don't compile-error against the
 * SDK. The trick preserves autocomplete on the known set while permitting
 * arbitrary strings at runtime — see
 * https://github.com/microsoft/TypeScript/issues/29729 for the pattern.
 *
 * @stable v0.1.0
 */
export type ScorezillaErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'invalid_json'
  | 'out_of_bounds'
  | 'rate_limited'
  | 'conflict'
  | 'internal_error'
  /** 402 Payment Required — tenant exceeded their monthly submission cap, OR
   *  the tenant is `'suspended'` (see {@link UsageCapReason}). The error body
   *  carries `tier`, `cap`, `count`, `period`, `resetsAt`. */
  | 'usage_cap_exceeded'
  /** 402 — the board's tenant is suspended. Returned by the READ paths
   *  (`getLeaderboard` / `getPlayerRank` / `getWindowAround`); the submit path
   *  instead returns `usage_cap_exceeded` with `reason: 'suspended'`. */
  | 'tenant_suspended'
  /** 403 — the player is on this board's denylist (banned by the game owner). */
  | 'player_banned'
  /** 409 — the requested display `name` is already held by a different player. */
  | 'name_taken'
  /** 409 — the board is archived (frozen); writes are rejected. */
  | 'board_archived'
  /** 403 — the board requires a Cloudflare Turnstile token and none was sent. */
  | 'turnstile_required'
  /** 403 — the supplied Turnstile token failed verification. */
  | 'turnstile_failed'
  /** 403 — the Turnstile token was solved on an origin not allowed for this game. */
  | 'turnstile_hostname_mismatch'
  /** 403 — the request Origin is not in the board's embed allowlist. */
  | 'origin_not_allowed'
  | (string & {});

/** Reason sub-classifier on `out_of_bounds` errors. Open union — see {@link ScorezillaErrorCode}. */
export type OutOfBoundsReason = 'below_min' | 'above_max' | (string & {});

/** Reason sub-classifier on `usage_cap_exceeded` errors.
 *  - `'over_cap'`   — tenant hit their tier's monthly submit limit
 *  - `'suspended'`  — tenant's `billing_status` is `'suspended'`; every
 *                     submit is rejected (cap is structurally 0)
 *  Open union for forward compatibility.
 */
export type UsageCapReason = 'over_cap' | 'suspended' | (string & {});

/** Tier identifier mirrored from the server's `PlanConfig.key`. */
export type BillingTier =
  | 'free'
  | 'indie'
  | 'pro'
  | 'studio'
  | 'enterprise'
  | 'suspended'
  | (string & {});

/** Successful API response envelope. The `T` is the per-route payload. */
export type ApiSuccess<T> = { ok: true } & T;

/** Failure response envelope. The server returns this on every non-2xx response. */
export interface ApiError {
  ok: false;
  error: ScorezillaErrorCode;
  /** Human-readable, English only. Not machine-stable — branch on `error` and `reason`. */
  message?: string;
  /** Sub-classifier — used by `out_of_bounds` (`'below_min' | 'above_max'`). */
  reason?: string;
  /** Seconds — present on `rate_limited`. Also mirrored in the HTTP `Retry-After` header. */
  retryAfter?: number;
  /** Which rate-limit layer fired — present on `rate_limited`. */
  layer?: string;
  /** The limit value that was crossed — present on `out_of_bounds`. */
  bound?: number;
  // ── Usage-cap fields (present on `usage_cap_exceeded`) ────────────────
  /** Tenant's tier at the time of rejection. */
  tier?: BillingTier;
  /** The cap value that was crossed (monthly submit limit). `0` for
   *  suspended tenants; `null` is never sent (enterprise has no cap and
   *  can never be over). */
  cap?: number;
  /** The post-increment submit count when the cap was crossed. Always
   *  > `cap` when `reason === 'over_cap'`. */
  count?: number;
  /** The period the count belongs to, in `YYYY-MM` UTC form. */
  period?: string;
  /** ISO-8601 timestamp of midnight UTC on the 1st of the next month —
   *  when the counter resets. Lets clients compute `Retry-After` without
   *  parsing dates server-side. */
  resetsAt?: string;
}

/** Discriminated envelope: every API response is one of these two shapes. */
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

/**
 * A single ranked entry on a leaderboard.
 *
 * Returned as an array on `leaderboard` and `window-around` responses, and
 * inline on `playerRank` (without the `rank` wrapper — see
 * {@link PlayerRankResponse}).
 */
export interface RankedEntry {
  /** 1-based rank. */
  rank: number;
  playerId: string;
  score: number;
  /** Milliseconds since epoch. */
  submittedAt: number;
  metadata?: Record<string, unknown>;
  /** The player's public display name, when they've set one. Absent on older
   *  entries and for players who submit without a name. */
  name?: string;
}

/** Payload from `POST /v1/boards/:boardId/scores`. */
export interface SubmitScoreResponse {
  boardId: string;
  /** The key ID that authorized the submission. Useful for consumer-side audit. */
  keyId: string;
  /** 1-based rank after the submit settled. */
  rank: number;
  totalEntries: number;
  isPersonalBest: boolean;
}

/** Payload from `GET /v1/boards/:boardId/leaderboard`. */
export interface LeaderboardResponse {
  boardId: string;
  offset: number;
  limit: number;
  entries: RankedEntry[];
}

/**
 * Payload from `GET /v1/boards/:boardId/players/:playerId/rank`.
 *
 * Discriminated on `ranked`. "No entry yet" is a normal state, not an error:
 * the API returns `200 { ranked: false }` (not a 404 — a 404 spammed an
 * un-suppressable red console line for every benign "has this player scored?"
 * check). A 404 is now reserved for a genuinely missing board.
 *
 * @example
 * ```ts
 * const r = await sz.getPlayerRank({ boardId, playerId });
 * if (r.ranked) console.log(`Rank ${r.rank} of ${r.totalEntries}`);
 * else console.log('No submission yet.');
 * ```
 */
export type PlayerRankResponse =
  | {
      boardId: string;
      playerId: string;
      ranked: true;
      rank: number;
      score: number;
      submittedAt: number;
      totalEntries: number;
    }
  | {
      boardId: string;
      playerId: string;
      ranked: false;
      rank: null;
      score: null;
    };

/** Payload from `GET /v1/boards/:boardId/players/:playerId/window`. */
export interface WindowAroundResponse {
  boardId: string;
  playerId: string;
  before: number;
  after: number;
  entries: RankedEntry[];
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrows `ApiResponse<T>` to `ApiSuccess<T>`. Use after JSON-parsing a
 * response so the success-path fields become accessible without casts.
 *
 * ```ts
 * const json = (await res.json()) as ApiResponse<LeaderboardResponse>;
 * if (isApiSuccess(json)) {
 *   for (const entry of json.entries) { … }
 * }
 * ```
 */
export function isApiSuccess<T>(r: ApiResponse<T>): r is ApiSuccess<T> {
  return r.ok === true;
}

/**
 * Narrows an arbitrary `unknown` value to `ApiError` — useful when handling
 * a fetch response whose body shape isn't yet known.
 *
 * Checks the discriminator (`ok === false`) AND that `error` is a string,
 * since a malicious or malformed body could otherwise masquerade as an
 * error.
 */
export function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; error?: unknown };
  return v.ok === false && typeof v.error === 'string';
}
