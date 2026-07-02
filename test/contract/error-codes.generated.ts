// GENERATED — DO NOT EDIT BY HAND.
// Vendored verbatim from the Scorezilla monorepo source of truth: apps/api/src/public-error-codes.ts
// Regenerate via the cross-repo contract-sync (or `node scripts/sync-contract.mjs`
// in the monorepo). The drift guard in this repo recomputes source-sha256 below
// and fails if this file was edited by hand or drifted from the SoT.
// source-sha256: 7928946729e4e677d1d6a51b5cedb648636546ab1cded490fb758f4aafb78835

/**
 * Canonical registry of PUBLIC-CLIENT error codes (#407).
 *
 * The `error` value an external client can receive from the public endpoints —
 * the public-key submit (`POST /v1/boards/:id/scores`), the HMAC / `sk_live_`
 * secure-submit + moderation routes, leaderboard read / player rank / window,
 * and the unauthenticated public board-metadata route. This module is the
 * SINGLE SOURCE OF TRUTH that the downstream mirrors must track:
 *   - the SDK `ScorezillaErrorCode` union (`scorezilla-js/src/types.ts`),
 *   - the MCP scaffold + the SDK `API.md` / marketing docs error tables.
 *
 * Adding a code here is the conscious registration step. The drift guard in
 * `test/public-error-codes.test.ts` fails the build if a public route emits a
 * code that isn't registered — so a new public error code can't ship
 * un-mirrored (the failure mode #407 was filed to kill: three codes drifted
 * silently before this existed).
 *
 * EXCLUDES admin (`INTERNAL_SHARED_SECRET`) and MCP error codes — those are
 * separate, non-public contracts with their own consumers.
 *
 * Subset note: `invalid_idempotency_key` is a public API code but is NOT
 * currently reachable through the official SDK (it auto-generates valid
 * Idempotency-Keys and exposes no custom-key option), so the SDK union
 * legitimately omits it. The SDK mirrors the client-reachable SUBSET of this
 * registry — this list is the API's complete public surface.
 */

/** The canonical, ordered public-client error codes. THE source of truth. */
export const PUBLIC_ERROR_CODES = [
  'unauthorized', // 401
  'invalid_idempotency_key', // 400 — public API; not SDK-reachable (see header)
  'invalid_json', // 400
  'invalid_input', // 400
  'usage_cap_exceeded', // 402
  'tenant_suspended', // 402 — read paths
  'forbidden', // 403
  'origin_not_allowed', // 403
  'player_banned', // 403
  'turnstile_required', // 403 — emitted via `error: reason` (a variable)
  'turnstile_failed', // 403 — emitted via `error: reason`
  'turnstile_hostname_mismatch', // 403 — emitted via `error: reason`
  'not_found', // 404
  'board_archived', // 409
  'name_taken', // 409
  'out_of_bounds', // 422
  'rate_limited', // 429
  'internal_error', // 500 — global onError catch-all
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

/** Typed as `string` membership so the scan guard can test raw scanned tokens. */
export const PUBLIC_ERROR_CODE_SET: ReadonlySet<string> = new Set(PUBLIC_ERROR_CODES);

/**
 * The HTTP statuses the public surface actually uses. Declared locally (this
 * file must stay import-free for the vendor-verbatim sync) so the map below is
 * COMPILE-checked — a typo'd `999` no longer type-checks and then explodes at
 * runtime behind `publicError`'s status cast.
 */
export type PublicErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500;

/** HTTP status each code is returned with — docs + the SDK error table mirror this. */
export const PUBLIC_ERROR_CODE_STATUS: Record<PublicErrorCode, PublicErrorStatus> = {
  unauthorized: 401,
  invalid_idempotency_key: 400,
  invalid_json: 400,
  invalid_input: 400,
  usage_cap_exceeded: 402,
  tenant_suspended: 402,
  forbidden: 403,
  origin_not_allowed: 403,
  player_banned: 403,
  turnstile_required: 403,
  turnstile_failed: 403,
  turnstile_hostname_mismatch: 403,
  not_found: 404,
  board_archived: 409,
  name_taken: 409,
  out_of_bounds: 422,
  rate_limited: 429,
  internal_error: 500,
};

/**
 * Turnstile reasons — the submit gate emits these via `error: reason` (a
 * variable, not a string literal), so the scan guard cannot see them. This
 * const is the runtime source of truth; `TurnstileReason` in `submit-core`
 * derives from it. The `satisfies` clause proves at compile time that every
 * reason is a registered `PublicErrorCode` — a 4th unregistered reason fails
 * the build right here, not at runtime.
 */
export const TURNSTILE_REASONS = [
  'turnstile_required',
  'turnstile_failed',
  'turnstile_hostname_mismatch',
] as const satisfies readonly PublicErrorCode[];
