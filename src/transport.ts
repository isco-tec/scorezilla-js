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
  /** Extra headers to merge on top of the SDK's defaults. The public-key
   *  client passes a static `Authorization: Bearer pk_*` here. Leave
   *  `Authorization` unset when using `signRequest` — the per-attempt
   *  hook owns that header. */
  headers?: Record<string, string> | undefined;
  /** Per-attempt request-signing hook. Called fresh on every fetch attempt
   *  (including each retry) with the canonicalized method, path-and-query,
   *  and body, returning the `Authorization` header value.
   *
   *  This is what the HMAC server adapter uses: each attempt needs a fresh
   *  timestamp + nonce, so a static header would burn replay-protection
   *  budget. The public-key client doesn't pass this — it uses `headers`
   *  with a static Bearer token instead. Mutually exclusive in practice. */
  signRequest?:
    | ((args: { method: HttpMethod; pathAndQuery: string; body: string }) => Promise<string>)
    | undefined;
  /** Injectable fetch — defaults to `globalThis.fetch`. */
  fetchImpl?: FetchImpl | undefined;
  /** Injectable warn sink for deprecation notices. Defaults to
   *  `console.warn`. Pass a function to route SDK warnings into your
   *  logger of choice, or pass `() => {}` to suppress them entirely.
   *  At million-integration scale, embedders shouldn't have to
   *  console-filter our deprecation messages.
   *
   *  Same signature as `console.warn`. The SDK never calls
   *  `warnImpl` for anything other than developer-visible deprecations. */
  warnImpl?: ((...args: unknown[]) => void) | undefined;
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
 * @typeParam T - the per-route success payload shape — always an
 *                `ApiSuccess<X> = { ok: true } & X`. The constraint enforces
 *                that `parseJson`'s discriminator check applies to every
 *                call site at compile time, with no escape hatch.
 */
