# Node server (HMAC) — Scorezilla SDK secret-key example

A one-shot script that submits an HMAC-signed score and reads the top-N
through the `scorezilla/server` adapter. Useful for verifying your
`sk_live_*` secret + `boardId` work without writing a backend.

## Run it (developing inside this repo)

```bash
# From the repo root:
pnpm install
pnpm build  # required — this example imports from ../../dist/server.js

SCOREZILLA_SECRET_KEY=sk_live_<keyId>_<random> \
BOARD_ID=00000000-0000-4000-8000-000000000000 \
PLAYER_ID=alice \
node examples/node-server-hmac/index.mjs 9001
```

The `pnpm build` step is required because the script imports from
`../../dist/server.js` (the built bundle) so it doubles as a published-
surface smoke test for `scorezilla/server`. The example imports
through the public exports map — never a deep `../../src/*` path.

## Run it (as a published-package consumer)

Copy the script into your own project, change the import to:

```js
import { Scorezilla, ScorezillaError } from 'scorezilla/server';
```

…and run it with `node` after `npm install scorezilla`. You'll need
`engines.node ≥ 20` (Node 20+ has `fetch` built in).

## Env vars

| Var | Required | Default |
|---|---|---|
| `SCOREZILLA_SECRET_KEY` | yes | — (format: `sk_live_<keyId>_<random>`) |
| `BOARD_ID` | yes | — |
| `PLAYER_ID` | no | `alice` |
| `SCOREZILLA_BASE_URL` | no | `https://api.scorezilla.dev` |

## Where to get the keys

See the top-level [README "Get your keys"](../../README.md#get-your-keys)
section. The dashboard issues secret keys ONCE at game creation; the
plaintext is never recoverable afterwards (only the prefix is shown).
Store the full plaintext in your server's secret manager.

## ⚠️ Never put `sk_live_*` in client code

The whole point of the server adapter is that the secret never leaves
your backend. Putting it in a browser bundle, a mobile app string
table, or a CDN-hosted JavaScript file defeats the model entirely.

The package's `exports.browser` condition routes `scorezilla/server`
to a stub that throws at module evaluation if a browser bundler
includes it, but defense-in-depth: keep the secret in a server-side
secret manager and inject via env at boot.

## What it shows

- HMAC-signed submit via `POST /v1/secure/scores`
- HMAC-signed read via `GET /v1/boards/:id/leaderboard`
- Structured error handling via `ScorezillaError` with typed predicates
  (`isRateLimited`, `isUsageCapExceeded`, etc.)
- Fresh `(ts, nonce)` pair generated on every retry (replay-safe)

## What it does NOT show

- HTTP framework integration (Express/Hono/Fastify/Next.js route
  handlers). Once you have a `Scorezilla` instance from this script,
  drop the `submitScore` call into your handler — same code path.
- Multi-game key management. This example uses one secret. Real
  backends typically read from a key store keyed by `gameId`.
