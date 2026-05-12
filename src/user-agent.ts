/**
 * Runtime detection + `User-Agent` builder.
 *
 * **Privacy invariant:** detection happens via cheap probes on
 * `globalThis` only. The SDK never reads `navigator.userAgent` for
 * fingerprinting — only for the narrow case of distinguishing Cloudflare
 * Workers from a generic worker scope. No other DOM, hardware, or
 * timezone signals are touched. This is documented in COMPATIBILITY.md.
 *
 * Note on browsers: per the Fetch spec, browsers silently ignore the
 * `User-Agent` request header. Setting it has no effect there — but it
 * remains meaningful in Node, Bun, Deno, and Workers, where we want
 * server-side observability of which SDK version + runtime issued each
 * request. The client layer also sends a separate `X-Scorezilla-Client`
 * header that browsers do honor, so we get browser-side telemetry too.
 */

/** Runtimes the SDK explicitly identifies. `unknown` is the fallback when
 *  no signature matches (e.g., a new runtime, or one with all the right
 *  globals stripped). */
export type Runtime = 'browser' | 'node' | 'bun' | 'deno' | 'workers' | 'unknown';

interface GlobalProbe {
  readonly Bun?: unknown;
  readonly Deno?: unknown;
  readonly process?: { readonly versions?: { readonly node?: string } };
  readonly document?: unknown;
  readonly WorkerGlobalScope?: unknown;
  readonly navigator?: { readonly userAgent?: string };
}

/**
 * Detect the current runtime by probing well-known globals. Pure function
 * — accepts an optional `g` override so tests can simulate any runtime.
 *
 * Order matters: Bun and Deno expose `process.versions.node`-like shims
 * for compat, so we check their own identifiers first.
 *
 * @example
 * ```ts
 * import { detectRuntime } from 'scorezilla';
 * const runtime = detectRuntime();   // → 'browser' | 'node' | 'bun' | 'deno' | 'workers' | 'unknown'
 * myTelemetry.track('app.start', { sdk_runtime: runtime });
 * ```
 *
 * @since 0.1.0
 * @stability stable
 */
export function detectRuntime(g: GlobalProbe = globalThis as GlobalProbe): Runtime {
  if (typeof g.Bun !== 'undefined') return 'bun';
  if (typeof g.Deno !== 'undefined') return 'deno';

  // Cloudflare Workers set `navigator.userAgent === 'Cloudflare-Workers'`.
  // Check this BEFORE the generic node check — Workers expose neither
  // `process` nor `document`, so the navigator probe is the unique signal.
  if (
    typeof g.navigator?.userAgent === 'string' &&
    g.navigator.userAgent.includes('Cloudflare-Workers')
  ) {
    return 'workers';
  }

  if (typeof g.process?.versions?.node === 'string') return 'node';
  if (typeof g.document !== 'undefined') return 'browser';

  return 'unknown';
}

/**
 * Build the SDK's default `User-Agent` header value.
 *
 * Shape: `scorezilla-js/<version> (<runtime>)`, e.g.
 * `scorezilla-js/0.1.0 (node)`. Version is the build-time-injected
 * `SDK_VERSION` so we don't read package.json at runtime.
 */
export function defaultUserAgent(version: string, runtime: Runtime = detectRuntime()): string {
  return `scorezilla-js/${version} (${runtime})`;
}
