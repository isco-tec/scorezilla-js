// Bundle-size budget for the scorezilla SDK.
//
// `size-limit` simulates what a consumer's bundler produces: it imports the
// built dist/index.js, applies a real minification pass (esbuild), and
// measures the gzipped result. This is the size your customers actually
// download — not the unminified tarball weight.
//
// Two checks:
//   1. ESM bundle, full import surface — caps the worst case.
//   2. ESM bundle, named import of `Scorezilla` only — proves tree-shaking
//      is effective: a customer who only imports the class pays less than
//      the full surface.
//
// CI gates on these in `.github/workflows/sdk-ci.yml`. Bumps must be
// intentional — every byte over budget is a customer-load-time tax.

module.exports = [
  {
    name: 'ESM — full surface (everything exported by index.ts)',
    path: 'dist/index.js',
    import: '*',
    limit: '6 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'ESM — `import { Scorezilla }` only (tree-shaking effectiveness)',
    path: 'dist/index.js',
    import: '{ Scorezilla }',
    limit: '6 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'CJS — full surface (Node + legacy bundlers)',
    path: 'dist/index.cjs',
    import: '*',
    limit: '6 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'ESM — `scorezilla/server` (HMAC adapter)',
    path: 'dist/server.js',
    import: '*',
    limit: '6 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'CJS — `scorezilla/server` (HMAC adapter)',
    path: 'dist/server.cjs',
    import: '*',
    limit: '6 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'ESM — `scorezilla/identity` (preset helpers)',
    path: 'dist/identity.js',
    import: '*',
    // No deps, pure helpers; budget intentionally tight. Bumps need
    // a real reason (e.g. OAuth provider code shipping in 0.3.x).
    limit: '2 KB',
    gzip: true,
    brotli: false,
  },
];
