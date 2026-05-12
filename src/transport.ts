/**
 * HTTP transport for the Scorezilla SDK.
 *
 * Single entry point — {@link request} — wraps `fetch` with the SDK's
 * cross-cutting concerns:
 *   • JSON serialization / parsing
 *   • Idempotency-Key on retried POSTs (same key reused across attempts)
 *   • Retry loop with exponential backoff + jitter on 5xx / 429 / network
 *   • `Retry-After` honored when ≤ {@link MAX_RETRY_AFTER_SEC}
 *   • Combined AbortSignal: caller-supplied + per-call timeout budget
 *   • Uniform {@link ScorezillaError} for every failure path
 *
 * The function is fully fetch-impl-injectable so it tests cleanly with a
 * stub. No Node-only APIs; runs in browsers, Node, Workers, Bun, Deno.
 */

import { ScorezillaError } from './errors';
import {
  DEFAULT_MAX_RETRIES,
  generateIdempotencyKey,
  nextDelay,
  shouldRetryError,
  shouldRetryStatus,
  sleep,
} from './retry';
import type { ApiError, ApiResponse } from './types';

/** Default per-request timeout budget in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** HTTP methods the SDK issues. */
export type HttpMethod = 'GET' | 'POST' | 'DELETE';

/** Minimal fetch shape — broader than `typeof fetch` so polyfills and
 *  test stubs (`vi.fn()`, `node-fetch`, etc.) typecheck cleanly. */
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Options for {@link request}. */
export interface RequestOptions {
  /** Base URL — typically the API origin, no trailing slash. */
  baseUrl: string;
  /** Path with leading `/` — typically built via the helpers in `src/paths.ts`. */
  path: string;
  /** HTTP method. */
  method: HttpMethod;
  /** Request body to JSON-stringify. `undefined` → no body, no Content-Type. */
  body?: Record<string, unknown> | undefined;
  /** Extra headers to merge on top of the SDK's defaults. The client layer
   *  passes `Authorization` here. */
  headers?: Record<string, string> | undefined;
  /** Injectable fetch — defaults to `globalThis.fetch`. */
  fetchImpl?: FetchImpl | undefined;
  /** Caller-supplied AbortSignal — composed with the SDK's internal timeout signal. */
  signal?: AbortSignal | undefined;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
  /** Retry policy overrides. */
  retry?:
    | {
        maxRetries?: number | undefined;
        /** Injectable RNG for jitter — used by tests for deterministic delays. */
        random?: (() => number) | undefined;
        /** Injectable sleep — used by tests to advance time without real waits. */
        sleepImpl?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
      }
    | undefined;
}

/**
 * Make an HTTP request and return the parsed JSON body on success.
 *
 * Throws {@link ScorezillaError} on:
 *   • non-2xx response (with status, code, reason, retryAfter, requestId)
 *   • network failure (`code: 'network_error'`)
 *   • timeout (`code: 'timeout'`)
 *   • abort via caller's signal (`code: 'aborted'`)
 *   • response JSON parsing failure (`code: 'invalid_json'`)
 *
 * @typeParam T - the per-route success payload shape (e.g., `SubmitScoreResponse`).
 */
