import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Single-file config — owns coverage settings, the build-time `define`
// substitution that mirrors tsup's, AND the two-project layout (vitest 4
// removed `vitest.workspace.ts`; projects live in `test.projects` now):
//   • `unit`        — jsdom env, fast, runs on every commit. Covers the SDK
//                     surface that doesn't touch the network.
//   • `integration` — node env, longer timeout (60 s) for end-to-end runs
//                     against a running API. Skips with no env config; in
//                     CI here, no integration env is wired (the API runs
//                     elsewhere), so integration stays a local-dev tool
//                     for engineers who have admin access to a target API.
//
// Each project sets `extends: true` to inherit this root config — that is
// what carries `define` (and any future plugins) into the projects.
//
// `setupFiles` shims `globalThis.__SCOREZILLA_SDK_VERSION__` so source
// files that reference the tsup-defined build-time constant resolve at
// test runtime. See `test/_setup/sdk-version.ts` for the why.
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

    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
          setupFiles: ['./test/_setup/sdk-version.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          setupFiles: ['./test/_setup/sdk-version.ts'],
          // Provisioning a fresh test game via admin endpoint + HTTP
          // round-trips pushes past the default 5 s ceiling; 60 s gives
          // slow networks room.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],

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
