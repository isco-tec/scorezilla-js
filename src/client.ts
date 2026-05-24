/**
 * `Scorezilla` — the public-key client for v0.1.0.
 *
 * Composes the substrate modules (transport, retry, errors, config,
 * paths, user-agent) into the four documented public methods:
 *
 *   • {@link Scorezilla.submitScore}
 *   • {@link Scorezilla.getLeaderboard}
 *   • {@link Scorezilla.getPlayerRank}
 *   • {@link Scorezilla.getWindowAround}
 *
 * Every method returns a parsed, typed response on the success path and
 * throws {@link ScorezillaError} on every failure path (HTTP non-2xx,
 * network failures, aborts, timeouts, invalid JSON).
 *
 * **Input contract — `playerId` only.** The SDK does NOT accept a `player`
 * alias. TypeScript discriminated unions that differ only in key name
 * produce no narrowing benefit and create friction for callers spreading
 * existing types. v0.1.0 is the moment to be strict.
 *
 * **Auth — v0.1.0 is public-key only.** A `ScorezillaConfig` with
 * `secretKey` is accepted by `validateConfig` (since the type union covers
 * both kinds) but the constructor throws a clear `Error` pointing to the
 * future `scorezilla/server` adapter (v0.2.0). This prevents accidental
 * browser leakage of secret keys via the public-key surface.
 */

import { validateConfig, type ResolvedConfig, type ScorezillaConfig } from './config';
import {
  getLeaderboardPath,
  getPlayerRankPath,
  getWindowAroundPath,
  submitScorePath,
} from './paths';
import { request, type RequestOptions } from './transport';
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
//
// Each input field uses `?: T | undefined` (with explicit `| undefined`) so
// callers under `exactOptionalPropertyTypes: true` can pass a maybe-undefined
// variable without a spread workaround. See COMPATIBILITY.md for the
// detailed callout.
// ---------------------------------------------------------------------------

/** Caller-cancellable common shape. All public methods accept an
 *  `AbortSignal` so framework consumers (Next.js route handlers, Hono,
 *  Express request lifecycles, React effect cleanup) can propagate
 *  cancellation through to the underlying `fetch`. The signal is wired
 *  into the transport's per-attempt timeout composition — aborting the
 *  caller signal cancels any in-flight retry. */
export interface CancellableInput {
  /** Optional `AbortSignal` to cancel the request mid-flight. The SDK
   *  composes this with its per-attempt timeout, so aborting always wins
   *  over the SDK's own timer. */
  signal?: AbortSignal | undefined;
}

/** Input for {@link Scorezilla.submitScore}. */
export interface SubmitScoreInput extends CancellableInput {
  /** UUID-typed board identifier — issued by the operator dashboard. */
  boardId: string;
  /** The SDK accepts ONLY `playerId`. Pass your stable per-player identifier
   *  (UUID, account id, anonymous-session id). Avoid PII. */
  playerId: string;
  /** Finite number. The API rejects NaN, Infinity, and values outside the
   *  board's configured `[minScore, maxScore]` range with `out_of_bounds`. */
  score: number;
  /** Optional structured context attached to the submission. Validated
   *  locally before send: no functions, no symbols, no circular refs;
   *  ≤ 4 KB UTF-8 bytes when JSON-stringified. */
  metadata?: Record<string, unknown> | undefined;
}

/** Input for {@link Scorezilla.getLeaderboard}. */
export interface GetLeaderboardInput extends CancellableInput {
  boardId: string;
  /** Number of entries to return. API caps at 1000; default 100. */
  top?: number | undefined;
  /** Offset into the sorted board. API caps at 1_000_000; default 0. */
  offset?: number | undefined;
}

/** Input for {@link Scorezilla.getPlayerRank}. */
export interface GetPlayerRankInput extends CancellableInput {
  boardId: string;
  playerId: string;
}

/** Input for {@link Scorezilla.getWindowAround}. */
export interface GetWindowAroundInput extends CancellableInput {
  boardId: string;
  playerId: string;
  /** Entries strictly above the player. API caps at 100; default 5. */
  before?: number | undefined;
  /** Entries strictly below the player. API caps at 100; default 5. */
  after?: number | undefined;
}

