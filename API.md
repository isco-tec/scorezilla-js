# Scorezilla SDK — API Reference

> **Status:** The public-key client and the HMAC server adapter
> (`scorezilla/server` — incl. `createScoreSubmitHandler` + JWT verifiers) are
> stable; the `scorezilla/identity` presets ship in 0.3.0. See
> [CHANGELOG.md](./CHANGELOG.md) and [VERSIONING.md](./VERSIONING.md) for the
> release timeline and stability guarantees.

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
- `secretKey`: a single `sk_live_<keyId>_<random>` token (the keyId is embedded,
  so you manage one value). Server-side only — used by the `scorezilla/server`
  adapter to HMAC-sign the secure path. Never embed it in client code.

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

| Code                             | Status | Meaning                                                                                                                                               |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized`                   | 401    | Invalid `publicKey`.                                                                                                                                  |
| `forbidden`                      | 403    | Key is not bound to this `boardId`.                                                                                                                   |
| `origin_not_allowed`             | 403    | Request `Origin` is not in the board's allowlist (configured in the dashboard). Gates browser submits only — server-to-server calls send no `Origin`. |
| `player_banned`                  | 403    | The player is on this board's denylist (banned by the game owner).                                                                                    |
| `turnstile_required`             | 403    | The board requires a Cloudflare Turnstile token and none was sent.                                                                                    |
| `turnstile_failed`               | 403    | The supplied Turnstile token failed verification.                                                                                                     |
| `turnstile_hostname_mismatch`    | 403    | The Turnstile token was solved on an origin not allowed for this game.                                                                                |
| `not_found`                      | 404    | Board doesn't exist.                                                                                                                                  |
| `out_of_bounds`                  | 422    | Score outside the board's `[minScore, maxScore]`. `error.reason` is `'below_min'` or `'above_max'`; `error.bound` is the limit.                       |
| `rate_limited`                   | 429    | Throttled. `error.retryAfter` (seconds), `error.layer`.                                                                                               |
| `invalid_input` / `invalid_json` | 400    | Malformed body.                                                                                                                                       |
| `network_error`                  | 0      | Could not reach the API.                                                                                                                              |
| `timeout`                        | 0      | Request exceeded `timeoutMs`.                                                                                                                         |
| `aborted`                        | 0      | Caller-provided `AbortSignal` fired.                                                                                                                  |

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

`GET /v1/boards/:boardId/players/:playerId/rank`. "No entry yet" is a normal
result (`{ ranked: false }`), **not** an error — narrow on `ranked` before
reading `rank`. A `not_found` (404) is thrown only when the board doesn't exist.

```ts
interface GetPlayerRankInput {
  boardId: string;
  playerId: string;
}

type PlayerRankResponse =
  | {
      ok: true;
      boardId: string;
      playerId: string;
      ranked: true;
      rank: number;
      score: number;
      submittedAt: number;
      totalEntries: number;
    }
  | { ok: true; boardId: string; playerId: string; ranked: false; rank: null; score: null };
```

```ts
const r = await sz.getPlayerRank({ boardId, playerId });
if (r.ranked) console.log(`Rank ${r.rank} of ${r.totalEntries}`);
else console.log('No submission yet.');
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

## Server adapter (`scorezilla/server`)

