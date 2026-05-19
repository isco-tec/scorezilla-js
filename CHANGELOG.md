# Changelog

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
