# Vanilla HTML — minimal Scorezilla example

The smallest possible SDK integration: one HTML file, one JS file, no
build step, no framework. Submits a score and reads the top-N.

## Run it

You need two things from the dashboard (see the top-level
[README "Get your keys"](../../README.md#get-your-keys) section):

- `publicKey` — a `pk_*` string from `dashboard.scorezilla.dev`
- `boardId` — a UUID, also from the dashboard

Open `index.html` in any browser and paste those into the form. Submits
go to `https://api.scorezilla.dev` against the real API.

If you want to run against a local API instead, set `SCOREZILLA_BASE_URL`
in the URL hash or edit `app.js:5` directly.

## What it shows

- ESM import of the SDK from npm CDN (`https://esm.sh/scorezilla`)
- `new Scorezilla({ publicKey })` constructor
- `submitScore` + `getLeaderboard` round-trip
- Handling `ScorezillaError` with typed predicates (e.g. `isUsageCapExceeded()`)

## What it does NOT show

- TypeScript (use `examples/node-cli` for a typed demo via dist build)
- HMAC `sk_live_*` server-side flow (coming in v0.2.0 — `scorezilla/server`)
- Persistent player identity (use `scorezilla/identity` helpers in a real app)

## Next steps

- For TypeScript / a build pipeline: see the [Phaser](../../README.md) and React snippets in the top-level README.
- For AI-scaffolded integration: use the [Scorezilla MCP](https://github.com/isco-tec/scorezilla-mcp) — `bootstrap_leaderboard` will hand you a complete integration code block.
