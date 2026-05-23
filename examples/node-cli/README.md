# Node CLI — Scorezilla SDK smoke-test from the terminal

A one-shot script that submits a score and prints the player's rank.
Useful for verifying your `publicKey` + `boardId` work without writing
a UI.

## Run it (developing inside this repo)

```bash
# From the repo root:
pnpm install
pnpm build  # required — this example imports from ../../dist/

SCOREZILLA_PUBLIC_KEY=pk_yourgame_xxx \
BOARD_ID=00000000-0000-4000-8000-000000000000 \
PLAYER_ID=alice \
node examples/node-cli/index.mjs 9001
```

The `pnpm build` step is required because the script imports from
`../../dist/index.js` (the built bundle) so it doubles as a published-
surface smoke test. If you don't have the repo checked out, see the
"Run it (as a published-package consumer)" section below.

## Run it (as a published-package consumer)

Copy the script into your own project, change the import to:

```js
import { Scorezilla, ScorezillaError } from 'scorezilla';
```

…and run it with `node` after `npm install scorezilla`.

## Env vars

| Var | Required | Default |
|---|---|---|
| `SCOREZILLA_PUBLIC_KEY` | yes | — |
| `BOARD_ID` | yes | — |
| `PLAYER_ID` | no | `alice` |
| `SCOREZILLA_BASE_URL` | no | `https://api.scorezilla.dev` |

## Where to get the keys

See the top-level [README "Get your keys"](../../README.md#get-your-keys)
section. The dashboard creates a Tutorial Game on first sign-in — its
auto-created `High Scores` board is a fine target for this smoke test.

## What it shows

- Server-side / Node usage of the SDK (not just browser)
- `submitScore` + `getLeaderboard` round-trip
- Structured error handling via `ScorezillaError`

## What it does NOT show

- HMAC `sk_live_*` server-side signing (coming in v0.2.0 — `scorezilla/server`).
  For the current `v0.1.0-next` you can use `pk_*` from Node too, but you
  should treat the key as if it's still going into a browser — don't put
  it in source control.