// ---------------------------------------------------------------------------
// Metadata validation
//
// Local pre-flight checks so callers fail fast on programmer errors rather
// than receiving a vague 400 from the API. Two failure modes:
//   1. Structural — functions, symbols, circular refs aren't serializable.
//   2. Size — JSON.stringify result exceeds 4 KB UTF-8 bytes.
//
// Returns the canonicalized JSON string the validator produced. Callers
// that pass it through to the transport avoid a second JSON.stringify on
// the same object — meaningful for submit hot paths in high-frequency
// games. Tests can assert on the string directly.
// ---------------------------------------------------------------------------

/** Maximum size, in UTF-8 bytes, of a metadata payload. */
export const METADATA_MAX_BYTES = 4096;

function validateMetadata(metadata: Record<string, unknown>): string {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(
      'scorezilla: metadata must be a plain object (got ' +
        (Array.isArray(metadata) ? 'array' : typeof metadata) +
        ')',
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(metadata, (_key, value): unknown => {
      if (typeof value === 'function') {
        throw new Error('scorezilla: metadata may not contain functions');
      }
      if (typeof value === 'symbol') {
        throw new Error('scorezilla: metadata may not contain symbols');
      }
      if (typeof value === 'bigint') {
        // BigInt isn't representable in JSON; without this check, JSON.stringify
        // would throw a confusing TypeError. Fail fast with a clear message.
        throw new Error('scorezilla: metadata may not contain BigInt');
      }
      return value;
    });
  } catch (cause) {
    if (cause instanceof Error) {
      // The replacer's explicit Errors propagate; re-throw verbatim.
      if (cause.message.startsWith('scorezilla:')) throw cause;
      // JSON.stringify on a circular structure throws TypeError with
      // engine-specific messages — normalize to a single clear error.
      if (/circular|convert|cyclic/i.test(cause.message)) {
        throw new Error('scorezilla: metadata contains circular references');
      }
    }
    throw cause;
  }

  // UTF-8 byte length, NOT character length. The wire format is JSON, and
  // the API gates on bytes. Avoids the surprise of a 4000-char string with
  // emoji weighing 12 000 bytes.
  const byteLength = new TextEncoder().encode(serialized).length;
  if (byteLength > METADATA_MAX_BYTES) {
    throw new Error(
      `scorezilla: metadata exceeds ${METADATA_MAX_BYTES} bytes (got ${byteLength} bytes when JSON-stringified)`,
    );
  }
  return serialized;
}

// ---------------------------------------------------------------------------
// Scorezilla class
// ---------------------------------------------------------------------------

/**
 * Public-key client for the Scorezilla API.
 *
 * ```ts
 * const sz = new Scorezilla({ publicKey: 'pk_mygame_aBcDeF…' });
 * const { rank, isPersonalBest } = await sz.submitScore({
 *   boardId: 'board-uuid',
 *   playerId: 'player-uuid',
 *   score: 9001,
 * });
 * ```
 *
 * @since 0.1.0
 * @stability stable
 */
export class Scorezilla {
  /** The package version, injected at build time from `package.json`. */
  static readonly version: string = __SCOREZILLA_SDK_VERSION__;

  readonly #config: ResolvedConfig;
  readonly #userAgent: string;
  readonly #authHeader: string;

  /**
   * @param config - public-key configuration. Passing `secretKey` throws —
   *                 use the `scorezilla/server` adapter (v0.2.0) for HMAC.
   */
  constructor(config: ScorezillaConfig) {
    const resolved = validateConfig(config);
    if (resolved.auth.kind !== 'public') {
      throw new Error(
        'scorezilla: the default `Scorezilla` client is public-key only. ' +
          'Secret-key (HMAC) auth ships in v0.2.0 via the `scorezilla/server` adapter — ' +
          'use that for server-side code; use `publicKey` for browser / public clients.',
      );
    }
    this.#config = resolved;
    this.#userAgent = resolved.userAgent ?? defaultUserAgent(Scorezilla.version);
    this.#authHeader = `Bearer ${resolved.auth.key}`;
  }

