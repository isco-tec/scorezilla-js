---
'scorezilla': patch
---

**Pre-release security hardening pass.** Three issues surfaced by a focused security review before the first public release of `scorezilla/server`:

- **HIGH — nonce injection.** `buildHmacAuthHeader` now requires injected nonces to be at least 16 characters. The default path (`crypto.randomUUID()`) is unaffected. Previously a misconfigured caller could pass `nonce: ''` and silently sign a header with no replay protection — the server has no minimum-length check, so the API would accept it. Now caught at SDK build-time with a clear error.
- **HIGH — server policy disclosure.** `HMAC_TIMESTAMP_WINDOW_SECONDS = 300` was previously exported as documentation of the API's clock-skew tolerance. Removed from the public API — publishing the server's replay-protection window in the SDK's types was unnecessary information disclosure and narrowed the pre-computation window for any future timestamp-forgery work. The SDK has no behavioral dependency on the value (it always emits a fresh `ts = floor(Date.now() / 1000)`).
- **MEDIUM — `EdgeRuntime` polyfill bypass.** The server adapter's runtime browser-guard previously trusted `globalThis.EdgeRuntime` as a "this is a server" signal. A browser extension or bundler misconfig setting that global would have bypassed the guard. Removed from the trusted set — the package's `exports.browser` condition remains the primary gate, and the runtime check now refuses to trust globals that can be polyfilled from a browser context. Real Vercel Edge runtimes still pass the guard because they don't have `window`/`document`.

No external-attack surface was exploitable; all three are self-inflicted/defense-in-depth issues caught before the first stable release. Tests added: 4 for nonce validation (rejects empty / too-short, accepts at-floor / default UUID), 1 for the EdgeRuntime polyfill scenario.
