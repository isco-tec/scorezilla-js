/**
 * Retry + backoff helpers used by the HTTP transport (src/transport.ts).
 *
 * Pure where possible — `nextDelay` and the predicate functions take no
 * side effects, so they're unit-testable without time mocks. The only
 * impure helpers are {@link sleep} and {@link generateIdempotencyKey},
 * both isolated so callers can swap them in tests.
 */

import { ScorezillaError } from './errors';

/** Default cap on retry attempts (does not include the initial attempt). */
export const DEFAULT_MAX_RETRIES = 2;

/** Base delay for exponential backoff, in milliseconds. */
export const BASE_DELAY_MS = 200;

/** Hard ceiling on per-attempt backoff, in milliseconds. */
export const MAX_DELAY_MS = 4_000;

/**
 * Maximum `Retry-After` value (in seconds) the SDK will honor. A misbehaving
 * server returning `Retry-After: 86400` won't park the caller for a day —
 * we treat anything over this as transient and fall back to exponential
 * backoff. The transport surfaces a `ScorezillaError` on the next attempt
 * if the server still rejects.
 */
export const MAX_RETRY_AFTER_SEC = 30;

/**
 * Pure: compute the delay (in milliseconds) before the next retry.
 *
 * The algorithm is "decorrelated exponential" backoff: `BASE_DELAY_MS *
 * 2^attempt` capped at `MAX_DELAY_MS`, multiplied by a jitter factor in
 * `[0.5, 1.0]` to avoid thundering-herd retries from clients that all
 * receive the same 5xx at the same moment.
 *
 * If `retryAfterSec` is provided and `<= MAX_RETRY_AFTER_SEC`, that wins
 * over the exponential schedule (the server has told us a specific wait).
 * Values over the cap are ignored — we fall back to exponential.
 *
 * @param attempt        Zero-based retry index (0 = first retry, 1 = second, …).
 * @param retryAfterSec  `Retry-After` header value in seconds, if any.
 * @param random         Injectable RNG for jitter — defaults to `Math.random`.
 *                       Pass a deterministic stub in tests.
 */
export function nextDelay(
  attempt: number,
  retryAfterSec: number | undefined,
  random: () => number = Math.random,
): number {
  if (
    typeof retryAfterSec === 'number' &&
    Number.isFinite(retryAfterSec) &&
    retryAfterSec >= 0 &&
    retryAfterSec <= MAX_RETRY_AFTER_SEC
  ) {
    return Math.round(retryAfterSec * 1000);
  }

  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitterFactor = 0.5 + random() * 0.5; // [0.5, 1.0]
  return Math.round(exponential * jitterFactor);
}

/**
 * Pure: should an HTTP status code trigger a retry?
 *
 * 429 (rate limited) and 5xx (server error) are retryable. 4xx other than
 * 429 are caller errors and never retried — they won't succeed on
 * re-attempt and would waste budget.
 */
export function shouldRetryStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Pure: should a thrown error trigger a retry?
 *
 * A network-level failure (no HTTP response) is retryable. Timeouts are
 * NOT retried by default — the caller set the budget intentionally; retrying
 * would extend it past their intent. Aborts are never retried (signal was
 * explicit).
 */
export function shouldRetryError(err: unknown): boolean {
  if (err instanceof ScorezillaError) {
    return err.code === 'network_error';
  }
  return false;
}

/**
 * Generate an idempotency key for a POST request.
 *
 * Note: the workplan refers to "UUID v7" but `crypto.randomUUID()` returns
 * v4 universally (Node 19+, all modern browsers, Workers, Bun, Deno). v4 is
 * the correct choice for an idempotency key — we need uniqueness, not
 * time-ordering. v7's time prefix offers no benefit for keys that live for
 * one request lifetime.
 *
 * Throws if `crypto.randomUUID` isn't available on the platform — that's
 * always a misconfiguration (the SDK declares Node ≥ 20 / modern browsers
 * in `engines`).
 */
export function generateIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c || typeof c.randomUUID !== 'function') {
    throw new Error(
      'scorezilla: globalThis.crypto.randomUUID is unavailable. ' +
        'The SDK requires Node ≥ 20 or a modern browser. Check your runtime.',
    );
  }
  return c.randomUUID();
}

/**
 * Sleep for `ms` milliseconds. Aborts immediately if the provided
 * `AbortSignal` fires — the returned promise rejects with the signal's
 * `reason` so the transport can map it to {@link ScorezillaError.aborted}.
 *
 * The handler unhooks itself when the timer settles, so a long-lived
 * signal can be reused across many sleeps without leaking listeners.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