export async function request<T extends { ok: true }>(opts: RequestOptions): Promise<T> {
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

    // Cleanup is structural, not positional: a `try { … } finally { cleanup }`
    // wrapper guarantees the per-attempt signal+timer is detached on EVERY
    // exit path — return, throw, or `continue`. The earlier implementation
    // called `cleanup()` at two positional points (after fetch, in catch);
    // any future early-exit added between them would silently leak listeners
    // and timers on a long-lived caller signal. The current shape is
    // resilient to that class of edit.
    try {
      // Serialize the body ONCE per attempt — both the fetch and the
      // signRequest hook need identical bytes. Re-stringifying inside
      // the signer would be a subtle correctness hazard if Date.now /
      // any non-deterministic field ever crept into body construction.
      const bodyString = opts.body !== undefined ? JSON.stringify(opts.body) : '';

      // Headers + Authorization. The HMAC signer (if present) wins —
      // per-attempt fresh signing is the contract for that auth mode.
      // Path-and-query fed to the signer must match what the server
      // will see (`/v1/...?...`), without the baseUrl origin prefix.
      const perAttemptHeaders = { ...(opts.headers ?? {}) };
      if (opts.signRequest) {
        perAttemptHeaders.Authorization = await opts.signRequest({
          method: opts.method,
          pathAndQuery: opts.path,
          body: bodyString,
        });
      }
      const init: RequestInit = {
        method: opts.method,
        headers: buildHeaders({ ...opts, headers: perAttemptHeaders }, idempotencyKey),
        signal: combined.signal,
      };
      if (opts.body !== undefined) {
        init.body = bodyString;
      }
      const response = await fetchImpl(url, init);

      if (response.ok) {
        // PR R: surface API-level deprecation signals (RFC 8594 Sunset +
        // IETF draft Deprecation headers). The server emits these when
        // a deprecated request shape is in use. We log a warning
        // exactly once per SDK process per (code-path) to avoid spam.
        warnOnDeprecationOnce(response, opts.warnImpl);
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

      // Map raw fetch failures to ScorezillaError. `combined.timedOut()`
      // remains queryable after cleanup — the boolean is captured in the
      // closure regardless of timer state — so this works correctly even
      // though the `finally` below has already run by the time we get here.
      const mapped = mapTransportError(caught, opts.signal, timeoutMs, combined);
      if (shouldRetryError(mapped) && attempt < maxRetries) {
        const delay = nextDelay(attempt, undefined, random);
        await retrySleep(delay);
        lastError = mapped;
        continue;
      }
      throw mapped;
    } finally {
      combined.cleanup();
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

/**
 * Parse a successful response body and assert it matches the success envelope.
 *
 * The `T extends { ok: true }` constraint reflects that every API success
 * payload is shaped `ApiSuccess<X> = { ok: true } & X`. Asserting the
 * discriminator at runtime catches a class of silent contract violations:
 * a server-side regression that omits `ok` or returns a non-object on a
 * 2xx would otherwise produce `undefined` on typed-as-required fields far
 * from this fetch site, with no error message that pointed back here.
 *
 * Three distinct failure modes all map to `code: 'invalid_json'`:
 *   1. JSON parse error (malformed body)
 *   2. Non-object body (`null`, array, primitive)
 *   3. Object missing `ok: true` discriminator
 *
 * `'invalid_json'` is documented as a transport-layer code in errors.ts
 * and ScorezillaErrorCode; consumers can `if (e.code === 'invalid_json')`
 * to detect API/SDK contract drift.
 */
async function parseJson<T extends { ok: true }>(response: Response): Promise<T> {
  const requestId = response.headers.get('X-Request-Id') ?? undefined;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new ScorezillaError('Response body was not valid JSON', {
      status: response.status,
      code: 'invalid_json',
      requestId,
      cause,
    });
  }

  if (parsed === null || typeof parsed !== 'object') {
    const observed = parsed === null ? 'null' : typeof parsed;
    throw new ScorezillaError(`Response body was not a JSON object (got ${observed})`, {
      status: response.status,
      code: 'invalid_json',
      requestId,
    });
  }

  // The `ok: true` discriminator must be present on a successful response.
  // If it isn't, the server has drifted from the API contract — surface
  // that as a typed error rather than letting the consumer's code crash on
  // `result.rank` being undefined three call frames away.
  const okField = (parsed as { ok?: unknown }).ok;
  if (okField !== true) {
    throw new ScorezillaError(
      `Response body on a 2xx is missing the \`ok: true\` discriminator (got ok=${String(okField)})`,
      {
        status: response.status,
        code: 'invalid_json',
        requestId,
      },
    );
  }

  return parsed as T;
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
 * PR R: emit a once-per-process warning when an API response carries
 * the `Deprecation` header (per IETF draft) or a `Sunset` header
 * (RFC 8594). The dedupe key is the (Deprecation + Sunset + Link)
 * triplet, so different deprecation signals across the SDK lifetime
 * each surface once but the SAME signal across many requests fires
 * once.
 *
 * Quiet by design: this is a developer warning, not a runtime error.
 * Production loops shouldn't see this unless the SDK is genuinely
 * out-of-date.
 */
const seenDeprecations = new Set<string>();
function warnOnDeprecationOnce(response: Response, warnImpl?: (...args: unknown[]) => void): void {
  const deprecation = response.headers.get('Deprecation');
  const sunset = response.headers.get('Sunset');
  if (!deprecation && !sunset) return;
  const link = response.headers.get('Link') ?? '';
  const key = `${deprecation ?? ''}|${sunset ?? ''}|${link}`;
  if (seenDeprecations.has(key)) return;
  seenDeprecations.add(key);

  const detail: string[] = [];
  if (deprecation === 'true' || deprecation) detail.push(`Deprecation: ${deprecation}`);
  if (sunset) detail.push(`Sunset: ${sunset}`);
  if (link) {
    // Pull the URL out of `<url>; rel="deprecation"` per RFC 8288.
    const m = link.match(/<([^>]+)>/);
    if (m) detail.push(`Docs: ${m[1]}`);
  }
  const message =
    `[scorezilla-sdk] API responded with deprecation signal: ${detail.join(' · ')}. ` +
    `Upgrade your SDK before the sunset date.`;
  // Inject point — embedders can route via warnImpl or suppress with `() => {}`.
  if (warnImpl) {
    warnImpl(message);
  } else {
    // eslint-disable-next-line no-console -- developer-facing warning, intentional
    console.warn(message);
  }
}

/**
 * Test-only: clear the seen-deprecations dedupe set so unit tests can
 * exercise the warn-once behavior across cases. Not exported from the
 * public entry point; reachable only via the internal transport module
 * from inside the package.
 */
export function __resetDeprecationDedupe(): void {
  seenDeprecations.clear();
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