export async function request<T>(opts: RequestOptions): Promise<T> {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'scorezilla: globalThis.fetch is unavailable. ' +
        'Either upgrade your runtime (Node ≥ 20 has fetch built in) or pass `fetch: yourFetch` in the SDK config.',
    );
  }

  const url = buildUrl(opts.baseUrl, opts.path);
  const maxRetries = opts.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const random = opts.retry?.random ?? Math.random;
  const sleepImpl = opts.retry?.sleepImpl ?? sleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `scorezilla: timeoutMs must be a positive finite number (got ${String(timeoutMs)})`,
    );
  }

  // Wrapped retry sleep — if the caller's signal aborts during the inter-attempt
  // pause, the raw rejection (typically a DOMException) would otherwise leak
  // out of request() unwrapped. Normalize every abort path to a ScorezillaError.
  const retrySleep = async (delay: number): Promise<void> => {
    try {
      await sleepImpl(delay, opts.signal);
    } catch (cause) {
      throw ScorezillaError.aborted(cause);
    }
  };

  // Idempotency-Key is generated ONCE per logical request and reused across
  // all retry attempts. This makes server-side dedup (if/when added) safe:
  // the same logical write maps to one key, multiple network attempts.
  // GET / DELETE are already idempotent; no key needed.
  const idempotencyKey = opts.method === 'POST' ? generateIdempotencyKey() : null;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const combined = combineSignalsWithTimeout(opts.signal, timeoutMs);

    try {
      const init: RequestInit = {
        method: opts.method,
        headers: buildHeaders(opts, idempotencyKey),
        signal: combined.signal,
      };
      if (opts.body !== undefined) {
        init.body = JSON.stringify(opts.body);
      }
      const response = await fetchImpl(url, init);

      combined.cleanup();

      if (response.ok) {
        return await parseJson<T>(response);
      }

      // Non-2xx — try to parse the error body for structured fields.
      const body = await safelyParseErrorBody(response);
      const err = ScorezillaError.from({
        status: response.status,
        body,
        requestId: response.headers.get('X-Request-Id') ?? undefined,
      });

      if (shouldRetryStatus(response.status) && attempt < maxRetries) {
        const retryAfter = readRetryAfter(response);
        const delay = nextDelay(attempt, retryAfter, random);
        await retrySleep(delay);
        lastError = err;
        continue;
      }

      throw err;
    } catch (caught: unknown) {
      combined.cleanup();

      // ScorezillaError thrown by our own logic above (already typed) —
      // either retry or rethrow per the retry policy.
      if (caught instanceof ScorezillaError) {
        if (shouldRetryError(caught) && attempt < maxRetries) {
          const delay = nextDelay(attempt, undefined, random);
          await retrySleep(delay);
          lastError = caught;
          continue;
        }
        throw caught;
      }

      // Map raw fetch failures to ScorezillaError.
      const mapped = mapTransportError(caught, opts.signal, timeoutMs, combined);
      if (shouldRetryError(mapped) && attempt < maxRetries) {
        const delay = nextDelay(attempt, undefined, random);
        await retrySleep(delay);
        lastError = mapped;
        continue;
      }
      throw mapped;
    }
  }

  // Unreachable in practice — every loop iteration either returns, throws,
  // or `continue`s. Keep as a typed fallback for the compiler.
  throw (
    lastError ??
    new ScorezillaError('Request failed after retries', {
      status: 0,
      code: 'internal_error',
    })
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function buildUrl(baseUrl: string, path: string): string {
  // Trim a single trailing slash from baseUrl so `baseUrl + path` doesn't
  // produce double slashes. Path is expected to start with `/` (enforced by
  // the path-helper functions).
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return base + path;
}

function buildHeaders(opts: RequestOptions, idempotencyKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (idempotencyKey !== null) {
    headers['Idempotency-Key'] = idempotencyKey;
  }
  // Caller-supplied headers (e.g., Authorization) override defaults. The
  // client layer is trusted; this is a public-API style merge, not security.
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers[k] = v;
  }
  return headers;
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new ScorezillaError('Response body was not valid JSON', {
      status: response.status,
      code: 'invalid_json',
      requestId: response.headers.get('X-Request-Id') ?? undefined,
      cause,
    });
  }
}

async function safelyParseErrorBody(response: Response): Promise<ApiError | undefined> {
  // Error responses may legitimately have empty body (e.g., some 5xx).
  // We try to parse, but a parse failure is non-fatal here — the caller
  // gets a status-derived code via ScorezillaError.from.
  try {
    const json = (await response.json()) as ApiResponse<unknown>;
    if (json && typeof json === 'object' && 'ok' in json && json.ok === false) {
      return json;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Compose the caller's signal with a fresh timeout signal, returning a
 * single signal to pass to fetch plus a `cleanup` to detach the listeners.
 *
 * Implemented manually (not `AbortSignal.any`) because Safari 17.0–17.3
 * lacks that primitive. The cleanup is essential — without it, a long-lived
 * caller signal accumulates listeners every retry.
 */
function combineSignalsWithTimeout(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let didTimeOut = false;

  if (caller?.aborted) {
    ctrl.abort(caller.reason);
    return { signal: ctrl.signal, cleanup: () => {}, timedOut: () => false };
  }

  const onCallerAbort = (): void => {
    ctrl.abort(caller?.reason);
  };
  caller?.addEventListener('abort', onCallerAbort, { once: true });

  const timer = setTimeout(() => {
    didTimeOut = true;
    ctrl.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);

  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
    timedOut: () => didTimeOut,
  };
}

function mapTransportError(
  caught: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  combined: { timedOut: () => boolean },
): ScorezillaError {
  // If the caller's signal aborted, that wins (most specific).
  if (callerSignal?.aborted) {
    return ScorezillaError.aborted(callerSignal.reason ?? caught);
  }
  // If our internal timeout fired, surface that.
  if (combined.timedOut()) {
    return ScorezillaError.timeout(timeoutMs);
  }
  // Generic fetch-throws-everything path: TypeErrors, DOMExceptions, etc.
  const message = caught instanceof Error ? caught.message : 'Network request failed';
  return ScorezillaError.network(message, caught);
}