  /**
   * Submit a score to a board.
   *
   * Maps to `POST /v1/boards/:boardId/scores`. See [API.md](../API.md#submitscore)
   * for the full contract.
   *
   * @example
   * ```ts
   * try {
   *   const r = await sz.submitScore({ boardId, playerId: 'alice', score: 9001 });
   *   if (r.isPersonalBest) console.log(`PB! Rank ${r.rank} of ${r.totalEntries}`);
   * } catch (e) {
   *   if (e instanceof ScorezillaError && e.code === 'out_of_bounds') {
   *     console.warn(`Score outside board bounds (${e.reason}, limit ${e.bound})`);
   *   } else throw e;
   * }
   * ```
   *
   * @throws {ScorezillaError} `unauthorized` (bad publicKey), `forbidden`
   *   (key not bound to this board), `not_found` (board doesn't exist),
   *   `out_of_bounds` (score outside board's min/max), `rate_limited`
   *   (Layer 2/3 throttle hit), `invalid_input`, `network_error`, `timeout`.
   * @since 0.1.0
   * @stability stable
   */
  async submitScore(input: SubmitScoreInput): Promise<ApiSuccess<SubmitScoreResponse>> {
    if (input.metadata !== undefined) {
      validateMetadata(input.metadata);
    }

    const body: Record<string, unknown> = {
      playerId: input.playerId,
      score: input.score,
    };
    if (input.metadata !== undefined) {
      body.metadata = input.metadata;
    }

    return this.#request<ApiSuccess<SubmitScoreResponse>>({
      path: submitScorePath(input.boardId),
      method: 'POST',
      body,
      signal: input.signal,
    });
  }

  /**
   * Fetch the top-N leaderboard for a board.
   *
   * Maps to `GET /v1/boards/:boardId/leaderboard`.
   *
   * @example
   * ```ts
   * const { entries } = await sz.getLeaderboard({ boardId, top: 25 });
   * for (const e of entries) console.log(`${e.rank}. ${e.playerId}: ${e.score}`);
   * ```
   *
   * @throws {ScorezillaError} `not_found`, `network_error`, `timeout`.
   * @since 0.1.0
   * @stability stable
   */
  async getLeaderboard(input: GetLeaderboardInput): Promise<ApiSuccess<LeaderboardResponse>> {
    const q: { top?: number; offset?: number } = {};
    if (input.top !== undefined) q.top = input.top;
    if (input.offset !== undefined) q.offset = input.offset;
    return this.#request<ApiSuccess<LeaderboardResponse>>({
      path: getLeaderboardPath(input.boardId, q),
      method: 'GET',
      signal: input.signal,
    });
  }

  /**
   * Fetch a single player's rank on a board.
   *
   * Maps to `GET /v1/boards/:boardId/players/:playerId/rank`. Returns 404
   * (`not_found`) if the player has no entry yet.
   *
   * @example
   * ```ts
   * try {
   *   const { rank, score } = await sz.getPlayerRank({ boardId, playerId: 'alice' });
   *   console.log(`Alice is rank ${rank} with score ${score}`);
   * } catch (e) {
   *   if (e instanceof ScorezillaError && e.isNotFound()) {
   *     console.log('Alice has no submission on this board yet.');
   *   } else throw e;
   * }
   * ```
   *
   * @throws {ScorezillaError} `not_found` (player has no submission),
   *   `network_error`, `timeout`.
   * @since 0.1.0
   * @stability stable
   */
  async getPlayerRank(input: GetPlayerRankInput): Promise<ApiSuccess<PlayerRankResponse>> {
    return this.#request<ApiSuccess<PlayerRankResponse>>({
      path: getPlayerRankPath(input.boardId, input.playerId),
      method: 'GET',
      signal: input.signal,
    });
  }

  /**
   * Fetch the slice of entries surrounding a player.
   *
   * Maps to `GET /v1/boards/:boardId/players/:playerId/window?before=&after=`.
   *
   * @example
   * ```ts
   * const { entries } = await sz.getWindowAround({
   *   boardId, playerId: 'alice', before: 2, after: 2,
   * });
   * ```
   *
   * @throws {ScorezillaError} `network_error`, `timeout`.
   * @since 0.1.0
   * @stability stable
   */
  async getWindowAround(input: GetWindowAroundInput): Promise<ApiSuccess<WindowAroundResponse>> {
    const q: { before?: number; after?: number } = {};
    if (input.before !== undefined) q.before = input.before;
    if (input.after !== undefined) q.after = input.after;
    return this.#request<ApiSuccess<WindowAroundResponse>>({
      path: getWindowAroundPath(input.boardId, input.playerId, q),
      method: 'GET',
      signal: input.signal,
    });
  }

  // ─── Internal ────────────────────────────────────────────────────────

  /**
   * Common request wiring — auth header, default fetch impl, timeout, retry.
   * Each public method composes its `path`, `method`, and (optionally) `body`
   * and hands them to this thin pass-through. Keeps the four method bodies
   * boilerplate-free and ensures every call shares identical defaults.
   */
  async #request<T extends { ok: true }>(
    opts: Pick<RequestOptions, 'path' | 'method' | 'body' | 'signal'>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.#authHeader,
      // User-Agent: ignored by browsers (per Fetch spec), useful in
      // Node/Bun/Deno/Workers for server-side observability.
      'User-Agent': this.#userAgent,
      // X-Scorezilla-Client: browser-honored, mirrors the UA for telemetry
      // parity across runtimes.
      'X-Scorezilla-Client': this.#userAgent,
    };

    const requestOpts: RequestOptions = {
      baseUrl: this.#config.baseUrl,
      path: opts.path,
      method: opts.method,
      headers,
    };
    if (opts.body !== undefined) requestOpts.body = opts.body;
    if (opts.signal !== undefined) requestOpts.signal = opts.signal;
    if (this.#config.fetch !== undefined) requestOpts.fetchImpl = this.#config.fetch;
    if (this.#config.warn !== undefined) requestOpts.warnImpl = this.#config.warn;
    if (this.#config.timeoutMs !== undefined) requestOpts.timeoutMs = this.#config.timeoutMs;
    // Build the `retry` block only if at least one knob is set. Two
    // distinct config options (`maxRetries`, `sleepImpl`) collapse into
    // the single `retry: { ... }` shape transport expects.
    if (this.#config.maxRetries !== undefined || this.#config.sleepImpl !== undefined) {
      requestOpts.retry = {
        ...(this.#config.maxRetries !== undefined ? { maxRetries: this.#config.maxRetries } : {}),
        ...(this.#config.sleepImpl !== undefined ? { sleepImpl: this.#config.sleepImpl } : {}),
      };
    }

    return request<T>(requestOpts);
  }
}

/**
 * Convenience factory for users who prefer a functional API.
 *
 * Functionally equivalent to `new Scorezilla(config)` — same auth rules,
 * same validation, same instance type. The only reason to prefer one over
 * the other is code style.
 *
 * @example
 * ```ts
 * import { createClient, ScorezillaError } from 'scorezilla';
 *
 * const sz = createClient({ publicKey: 'pk_mygame_…' });
 * try {
 *   await sz.submitScore({ boardId, playerId: 'alice', score: 9001 });
 * } catch (e) {
 *   if (e instanceof ScorezillaError && e.isRateLimited()) {
 *     await new Promise((r) => setTimeout(r, (e.retryAfter ?? 30) * 1000));
 *   } else throw e;
 * }
 * ```
 *
 * @throws Plain `Error` if the config is malformed (e.g. invalid
 *   `publicKey` format, or `secretKey` passed to the public-key client).
 *   See `validateConfig`.
 * @since 0.1.0
 * @stability stable
 */
export function createClient(config: ScorezillaConfig): Scorezilla {
  return new Scorezilla(config);
}

// Re-export the error class here too so consumers can `import { Scorezilla,
// ScorezillaError } from 'scorezilla'` in one statement.
export { ScorezillaError } from './errors';
