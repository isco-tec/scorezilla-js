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
    name: 'ESM — `scorezilla/server` (HMAC adapter + factories)',
    path: 'dist/server.js',
    import: '*',
    // Bumped 6 -> 7 KB in 0.3.0: `createScoreSubmitHandler` (#211) and the
    // built-in `verifyJwt`/`verifySupabaseJwt` verifiers landed here. `jose`
    // is an optional peer dep loaded via dynamic import — it is NOT bundled,
    // so this figure is just the thin factory + verifier wrappers. Server-side
    // bundle; size matters less here than for the browser client.
    // Bumped 7 -> 8 KB in 0.3.0-next.3: `createGitHubOAuthHandler` (#194) —
    // the OAuth callback endpoint incl. its inline HTML page (~1.2 KB gz).
    limit: '8 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'CJS — `scorezilla/server` (HMAC adapter + factories)',
    path: 'dist/server.cjs',
    import: '*',
    limit: '8 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'ESM — `scorezilla/server` adapter only (tree-shaking proof: factories dropped)',
    path: 'dist/server.js',
    import: '{ Scorezilla }',
    // Proves a consumer who only uses the HMAC client pays for neither
    // `createScoreSubmitHandler` nor `createGitHubOAuthHandler` — same
    // boundary-guard pattern as the identity core-only entry below. Cap sits
    // just above the adapter's actual size; a factory leak (each ~1 KB+)
    // trips it immediately.
    limit: '5.5 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'ESM — `scorezilla/identity` full surface (incl. Google + GitHub OAuth wrappers)',
    path: 'dist/identity.js',
    import: '*',
    // OAuth (Google) shipped in 0.3.0-next.1 — the "real reason" the original
    // 2 KB note anticipated. GitHub (popup + exchange-endpoint flow) joined in
    // 0.3.0-next.3. This worst-case figure pulls in the whole surface incl.
    // both provider wrappers. The heavy Google Identity Services library is
    // NOT bundled (fetched at runtime), and the GitHub token exchange lives
    // server-side — these are thin client orchestrators. Non-OAuth consumers
    // don't pay for either; the tree-shaking-proof entry below gates that.
    limit: '3 KB',
    gzip: true,
    brotli: false,
  },
  {
    name: 'ESM — `scorezilla/identity` core only (tree-shaking proof: OAuth dropped)',
    path: 'dist/identity.js',
    import: '{ useAnonymousPlayer }',
    // Proves a consumer who only uses the non-OAuth presets does NOT bundle the
    // Google provider: `sideEffects: false` lets the bundler drop the unused
    // `useAuthProvider` subtree, and with it the entire `./identity/google`
    // module. This is the real boundary guard — the cap is set just above the
    // actual core size (~0.38 KB), so any GIS leak (the wrapper is ~1 KB+)
    // trips it immediately. A legitimate core-preset change bumps it knowingly.
    limit: '0.6 KB',
    gzip: true,
    brotli: false,
  },
];
