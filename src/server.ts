/**
 * `scorezilla/server` — HMAC-signed adapter for game backends (#17, v0.2.0).
 *
 * Why this exists
 * ---------------
 * The default `Scorezilla` from `'scorezilla'` uses a public key
 * (`pk_*`) and is browser-safe. That model is client-authoritative —
 * any player can submit any score from devtools. Fine for casual
 * leaderboards; not fine for anything where the ranking matters.
 *
 * This adapter is the opposite: the game backend signs each request
 * with a secret key (`sk_live_*`). The Scorezilla API verifies the
 * signature server-side. Players can't forge submissions even with
 * full client-side access.
 *
 * Surface parity with the public-key client
 * -----------------------------------------
 * The method shape is intentionally identical — `submitScore`,
 * `getLeaderboard`, `getPlayerRank`, `getWindowAround`. The only
 * difference at the call site is the constructor argument:
 *
 *   import { Scorezilla } from 'scorezilla/server';
 *   const sz = new Scorezilla({
 *     secretKey: { id: 'sk-id-abc', secret: 'sk_live_…' },
 *   });
 *
 * Behind the scenes:
 *   - `submitScore` posts to `/v1/secure/scores` (different from the
 *     public-key submit endpoint, which carries the boardId in the
 *     path). The HMAC signing string covers method + path + ts +
 *     nonce + sha256(body), so the API verifies before any DO read.
 *   - Read methods hit the same `/v1/boards/…/leaderboard` etc.
 *     endpoints as the public-key client.
 *
 * Browser hard-stop
 * -----------------
 * The package's exports map routes `"./server"` through
 * `src/server-browser-stub.ts` when the bundler honors the `browser`
 * condition, so a browser-side import throws at module evaluation. The
 * secret key MUST NEVER leave the server.
 */

import { validateSecretKey, DEFAULT_BASE_URL, type SecretKeyConfig } from './config';
import { buildHmacAuthHeader } from './hmac';
import {
  getLeaderboardPath,
  getPlayerRankPath,
  getWindowAroundPath,
  submitScoreSecurePath,
} from './paths';
import { request, type FetchImpl, type RequestOptions } from './transport';
import type {
  ApiSuccess,
  LeaderboardResponse,
  PlayerRankResponse,
  SubmitScoreResponse,
  WindowAroundResponse,
} from './types';
import { defaultUserAgent } from './user-agent';

// ---------------------------------------------------------------------------
// Public input types
// ---------------------------------------------------------------------------
// Intentionally mirror the public-key client's input shapes (see
// src/client.ts). Kept as a separate set of declarations rather than
// re-exported to keep the `scorezilla/server` surface self-contained —
// consumers of this entry point shouldn't need to import from
// `scorezilla` core to get types.

/** Input for {@link Scorezilla.submitScore}. */
export interface SubmitScoreInput {
  /** UUID-typed board identifier — issued by the operator dashboard. */
  boardId: string;
  /** Stable per-player identifier (UUID, your account ID, etc.). Avoid PII. */
  playerId: string;
  /** Finite number. Rejected with `out_of_bounds` if outside the board's
   *  configured `[minScore, maxScore]` range. */
  score: number;
  /** Optional structured context attached to the submission. ≤ 4 KB JSON. */
  metadata?: Record<string, unknown> | undefined;
}

/** Input for {@link Scorezilla.getLeaderboard}. */
export interface GetLeaderboardInput {
  boardId: string;
  /** Number of entries (API caps at 1000; default 100). */
  top?: number | undefined;
  /** Offset into the sorted board (API caps at 1_000_000; default 0). */
  offset?: number | undefined;
}

/** Input for {@link Scorezilla.getPlayerRank}. */
export interface GetPlayerRankInput {
  boardId: string;
  playerId: string;
}

/** Input for {@link Scorezilla.getWindowAround}. */
export interface GetWindowAroundInput {
  boardId: string;
  playerId: string;
  /** Entries strictly above the player (API caps at 100; default 5). */
  before?: number | undefined;
  /** Entries strictly below the player (API caps at 100; default 5). */
  after?: number | undefined;
}

// ---------------------------------------------------------------------------
// The Scorezilla server client
// ---------------------------------------------------------------------------

/**
 * Server-side, HMAC-signing Scorezilla client.
 *
 * Construct once at process boot with your `sk_live_*` secret and reuse
 * the instance across requests — there's no per-request state in here
 * other than the freshly-generated timestamp + nonce computed inside
 * each HTTP attempt.
 *
 * @example
 * ```ts
 * import { Scorezilla, ScorezillaError } from 'scorezilla/server';
 *
 * const sz = new Scorezilla({
 *   secretKey: {
 *     id:     process.env.SCOREZILLA_KEY_ID!,
 *     secret: process.env.SCOREZILLA_KEY_SECRET!,
 *   },
 * });
 *
 * try {
 *   const r = await sz.submitScore({ boardId, playerId, score, metadata });
 *   if (r.isPersonalBest) notifyPlayer(r.rank);
 * } catch (e) {
 *   if (e instanceof ScorezillaError && e.isRateLimited()) {
 *     await delay((e.retryAfter ?? 30) * 1000);
 *   } else throw e;
 * }
 * ```
 *
 * @since 0.2.0
 * @stability stable
 */
