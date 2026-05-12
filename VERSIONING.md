# Versioning policy

Scorezilla follows [Semantic Versioning](https://semver.org/) starting at
**v0.1.0**. This document defines what counts as a breaking change, what the
SemVer contract covers (and explicitly does NOT cover), and the path to v1.0.

## The SemVer contract

### Covered by SemVer

**Machine-stable.** A change to any of these requires a major version bump.

| What                                               | Where                                                                   | Example                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Method names**                                   | `Scorezilla.*`                                                          | Renaming `submitScore` → `postScore` is a major bump.                                                             |
| **Method signatures (required args, return type)** | `Scorezilla.*`                                                          | Adding a required parameter is a major bump. Tightening a return type (`number` → `1 \| 2 \| 3`) is a major bump. |
| **Error codes**                                    | `ScorezillaError.code`                                                  | Renaming `out_of_bounds` → `score_out_of_range` is a major bump. Removing a code is a major bump.                 |
| **Error sub-fields**                               | `ScorezillaError.{reason, retryAfter, bound, layer, status, requestId}` | Renaming `retryAfter` → `retryAfterSec` is a major bump.                                                          |
| **Config field names**                             | `ScorezillaConfig.*`                                                    | Renaming `baseUrl` → `apiOrigin` is a major bump.                                                                 |
| **Auth mode discriminator**                        | `publicKey` vs `secretKey`                                              | Adding a third top-level auth field is non-breaking; renaming either is a major bump.                             |
| **Type exports**                                   | `import type { … } from 'scorezilla'`                                   | Removing or renaming a type export is a major bump.                                                               |
| **Default behavior of optional knobs**             | `timeoutMs`, `maxRetries`, retry windows                                | Changing the default of `timeoutMs` from 30 000 to 5 000 is a major bump.                                         |

### NOT covered by SemVer

**English-flavored and free to change.**

| What                                     | Where                            | Why                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`message` text on errors**             | `ScorezillaError.message`        | English-only operator hint. Branch on `code` and `reason` instead.                                                                                                                                  |
| **Error stack format**                   | `ScorezillaError.stack`          | V8 / SpiderMonkey / JavaScriptCore each format differently and update across runtime versions.                                                                                                      |
| **Whitespace / casing in `User-Agent`**  | Header value                     | Cosmetic.                                                                                                                                                                                           |
| **Internal module layout**               | `src/*`                          | Not part of the public surface. Importing from anywhere other than `'scorezilla'` (or its documented subpaths `'scorezilla/server'` / `'scorezilla/react'` / `'scorezilla/phaser'`) is unsupported. |
| **Server-side response field additions** | New fields on `*Response` shapes | Response types are open `Record`-friendly — the API may add fields in a minor release without breaking consumers who don't read them.                                                               |

## What counts as a breaking change

### Breaking (major bump)

- Removing or renaming an exported symbol (class, function, type)
- Removing a method on `Scorezilla`
- Removing a field on a published response type
- Renaming or removing an error code
- Adding a **required** argument to a method
- Narrowing a return type (e.g., `number | undefined` → `number`)
- Changing the default value of an optional knob in a user-visible way
- Tightening runtime validation that used to accept some input
- Dropping support for a documented runtime (e.g., Node 20)

### Non-breaking (minor or patch bump)

- Adding a new method
- Adding a new optional argument with a backward-compatible default
- Adding a new error code that the server already returns
- Adding a new field on a response type
- Bug fixes that align behavior with the documented contract
- Performance / bundle-size improvements
- New exported type that doesn't replace an existing one
- New subpath export (e.g., adding `scorezilla/server` in v0.2.0)

### Patch-bump only

- Documentation updates
- Internal refactors that don't change observable behavior
- Dependency version bumps within `peerDependencies` semver ranges

## Deprecation policy

When we need to remove or replace a public symbol:

1. **Mark deprecated.** Add `@deprecated` JSDoc on the symbol with:
   - The version it was deprecated (`@deprecated 0.5.0`)
   - The version it will be removed (`will be removed in 1.0.0`)
   - The replacement, if any
2. **Runtime warning.** First call site emits a single `console.warn`:
   ```
   scorezilla: `oldMethod` is deprecated since 0.5.0 and will be removed in 1.0.0. Use `newMethod` instead.
   ```
   Suppressible via `SCOREZILLA_SUPPRESS_DEPRECATION_WARNINGS=1` env or the
   `suppressDeprecationWarnings: true` config field.
3. **Minimum window.** A symbol must spend at least **one full minor release**
   in the deprecated state before removal in the next major. This gives
   consumers a guaranteed upgrade path without forced churn.
4. **CHANGELOG entry.** Both the deprecation and the removal are explicitly
   called out.

## 0.x → 1.0 exit criteria

The SDK stays in `0.x` until ALL of the following are true:

- [ ] 30 days have passed on `main` without a breaking change to the core
      surface (the `Scorezilla` class + `ScorezillaError` + `ScorezillaConfig`).
- [ ] **`scorezilla/server`** (HMAC adapter, v0.2.0) has shipped and seen
      production use.
- [ ] **`scorezilla/react`** (React adapter, v0.3.0) has shipped and seen
      production use.
- [ ] Zero open issues tagged `api-shape-drift` from real-world consumers.
- [ ] The 4-method surface (`submitScore`, `getLeaderboard`, `getPlayerRank`,
      `getWindowAround`) has not had a signature change for the same 30-day
      window.

When all five are met, we cut **v1.0.0** with no breaking changes from the last
0.x — v1.0 is just "this is the surface we commit to." Subsequent breaking
changes follow normal SemVer (major bump).

## Pre-release tags

| Tag            | Meaning                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `latest`       | Stable, recommended for production.                                                                          |
| `next`         | Release candidate. Installable via `npm install scorezilla@next`.                                            |
| `experimental` | Alpha features behind a flag. May break without notice between releases. Not covered by the SemVer contract. |

## Reporting drift

If you encounter behavior that contradicts this document — e.g., a `code` value
changed across a minor release — please file an issue at
<https://github.com/isco-tec/scorezilla-js/issues> with the tag
`api-shape-drift`. These reports gate the 1.0 cut.
