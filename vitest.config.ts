import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Root-level config — owns coverage settings AND the build-time `define`
// substitution that mirrors tsup's. Project shapes (unit / integration)
// live in `vitest.workspace.ts`; vitest 2.1 only accepts inline project
// definitions in the dedicated workspace file, not nested inside
// `test.workspace`. When this repo upgrades to vitest 3+, both files can
// collapse back into one via `test.projects`.
//
// Coverage exclusions: the four adapter stubs (server / react / phaser /
// server-browser-stub) throw at module top — covering them would only
// assert the throw, which is a smoke test, not real behavior.

const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export default defineConfig({
  // `define` is read by vitest's underlying esbuild transform, so source
  // files that reference `__SCOREZILLA_SDK_VERSION__` resolve to the package
  // version under test — without this, every `client.ts` import via tests
  // would crash with "is not defined". Mirrors tsup.config.ts:`define`.
  define: {
    __SCOREZILLA_SDK_VERSION__: JSON.stringify(pkg.version),
  },

  test: {
    // Don't fail when a project's include glob has zero matches — real
    // failures surface as actual test failures, not "couldn't find any
    // tests". Useful when contributors filter to a project they're
    // populating from scratch.
    passWithNoTests: true,

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Type-declaration file — no runtime code to cover.
        'src/global.d.ts',
        // Adapter stubs that throw at module top; covering them would only
        // assert the throw, not real behavior.
        'src/server.ts',
        'src/react.ts',
        'src/phaser.ts',
        'src/server-browser-stub.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
