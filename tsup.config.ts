import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// Read version from package.json so SDK_VERSION always matches the published
// version. Done at build time; nothing reads package.json at runtime.
//
// Defensive parse: if package.json is malformed or missing `version`, the
// build fails loud rather than silently emitting `__SCOREZILLA_SDK_VERSION__
// = "undefined"`. That kind of silent bug would otherwise survive all the
// way to npm consumers who'd see `Scorezilla.version === undefined`.
const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url));
const pkgRaw = readFileSync(pkgPath, 'utf8');
const pkg: unknown = JSON.parse(pkgRaw);
function readVersion(p: unknown): string {
  if (p && typeof p === 'object' && 'version' in p) {
    const v = (p as { version: unknown }).version;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  throw new Error(
    'tsup.config.ts: package.json is missing a non-empty `version` field. ' +
      'The build refuses to emit __SCOREZILLA_SDK_VERSION__ = "undefined".',
  );
}
const SDK_VERSION = readVersion(pkg);

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    react: 'src/react.ts',
    phaser: 'src/phaser.ts',
    'server-browser-stub': 'src/server-browser-stub.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  // ES2022 is the floor: WebCrypto, top-level await, Error cause, all current
  // Node 20+, modern Safari/Firefox/Chrome. Re-evaluate against caniuse only
  // when a new browser-target capability is needed.
  target: 'es2022',
  // `neutral` keeps the bundle free of Node-only or browser-only shims. The
  // SDK targets both — esbuild's `node` platform default would silently allow
  // built-in module imports that break in browsers. This is the second line
  // of defense against accidental Node-only deps (the first is the ESLint
  // import gate in `eslint.config.mjs`).
  platform: 'neutral',
  outDir: 'dist',
  // Per-entry isolation: each subpath export resolves to a self-contained
  // file. No shared chunks means consumers tree-shake cleanly and we don't
  // ship a hidden `chunk-*.js` that has to live forever for back-compat.
  splitting: false,
  cjsInterop: true,
  define: {
    __SCOREZILLA_SDK_VERSION__: JSON.stringify(SDK_VERSION),
  },
});
