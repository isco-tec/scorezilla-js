import { describe, expect, it } from 'vitest';
import { defaultUserAgent, detectRuntime } from '../../src/user-agent';

describe('detectRuntime', () => {
  it('returns "bun" when globalThis.Bun is defined', () => {
    expect(detectRuntime({ Bun: {} })).toBe('bun');
  });

  it('returns "deno" when globalThis.Deno is defined', () => {
    expect(detectRuntime({ Deno: {} })).toBe('deno');
  });

  it('returns "workers" when navigator.userAgent contains "Cloudflare-Workers"', () => {
    expect(detectRuntime({ navigator: { userAgent: 'Cloudflare-Workers' } })).toBe('workers');
  });

  it('returns "node" when process.versions.node is set', () => {
    expect(detectRuntime({ process: { versions: { node: '20.10.0' } } })).toBe('node');
  });

  it('returns "browser" when document is defined and no other signature matches', () => {
    expect(detectRuntime({ document: {} })).toBe('browser');
  });

  it('returns "unknown" when no signature matches', () => {
    expect(detectRuntime({})).toBe('unknown');
  });

  it('prefers Bun over Node when both signatures present (Bun shims process)', () => {
    expect(detectRuntime({ Bun: {}, process: { versions: { node: '20.10.0' } } })).toBe('bun');
  });

  it('prefers Deno over Node when both signatures present', () => {
    expect(detectRuntime({ Deno: {}, process: { versions: { node: '20.10.0' } } })).toBe('deno');
  });

  it('prefers Workers over Browser-default-document when navigator signature matches', () => {
    // A worker scope might also have `self` and other window-like globals.
    expect(
      detectRuntime({
        navigator: { userAgent: 'Cloudflare-Workers' },
        document: {},
      }),
    ).toBe('workers');
  });

  it('the real globalThis classifies as one of the documented runtimes', () => {
    // The vitest "unit" project uses jsdom, so this should be "browser" —
    // jsdom provides `document` but not `process.versions.node` in the
    // typical setup. If vitest changes its default env, this asserts a
    // valid runtime regardless.
    const r = detectRuntime();
    expect(['browser', 'node', 'bun', 'deno', 'workers', 'unknown']).toContain(r);
  });
});

describe('defaultUserAgent', () => {
  it('formats as scorezilla-js/<version> (<runtime>)', () => {
    expect(defaultUserAgent('0.1.0', 'node')).toBe('scorezilla-js/0.1.0 (node)');
  });

  it('uses detectRuntime by default', () => {
    const ua = defaultUserAgent('1.2.3');
    expect(ua).toMatch(/^scorezilla-js\/1\.2\.3 \((browser|node|bun|deno|workers|unknown)\)$/);
  });
});
