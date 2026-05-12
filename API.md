# Scorezilla SDK — API Reference

> **Status:** v0.1.0 (public-key client). The HMAC server adapter
> (`scorezilla/server`) ships in v0.2.0; React adapter in v0.3.0; Phaser in
> v0.4.0. See [CHANGELOG.md](./CHANGELOG.md) and
> [VERSIONING.md](./VERSIONING.md) for the release timeline and stability
> guarantees.

## Quick start

```ts
import { Scorezilla } from 'scorezilla';

const sz = new Scorezilla({ publicKey: 'pk_mygame_aBcDeF…' });

const r = await sz.submitScore({
  boardId: 'board-uuid',
  playerId: 'player-uuid',
  score: 9001,
});
console.log(r.rank, r.isPersonalBest);
```

## Configuration

The constructor takes a `ScorezillaConfig`. Pass `publicKey` for client-side
use; the SDK throws if you pass `secretKey` (use the `scorezilla/server` adapter
from v0.2.0).

```ts
interface BaseConfig {
  /** API base URL. Defaults to `https://api.scorezilla.dev`. */
  baseUrl?: string;
  /** Custom fetch (node-fetch, undici, mock). Defaults to globalThis.fetch. */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Per-request timeout in ms. Default 30 000. */
  timeoutMs?: number;
  /** Maximum retry attempts on transient failures. Default 2. */
  maxRetries?: number;
  /** Override the default User-Agent header. */
  userAgent?: string;
}

type PublicKeyConfig = BaseConfig & { publicKey: string; secretKey?: never };

type ScorezillaConfig = PublicKeyConfig /* | SecretKeyConfig — v0.2.0 */;
```

### Key format

- `publicKey`: `pk_<game-slug>_<base62-suffix>`. Issued by the operator
  dashboard. Safe to embed in browser code.
- `secretKey` (v0.2.0+): `{ id: string, secret: 'sk_live_…' }`. Server-side
  only. Used to compute HMAC signatures for the secure path.

### Mutual exclusivity

Passing both `publicKey` and `secretKey` is a TypeScript error. Passing neither
throws at runtime.

## Methods

All methods are `async` and return parsed, typed responses on success. Every
failure path — HTTP non-2xx, network error, timeout, abort, JSON parse error —
throws a single error type, [`ScorezillaError`](#errors).

### `submitScore`

`POST /v1/boards/:boardId/scores`. Submits a score for a player. The API
authoritatively decides if the new score is a personal best.

```ts
interface SubmitScoreInput {
  boardId: string;
  playerId: string; // ← The only accepted key (no `player` alias).
  score: number; // Finite. NaN / Infinity rejected as invalid_input.
  metadata?: Record<string, unknown>; // ≤ 4 KB UTF-8, JSON-serializable.
}

interface SubmitScoreResponse {
  ok: true;
  boardId: string;
  keyId: string; // The publicKey ID that authorized the submission.
  rank: number; // 1-based, after the submit settles.
  totalEntries: number;
  isPersonalBest: boolean;
}

const r = await sz.submitScore({
  boardId: 'board-uuid',
  playerId: 'alice',
  score: 9001,
  metadata: { level: 'hard', completionMs: 27_400 },
});
if (r.isPersonalBest) {
  console.log(`New PB! Rank ${r.rank} of ${r.totalEntries}`);
}
```

#### Metadata constraints

- Must be a **plain object** (arrays / primitives / null rejected).
- Values must be JSON-serializable: no `function`, `symbol`, or `bigint`.
- No circular references.
- ≤ **4096 UTF-8 bytes** when JSON-stringified (the byte count is what matters —
  emoji weigh ~4 bytes each).

Violations throw a plain `Error` (not `ScorezillaError`) before any network call
— these are caller bugs, not API failures.

#### Errors

| Code                             | Status | Meaning                                                                                                                         |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized`                   | 401    | Invalid `publicKey`.                                                                                                            |
| `forbidden`                      | 403    | Key is not bound to this `boardId`.                                                                                             |
| `not_found`                      | 404    | Board doesn't exist.                                                                                                            |
| `out_of_bounds`                  | 422    | Score outside the board's `[minScore, maxScore]`. `error.reason` is `'below_min'` or `'above_max'`; `error.bound` is the limit. |
| `rate_limited`                   | 429    | Throttled. `error.retryAfter` (seconds), `error.layer`.                                                                         |
| `invalid_input` / `invalid_json` | 400    | Malformed body.                                                                                                                 |
| `network_error`                  | 0      | Could not reach the API.                                                                                                        |
| `timeout`                        | 0      | Request exceeded `timeoutMs`.                                                                                                   |
| `aborted`                        | 0      | Caller-provided `AbortSignal` fired.                                                                                            |

### `getLeaderboard`

`GET /v1/boards/:boardId/leaderboard?top=&offset=`.

