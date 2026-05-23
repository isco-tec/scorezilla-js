---
'scorezilla': patch
---

**Error mapping, retry-policy alignment, and `AbortSignal` plumbing.**

Three small but user-visible correctness fixes driven by the in-house review:

- `ScorezillaError.code` now resolves to `'conflict'` on 409 responses (was incorrectly falling back to `'invalid_input'`). The error type already listed `'conflict'` as a valid code; the gap was in the status→code mapper. A new `e.isConflict()` predicate joins the existing `isAuth() / isNotFound() / isRateLimited() / isOutOfBounds() / isUsageCapExceeded() / isTransient()` family.

- `e.isTransient()` no longer flags `timeout` or `aborted` as transient. Those are caller-observable terminal states, not retryable conditions — and the SDK's own `shouldRetryError` policy never retries on them. The predicate is now aligned with the transport's actual retry policy, so consumer code mirroring "if (e.isTransient()) retry()" no longer loops on timeouts.

- All four public methods (`submitScore`, `getLeaderboard`, `getPlayerRank`, `getWindowAround`) now accept an optional `signal?: AbortSignal` and forward it into the transport. This unblocks request-cancellation propagation under frameworks that thread cancellation through the request lifecycle (Next.js route handlers, Hono, Express middleware, React effect cleanup).

No behavior change for callers that didn't depend on the two buggy classifications and didn't need cancellation.
