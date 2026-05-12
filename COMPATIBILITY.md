# Compatibility

Where the Scorezilla SDK runs, what it needs, what it sends, and what it does
not.

## Runtime support

The SDK targets ES2022 + the standard `fetch` / `AbortController` /
`crypto.randomUUID` web platform APIs. Anywhere those are available, the SDK
works.

| Runtime                | Status        | Notes                                                                                                                                                                                             |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node**               | ≥ 20 (hard)   | Native `fetch` since Node 18.0; `crypto.randomUUID` since Node 14.17. We require Node 20 to inherit the modern Web Crypto profile.                                                                |
| **Browsers**           | All evergreen | Native `fetch` since 2017; `crypto.randomUUID` since Safari 15.4, Firefox 95, Chrome 92. **Safari 17.0–17.3** is supported despite lacking `AbortSignal.any` — the SDK composes signals manually. |
| **Cloudflare Workers** | Supported     | Detected via `navigator.userAgent === 'Cloudflare-Workers'`. No Node-only API used.                                                                                                               |
| **Bun**                | ≥ 1.0         | Bun ≥ 1.0 ships compatible fetch + WebCrypto. CI runs Bun as a best-effort matrix until v0.2.0 (see VERSIONING.md).                                                                               |
| **Deno**               | ≥ 1.40        | Native fetch + Web Crypto.                                                                                                                                                                        |
| **React Native**       | Unverified    | The standard `fetch` polyfill ships with RN ≥ 0.60, but `crypto.randomUUID` typically requires `react-native-get-random-values`. Not part of the v0.1.0 CI matrix.                                |

### Minimum API version

The SDK talks to `/v1/*` only. The base URL defaults to
`https://api.scorezilla.dev`; pass `baseUrl` to override (e.g. for a local
`wrangler dev` instance during development).

The SDK does not negotiate API versions — it speaks `/v1` literally. When `/v2`
ships, a major-bumped SDK will accept a new `apiVersion: '2'` knob.

## TypeScript

### Compiler version

TypeScript ≥ 4.7 (for the modern `node16`/`bundler` `moduleResolution`). The
SDK's published types include a `typesVersions` fallback for ≤ 4.6's `node10`
resolver, so `import { Scorezilla } from 'scorezilla'` resolves cleanly under
both algorithms.

### `exactOptionalPropertyTypes`

The SDK is built with `exactOptionalPropertyTypes: true`. The PUBLIC input types
use `?: T | undefined` (with explicit `| undefined`) on optional fields
specifically so callers under the same setting can pass a maybe-undefined
variable without a workaround:

```ts
// Works under exactOptionalPropertyTypes: true thanks to `| undefined`.
const meta: Record<string, unknown> | undefined = computeMeta();
await sz.submitScore({ boardId, playerId, score, metadata: meta });
```

If you're consuming the SDK from a project that does NOT use
`exactOptionalPropertyTypes`, this is fully transparent — the union collapses to
just `T?` for you.

### The spread workaround (for the rare strict consumer)

If you find yourself with a value typed `T` (not `T | undefined`) inside a
strict object you want to spread into a Scorezilla input, use object spread
rather than property assignment:

```ts
// Don't:
const input: SubmitScoreInput = {
  boardId,
  playerId,
  score,
  metadata: someStrictMeta as Record<string, unknown>, // cast
};

// Do:
const input: SubmitScoreInput = {
  boardId,
  playerId,
  score,
  ...(someStrictMeta ? { metadata: someStrictMeta } : {}),
};
```

The conditional spread keeps the `metadata` key absent (rather than
present-with-`undefined`) when the value isn't ready — matching what the strict
type system expects.

## Custom fetch / polyfills

`cfg.fetch` accepts any function with the shape
`(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>`. This is
intentionally broader than `typeof fetch` so common polyfills and test stubs
typecheck cleanly:

```ts
import fetch from 'node-fetch';
import { Scorezilla } from 'scorezilla';
const sz = new Scorezilla({ publicKey, fetch });
```

Polyfill compatibility:

- [`node-fetch`](https://www.npmjs.com/package/node-fetch) ≥ 3 — typechecks
  against the SDK's `FetchImpl`; functional smoke-test in the SDK's own unit
  suite.
- [`undici`](https://www.npmjs.com/package/undici) — typechecks; not exercised
  in CI but its native fetch matches the contract.
- `vi.fn()` (Vitest) — used throughout the SDK's own 171-test suite.
- `jest.fn()` — same shape as `vi.fn()`, expected to work but not currently
  exercised in CI. File an issue if you hit a mismatch.

## Bundle sizes

| Bundle           | Format | Gzipped |
| ---------------- | ------ | ------- |
| `dist/index.js`  | ESM    | ~3.8 KB |
| `dist/index.cjs` | CJS    | ~4.0 KB |

These numbers come from `size-limit` simulating a consumer's bundler. Source
maps ship alongside but aren't counted against the budget. The CI gate caps the
bundle at 6 KB gzipped.

## What the SDK does NOT do

The SDK is deliberately minimal in side-effects and identifiers.

### No fingerprinting

`detectRuntime()` probes only `globalThis.Bun`, `globalThis.Deno`,
`globalThis.process.versions.node`, `globalThis.document`, and a single specific
string check on `navigator.userAgent` (`'Cloudflare-Workers'`). No other
browser, hardware, locale, or timezone signal is read.

### No cookies, no localStorage, no IndexedDB

The SDK does not set cookies, write to `localStorage` / `sessionStorage` /
`IndexedDB`, or use any persistent client storage. The `playerId` you pass is
the only identifier the SDK transmits; it never generates or stores one on your
behalf.

### No analytics calls

The SDK sends `POST` and `GET` requests only to the configured `baseUrl`. It
does not phone home, report errors externally, or fetch from any other origin.

### No console writes during normal operation

The SDK throws `ScorezillaError` for failures rather than logging. The sole
intentional `console.warn` site is the deprecation-warning machinery described
in [VERSIONING.md](./VERSIONING.md), which fires at most once per deprecated
symbol per process and can be suppressed.

### No automatic retries on caller errors

4xx responses (except 429) are surfaced verbatim. The retry loop only fires on
5xx, 429, and network-level errors — exactly the conditions where re-attempt is
idempotent and reasonable.

## Privacy invariants summary

For your `<privacy-policy>` if you embed the SDK:

> The Scorezilla SDK transmits the player identifier and metadata you provide,
> with the API requests you instruct it to send. It does not read browser
> fingerprinting signals beyond a single runtime-detection probe; does not write
> cookies, local storage, or any other persistent data; and does not contact any
> origin besides the one you configure via `baseUrl`.

## See also

- [README.md](./README.md)
- [API.md](./API.md)
- [VERSIONING.md](./VERSIONING.md)
- [CHANGELOG.md](./CHANGELOG.md)
