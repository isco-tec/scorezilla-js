---
'scorezilla': minor
---

**Initial public release candidate.** First publish of the `scorezilla` SDK to npm.

Includes the v0.1.0 public-key client surface:

- `Scorezilla` class with `submitScore`, `getLeaderboard`, `getPlayerRank`, `getWindowAround`
- `ScorezillaError` for every failure path (network, timeout, abort, HTTP non-2xx)
- Universal runtime support (browsers, Node ≥ 20, Cloudflare Workers, Bun, Deno)
- Automatic retries with idempotency keys
- Dual ESM/CJS build with [arethetypeswrong](https://arethetypeswrong.github.io/)-clean exports map
- ~3.8 KB ESM gzipped

This RC publishes under the `next` npm dist-tag — install with `npm install scorezilla@next` to try it out. The HMAC server adapter, React hooks, and Phaser plugin land in subsequent v0.2.0, v0.3.0, and v0.4.0 releases.
