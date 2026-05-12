/**
 * SDK error type.
 *
 * Every non-2xx API response is normalized into a `ScorezillaError` instance
 * by the transport layer. Network failures and timeouts surface as the same
 * class (with `status: 0`) so callers have a single error type to catch.
 *
 * **Invariant — consumers MUST branch on `code` (and optionally `reason`),
 * never on `message`.** The English-language `message` is for operator
 * logging only and is explicitly **not** part of the SemVer contract; a
 * minor release MAY reword any message. Machine logic that depends on
 * message text will break silently across upgrades.
 */
import type { ApiError, OutOfBoundsReason, ScorezillaErrorCode } from './types';

/** Maximum length, in characters, that an error `message` may hold.
 *
 * Defense against a future server-side change that includes caller-controlled
 * strings in error messages — e.g., echoing back a malformed `playerId` of
 * arbitrary length. Capping at 500 keeps the thrown error printable in
 * devtools and bounded in memory usage. */
export const MESSAGE_MAX_CHARS = 500;

/** Suffix appended when a server-supplied message exceeds {@link MESSAGE_MAX_CHARS}. */
export const TRUNCATION_SUFFIX = '… [truncated]';

/** Sentinel `status` for network errors / timeouts (no HTTP response was received). */
export const STATUS_NETWORK_ERROR = 0;

function truncateMessage(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  if (raw.length <= MESSAGE_MAX_CHARS) return raw;
  // Safety against a future tweak that makes TRUNCATION_SUFFIX longer than
  // the cap — `slice(0, -n)` would silently chop from the end instead of
  // from the beginning, masking the bug. `Math.max(0, …)` keeps the
  // truncation honest.
  const sliceEnd = Math.max(0, MESSAGE_MAX_CHARS - TRUNCATION_SUFFIX.length);
  return raw.slice(0, sliceEnd) + TRUNCATION_SUFFIX;
}

/**
 * Options for {@link ScorezillaError.from}.
 *
 * The fields mirror what's available after a fetch round-trip: the HTTP
 * status, the parsed JSON body (if any), the request ID from
 * `X-Request-Id`, and an optional `cause` for the underlying
 * network/abort error.
 */
export interface ScorezillaErrorFromInit {
  status: number;
  body?: ApiError | undefined;
  requestId?: string | undefined;
  cause?: unknown;
}

/**
 * Thrown by the SDK for every failure path — non-2xx responses, network
 * errors, aborts, and timeouts.
 *
 * Cross-realm `instanceof` is guaranteed: the class sets `Error.prototype`
 * explicitly so checks survive iframe / worker boundaries.
 *
 * @example
 * ```ts
 * try {
 *   await sz.submitScore({ boardId, playerId, score });
 * } catch (e) {
 *   if (!(e instanceof ScorezillaError)) throw e;
 *
 *   if (e.isRateLimited()) {
 *     await sleep((e.retryAfter ?? 30) * 1000);
 *     return retry();
 *   }
 *   if (e.code === 'out_of_bounds') {
 *     console.warn(`Score crosses ${e.reason} bound (limit ${e.bound})`);
 *     return;
 *   }
 *   if (e.isAuth()) throw new Error('SDK misconfigured — bad publicKey');
 *
 *   // Anything else: surface to your reporter with requestId for support.
 *   console.error(`Scorezilla ${e.code} (${e.status}) — request ${e.requestId}`);
 *   throw e;
 * }
 * ```
 *
 * @since 0.1.0
 * @stability stable
 */
export class ScorezillaError extends Error {
  /** HTTP status of the response, or {@link STATUS_NETWORK_ERROR} (0) for
   *  network / abort / timeout. */
  readonly status: number;

  /** Machine-stable error code from the API. Open union — see
   *  {@link ScorezillaErrorCode}. For network errors, this is `'network_error'`;
   *  for aborts, `'aborted'`; for timeouts, `'timeout'`. */
  readonly code: ScorezillaErrorCode;

  /** Sub-classifier — present on `out_of_bounds` (`'below_min' | 'above_max'`)
   *  and possibly other codes in future minor releases. */
  readonly reason: OutOfBoundsReason | string | undefined;

  /** Seconds — present on `rate_limited`. Honored by the transport's retry
   *  policy (Step 2.4). */
  readonly retryAfter: number | undefined;

  /** Server-issued request ID, lifted from the `X-Request-Id` response
   *  header. Pass this to support when filing bugs. */
  readonly requestId: string | undefined;

  /** The bound value crossed on `out_of_bounds`. */
  readonly bound: number | undefined;

  /** Which rate-limit layer fired on `rate_limited`. */
  readonly layer: string | undefined;

  /** The underlying cause (e.g., a `TypeError: fetch failed`) for
   *  network/abort/timeout paths. `undefined` when the error came from a
   *  successfully-parsed API error body. */
  override readonly cause: unknown;

