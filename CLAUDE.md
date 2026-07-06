# scorezilla-js

Official JS/TS SDK for Scorezilla (scorezilla.dev) — hosted leaderboards for indie/browser games. Published to npm as `scorezilla`. PUBLIC repo — never commit secrets, tokens, or internal URLs.

## Stack

TypeScript (strict) → tsup dual ESM+CJS with subpath exports (`/server`, `/react`, `/identity`, `/headless`, `/phaser`). Vitest (unit/integration/contract projects). Zero runtime deps; `jose` is an optional lazy-loaded peer dep. Targets browser, Node >=20, Workers, Bun, Deno.

## Commands

Package manager is **pnpm** (pinned `pnpm@10.11.0` — never npm/yarn).

- `pnpm dev` — tsup watch
- `pnpm build`
- `pnpm test` / `pnpm test:unit` / `pnpm test:integration` / `pnpm test:coverage`
- `pnpm typecheck` · `pnpm lint` / `pnpm lint:fix`
- `pnpm size` (bundle budget) · `pnpm check:types-resolution` (attw)

## Deploy (npm release)

- Releases are **CI-only** via `.github/workflows/sdk-release.yml` (runs on every push to main). NEVER `npm publish` locally.
- **Changesets-only versioning**: record changes with `pnpm changeset`. NEVER hand-bump the `package.json` version or edit `CHANGELOG.md` — the release bot does both.
- Flow: merge changeset to main → approve the `npm-publish` environment gate → bot opens/updates the "Version Packages" PR → merge that PR (+ approve the gate again) → publish to npm with provenance.
- Gotcha: the bot's Version PR does NOT trigger required CI (GITHUB_TOKEN limitation) — **close/reopen the PR** to run the required checks before merging.
- Every sdk-release.yml run pauses at the `npm-publish` environment for manual approval. This is intentional supply-chain defense — never work around it.

## Rules & gotchas

- `test/contract/error-codes.generated.ts` is GENERATED from the API repo (cross-repo contract sync) — never hand-edit it. A red `test/unit/contract-drift.test.ts` usually means the API repo changed error codes, not a local bug.
- Bundle size is gated by `.size-limit.cjs` (gzipped, post-tree-shake). Size bumps must be intentional and pass `pnpm size` (`pnpm size:why` to inspect).
- Zero runtime dependencies is policy. Don't add deps; heavy optional features go behind lazy-loaded optional peer deps (like `jose`).
- New subpath export = update `tsup.config.ts` + `exports` + `typesVersions` in package.json, and it must pass `pnpm check:types-resolution`.
- A successful publish fires a repo-dispatch to `isco-tec/scorezilla` for marketing version sync (`SCOREZILLA_REPO_DISPATCH_TOKEN`).

Full brief & known issues: ~/Code/ccc/projects/by-name/scorezilla-js/
