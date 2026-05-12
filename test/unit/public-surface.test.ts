/**
 * Public-surface smoke test.
 *
 * Imports through the actual public entry — `'../../src/index'` rather than
 * a deep module path. This ensures every export the README and API.md
 * promise is reachable, AND it gives coverage tools something to attribute
 * to `src/index.ts` (which is otherwise un-imported by the more focused
 * unit suites).
 */

import { describe, expect, it } from 'vitest';
import {
  createClient,
  detectRuntime,
  SDK_VERSION,
  Scorezilla,
  ScorezillaError,
} from '../../src/index';

describe('public surface (src/index.ts)', () => {
  it('exports Scorezilla as a constructor', () => {
    expect(typeof Scorezilla).toBe('function');
    expect(new Scorezilla({ publicKey: 'pk_testgame_aBcDeFgHiJkLmNoPqR' })).toBeInstanceOf(
      Scorezilla,
    );
  });

  it('exports createClient as a function returning Scorezilla', () => {
    const sz = createClient({ publicKey: 'pk_testgame_aBcDeFgHiJkLmNoPqR' });
    expect(sz).toBeInstanceOf(Scorezilla);
  });

  it('exports ScorezillaError as a constructor', () => {
    expect(typeof ScorezillaError).toBe('function');
    const e = new ScorezillaError('x', { status: 500, code: 'internal_error' });
    expect(e).toBeInstanceOf(ScorezillaError);
  });

  it('exports SDK_VERSION as a non-empty string', () => {
    expect(typeof SDK_VERSION).toBe('string');
    expect(SDK_VERSION.length).toBeGreaterThan(0);
  });

  it('exports detectRuntime as a function', () => {
    expect(typeof detectRuntime).toBe('function');
    const r = detectRuntime();
    expect(['browser', 'node', 'bun', 'deno', 'workers', 'unknown']).toContain(r);
  });

  it('Scorezilla.version matches the imported SDK_VERSION', () => {
    expect(Scorezilla.version).toBe(SDK_VERSION);
  });
});
