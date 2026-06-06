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
 * difference at the call site is the constructor argument: a single
 * `sk_live_<keyId>_<random>` token replaces the public key (Stripe-
 * style single-token format; the keyId is embedded in the plaintext
 * so consumers manage one value, not two):
 *
 *   import { Scorezilla } from 'scorezilla/server';
 *   const sz = new Scorezilla({
 *     secretKey: process.env.SCOREZILLA_SECRET_KEY!, // sk_live_<keyId>_<random>
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
import { ScorezillaError } from './errors';

// ---------------------------------------------------------------------------
// Public input types
// ---------------------------------------------------------------------------
// Intentionally mirror the public-key client's input shapes (see
// src/client.ts). Kept as a separate set of declarations rather than
// re-exported to keep the `scorezilla/server` surface self-contained —
// consumers of this entry point shouldn't need to import from
// `scorezilla` core to get types.

/** Caller-cancellable common shape — server-side too. */
export interface CancellableInput {
  /** Optional `AbortSignal` to cancel mid-flight. The transport composes
   *  it with the per-attempt timeout, so aborting always wins. */
  signal?: AbortSignal | undefined;
}

/** Input for {@link Scorezilla.submitScore}. */
export interface SubmitScoreInput extends CancellableInput {
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
export interface GetLeaderboardInput extends CancellableInput {
  boardId: string;
  /** Number of entries (API caps at 1000; default 100). */
  top?: number | undefined;
  /** Offset into the sorted board (API caps at 1_000_000; default 0). */
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
 *   secretKey: process.env.SCOREZILLA_SECRET_KEY!, // sk_live_<keyId>_<random>
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
  /** Host portion of `#baseUrl` (e.g. "api.scorezilla.dev"). Captured at
   *  construction so every signed request binds to this exact origin —
   *  see `buildSigningString` v=2 in `hmac.ts`. */
  readonly #host: string;
  readonly #fetchImpl: FetchImpl | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #maxRetries: number | undefined;
  readonly #sleepImpl: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly #warnImpl: ((...args: unknown[]) => void) | undefined;
  readonly #userAgent: string;

  constructor(config: SecretKeyConfig) {
    // Belt-and-suspenders browser guard. The package's exports map routes
    // `scorezilla/server` to `server-browser-stub.ts` when the bundler
    // honors the `browser` condition — which closes the issue cleanly for
    // modern bundlers (Vite, esbuild, Rollup, Webpack 5 with the right
    // resolve config). But misconfigured older bundlers (Webpack 4 without
    // `resolve.conditionNames`, certain custom Rollup setups) may bundle
    // this file directly into a browser bundle. The secret would leak.
    // Throwing at construction time is a non-negotiable runtime fence
    // against that misconfiguration.
    //
    // Detection has to distinguish a *real browser* from *Node-with-jsdom*
    // (the latter is what vitest's `environment: 'jsdom'` produces — it
    // sets `window` + `document` but is fundamentally a Node process).
    // Strategy: if we have a Node-like host (Node, Bun, Deno, or a
    // Workers runtime with `nodejs_compat`), the secret is safe; otherwise
    // if we see browser globals, refuse to instantiate.
    if (isRealBrowserEnvironment()) {
      throw new Error(
        'scorezilla/server: this adapter is server-only and must not run in browsers. ' +
          'Your bundler is shipping `scorezilla/server` into a browser bundle — check that it ' +
          'honors the `browser` export condition in package.json. Use the public-key client ' +
          "(`import { Scorezilla } from 'scorezilla'`) from browser code.",
      );
    }

    const resolved = validateSecretKey(config);
    this.#keyId = resolved.keyId;
    this.#secret = resolved.secret;
    this.#baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Derive host once. URL parsing is also a soft validation of baseUrl —
    // a malformed baseUrl (no scheme, etc.) would throw here at boot rather
    // than surface as a confusing "signature mismatch" 401 on every request.
    try {
      this.#host = new URL(this.#baseUrl).host;
    } catch {
      throw new Error(
        `scorezilla/server: baseUrl must be a valid absolute URL (got: ${this.#baseUrl})`,
      );
    }
    this.#fetchImpl = config.fetch;
    this.#timeoutMs = config.timeoutMs;
    this.#maxRetries = config.maxRetries;
    this.#sleepImpl = config.sleepImpl;
    this.#warnImpl = config.warn;
    this.#userAgent = config.userAgent ?? defaultUserAgent(Scorezilla.version);
  }

  /**
   * Submit a score to a board. Signed end-to-end — the API verifies
   * before any state change.
   *
   * **Behavioral note vs. the public-key client**: the server adapter
   * does NOT perform local `metadata` validation. The public-key
   * client (`scorezilla`) validates size + structure client-side and
   * fails fast; the server adapter relies on the API to reject
   * malformed metadata with `invalid_input`. Trade-off: smaller bundle
   * + simpler server-side logic vs. one extra network round-trip on
   * caller mistakes. If you want fast-fail behavior, validate metadata
   * yourself before calling this method.
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
      signal: input.signal,
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
      signal: input.signal,
    });
  }

  /** Look up a single player's rank on a board. */
  async getPlayerRank(input: GetPlayerRankInput): Promise<ApiSuccess<PlayerRankResponse>> {
    return this.#request<ApiSuccess<PlayerRankResponse>>({
      path: getPlayerRankPath(input.boardId, input.playerId),
      method: 'GET',
      signal: input.signal,
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
      signal: input.signal,
    });
  }

  /**
   * Thin wrapper around `transport.request` that wires the HMAC signer
   * for every attempt. Each retry calls `signRequest` again, producing
   * a fresh `(ts, nonce)` pair — the server's replay protection (10-min
   * KV) requires this.
   */
  async #request<T extends { ok: true }>(
    opts: Pick<RequestOptions, 'path' | 'method' | 'body' | 'signal'>,
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
          host: this.#host,
          body,
        }),
    };
    if (opts.body !== undefined) requestOpts.body = opts.body;
    if (opts.signal !== undefined) requestOpts.signal = opts.signal;
    if (this.#fetchImpl !== undefined) requestOpts.fetchImpl = this.#fetchImpl;
    if (this.#warnImpl !== undefined) requestOpts.warnImpl = this.#warnImpl;
    if (this.#timeoutMs !== undefined) requestOpts.timeoutMs = this.#timeoutMs;
    if (this.#maxRetries !== undefined || this.#sleepImpl !== undefined) {
      requestOpts.retry = {
        ...(this.#maxRetries !== undefined ? { maxRetries: this.#maxRetries } : {}),
        ...(this.#sleepImpl !== undefined ? { sleepImpl: this.#sleepImpl } : {}),
      };
    }

    return request<T>(requestOpts);
  }
}

/**
 * Distinguish a real browser from a Node-with-jsdom test environment.
 *
 * Browser globals (`window`, `document`) appear in both contexts. The
 * differentiator is the presence of a recognizable server runtime:
 *   - Node + Bun:         `process.versions.node`
 *   - Cloudflare Workers
 *     w/ nodejs_compat:   `process.versions.node` too
 *   - Deno:               `globalThis.Deno`
 *
 * `globalThis.EdgeRuntime` is intentionally NOT on the trust list. It's
 * a Vercel-Edge convention that can be polyfilled by browser extensions
 * or bundler misconfiguration; trusting it would let an adversarial
 * page bypass the runtime guard by setting `globalThis.EdgeRuntime =
 * 'edge'`. The package's `exports.browser` condition remains the
 * primary gate against browser loading; this runtime check is
 * defense-in-depth and should err on the side of REFUSING.
 *
 * Real Vercel Edge code typically lacks `window` and `document` so it
 * never reaches the disqualifier branch — no false positive.
 *
 * If ANY trusted server runtime is detected we trust the caller.
 * Otherwise, if browser globals exist, refuse.
 */
function isRealBrowserEnvironment(): boolean {
  const g = globalThis as {
    window?: unknown;
    document?: unknown;
    Deno?: unknown;
    Bun?: unknown;
    process?: { versions?: { node?: string } };
  };
  const hasBrowserGlobals = typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
  if (!hasBrowserGlobals) return false;
  const hasNodeLikeHost =
    Boolean(g.process?.versions?.node) ||
    typeof g.Deno !== 'undefined' ||
    typeof g.Bun !== 'undefined';
  return !hasNodeLikeHost;
}

// ---------------------------------------------------------------------------
// createScoreSubmitHandler — turnkey secure-submit endpoint (#211)
// ---------------------------------------------------------------------------

/** A value or a promise of it. */
type Awaitable<T> = T | Promise<T>;

/**
 * The trusted identity produced by your `verify` callback. `playerId` is what
 * gets submitted — derived from the *verified* request, never the request body.
 */
export interface VerifiedIdentity {
  /** Stable, trusted per-player id (e.g. your auth user id). Avoid PII. */
  readonly playerId: string;
  /** Optional trusted metadata merged into the submission (wins over the body). */
  readonly metadata?: Record<string, unknown> | undefined;
}

/** The score payload extracted from the request body. */
export interface ParsedScoreSubmission {
  readonly score: number;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** Decision returned by an optional pre-verify rate-limit gate. */
export interface RateLimitDecision {
  readonly ok: boolean;
  readonly retryAfterSeconds?: number | undefined;
}

/** CORS config for the handler. Omit entirely for same-origin endpoints. */
export interface ScoreSubmitCorsOptions {
  /**
   * Allowed origin(s): an exact string, an array of strings, a predicate, or
   * `true` to reflect any `Origin`. `false` disables reflection.
   */
  readonly origin: string | readonly string[] | boolean | ((origin: string | null) => boolean);
  /** Methods for the preflight. Default `['POST', 'OPTIONS']`. */
  readonly methods?: readonly string[];
  /** Request headers for the preflight. Default `['content-type', 'authorization']`. */
  readonly headers?: readonly string[];
  /** `Access-Control-Max-Age` seconds. Default `600`. */
  readonly maxAgeSeconds?: number;
}

/** Configuration for {@link createScoreSubmitHandler}. */
export interface CreateScoreSubmitHandlerConfig {
  /** Your `sk_live_*` secret. Server-only — never ship to a browser. */
  readonly secretKey: string;
  /** The board UUID this handler submits to. */
  readonly boardId: string;
  /**
   * Authenticate the request and return the **trusted** `playerId` (and any
   * trusted metadata). Return `null` to reject (→ 401); throwing also rejects.
   * Read identity from headers/cookies — the request **body** is reserved for
   * the score payload (see `parseSubmission`). This callback is the universal
   * seam: wire any auth (provider SDK, JWT verify, DB session lookup) here.
   */
  readonly verify: (req: Request) => Awaitable<VerifiedIdentity | null>;
  /**
   * Extract the score (+ optional client metadata) from the request. Defaults
   * to JSON `{ score: number, metadata?: object }`. Return `null` (or throw)
   * to reject as a bad request (→ 400). Note: a `playerId` in the body is
   * always ignored — identity comes only from `verify`.
   */
  readonly parseSubmission?: (req: Request) => Awaitable<ParsedScoreSubmission | null>;
  /**
   * Optional gate that runs **before** `verify` (cheap defense — e.g. a per-IP
   * rate limit, so unauthenticated spam can't drive auth/crypto work). Return
   * `{ ok: false }` to reject with 429. Per-user limits belong inside `verify`.
   */
  readonly rateLimit?: (req: Request) => Awaitable<RateLimitDecision>;
  /** Optional CORS handling (OPTIONS preflight + reflected `Access-Control-Allow-Origin`). */
  readonly cors?: ScoreSubmitCorsOptions;
  /** Override the API base URL (self-host / testing). */
  readonly baseUrl?: string;
  /** Inject a `fetch` (testing / custom transport). */
  readonly fetch?: FetchImpl;
  /** Max transport retries (default SDK policy). Set `0` to disable. */
  readonly maxRetries?: number;
  /** Per-attempt timeout in ms. */
  readonly timeoutMs?: number;
}

/** The web-standard request handler returned by {@link createScoreSubmitHandler}. */
export type ScoreSubmitHandler = (req: Request) => Promise<Response>;

/**
 * Build a turnkey, framework-agnostic secure score-submit endpoint.
 *
 * Returns a standard `(Request) => Promise<Response>` handler — drop it into a
 * Cloudflare Worker, a Next.js route handler, Hono, Deno, Bun, or any runtime
 * that speaks web `Request`/`Response`. You supply only what's app-specific:
 * the `secretKey`, the `boardId`, and a `verify` callback that proves identity
 * and returns the trusted `playerId`. The handler owns parsing/validation, the
 * "playerId comes from `verify`, never the body" guarantee, signing via the
 * HMAC server client, and error → HTTP mapping.
 *
 * **Construction patterns.** In Node/Next, secrets are in `process.env`, so
 * build the handler once at module scope. In Cloudflare Workers, secrets live
 * on the per-request `env` binding, so build it inside `fetch` (closing over
 * `env`) — the construction is cheap (no I/O).
 *
 * @example Cloudflare Worker
 * ```ts
 * import { createScoreSubmitHandler } from 'scorezilla/server';
 *
 * export default {
 *   fetch(req, env) {
 *     const handler = createScoreSubmitHandler({
 *       secretKey: env.SCOREZILLA_SECRET_KEY,
 *       boardId: env.SCOREZILLA_BOARD_ID,
 *       verify: async (r) => {
 *         const user = await verifyMyAuth(r, env); // your auth: SDK / JWT / DB
 *         return user ? { playerId: user.id } : null;
 *       },
 *       cors: { origin: 'https://mygame.example' },
 *     });
 *     return handler(req);
 *   },
 * };
 * ```
 *
 * @since 0.3.0
 * @stability stable
 */
export function createScoreSubmitHandler(
  config: CreateScoreSubmitHandlerConfig,
): ScoreSubmitHandler {
  // Construct the signing client once; reuse across requests.
  const sz = new Scorezilla({
    secretKey: config.secretKey,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });
  const parse = config.parseSubmission ?? defaultParseSubmission;

  return async (req: Request): Promise<Response> => {
    const cors = config.cors ? buildCorsHeaders(config.cors, req.headers.get('Origin')) : {};

    if (req.method === 'OPTIONS' && config.cors) {
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, cors);
    }

    if (config.rateLimit) {
      const decision = await config.rateLimit(req);
      if (!decision.ok) {
        const headers = { ...cors };
        if (decision.retryAfterSeconds !== undefined) {
          headers['Retry-After'] = String(decision.retryAfterSeconds);
        }
        return jsonResponse({ ok: false, error: 'rate_limited' }, 429, headers);
      }
    }

    let identity: VerifiedIdentity | null;
    try {
      identity = await config.verify(req);
    } catch {
      // A throwing verify is treated as a rejection — it should catch its own
      // errors. We never surface its message (it may carry token internals).
      identity = null;
    }
    if (!identity || typeof identity.playerId !== 'string' || identity.playerId.length === 0) {
      return jsonResponse({ ok: false, error: 'unauthorized' }, 401, cors);
    }

    let submission: ParsedScoreSubmission | null;
    try {
      submission = await parse(req);
    } catch {
      submission = null;
    }
    if (!submission || typeof submission.score !== 'number' || !Number.isFinite(submission.score)) {
      return jsonResponse(
        { ok: false, error: 'bad_request', message: 'invalid score submission' },
        400,
        cors,
      );
    }

    const metadata = mergeMetadata(submission.metadata, identity.metadata);

    try {
      const result = await sz.submitScore({
        boardId: config.boardId,
        playerId: identity.playerId,
        score: submission.score,
        ...(metadata !== undefined ? { metadata } : {}),
      });
      return jsonResponse(
        {
          ok: true,
          rank: result.rank,
          totalEntries: result.totalEntries,
          isPersonalBest: result.isPersonalBest,
        },
        200,
        cors,
      );
    } catch (err: unknown) {
      return mapSubmitError(err, cors);
    }
  };
}

async function defaultParseSubmission(req: Request): Promise<ParsedScoreSubmission | null> {
  const raw: unknown = await req.json().catch(() => null);
  if (!isPlainObject(raw)) return null;
  const score = raw.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return { score, metadata: isPlainObject(raw.metadata) ? raw.metadata : undefined };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeMetadata(
  client: Record<string, unknown> | undefined,
  verified: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!client && !verified) return undefined;
  // Verified (trusted) values win over client-supplied ones on conflict.
  return { ...(client ?? {}), ...(verified ?? {}) };
}

function jsonResponse(body: unknown, status: number, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function mapSubmitError(err: unknown, cors: Record<string, string>): Response {
  if (err instanceof ScorezillaError) {
    if (err.isRateLimited()) {
      const headers = { ...cors };
      if (err.retryAfter !== undefined) headers['Retry-After'] = String(err.retryAfter);
      return jsonResponse({ ok: false, error: 'rate_limited' }, 429, headers);
    }
    // Echo genuine client errors (e.g. out_of_bounds, invalid_input); treat
    // everything else (5xx, network) as an upstream failure.
    if (err.status >= 400 && err.status < 500) {
      return jsonResponse({ ok: false, error: err.code, message: err.message }, err.status, cors);
    }
    return jsonResponse({ ok: false, error: 'upstream_error' }, 502, cors);
  }
  return jsonResponse({ ok: false, error: 'server_error' }, 500, cors);
}

function buildCorsHeaders(
  cors: ScoreSubmitCorsOptions,
  origin: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': (cors.methods ?? ['POST', 'OPTIONS']).join(', '),
    'Access-Control-Allow-Headers': (cors.headers ?? ['content-type', 'authorization']).join(', '),
    'Access-Control-Max-Age': String(cors.maxAgeSeconds ?? 600),
    Vary: 'Origin',
  };
  if (origin !== null && isCorsOriginAllowed(cors.origin, origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function isCorsOriginAllowed(rule: ScoreSubmitCorsOptions['origin'], origin: string): boolean {
  if (typeof rule === 'boolean') return rule;
  if (typeof rule === 'string') return rule === origin;
  if (typeof rule === 'function') return rule(origin);
  return rule.includes(origin);
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

// Built-in `verify` helpers for createScoreSubmitHandler (#211). `jose` is an
// optional peer dependency, loaded lazily — only consumers of these pay for it.
export {
  verifyJwt,
  verifySupabaseJwt,
  verifyClerkJwt,
  verifyAuth0Jwt,
  verifyFirebaseIdToken,
} from './verifiers';
export type {
  RequestVerifier,
  VerifyJwtOptions,
  VerifySupabaseJwtOptions,
  VerifyClerkJwtOptions,
  VerifyAuth0JwtOptions,
  VerifyFirebaseIdTokenOptions,
} from './verifiers';
