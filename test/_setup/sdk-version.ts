/**
 * Vitest setup: define the build-time constant `__SCOREZILLA_SDK_VERSION__`
 * so source files that reference it resolve at test runtime.
 *
 * Background: tsup's `define` substitutes the literal `__SCOREZILLA_SDK_VERSION__`
 * with `"<version>"` at build time. Vitest doesn't go through tsup — it
 * evaluates the source directly. We tried `defineWorkspace([{ define: … }])`
 * but vitest 2.1's workspace projects don't reliably propagate the
 * top-level Vite `define` field to every project's esbuild transform.
 *
 * The fallback: declare the identifier on `globalThis` BEFORE any source
 * file is imported. At runtime, an unresolved identifier reference (e.g.
 * `var x = __SCOREZILLA_SDK_VERSION__`) falls through to a globalThis
 * property lookup, so this works exactly like the build-time substitution
 * for the purposes of testing.
 *
 * We hardcode `'0.0.0-test'` rather than reading package.json: jsdom (the
 * unit project's env) doesn't expose `import.meta.url` as a `file://` URL
 * so `fileURLToPath` would fail there. Tests only assert the SHAPE of the
 * version string, not the exact value.
 *
 * Drop this file once the repo upgrades to vitest 3+ (which supports
 * `test.projects` with reliable `extends: true` inheritance from
 * vitest.config.ts's top-level define).
 */
(globalThis as { __SCOREZILLA_SDK_VERSION__?: string }).__SCOREZILLA_SDK_VERSION__ = '0.0.0-test';
