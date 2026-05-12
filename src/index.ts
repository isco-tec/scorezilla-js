/**
 * Scorezilla SDK — public entry.
 *
 * Surface (v0.1.0):
 *   • `Scorezilla` — public-key client (browser + Node ≥ 20 + Workers + Bun + Deno)
 *   • `createClient` — convenience factory
 *   • `ScorezillaError` — the single error type the SDK throws
 *   • `SDK_VERSION` — exported for support / bug-reporting
 *   • All wire types — `SubmitScoreResponse`, `LeaderboardResponse`, etc.
 *   • All input types — `SubmitScoreInput`, `GetLeaderboardInput`, etc.
 *   • Config types — `ScorezillaConfig`, `PublicKeyConfig`, `SecretKeyConfig`
 *
 * The HMAC server-side client (`scorezilla/server`), React adapter
 * (`scorezilla/react`), and Phaser plugin (`scorezilla/phaser`) ship in
 * later minor releases — see CHANGELOG.md.
 */

// Re-export the class + convenience factory + error type.
export { createClient, Scorezilla, ScorezillaError } from './client';

// Re-export public input types.
export type {
  GetLeaderboardInput,
  GetPlayerRankInput,
  GetWindowAroundInput,
  SubmitScoreInput,
} from './client';

// Re-export config types so consumers can typed-store the config object.
export type { BaseConfig, PublicKeyConfig, ScorezillaConfig, SecretKeyConfig } from './config';

// Re-export wire types — consumers ARE the API contract; expose every shape.
export type {
  ApiError,
  ApiResponse,
  ApiSuccess,
  LeaderboardResponse,
  OutOfBoundsReason,
  PlayerRankResponse,
  RankedEntry,
  ScorezillaErrorCode,
  SubmitScoreResponse,
  WindowAroundResponse,
} from './types';

// Re-export the runtime-detection helper — opt-in observability for
// consumers who want to label their own telemetry.
export { detectRuntime, type Runtime } from './user-agent';

// Build-time-injected version constant — see global.d.ts.
export const SDK_VERSION: string = __SCOREZILLA_SDK_VERSION__;
