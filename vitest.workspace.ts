import { defineWorkspace } from 'vitest/config';

// Two-project layout for the scorezilla SDK:
//   • `unit`        — jsdom env, fast, runs on every commit. Covers the SDK
//                     surface that doesn't touch the network.
//   • `integration` — node env, longer timeout (60 s) for end-to-end runs
//                     against a running API. Skips with no env config; in
//                     CI here, no integration env is wired (the API runs
//                     elsewhere), so integration stays a local-dev tool
//                     for engineers who have admin access to a target API.
//
// Each project is fully independent — vitest 2.x workspace projects do NOT
// inherit `vitest.config.ts` (3.x's `extends: true` fixes this).
//
// `setupFiles` shims `globalThis.__SCOREZILLA_SDK_VERSION__` so source
// files that reference the tsup-defined build-time constant resolve at
// test runtime. See `test/_setup/sdk-version.ts` for the why.

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'jsdom',
      include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
      setupFiles: ['./test/_setup/sdk-version.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      environment: 'node',
      include: ['test/integration/**/*.test.ts'],
      setupFiles: ['./test/_setup/sdk-version.ts'],
      // Provisioning a fresh test game via admin endpoint + HTTP round-trips
      // pushes past the default 5 s ceiling; 60 s gives slow networks room.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