  constructor(
    message: string,
    init: {
      status: number;
      code: ScorezillaErrorCode;
      reason?: string | undefined;
      retryAfter?: number | undefined;
      requestId?: string | undefined;
      bound?: number | undefined;
      layer?: string | undefined;
      cause?: unknown;
    },
  ) {
    super(truncateMessage(message));
    this.name = 'ScorezillaError';
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.retryAfter = init.retryAfter;
    this.requestId = init.requestId;
    this.bound = init.bound;
    this.layer = init.layer;
    this.cause = init.cause;

    // Cross-realm instanceof: explicitly set the prototype. Without this,
    // an instance of ScorezillaError thrown in one realm (e.g., a worker)
    // and caught in another (the main thread) wouldn't satisfy
    // `e instanceof ScorezillaError` because the constructor lookup
    // crosses the realm boundary.
    Object.setPrototypeOf(this, ScorezillaError.prototype);

    // V8 stack capture — omits the constructor frame for cleaner traces.
    // No-op on engines without `captureStackTrace` (Safari, older Firefox).
    if (
      typeof (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace === 'function'
    ) {
      (
        Error as unknown as {
          captureStackTrace: (target: object, ctor: unknown) => void;
        }
      ).captureStackTrace(this, ScorezillaError);
    }
  }

  // ─── Sub-message helpers ─────────────────────────────────────────────
  // Stable wrappers over the `code` discriminator so consumers can write
  // `if (err.isRateLimited())` instead of memorizing the code spelling.

  /** `true` when this error is a 429 / `rate_limited`. */
  isRateLimited(): boolean {
    return this.code === 'rate_limited';
  }

  /** `true` when this error is a 401 / `unauthorized` (or 403 / `forbidden`). */
  isAuth(): boolean {
    return this.code === 'unauthorized' || this.code === 'forbidden';
  }

  /** `true` when this error is a 404 / `not_found`. */
  isNotFound(): boolean {
    return this.code === 'not_found';
  }

  /** `true` when this error is a 422 / `out_of_bounds` (score below/above board limit). */
  isOutOfBounds(): boolean {
    return this.code === 'out_of_bounds';
  }

  /** `true` for transient / retryable conditions: network errors, timeouts,
   *  5xx, and 429. The transport layer relies on this for its retry policy. */
  isTransient(): boolean {
    if (this.status === STATUS_NETWORK_ERROR) return true;
    if (this.status >= 500 && this.status < 600) return true;
    return this.isRateLimited();
  }

  // ─── Factory ─────────────────────────────────────────────────────────

  /**
   * Build a `ScorezillaError` from a fetch round-trip outcome.
   *
   * Prefer this over `new ScorezillaError(...)` from the transport layer —
   * it does the mapping from API response shape to error fields in one
   * place, so future fields like `correlationId` get added once here.
   *
   * @param init - status, optional parsed body, optional requestId, optional cause
   */
  static from(init: ScorezillaErrorFromInit): ScorezillaError {
    const { status, body, requestId, cause } = init;

    // If the body parsed as an API error, use its fields. Otherwise, fall
    // back to status-derived defaults so the SDK always returns a
    // typed error even when the server returns garbage.
    if (body && body.ok === false && typeof body.error === 'string') {
      return new ScorezillaError(body.message ?? `Request failed: ${body.error}`, {
        status,
        code: body.error,
        reason: body.reason,
        retryAfter: body.retryAfter,
        bound: body.bound,
        layer: body.layer,
        requestId,
        cause,
      });
    }

    // No usable body — synthesize from status code.
    const code = codeForStatus(status);
    return new ScorezillaError(`Request failed with status ${status}`, {
      status,
      code,
      requestId,
      cause,
    });
  }

  /**
   * Build a `ScorezillaError` for a transport-level failure (no HTTP
   * response received): network error, abort, or timeout.
   */
  static network(message: string, cause: unknown): ScorezillaError {
    return new ScorezillaError(message, {
      status: STATUS_NETWORK_ERROR,
      code: 'network_error',
      cause,
    });
  }

  /** Build a `ScorezillaError` for an `AbortSignal`-triggered cancellation. */
  static aborted(cause: unknown): ScorezillaError {
    return new ScorezillaError('Request aborted', {
      status: STATUS_NETWORK_ERROR,
      code: 'aborted',
      cause,
    });
  }

  /** Build a `ScorezillaError` for a request that exceeded its timeout budget. */
  static timeout(timeoutMs: number): ScorezillaError {
    return new ScorezillaError(`Request timed out after ${timeoutMs}ms`, {
      status: STATUS_NETWORK_ERROR,
      code: 'timeout',
    });
  }
}

/** Default `code` for a given HTTP status when the body didn't parse as ApiError. */
function codeForStatus(status: number): ScorezillaErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 422) return 'out_of_bounds';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal_error';
  if (status >= 400) return 'invalid_input';
  return 'internal_error';
}
