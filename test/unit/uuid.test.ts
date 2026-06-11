import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from '../../src/uuid';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const original = globalThis.crypto;

function setCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

describe('randomUUID', () => {
  afterEach(() => setCrypto(original));

  it('returns a valid v4 via the native path (secure context)', () => {
    // Default environment has crypto.randomUUID.
    expect(randomUUID()).toMatch(UUID_V4);
  });

  it('falls back to a valid v4 when randomUUID is absent but getRandomValues exists', () => {
    setCrypto({ getRandomValues: (a: Uint8Array) => original.getRandomValues(a) });
    expect(randomUUID()).toMatch(UUID_V4);
  });

  it('fallback sets the version (4) and variant (8/9/a/b) bits correctly', () => {
    setCrypto({ getRandomValues: (a: Uint8Array) => original.getRandomValues(a) });
    for (let i = 0; i < 200; i++) {
      const u = randomUUID();
      expect(u[14]).toBe('4'); // version nibble
      expect('89ab').toContain(u[19].toLowerCase()); // variant nibble
    }
  });

  it('fallback is collision-free across many draws', () => {
    setCrypto({ getRandomValues: (a: Uint8Array) => original.getRandomValues(a) });
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomUUID());
    expect(seen.size).toBe(1000);
  });

  it('throws only when no Web Crypto RNG exists at all', () => {
    setCrypto(undefined);
    expect(() => randomUUID()).toThrow(/Web Crypto/);
  });
});
