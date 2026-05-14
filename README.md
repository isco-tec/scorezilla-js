# scorezilla

[![npm version](https://img.shields.io/npm/v/scorezilla.svg)](https://www.npmjs.com/package/scorezilla)
[![bundle size](https://img.shields.io/bundlephobia/minzip/scorezilla)](https://bundlephobia.com/package/scorezilla)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/isco-tec/scorezilla-js/sdk-ci.yml?branch=main)](https://github.com/isco-tec/scorezilla-js/actions)
[![provenance](https://img.shields.io/badge/npm-provenance-success)](https://docs.npmjs.com/generating-provenance-statements)

Official JavaScript / TypeScript SDK for [Scorezilla](https://scorezilla.dev) —
focused leaderboard infrastructure for indie games, browser games, and
AI-vibe-coded games.

- **Tiny.** ~4 KB gzipped. No runtime dependencies.
- **Universal.** Browser, Node ≥ 20, Cloudflare Workers, Bun, Deno.
- **Typed.** First-class TypeScript with strict types and rich JSDoc.
- **Safe-by-default.** Automatic retries on transient failures with idempotency
  keys; per-request timeouts; cancellation via `AbortSignal`.
- **Private.** No cookies, no `localStorage`, no fingerprinting beyond runtime
  detection — see [COMPATIBILITY.md](./COMPATIBILITY.md).

> **Status:** v0.1.0 ships the **public-key client** (browser-safe).
> v0.2.0 ships the **HMAC server adapter** (`scorezilla/server`) for
> game backends that need cheat-resistant submissions. React
> (`scorezilla/react`) lands in v0.3.0; Phaser (`scorezilla/phaser`) in
> v0.4.0. The first preview is on the `next` dist-tag — install with
> `npm install scorezilla@next`. See [CHANGELOG.md](./CHANGELOG.md) and
> [VERSIONING.md](./VERSIONING.md).

> **Commercial context.** Scorezilla is a hosted leaderboard service with free
> and paid tiers — see [scorezilla.dev/pricing](https://scorezilla.dev/pricing).
> This SDK is MIT-licensed and works identically across every plan; get your API
> key from the [operator dashboard](https://dashboard.scorezilla.dev).

## Install

```bash
npm install scorezilla
# or
pnpm add scorezilla
# or
yarn add scorezilla
# or
bun add scorezilla
```

## Quickstart

```ts
import { Scorezilla, ScorezillaError } from 'scorezilla';

const sz = new Scorezilla({ publicKey: 'pk_mygame_aBcDeF…' });

try {
  const r = await sz.submitScore({
    boardId: 'board-uuid',
    playerId: 'player-uuid',
    score: 9001,
    metadata: { level: 'hard' },
  });
  if (r.isPersonalBest) {
    console.log(`🏆 New personal best! Rank ${r.rank} of ${r.totalEntries}`);
  }
} catch (e) {
  if (e instanceof ScorezillaError && e.isRateLimited()) {
    console.warn(`Rate-limited. Retry after ${e.retryAfter}s.`);
  } else throw e;
}
```

The four public methods:

```ts
await sz.submitScore({ boardId, playerId, score, metadata? });
await sz.getLeaderboard({ boardId, top?, offset? });
await sz.getPlayerRank({ boardId, playerId });
await sz.getWindowAround({ boardId, playerId, before?, after? });
```

See [**API.md**](./API.md) for the full reference, including every response
field, every error code, and advanced patterns.

## Server-side HMAC (`scorezilla/server`)

Public-key submissions are client-authoritative — anyone with your `pk_` can
submit any score from devtools. For games where ranking matters, sign each
submission server-side with a `sk_live_*` secret:

```ts
import { Scorezilla, ScorezillaError } from 'scorezilla/server';

// Single self-contained token from the dashboard. Format:
//   sk_live_<keyId>_<random>
// The SDK parses the keyId out internally; you only manage one value.
const sz = new Scorezilla({
  secretKey: process.env.SCOREZILLA_SECRET_KEY!, // never ship to a browser
});

await sz.submitScore({ boardId, playerId, score, metadata });
```

Same method shape as the public-key client — `submitScore`, `getLeaderboard`,
`getPlayerRank`, `getWindowAround`. The adapter signs every request with
**HMAC-SHA256** over a canonical string (method + path + ts + nonce +
sha256(body)), and the API verifies before any state change. Replay
protection is enforced server-side via a 10-minute nonce window.

The `scorezilla/server` subpath is server-only — importing it from the
browser throws at module evaluation. Use environment variables (or your
secret manager) to load the `sk_live_*` value; never embed it in a build
that ships to clients.

## Error handling

Every failure path — HTTP non-2xx, network error, timeout, abort, JSON parse
error — throws a single `ScorezillaError`. **Branch on `code`**
(machine-stable), never on `message` (English-only, may change without a major
bump):

```ts
import { ScorezillaError } from 'scorezilla';

try {
  await sz.submitScore({ boardId, playerId, score });
} catch (e) {
  if (!(e instanceof ScorezillaError)) throw e;

  if (e.isRateLimited()) await sleep((e.retryAfter ?? 30) * 1000);
  else if (e.isAuth()) throw new Error('SDK misconfigured');
  else if (e.code === 'out_of_bounds')
    console.warn(`Score crosses ${e.reason} bound (limit ${e.bound})`);
  else if (e.isTransient()) /* automatic retries already exhausted */ throw e;
  else throw e;
}
```

The error class carries the request ID, status, and the underlying cause for
support tickets:

```ts
console.error(`Scorezilla ${e.code} (${e.status}) — req ${e.requestId}`);
```

## Runtime support

| Runtime                | Status                        | Notes                                                   |
| ---------------------- | ----------------------------- | ------------------------------------------------------- |
| **Node**               | ≥ 20                          | Hard requirement. Native `fetch` + `crypto.randomUUID`. |
| **Browsers**           | All evergreen                 | Chrome 92+, Firefox 95+, Safari 15.4+, Edge 92+.        |
| **Cloudflare Workers** | ✅                            | Detected via `navigator.userAgent`.                     |
| **Bun**                | ≥ 1.0 (best-effort in v0.1.0) | Promoted to hard gate in v0.2.0 if stable.              |
| **Deno**               | ≥ 1.40                        | Native fetch + Web Crypto.                              |
| **React Native**       | unverified                    | Requires `react-native-get-random-values` polyfill.     |

See [COMPATIBILITY.md](./COMPATIBILITY.md) for the detailed matrix, the
`exactOptionalPropertyTypes` workaround, and the privacy invariants.

## CDN usage

For zero-build prototyping, import from jsDelivr. Replace `<VERSION>` with the
exact release you want (see the [releases page](https://github.com/isco-tec/scorezilla-js/releases)):

```html
<script type="module">
  import { Scorezilla } from 'https://cdn.jsdelivr.net/npm/scorezilla@<VERSION>/dist/index.js';
  const sz = new Scorezilla({ publicKey: 'pk_…' });
  // …
</script>
```

For production, pair the version pin with
[Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
— the SHA-384 hash for each release ships in the GitHub release notes:

```html
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/scorezilla@<VERSION>/dist/index.js"
  integrity="sha384-<copy-from-release-notes>"
  crossorigin="anonymous"
></script>
```

A complete vanilla example lives at
[`examples/vanilla/`](https://github.com/isco-tec/scorezilla-js/tree/main/examples/vanilla)
and a Node CLI demo at
[`examples/node-cli/`](https://github.com/isco-tec/scorezilla-js/tree/main/examples/node-cli).
(The examples are in the source repo only — not in the npm tarball.)

## Custom fetch / polyfills

Pass your own `fetch` for environments where the global is missing or you want
to mock for tests:

```ts
import nodeFetch from 'node-fetch';
const sz = new Scorezilla({ publicKey, fetch: nodeFetch });
```

The signature
`(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>` is
intentionally broader than `typeof fetch` so `node-fetch`, `undici`, `vi.fn()`,
and `jest.fn()` all typecheck cleanly.

## Per-request timeout and retries

```ts
const sz = new Scorezilla({
  publicKey,
  timeoutMs: 5_000, // default 30_000
  maxRetries: 1, // default 2 (retries 5xx / 429 / network)
});
```

Retries automatically reuse the same `Idempotency-Key` across attempts, so
server-side dedup (when added) is safe by default.

## Versioning

Strict SemVer from v0.1.0 onward. The machine-stable surface is `code` strings
on `ScorezillaError`, response field names, method signatures, and config
fields. The human-readable `message` is **not** part of the contract.

See [VERSIONING.md](./VERSIONING.md) for the full breaking-change rules,
deprecation policy, and 0.x → 1.0 exit criteria.

## Contributing

Issues and PRs welcome. Local development:

```bash
pnpm install
pnpm typecheck
pnpm test                   # all projects
pnpm test:unit              # unit only (fast)
pnpm test:coverage          # unit + coverage gate
pnpm build                  # tsup → dist/
pnpm check:types-resolution # attw — exports map validation
pnpm size                   # size-limit (6 KB gzip ceiling)
```

Add a release note with `pnpm changeset` — see [`.changeset/README.md`](./.changeset/README.md) for the workflow.

## License

[MIT](./LICENSE) © [isco-tec](https://github.com/isco-tec)