export class Scorezilla {
  /** The package version, injected at build time from `package.json`.
   *  Mirrors the static on the public-key client so consumers can log
   *  the running SDK build the same way regardless of which surface
   *  they imported. */
  static readonly version: string = __SCOREZILLA_SDK_VERSION__;

  readonly #keyId: string;
  readonly #secret: string;
  readonly #baseUrl: string;
  readonly #fetchImpl: FetchImpl | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #maxRetries: number | undefined;
  readonly #userAgent: string;

  constructor(config: SecretKeyConfig) {
    const resolved = validateSecretKey(config);
    this.#keyId = resolved.keyId;
    this.#secret = resolved.secret;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#fetchImpl = config.fetch;
    this.#timeoutMs = config.timeoutMs;
    this.#maxRetries = config.maxRetries;
    this.#userAgent = config.userAgent ?? defaultUserAgent(Scorezilla.version);
  }

  /**
   * Submit a score to a board. Signed end-to-end — the API verifies
   * before any state change.
   */
  async submitScore(input: SubmitScoreInput): Promise<ApiSuccess<SubmitScoreResponse>> {
    return this.#request<ApiSuccess<SubmitScoreResponse>>({
      path: submitScoreSecurePath(),
      method: 'POST',
      body: {
        boardId: input.boardId,
        playerId: input.playerId,
        score: input.score,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
  }

  /** Fetch the top-N entries on a board. */
  async getLeaderboard(input: GetLeaderboardInput): Promise<ApiSuccess<LeaderboardResponse>> {
    return this.#request<ApiSuccess<LeaderboardResponse>>({
      path: getLeaderboardPath(input.boardId, {
        ...(input.top !== undefined ? { top: input.top } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
      }),
      method: 'GET',
    });
  }

  /** Look up a single player's rank on a board. */
  async getPlayerRank(input: GetPlayerRankInput): Promise<ApiSuccess<PlayerRankResponse>> {
    return this.#request<ApiSuccess<PlayerRankResponse>>({
      path: getPlayerRankPath(input.boardId, input.playerId),
      method: 'GET',
    });
  }

  /** Fetch the slice of entries surrounding a player. */
  async getWindowAround(input: GetWindowAroundInput): Promise<ApiSuccess<WindowAroundResponse>> {
    return this.#request<ApiSuccess<WindowAroundResponse>>({
      path: getWindowAroundPath(input.boardId, input.playerId, {
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
      }),
      method: 'GET',
    });
  }

  /**
   * Thin wrapper around `transport.request` that wires the HMAC signer
   * for every attempt. Each retry calls `signRequest` again, producing
   * a fresh `(ts, nonce)` pair — the server's replay protection (10-min
   * KV) requires this.
   */
  async #request<T extends { ok: true }>(
    opts: Pick<RequestOptions, 'path' | 'method' | 'body'>,
  ): Promise<T> {
    const baseHeaders: Record<string, string> = {
      // User-Agent: useful in Node/Bun/Deno/Workers for server observability.
      // (The browser stub blocks this code path from running browser-side.)
      'User-Agent': this.#userAgent,
      'X-Scorezilla-Client': this.#userAgent,
    };

    const requestOpts: RequestOptions = {
      baseUrl: this.#baseUrl,
      path: opts.path,
      method: opts.method,
      headers: baseHeaders,
      signRequest: async ({ method, pathAndQuery, body }) =>
        buildHmacAuthHeader({
          keyId: this.#keyId,
          secret: this.#secret,
          method,
          pathAndQuery,
          body,
        }),
    };
    if (opts.body !== undefined) requestOpts.body = opts.body;
    if (this.#fetchImpl !== undefined) requestOpts.fetchImpl = this.#fetchImpl;
    if (this.#timeoutMs !== undefined) requestOpts.timeoutMs = this.#timeoutMs;
    if (this.#maxRetries !== undefined) {
      requestOpts.retry = { maxRetries: this.#maxRetries };
    }

    return request<T>(requestOpts);
  }
}

// Mirror the public-key client's pattern: re-export error + response
// types so consumers of `'scorezilla/server'` get everything they need
// for typed catch blocks without a second import from the core package.
export { ScorezillaError } from './errors';
export type {
  ApiSuccess,
  LeaderboardResponse,
  PlayerRankResponse,
  RankedEntry,
  ScorezillaErrorCode,
  SubmitScoreResponse,
  WindowAroundResponse,
} from './types';
