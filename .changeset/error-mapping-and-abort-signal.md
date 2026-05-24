---
'scorezilla': patch
---

**Error mapping, retry-policy alignment, `AbortSignal` plumbing, injectable warn, validator-return tightening.**

Bundled correctness + ergonomics fixes from the in-house improvement-phase review:

- `ScorezillaError.code` now resolves to `'conflict'` on HTTP 409 responses (previously fell through to `'invalid_input'`). The error type already listed `'conflict'` as a valid code; the gap was in the status→code mapper. A new `e.isConflict()` predicate joins the existing `isAuth() / isNotFound() / isRateLimited() / isOutOfBounds() / isUsageCapExceeded() / isTransient()` family.

- `e.isTransient()` no longer flags `timeout` or `aborted` as transient — those are caller-observable terminal states, not retryable. The predicate is now aligned with the transport's actual retry policy (`shouldRetryError` in `retry.ts`), so consumer code mirroring "if (e.isTransient()) retry()" no longer loops on timeouts.

- All four public methods on **both** the public-key client (`Scorezilla`) and the secret-key server adapter (`Scorezilla` from `scorezilla/server`) now accept an optional `signal?: AbortSignal` via a shared `CancellableInput` shape, and forward it through the transport. Unblocks request-cancellation propagation under frameworks that thread cancellation through the request lifecycle (Next.js route handlers, Hono, Express middleware, React effect cleanup).

- New `warn?: (...args: unknown[]) => void` field on `ScorezillaConfig`. Defaults to `console.warn`. Pass your logger to route SDK deprecation notices into your observability stack, or pass `() => {}` to suppress them. Used today only for the `Deprecation` / `Sunset` once-per-process warning emitted when the API signals an upcoming sunset — at million-integration scale, embedders shouldn't have to console-filter our messages.

- `validateMetadata` now returns the serialized JSON string it computed (previously declared `void` despite a comment that claimed otherwise). Public callers that re-stringify metadata can reuse the value and skip a duplicate `JSON.stringify` pass on the hot submit path.

No breaking changes for callers that didn't rely on the two buggy classifications, didn't need cancellation, and didn't read `validateMetadata`'s return value.