The public-key client is client-authoritative — any player can submit any score
from devtools. For ranking-sensitive boards, sign submissions server-side with a
`sk_live_*` secret. Full recipes are in the
[README](./README.md#server-side-hmac-scorezillaserver); the surface:

### `Scorezilla` (server client)

```ts
import { Scorezilla } from 'scorezilla/server';

const sz = new Scorezilla({
  secretKey: process.env.SCOREZILLA_SECRET_KEY!, // sk_live_<keyId>_<random>
});
await sz.submitScore({ boardId, playerId, score, metadata });
```

Same methods as the public-key client (`submitScore`, `getLeaderboard`,
`getPlayerRank`, `getWindowAround`); each request is HMAC-SHA256 signed and
verified server-side. Server-only — importing it in a browser throws.

### `createScoreSubmitHandler(config)`

A framework-agnostic factory returning a `(Request) => Promise<Response>`
handler (Cloudflare Workers, Next route handlers, Hono, Deno, Bun). You supply
your auth via `verify`; it owns parsing/validation, signing, and error → HTTP
mapping.

```ts
import { createScoreSubmitHandler, verifySupabaseJwt } from 'scorezilla/server';

export const POST = createScoreSubmitHandler({
  secretKey: process.env.SCOREZILLA_SECRET_KEY!,
  boardId: process.env.SCOREZILLA_BOARD_ID!,
  verify: verifySupabaseJwt({ supabaseUrl: process.env.SUPABASE_URL! }),
});
```

| Option                                               | Type                                             | Notes                                                                               |
| ---------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `secretKey`                                          | `string`                                         | `sk_live_*`. Required.                                                              |
| `boardId`                                            | `string`                                         | Required.                                                                           |
| `verify`                                             | `(req) => { playerId, metadata? } \| null`       | Required. The submitted `playerId` always comes from here — never the request body. |
| `parseSubmission?`                                   | `(req) => { score, metadata? } \| null`          | Defaults to JSON `{ score, metadata? }`.                                            |
| `rateLimit?`                                         | `(req) => { ok, retryAfterSeconds? }`            | Runs **before** `verify`.                                                           |
| `cors?`                                              | `{ origin, methods?, headers?, maxAgeSeconds? }` | OPTIONS preflight + reflected `Access-Control-Allow-Origin`.                        |
| `baseUrl?` · `fetch?` · `maxRetries?` · `timeoutMs?` |                                                  | Pass-through to the server client.                                                  |

### JWT verifiers

Built-in `verify` helpers — each returns `(req) => Promise<{ playerId } | null>`.
They require the optional peer dependency `jose` (loaded lazily; only consumers
of a verifier install it).

```ts
import {
  verifyJwt, // generic JWKS: { jwksUrl, issuer, audience, claim? }
  verifySupabaseJwt, // { supabaseUrl }
  verifyClerkJwt, // { issuer }
  verifyAuth0Jwt, // { domain, audience }
  verifyFirebaseIdToken, // { projectId }
} from 'scorezilla/server';
```

For non-JWKS auth (Auth.js JWE sessions, opaque sessions, provider backend
SDKs), write your own `verify` — anything returning `{ playerId }` works. See
[RECIPES.md](./RECIPES.md) for worked recipes.

### `createGitHubOAuthHandler(config)`

The server half of `useAuthProvider({ provider: 'github' })` (see the
identity section below): a `(Request) => Promise<Response>` callback endpoint
that exchanges GitHub's OAuth `code` (the client secret stays server-side),
resolves the user id, and hands `{ id }` back to the sign-in popup via a
`postMessage` pinned to your game's origin. Deploy it anywhere that speaks
web `Request`/`Response`, and register its URL as the OAuth app's callback
URL on GitHub.

| Option          | Type     | Notes                                                               |
| --------------- | -------- | ------------------------------------------------------------------- |
| `clientId`      | `string` | Your GitHub OAuth app client ID. Required.                          |
| `clientSecret`  | `string` | Server-only. Required.                                              |
| `allowedOrigin` | `string` | Exact origin of the game page (the `postMessage` target). Required. |
| `fetch?`        |          | Inject a fetch (testing / custom transport).                        |

## Identity presets (`scorezilla/identity`)

Browser-side helpers producing the `playerId` for `submitScore`. All of them
are **client-authoritative** — see the trust-boundary note in the
[README](./README.md#player-identity-scorezillaidentity); for spoof-proof
identity use the secure path above.

```ts
import {
  useAnonymousPlayer, // { storageKey } → PlayerHandle (UUID, persisted)
  usePromptedPlayer, // { storageKey, prompt } → Promise<PlayerHandle>
  useServerAuthoritative, // () → marker; playerId comes from your server
  useAuthProvider, // OAuth sign-in → Promise<AuthPlayerHandle | null>
} from 'scorezilla/identity';
```

### `useAuthProvider(options)`

Discriminated on `provider`:

| Provider   | Options                                 | Flow                                                                  |
| ---------- | --------------------------------------- | --------------------------------------------------------------------- |
| `'google'` | `clientId`, `storageKey`, `autoSelect?` | Google Identity Services One Tap, client-only                         |
| `'github'` | `clientId`, `exchangeUrl`, `storageKey` | Popup → your deployed `createGitHubOAuthHandler` endpoint (see above) |

Resolves an `AuthPlayerHandle` (`{ id, provider, source, signOut() }`) — or
`null` when the player **declines** (dismissed One Tap, cancelled on GitHub,
closed the popup). Throws only on genuine failures (invalid arguments, popup
blocked, exchange endpoint failure). `source: 'restored'` means the id was
rehydrated from `localStorage` without a fresh provider interaction.

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
