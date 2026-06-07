# Changelog

## 0.3.0

### Minor Changes

- [#45](https://github.com/isco-tec/scorezilla-js/pull/45) [`1a1e625`](https://github.com/isco-tec/scorezilla-js/commit/1a1e625cc6aff058071f922c7c5a619efa80ddc8) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(identity): ship the GitHub provider for `useAuthProvider` (scorezilla#194)

  The GitHub option is real (and final, per ADR 0009): a popup OAuth web flow
  on the client plus a turnkey server-side token exchange.
  - `useAuthProvider({ provider: 'github', clientId, exchangeUrl, storageKey })`
    — opens the GitHub sign-in popup, validates the callback by origin + state,
    resolves `github:<id>` (or `null` on decline). The provisional option shape
    is finalized: `clientId`, `exchangeUrl`, and `storageKey` are all required.
  - `createGitHubOAuthHandler({ clientId, clientSecret, allowedOrigin })` (new
    in `scorezilla/server`) — the deployable callback endpoint: exchanges the
    code (secret stays server-side), resolves the user id, posts it back to the
    game's origin, closes the popup. The access token never reaches the browser.
  - size-limit: server caps 7 → 8 KB (documented); new tree-shaking proof pins
    that adapter-only consumers pay for neither factory.

- [#39](https://github.com/isco-tec/scorezilla-js/pull/39) [`608137f`](https://github.com/isco-tec/scorezilla-js/commit/608137f2a880fd3b9031cde8de765a5262d6c334) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(identity): ship the Google provider for `useAuthProvider`

  `useAuthProvider({ provider: 'google', clientId, storageKey })` is now
  implemented and **stable**. It wraps Google Identity Services ("One Tap"),
  derives a stable, opaque player id from the account's `sub` claim
  (`google:<sub>`), and persists it in `localStorage` so returning visitors are
  recognized without signing in again.

  ```ts
  import { Scorezilla } from 'scorezilla';
  import { useAuthProvider } from 'scorezilla/identity';

  const player = await useAuthProvider({
    provider: 'google',
    clientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
    storageKey: 'mygame:player',
  });

  if (player) {
    const sz = new Scorezilla({ publicKey: 'pk_…' });
    await sz.submitScore({ boardId, playerId: player.id, score: 42 });
    // player.signOut() clears the persisted id and disables Google auto-select.
  }
  ```

  - **Resolves `null` when the player declines** or One Tap can't be shown — a
    dismissed sign-in is not an error. It **rejects** only on genuine failures
    (invalid args, script load failure, malformed credential).
  - **`handle.source`** is `'signed-in'` for a fresh sign-in or `'restored'` when
    the id was rehydrated from `localStorage` (a restored id is not a re-verified
    live session).
  - **Bring your own client ID.** The SDK never bundles Scorezilla-owned OAuth
    credentials, so revocation and consent stay under your control.
  - **Privacy.** Only the derived `sub`-based id is stored and transmitted on
    score submission — never the Google credential, email, or profile.
  - **Bundle.** The Google provider tree-shakes out for consumers who don't call
    `useAuthProvider`; the Google Identity Services library is loaded at runtime
    from `accounts.google.com`, never bundled.
  - `useAuthProvider` is now async (replacing the `0.3.0-next.0` preview stub that
    threw synchronously). Despite the `use*` name it is **not** a React hook.
    Identity errors are plain `Error`/`TypeError` (not `ScorezillaError`), keeping
    the `scorezilla/identity` subpath dependency-free. The host page's CSP must
    allow `https://accounts.google.com`.
  - The **GitHub** provider is not available yet — it ships in a follow-up and
    will require a server-side token exchange (your backend or a Scorezilla
    Workers proxy). Calling `useAuthProvider({ provider: 'github' })` rejects
    with guidance until then.

- [#36](https://github.com/isco-tec/scorezilla-js/pull/36) [`19c2dcc`](https://github.com/isco-tec/scorezilla-js/commit/19c2dcc14d2000551d80498813b075172c8f4d66) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(identity): preset helpers for `scorezilla/identity` (Phase 1)

  New subpath export: `scorezilla/identity`. Three identity-strategy
  presets ship as `stable`; one OAuth helper ships as a preview stub.

  **Stable in this release:**
  - `useAnonymousPlayer({ storageKey })` — generates a UUID, persists in
    localStorage, same browser keeps the same id across reloads. Returns
    `{ id, forget() }`. Privacy-safe by default (no PII).
  - `usePromptedPlayer({ storageKey, prompt })` — `window.prompt()` on
    first run, persists to localStorage. Returns `{ id, forget() } | null`
    (null when SSR, no `prompt`, or user cancels).
  - `useServerAuthoritative()` — no-op marker for snippets using the
    HMAC-signed secure path (`scorezilla/server`). The browser SDK does
    no identity work; the server picks the value.

  **Preview stub in this release (throws on call):**
  - `useAuthProvider({ provider: 'google' | 'github' })` — OAuth-backed
    identity. Full implementation (Google + GitHub for v1) ships in a
    follow-up `next` release before the 0.3.0 latest promote.

  Per [ADR 0003](https://github.com/isco-tec/scorezilla/blob/main/docs/adr/0003-mcp-identity-axis.md). All helpers document where data is stored and
  what `forget()` / `signOut()` does NOT do (server-side history is
  retained — call admin delete-player for full erasure).

  Closes upstream tracking issue isco-tec/scorezilla#125 (Phase 1).

- [#41](https://github.com/isco-tec/scorezilla-js/pull/41) [`e48a5a2`](https://github.com/isco-tec/scorezilla-js/commit/e48a5a2f09cd0f098e8466b51586bd4108bb5678) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(server): `createScoreSubmitHandler()` — turnkey secure score submissions

  A framework-agnostic factory in `scorezilla/server` that collapses the secure
  (HMAC-signed) submission path from ~150 lines of boilerplate into a few. It
  returns a standard `(Request) => Promise<Response>` handler — drop it into a
  Cloudflare Worker, a Next.js route handler, Hono, Deno, or Bun.

  ```ts
  import { createScoreSubmitHandler } from 'scorezilla/server';

  export const POST = createScoreSubmitHandler({
    secretKey: process.env.SCOREZILLA_SECRET_KEY!,
    boardId: process.env.SCOREZILLA_BOARD_ID!,
    verify: async (req) => {
      // your auth — any provider; return the trusted playerId
      const user = await myAuth(req);
      return user ? { playerId: user.id } : null;
    },
  });
  ```

  - The submitted `playerId` always comes from `verify` (the verified request),
    never the request body — so ranking-sensitive boards aren't subject to the
    client-authoritative submission of the public-key path.
  - Owns body parsing/validation, HMAC signing, and `ScorezillaError` → HTTP
    status mapping. Optional `cors` (OPTIONS preflight + reflected origin) and a
    pre-verify `rateLimit` gate.
  - Works with **any** auth via the `verify` callback (Supabase / Clerk / Auth0 /
    Firebase JWTs, Lucia / opaque sessions, or a provider backend SDK). First-class
    one-line verifiers (`verifySupabaseJwt`, `verifyJwt`) follow.

- [#42](https://github.com/isco-tec/scorezilla-js/pull/42) [`7ca5976`](https://github.com/isco-tec/scorezilla-js/commit/7ca5976857cfff44cc3a3c155181cd9f6276aea0) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(server): built-in `verifyJwt` + `verifySupabaseJwt` for `createScoreSubmitHandler`

  Turn the common "verify a JWT, derive the player id" step into a one-liner.
  Both return a `verify` function you drop straight into `createScoreSubmitHandler`.

  ```ts
  import { createScoreSubmitHandler, verifySupabaseJwt } from 'scorezilla/server';

  export const POST = createScoreSubmitHandler({
    secretKey: process.env.SCOREZILLA_SECRET_KEY!,
    boardId: process.env.SCOREZILLA_BOARD_ID!,
    verify: verifySupabaseJwt({ supabaseUrl: process.env.SUPABASE_URL! }),
  });
  ```

  - `verifyJwt({ jwksUrl, issuer, audience, claim? })` — generic JWKS verifier,
    plus first-class presets for the popular providers: `verifySupabaseJwt({
supabaseUrl })`, `verifyClerkJwt({ issuer })`, `verifyAuth0Jwt({ domain,
audience })`, and `verifyFirebaseIdToken({ projectId })`.
  - **`jose` is an optional peer dependency**, loaded lazily via dynamic
    `import()` — consumers who use the public-key client, the factory with their
    own `verify`, or a provider backend SDK never install or load it.

### Patch Changes

- [#44](https://github.com/isco-tec/scorezilla-js/pull/44) [`e7fcc42`](https://github.com/isco-tec/scorezilla-js/commit/e7fcc4262b5d0a706d29f05333335f746307cb47) Thanks [@isco-tec](https://github.com/isco-tec)! - docs: make the `useAuthProvider` trust boundary explicit (scorezilla#213)

  Client OAuth identity is sign-in convenience, not anti-forgery — the derived
  id is computed client-side and submitted with the public key. New
  trust-boundary notes on the `useAuthProvider` JSDoc and `AuthPlayerHandle`, a
  "Player identity" section in the README, and a RECIPES.md recipe ("OAuth
  identity and the secure path") routing ranking-sensitive boards to
  `createScoreSubmitHandler` with a server-verified identity.

## 0.3.0-next.3

### Minor Changes

- [#45](https://github.com/isco-tec/scorezilla-js/pull/45) [`1a1e625`](https://github.com/isco-tec/scorezilla-js/commit/1a1e625cc6aff058071f922c7c5a619efa80ddc8) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(identity): ship the GitHub provider for `useAuthProvider` (scorezilla#194)

  The GitHub option is real (and final, per ADR 0009): a popup OAuth web flow
  on the client plus a turnkey server-side token exchange.
  - `useAuthProvider({ provider: 'github', clientId, exchangeUrl, storageKey })`
    — opens the GitHub sign-in popup, validates the callback by origin + state,
    resolves `github:<id>` (or `null` on decline). The provisional option shape
    is finalized: `clientId`, `exchangeUrl`, and `storageKey` are all required.
  - `createGitHubOAuthHandler({ clientId, clientSecret, allowedOrigin })` (new
    in `scorezilla/server`) — the deployable callback endpoint: exchanges the
    code (secret stays server-side), resolves the user id, posts it back to the
    game's origin, closes the popup. The access token never reaches the browser.
  - size-limit: server caps 7 → 8 KB (documented); new tree-shaking proof pins
    that adapter-only consumers pay for neither factory.

### Patch Changes

- [#44](https://github.com/isco-tec/scorezilla-js/pull/44) [`e7fcc42`](https://github.com/isco-tec/scorezilla-js/commit/e7fcc4262b5d0a706d29f05333335f746307cb47) Thanks [@isco-tec](https://github.com/isco-tec)! - docs: make the `useAuthProvider` trust boundary explicit (scorezilla#213)

  Client OAuth identity is sign-in convenience, not anti-forgery — the derived
  id is computed client-side and submitted with the public key. New
  trust-boundary notes on the `useAuthProvider` JSDoc and `AuthPlayerHandle`, a
  "Player identity" section in the README, and a RECIPES.md recipe ("OAuth
  identity and the secure path") routing ranking-sensitive boards to
  `createScoreSubmitHandler` with a server-verified identity.

## 0.3.0-next.2

### Minor Changes

- [#41](https://github.com/isco-tec/scorezilla-js/pull/41) [`e48a5a2`](https://github.com/isco-tec/scorezilla-js/commit/e48a5a2f09cd0f098e8466b51586bd4108bb5678) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(server): `createScoreSubmitHandler()` — turnkey secure score submissions

  A framework-agnostic factory in `scorezilla/server` that collapses the secure
  (HMAC-signed) submission path from ~150 lines of boilerplate into a few. It
  returns a standard `(Request) => Promise<Response>` handler — drop it into a
  Cloudflare Worker, a Next.js route handler, Hono, Deno, or Bun.

  ```ts
  import { createScoreSubmitHandler } from 'scorezilla/server';

  export const POST = createScoreSubmitHandler({
    secretKey: process.env.SCOREZILLA_SECRET_KEY!,
    boardId: process.env.SCOREZILLA_BOARD_ID!,
    verify: async (req) => {
      // your auth — any provider; return the trusted playerId
      const user = await myAuth(req);
      return user ? { playerId: user.id } : null;
    },
  });
  ```

  - The submitted `playerId` always comes from `verify` (the verified request),
    never the request body — so ranking-sensitive boards aren't subject to the
    client-authoritative submission of the public-key path.
  - Owns body parsing/validation, HMAC signing, and `ScorezillaError` → HTTP
    status mapping. Optional `cors` (OPTIONS preflight + reflected origin) and a
    pre-verify `rateLimit` gate.
  - Works with **any** auth via the `verify` callback (Supabase / Clerk / Auth0 /
    Firebase JWTs, Lucia / opaque sessions, or a provider backend SDK). First-class
    one-line verifiers (`verifySupabaseJwt`, `verifyJwt`) follow.

- [#42](https://github.com/isco-tec/scorezilla-js/pull/42) [`7ca5976`](https://github.com/isco-tec/scorezilla-js/commit/7ca5976857cfff44cc3a3c155181cd9f6276aea0) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(server): built-in `verifyJwt` + `verifySupabaseJwt` for `createScoreSubmitHandler`

  Turn the common "verify a JWT, derive the player id" step into a one-liner.
  Both return a `verify` function you drop straight into `createScoreSubmitHandler`.

  ```ts
  import { createScoreSubmitHandler, verifySupabaseJwt } from 'scorezilla/server';

  export const POST = createScoreSubmitHandler({
    secretKey: process.env.SCOREZILLA_SECRET_KEY!,
    boardId: process.env.SCOREZILLA_BOARD_ID!,
    verify: verifySupabaseJwt({ supabaseUrl: process.env.SUPABASE_URL! }),
  });
  ```

  - `verifyJwt({ jwksUrl, issuer, audience, claim? })` — generic JWKS verifier,
    plus first-class presets for the popular providers: `verifySupabaseJwt({
supabaseUrl })`, `verifyClerkJwt({ issuer })`, `verifyAuth0Jwt({ domain,
audience })`, and `verifyFirebaseIdToken({ projectId })`.
  - **`jose` is an optional peer dependency**, loaded lazily via dynamic
    `import()` — consumers who use the public-key client, the factory with their
    own `verify`, or a provider backend SDK never install or load it.

## 0.3.0-next.1

### Minor Changes

- [#39](https://github.com/isco-tec/scorezilla-js/pull/39) [`608137f`](https://github.com/isco-tec/scorezilla-js/commit/608137f2a880fd3b9031cde8de765a5262d6c334) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(identity): ship the Google provider for `useAuthProvider`

  `useAuthProvider({ provider: 'google', clientId, storageKey })` is now
  implemented and **stable**. It wraps Google Identity Services ("One Tap"),
  derives a stable, opaque player id from the account's `sub` claim
  (`google:<sub>`), and persists it in `localStorage` so returning visitors are
  recognized without signing in again.

  ```ts
  import { Scorezilla } from 'scorezilla';
  import { useAuthProvider } from 'scorezilla/identity';

  const player = await useAuthProvider({
    provider: 'google',
    clientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
    storageKey: 'mygame:player',
  });

  if (player) {
    const sz = new Scorezilla({ publicKey: 'pk_…' });
    await sz.submitScore({ boardId, playerId: player.id, score: 42 });
    // player.signOut() clears the persisted id and disables Google auto-select.
  }
  ```

  - **Resolves `null` when the player declines** or One Tap can't be shown — a
    dismissed sign-in is not an error. It **rejects** only on genuine failures
    (invalid args, script load failure, malformed credential).
  - **`handle.source`** is `'signed-in'` for a fresh sign-in or `'restored'` when
    the id was rehydrated from `localStorage` (a restored id is not a re-verified
    live session).
  - **Bring your own client ID.** The SDK never bundles Scorezilla-owned OAuth
    credentials, so revocation and consent stay under your control.
  - **Privacy.** Only the derived `sub`-based id is stored and transmitted on
    score submission — never the Google credential, email, or profile.
  - **Bundle.** The Google provider tree-shakes out for consumers who don't call
    `useAuthProvider`; the Google Identity Services library is loaded at runtime
    from `accounts.google.com`, never bundled.
  - `useAuthProvider` is now async (replacing the `0.3.0-next.0` preview stub that
    threw synchronously). Despite the `use*` name it is **not** a React hook.
    Identity errors are plain `Error`/`TypeError` (not `ScorezillaError`), keeping
    the `scorezilla/identity` subpath dependency-free. The host page's CSP must
    allow `https://accounts.google.com`.
  - The **GitHub** provider is not available yet — it ships in a follow-up and
    will require a server-side token exchange (your backend or a Scorezilla
    Workers proxy). Calling `useAuthProvider({ provider: 'github' })` rejects
    with guidance until then.

## 0.3.0-next.0

### Minor Changes

- [#36](https://github.com/isco-tec/scorezilla-js/pull/36) [`19c2dcc`](https://github.com/isco-tec/scorezilla-js/commit/19c2dcc14d2000551d80498813b075172c8f4d66) Thanks [@isco-tec](https://github.com/isco-tec)! - feat(identity): preset helpers for `scorezilla/identity` (Phase 1)

  New subpath export: `scorezilla/identity`. Three identity-strategy
  presets ship as `stable`; one OAuth helper ships as a preview stub.

  **Stable in this release:**
  - `useAnonymousPlayer({ storageKey })` — generates a UUID, persists in
    localStorage, same browser keeps the same id across reloads. Returns
    `{ id, forget() }`. Privacy-safe by default (no PII).
  - `usePromptedPlayer({ storageKey, prompt })` — `window.prompt()` on
    first run, persists to localStorage. Returns `{ id, forget() } | null`
    (null when SSR, no `prompt`, or user cancels).
  - `useServerAuthoritative()` — no-op marker for snippets using the
    HMAC-signed secure path (`scorezilla/server`). The browser SDK does
    no identity work; the server picks the value.

  **Preview stub in this release (throws on call):**
  - `useAuthProvider({ provider: 'google' | 'github' })` — OAuth-backed
    identity. Full implementation (Google + GitHub for v1) ships in a
    follow-up `next` release before the 0.3.0 latest promote.

  Per [ADR 0003](https://github.com/isco-tec/scorezilla/blob/main/docs/adr/0003-mcp-identity-axis.md). All helpers document where data is stored and
  what `forget()` / `signOut()` does NOT do (server-side history is
  retained — call admin delete-player for full erasure).

  Closes upstream tracking issue isco-tec/scorezilla#125 (Phase 1).

## 0.2.0 — `scorezilla/server` HMAC adapter GA

### Minor Changes

- [#25](https://github.com/isco-tec/scorezilla-js/pull/25) [`5f7025b`](https://github.com/isco-tec/scorezilla-js/commit/5f7025b7b06dded92b3e710316454eb8c891d053) Thanks [@isco-tec](https://github.com/isco-tec)! - **`scorezilla/server`: HMAC requests now bind to the target host (v=2).**

  The canonical signing string includes the host of the request URL, so a signature minted against staging cannot be replayed against prod (or any other origin that happens to share key material). SigV4 has had this since day one; closing the gap before MCP locks the format.

  Wire format change:

  ```
  Authorization: Scorezilla-HMAC-SHA256 keyId=…, ts=…, nonce=…, signature=…, v=2
  ```

  The `v=2` parameter is new. The canonical signing string now has six lines instead of five — `host` is inserted between `METHOD` and `pathAndQuery`, lowercased per RFC 9110 §4.2.4.

  **Backward compatibility.** The API verifier still accepts v=1 (no `v=` field, no host binding) during the rollout window — your existing pre-next.3 SDK builds will keep working until v=1 is deprecated. The SDK itself, however, emits v=2 unconditionally from next.3 onwards. If you've forked or wrapped `buildHmacAuthHeader` / `buildSigningString`, you'll need to thread a `host` parameter through.

  **For consumers of `Scorezilla` from `scorezilla/server`:** no API changes. The constructor derives `host` from `baseUrl` automatically. As an added safety net, an invalid `baseUrl` now throws at construction time rather than producing 401 mismatches at every request.

  **For low-level consumers of `buildSigningString` / `buildHmacAuthHeader`:** a new `host` parameter is now required. The latter also accepts an optional `version: 1 | 2` for explicit backward-compat scenarios.

- [`239642a`](https://github.com/isco-tec/scorezilla-js/commit/239642aaf73f643c2f51d806170d3ced31a3fe68) Thanks [@isco-tec](https://github.com/isco-tec)! - **Initial public release candidate.** First publish of the `scorezilla` SDK to npm.

  Includes the v0.1.0 public-key client surface:
  - `Scorezilla` class with `submitScore`, `getLeaderboard`, `getPlayerRank`, `getWindowAround`
  - `ScorezillaError` for every failure path (network, timeout, abort, HTTP non-2xx)
  - Universal runtime support (browsers, Node ≥ 20, Cloudflare Workers, Bun, Deno)
  - Automatic retries with idempotency keys
  - Dual ESM/CJS build with [arethetypeswrong](https://arethetypeswrong.github.io/)-clean exports map
  - ~3.8 KB ESM gzipped

  This RC publishes under the `next` npm dist-tag — install with `npm install scorezilla@next` to try it out. The HMAC server adapter, React hooks, and Phaser plugin land in subsequent v0.2.0, v0.3.0, and v0.4.0 releases.

- [#18](https://github.com/isco-tec/scorezilla-js/pull/18) [`a02b07a`](https://github.com/isco-tec/scorezilla-js/commit/a02b07a116a9d15c2928ad4f98a9cfa3a8dceffd) Thanks [@isco-tec](https://github.com/isco-tec)! - **v0.2.0 — HMAC server adapter (`scorezilla/server`).** Closes [#17](https://github.com/isco-tec/scorezilla-js/issues/17).

  The new `scorezilla/server` subpath ships an HMAC-SHA256 signing client for
  game backends that need cheat-resistant submissions. The browser-side
  public-key client (`scorezilla`) is unchanged.

  ```ts
  import { Scorezilla } from 'scorezilla/server';

  const sz = new Scorezilla({
    secretKey: {
      id: process.env.SCOREZILLA_KEY_ID,
      secret: process.env.SCOREZILLA_KEY_SECRET, // never ship to a browser
    },
  });

  await sz.submitScore({ boardId, playerId, score, metadata });
  await sz.getLeaderboard({ boardId, top });
  await sz.getPlayerRank({ boardId, playerId });
  await sz.getWindowAround({ boardId, playerId, before, after });
  ```

  Behavior:
  - Each request is signed with HMAC-SHA256 over a canonical
    `{ts}\n{nonce}\n{METHOD}\n{path?query}\n{sha256_hex(body)}` string and
    delivered via `Authorization: Scorezilla-HMAC-SHA256 keyId=…, ts=…,
nonce=…, signature=…`. Matches the API's verifier byte-for-byte.
  - `submitScore` posts to `/v1/secure/scores` (the boardId moves into the
    body — the public-key endpoint at `/v1/boards/:id/scores` is unchanged).
  - Read methods (`getLeaderboard` / `getPlayerRank` / `getWindowAround`)
    hit the same paths as the public-key client.
  - Every retry attempt regenerates `(ts, nonce)` so server-side replay
    protection (10-minute nonce window) doesn't trip.
  - Importing `scorezilla/server` from a browser bundle throws at module
    evaluation — the `sk_live_*` secret never reaches client-side code.

  Same `ScorezillaError` surface (`isRateLimited()`, `isAuth()`,
  `isTransient()`, `code`, `requestId`, etc.) — typed catch patterns
  written for v0.1 work unchanged.

  Bundle: ~3.84 KB ESM gzipped, ~4.04 KB CJS gzipped — well under the
  6 KB per-entry cap.

- [#23](https://github.com/isco-tec/scorezilla-js/pull/23) [`5163e31`](https://github.com/isco-tec/scorezilla-js/commit/5163e3130ac208d591b026d66870ce5a194f90b6) Thanks [@isco-tec](https://github.com/isco-tec)! - **`scorezilla/server` adopts a single-token secret-key format.** Breaking
  change vs. v0.1.0-next.1; we're still in pre-release so this is permitted.

  Before (v0.1.0-next.1):

  ```ts
  new Scorezilla({
    secretKey: { id: 'sk-id-uuid', secret: 'sk_live_xxxxx' },
  });
  ```

  After (v0.1.0-next.2):

  ```ts
  new Scorezilla({
    secretKey: 'sk_live_<keyId>_xxxxx', // one self-contained token
  });
  ```

  The keyId is embedded in the secret string itself; the SDK parses it
  out via `/^sk_live_([0-9a-f]{8}-...)_/` before signing. The HMAC key
  remains the WHOLE plaintext. Wire format on the Authorization header
  is unchanged. API verification is unchanged.

  Rationale: matches Stripe's design and the public-key client's
  single-string shape. One value to copy from the dashboard, one to
  manage in env config, one to pass into the constructor. Previously
  users had to manage two distinct values (`id` AND `secret`) which
  created confusion — they're functionally one credential.

  **To upgrade**: issue (or rotate) a fresh secret key in the dashboard.
  Old-format keys (no embedded keyId) are rejected by the SDK with a
  clear error message pointing at the migration path.

- [#30](https://github.com/isco-tec/scorezilla-js/pull/30) [`39fc70f`](https://github.com/isco-tec/scorezilla-js/commit/39fc70fa3a38bce619e87aa9f6179e79f1ae45ff) Thanks [@isco-tec](https://github.com/isco-tec)! - Handle HTTP 402 `usage_cap_exceeded` + observe API deprecation headers.

  **402 / `usage_cap_exceeded`**: when the server returns 402 (tenant hit
  their monthly submission cap or is suspended), the SDK now surfaces a
  typed `ScorezillaError` with the full cap context:
  - `err.code === 'usage_cap_exceeded'`
  - `err.reason === 'over_cap' | 'suspended'`
  - `err.tier`, `err.cap`, `err.count`, `err.period`, `err.resetsAt`
  - `err.isUsageCapExceeded()` predicate
  - `err.isSuspended()` predicate (distinguishes the suspended sub-case)
  - `err.isTransient() === false` — no auto-retry (the cap doesn't lift
    until `resetsAt`)

  **Deprecation signals**: when an API response carries an RFC 8594
  `Sunset` header or IETF `Deprecation` header, the SDK now logs a
  once-per-process `console.warn` so developers see deprecation
  notices during dev without prod-loop spam. The warning includes the
  sunset date and any `Link: rel="deprecation"` documentation URL.

  No breaking changes. New fields are additive; existing error handling
  keeps working unchanged.

### Patch Changes

- [#31](https://github.com/isco-tec/scorezilla-js/pull/31) [`9376a2d`](https://github.com/isco-tec/scorezilla-js/commit/9376a2d93d4edb42decca1bcf495b83fc013c309) Thanks [@isco-tec](https://github.com/isco-tec)! - **Error mapping, retry-policy alignment, `AbortSignal` plumbing, injectable warn, validator-return tightening.**

  Bundled correctness + ergonomics fixes from the in-house improvement-phase review:
  - `ScorezillaError.code` now resolves to `'conflict'` on HTTP 409 responses (previously fell through to `'invalid_input'`). The error type already listed `'conflict'` as a valid code; the gap was in the status→code mapper. A new `e.isConflict()` predicate joins the existing `isAuth() / isNotFound() / isRateLimited() / isOutOfBounds() / isUsageCapExceeded() / isTransient()` family.
  - `e.isTransient()` no longer flags `timeout` or `aborted` as transient — those are caller-observable terminal states, not retryable. The predicate is now aligned with the transport's actual retry policy (`shouldRetryError` in `retry.ts`), so consumer code mirroring "if (e.isTransient()) retry()" no longer loops on timeouts.
  - All four public methods on **both** the public-key client (`Scorezilla`) and the secret-key server adapter (`Scorezilla` from `scorezilla/server`) now accept an optional `signal?: AbortSignal` via a shared `CancellableInput` shape, and forward it through the transport. Unblocks request-cancellation propagation under frameworks that thread cancellation through the request lifecycle (Next.js route handlers, Hono, Express middleware, React effect cleanup).
  - New `warn?: (...args: unknown[]) => void` field on `ScorezillaConfig`. Defaults to `console.warn`. Pass your logger to route SDK deprecation notices into your observability stack, or pass `() => {}` to suppress them. Used today only for the `Deprecation` / `Sunset` once-per-process warning emitted when the API signals an upcoming sunset — at million-integration scale, embedders shouldn't have to console-filter our messages.
  - `validateMetadata` now returns the serialized JSON string it computed (previously declared `void` despite a comment that claimed otherwise). Public callers that re-stringify metadata can reuse the value and skip a duplicate `JSON.stringify` pass on the hot submit path.

  No breaking changes for callers that didn't rely on the two buggy classifications, didn't need cancellation, and didn't read `validateMetadata`'s return value.

- [#28](https://github.com/isco-tec/scorezilla-js/pull/28) [`94b39d2`](https://github.com/isco-tec/scorezilla-js/commit/94b39d2e67ec7bba2681145560529f058acfc633) Thanks [@isco-tec](https://github.com/isco-tec)! - **Pre-release security hardening pass.** Three issues surfaced by a focused security review before the first public release of `scorezilla/server`:
  - **HIGH — nonce injection.** `buildHmacAuthHeader` now requires injected nonces to be at least 16 characters. The default path (`crypto.randomUUID()`) is unaffected. Previously a misconfigured caller could pass `nonce: ''` and silently sign a header with no replay protection — the server has no minimum-length check, so the API would accept it. Now caught at SDK build-time with a clear error.
  - **HIGH — server policy disclosure.** `HMAC_TIMESTAMP_WINDOW_SECONDS = 300` was previously exported as documentation of the API's clock-skew tolerance. Removed from the public API — publishing the server's replay-protection window in the SDK's types was unnecessary information disclosure and narrowed the pre-computation window for any future timestamp-forgery work. The SDK has no behavioral dependency on the value (it always emits a fresh `ts = floor(Date.now() / 1000)`).
  - **MEDIUM — `EdgeRuntime` polyfill bypass.** The server adapter's runtime browser-guard previously trusted `globalThis.EdgeRuntime` as a "this is a server" signal. A browser extension or bundler misconfig setting that global would have bypassed the guard. Removed from the trusted set — the package's `exports.browser` condition remains the primary gate, and the runtime check now refuses to trust globals that can be polyfilled from a browser context. Real Vercel Edge runtimes still pass the guard because they don't have `window`/`document`.

  No external-attack surface was exploitable; all three are self-inflicted/defense-in-depth issues caught before the first stable release. Tests added: 4 for nonce validation (rejects empty / too-short, accepts at-floor / default UUID), 1 for the EdgeRuntime polyfill scenario.

## 0.1.0-next.3

### Minor Changes

- [#25](https://github.com/isco-tec/scorezilla-js/pull/25) [`5f7025b`](https://github.com/isco-tec/scorezilla-js/commit/5f7025b7b06dded92b3e710316454eb8c891d053) Thanks [@isco-tec](https://github.com/isco-tec)! - **`scorezilla/server`: HMAC requests now bind to the target host (v=2).**

  The canonical signing string includes the host of the request URL, so a signature minted against staging cannot be replayed against prod (or any other origin that happens to share key material). SigV4 has had this since day one; closing the gap before MCP locks the format.

  Wire format change:

  ```
  Authorization: Scorezilla-HMAC-SHA256 keyId=…, ts=…, nonce=…, signature=…, v=2
  ```

  The `v=2` parameter is new. The canonical signing string now has six lines instead of five — `host` is inserted between `METHOD` and `pathAndQuery`, lowercased per RFC 9110 §4.2.4.

  **Backward compatibility.** The API verifier still accepts v=1 (no `v=` field, no host binding) during the rollout window — your existing pre-next.3 SDK builds will keep working until v=1 is deprecated. The SDK itself, however, emits v=2 unconditionally from next.3 onwards. If you've forked or wrapped `buildHmacAuthHeader` / `buildSigningString`, you'll need to thread a `host` parameter through.

  **For consumers of `Scorezilla` from `scorezilla/server`:** no API changes. The constructor derives `host` from `baseUrl` automatically. As an added safety net, an invalid `baseUrl` now throws at construction time rather than producing 401 mismatches at every request.

  **For low-level consumers of `buildSigningString` / `buildHmacAuthHeader`:** a new `host` parameter is now required. The latter also accepts an optional `version: 1 | 2` for explicit backward-compat scenarios.

### Patch Changes

- [#28](https://github.com/isco-tec/scorezilla-js/pull/28) [`94b39d2`](https://github.com/isco-tec/scorezilla-js/commit/94b39d2e67ec7bba2681145560529f058acfc633) Thanks [@isco-tec](https://github.com/isco-tec)! - **Pre-release security hardening pass.** Three issues surfaced by a focused security review before the first public release of `scorezilla/server`:
  - **HIGH — nonce injection.** `buildHmacAuthHeader` now requires injected nonces to be at least 16 characters. The default path (`crypto.randomUUID()`) is unaffected. Previously a misconfigured caller could pass `nonce: ''` and silently sign a header with no replay protection — the server has no minimum-length check, so the API would accept it. Now caught at SDK build-time with a clear error.
  - **HIGH — server policy disclosure.** `HMAC_TIMESTAMP_WINDOW_SECONDS = 300` was previously exported as documentation of the API's clock-skew tolerance. Removed from the public API — publishing the server's replay-protection window in the SDK's types was unnecessary information disclosure and narrowed the pre-computation window for any future timestamp-forgery work. The SDK has no behavioral dependency on the value (it always emits a fresh `ts = floor(Date.now() / 1000)`).
  - **MEDIUM — `EdgeRuntime` polyfill bypass.** The server adapter's runtime browser-guard previously trusted `globalThis.EdgeRuntime` as a "this is a server" signal. A browser extension or bundler misconfig setting that global would have bypassed the guard. Removed from the trusted set — the package's `exports.browser` condition remains the primary gate, and the runtime check now refuses to trust globals that can be polyfilled from a browser context. Real Vercel Edge runtimes still pass the guard because they don't have `window`/`document`.

  No external-attack surface was exploitable; all three are self-inflicted/defense-in-depth issues caught before the first stable release. Tests added: 4 for nonce validation (rejects empty / too-short, accepts at-floor / default UUID), 1 for the EdgeRuntime polyfill scenario.

## 0.1.0-next.2

### Minor Changes

- [#23](https://github.com/isco-tec/scorezilla-js/pull/23) [`5163e31`](https://github.com/isco-tec/scorezilla-js/commit/5163e3130ac208d591b026d66870ce5a194f90b6) Thanks [@isco-tec](https://github.com/isco-tec)! - **`scorezilla/server` adopts a single-token secret-key format.** Breaking
  change vs. v0.1.0-next.1; we're still in pre-release so this is permitted.

  Before (v0.1.0-next.1):

  ```ts
  new Scorezilla({
    secretKey: { id: 'sk-id-uuid', secret: 'sk_live_xxxxx' },
  });
  ```

  After (v0.1.0-next.2):

  ```ts
  new Scorezilla({
    secretKey: 'sk_live_<keyId>_xxxxx', // one self-contained token
  });
  ```

  The keyId is embedded in the secret string itself; the SDK parses it
  out via `/^sk_live_([0-9a-f]{8}-...)_/` before signing. The HMAC key
  remains the WHOLE plaintext. Wire format on the Authorization header
  is unchanged. API verification is unchanged.

  Rationale: matches Stripe's design and the public-key client's
  single-string shape. One value to copy from the dashboard, one to
  manage in env config, one to pass into the constructor. Previously
  users had to manage two distinct values (`id` AND `secret`) which
  created confusion — they're functionally one credential.

  **To upgrade**: issue (or rotate) a fresh secret key in the dashboard.
  Old-format keys (no embedded keyId) are rejected by the SDK with a
  clear error message pointing at the migration path.

## 0.1.0-next.1

### Minor Changes

- [#18](https://github.com/isco-tec/scorezilla-js/pull/18) [`a02b07a`](https://github.com/isco-tec/scorezilla-js/commit/a02b07a116a9d15c2928ad4f98a9cfa3a8dceffd) Thanks [@isco-tec](https://github.com/isco-tec)! - **v0.2.0 — HMAC server adapter (`scorezilla/server`).** Closes [#17](https://github.com/isco-tec/scorezilla-js/issues/17).

  The new `scorezilla/server` subpath ships an HMAC-SHA256 signing client for
  game backends that need cheat-resistant submissions. The browser-side
  public-key client (`scorezilla`) is unchanged.

  ```ts
  import { Scorezilla } from 'scorezilla/server';

  const sz = new Scorezilla({
    secretKey: {
      id: process.env.SCOREZILLA_KEY_ID,
      secret: process.env.SCOREZILLA_KEY_SECRET, // never ship to a browser
    },
  });

  await sz.submitScore({ boardId, playerId, score, metadata });
  await sz.getLeaderboard({ boardId, top });
  await sz.getPlayerRank({ boardId, playerId });
  await sz.getWindowAround({ boardId, playerId, before, after });
  ```

  Behavior:
  - Each request is signed with HMAC-SHA256 over a canonical
    `{ts}\n{nonce}\n{METHOD}\n{path?query}\n{sha256_hex(body)}` string and
    delivered via `Authorization: Scorezilla-HMAC-SHA256 keyId=…, ts=…,
nonce=…, signature=…`. Matches the API's verifier byte-for-byte.
  - `submitScore` posts to `/v1/secure/scores` (the boardId moves into the
    body — the public-key endpoint at `/v1/boards/:id/scores` is unchanged).
  - Read methods (`getLeaderboard` / `getPlayerRank` / `getWindowAround`)
    hit the same paths as the public-key client.
  - Every retry attempt regenerates `(ts, nonce)` so server-side replay
    protection (10-minute nonce window) doesn't trip.
  - Importing `scorezilla/server` from a browser bundle throws at module
    evaluation — the `sk_live_*` secret never reaches client-side code.

  Same `ScorezillaError` surface (`isRateLimited()`, `isAuth()`,
  `isTransient()`, `code`, `requestId`, etc.) — typed catch patterns
  written for v0.1 work unchanged.

  Bundle: ~3.84 KB ESM gzipped, ~4.04 KB CJS gzipped — well under the
  6 KB per-entry cap.

## 0.1.0-next.0

### Minor Changes

- [`239642a`](https://github.com/isco-tec/scorezilla-js/commit/239642aaf73f643c2f51d806170d3ced31a3fe68) Thanks [@isco-tec](https://github.com/isco-tec)! - **Initial public release candidate.** First publish of the `scorezilla` SDK to npm.

  Includes the v0.1.0 public-key client surface:
  - `Scorezilla` class with `submitScore`, `getLeaderboard`, `getPlayerRank`, `getWindowAround`
  - `ScorezillaError` for every failure path (network, timeout, abort, HTTP non-2xx)
  - Universal runtime support (browsers, Node ≥ 20, Cloudflare Workers, Bun, Deno)
  - Automatic retries with idempotency keys
  - Dual ESM/CJS build with [arethetypeswrong](https://arethetypeswrong.github.io/)-clean exports map
  - ~3.8 KB ESM gzipped

  This RC publishes under the `next` npm dist-tag — install with `npm install scorezilla@next` to try it out. The HMAC server adapter, React hooks, and Phaser plugin land in subsequent v0.2.0, v0.3.0, and v0.4.0 releases.

All notable changes to `scorezilla` are documented here.

This project follows [Semantic Versioning](https://semver.org/). Releases are
managed by [Changesets](https://github.com/changesets/changesets) — see
[VERSIONING.md](./VERSIONING.md) for the SemVer contract, deprecation policy,
and the 0.x → 1.0 exit criteria.