```ts
interface GetLeaderboardInput {
  boardId: string;
  top?: number; // API caps at 1000; default 100.
  offset?: number; // API caps at 1_000_000; default 0.
}

interface LeaderboardResponse {
  ok: true;
  boardId: string;
  offset: number;
  limit: number;
  entries: RankedEntry[];
}

interface RankedEntry {
  rank: number; // 1-based.
  playerId: string;
  score: number;
  submittedAt: number; // Milliseconds since epoch.
  metadata?: Record<string, unknown>;
}

const { entries } = await sz.getLeaderboard({ boardId, top: 25 });
for (const e of entries) console.log(`${e.rank}. ${e.playerId}: ${e.score}`);
```

### `getPlayerRank`

`GET /v1/boards/:boardId/players/:playerId/rank`. Returns 404 (`not_found`) if
the player has no submission yet.

```ts
interface GetPlayerRankInput {
  boardId: string;
  playerId: string;
}

interface PlayerRankResponse {
  ok: true;
  boardId: string;
  playerId: string;
  rank: number;
  score: number;
  submittedAt: number;
  totalEntries: number;
}
```

### `getWindowAround`

`GET /v1/boards/:boardId/players/:playerId/window?before=&after=`. Returns the
slice of entries surrounding a player.

```ts
interface GetWindowAroundInput {
  boardId: string;
  playerId: string;
  before?: number; // API caps at 100; default 5.
  after?: number; // API caps at 100; default 5.
}

interface WindowAroundResponse {
  ok: true;
  boardId: string;
  playerId: string;
  before: number;
  after: number;
  entries: RankedEntry[];
}
```

## Errors

The SDK throws a single error type, `ScorezillaError`, for every failure mode.

```ts
class ScorezillaError extends Error {
  /** HTTP status of the response, or 0 for network/abort/timeout. */
  readonly status: number;
  /** Machine-stable code — see the table above. */
  readonly code: ScorezillaErrorCode;
  /** Sub-classifier — present on out_of_bounds (`below_min`/`above_max`). */
  readonly reason: string | undefined;
  /** Seconds — present on rate_limited (also Retry-After header). */
  readonly retryAfter: number | undefined;
  /** Server-issued request ID for support tickets. */
  readonly requestId: string | undefined;
  /** Bound that was crossed — present on out_of_bounds. */
  readonly bound: number | undefined;
  /** Which rate-limit layer fired — present on rate_limited. */
  readonly layer: string | undefined;
  /** Underlying cause (TypeError, DOMException, …) for transport failures. */
  readonly cause: unknown;

  isRateLimited(): boolean;
  isAuth(): boolean; // unauthorized OR forbidden
  isNotFound(): boolean;
  isOutOfBounds(): boolean;
  isTransient(): boolean; // network_error, timeout, 5xx, 429
}
```

### Branching pattern

**Always branch on `code`** — `message` is English-only and NOT part of the
SemVer contract (a minor release may reword any text).

```ts
try {
  await sz.submitScore({ boardId, playerId, score });
} catch (e) {
  if (!(e instanceof ScorezillaError)) throw e;

  if (e.isRateLimited()) {
    await sleep(e.retryAfter! * 1000);
    return retry();
  }
  if (e.code === 'out_of_bounds') {
    console.warn(`Score outside ${e.reason} bound (limit ${e.bound})`);
    return;
  }
  if (e.isAuth()) {
    throw new Error('SDK is misconfigured — bad publicKey');
  }
  throw e;
}
```

## Advanced

### Custom fetch / polyfills

```ts
import fetch from 'node-fetch';
const sz = new Scorezilla({ publicKey, fetch });
```

The signature is intentionally broader than `typeof fetch` so `node-fetch`,
`undici`, `vi.fn()`, and other polyfills typecheck cleanly.

### AbortController

Every method accepts the SDK's internal abort signal. To cancel from your own
code, configure a global `signal` on construction — TODO in v0.2.x; for v0.1.0,
set a short `timeoutMs` per construction.

### Idempotency keys

Every `POST` (i.e., `submitScore`) gets an automatic `Idempotency-Key` header
(UUID v4). The same key is reused across the SDK's internal retry attempts, so
server-side dedup (when added) is safe by default.

To control idempotency across your own retry loop, pass a fixed
`Idempotency-Key` via the `headers` field of `RequestOptions` — TODO public on
the client class in a follow-up release.

### Custom User-Agent

```ts
const sz = new Scorezilla({
  publicKey,
  userAgent: 'my-game/2.0',
});
```

Note: browsers silently ignore the `User-Agent` header per the Fetch spec. The
SDK also sets `X-Scorezilla-Client` (which browsers do honor) to the same value
for cross-runtime telemetry parity.

## See also

- [README.md](./README.md) — install + quickstart
- [VERSIONING.md](./VERSIONING.md) — SemVer contract + deprecation policy
- [CHANGELOG.md](./CHANGELOG.md) — release history
- [Scorezilla operator dashboard](https://dashboard.scorezilla.dev) — manage
  games + keys
