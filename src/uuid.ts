/**
 * Cross-context UUID v4 generation.
 *
 * `crypto.randomUUID()` is the native fast path, but it is exposed **only in
 * secure contexts** — https, or `http://localhost`. A game served from a
 * plain-http origin (a LAN IP like `http://192.168.1.20`, a non-localhost dev
 * hostname) has a `crypto` object but **no** `crypto.randomUUID`, so calling it
 * throws. `crypto.getRandomValues()`, by contrast, is available in *every*
 * context (secure or not) and in every runtime the SDK targets, so it is a
 * correct, collision-safe fallback.
 *
 * This matters because the SDK mints a UUID on every POST (the idempotency
 * key). Without the fallback, every write from a plain-http origin throws
 * before the request is even sent — silently, for the exact "localhost-adjacent
 * dev server" audience the SDK is built for.
 */

/** RFC 4122 §4.4 v4 UUID assembled from 16 random bytes. */
function uuidV4FromBytes(bytes: Uint8Array): string {
  // Pin the version (4) into the high nibble of byte 6 and the variant (10xx)
  // into the two high bits of byte 8 — what makes the bytes a valid v4 UUID.
  // (`?? 0` only to satisfy noUncheckedIndexedAccess; the array is length 16.)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * A UUID v4 string. Prefers native `crypto.randomUUID()`; falls back to a
 * `crypto.getRandomValues()`-derived v4 when `randomUUID` is unavailable
 * (a non-secure context). Throws only when no Web Crypto RNG exists at all —
 * a genuinely unsupported runtime (the SDK declares Node ≥ 20 / modern
 * browsers, all of which expose `getRandomValues`).
 */
export function randomUUID(): string {
  const c = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
      };
    }
  ).crypto;

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === 'function') {
    return uuidV4FromBytes(c.getRandomValues(new Uint8Array(16)));
  }
  throw new Error(
    'scorezilla: no Web Crypto RNG available (neither crypto.randomUUID nor ' +
      'crypto.getRandomValues). The SDK requires Node ≥ 20 or a modern browser.',
  );
}
