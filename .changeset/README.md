# Changesets

Adding a release note?

```bash
pnpm changeset
```

This creates a small markdown file in `.changeset/` describing what changed and
which version bump it requires (`patch` / `minor` / `major`). Commit the
changeset file alongside your code in the same PR.

When a PR with a changeset lands on `main`, the release workflow opens (or
updates) a "Version Packages" PR that aggregates pending changesets, bumps the
version in `package.json`, and updates `CHANGELOG.md`. Merging that PR
publishes a new release.

## Versioning policy

See [`VERSIONING.md`](../VERSIONING.md) for the full SemVer contract,
breaking-change rules, and deprecation policy.

- **patch** — bug fix, internal refactor, docs
- **minor** — new method, new optional argument, new error code (additive)
- **major** — renamed/removed symbol, changed signature, dropped runtime support
