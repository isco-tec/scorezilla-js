/**
 * #407 cross-repo drift guard.
 *
 * `ScorezillaErrorCode` (src/types.ts) is hand-written so it can carry per-code
 * JSDoc (the hover docs SDK users rely on). But it must never silently drift
 * from the API's public error-code registry — the exact failure #407 was filed
 * for (three codes drifted before the guards existed). The canonical registry is
 * vendored from the private monorepo into `test/contract/error-codes.generated.ts`
 * by the contract sync (never hand-edited). This test:
 *   (a) proves that vendored copy matches its synced source hash, and
 *   (b) checks the union against it in both directions (with documented
 *       allowlists for the two legitimate asymmetries).
 *
 * Mirrors the monorepo's own scan-guard pattern (apps/api/test/public-error-codes.test.ts).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ERROR_CODES } from '../contract/error-codes.generated';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_TS = join(HERE, '../../src/types.ts');
const VENDORED = join(HERE, '../contract/error-codes.generated.ts');

// Registry code the SDK legitimately omits — not reachable through the SDK
// client (it auto-generates valid Idempotency-Keys; no custom-key API).
const NON_SDK_REACHABLE = new Set(['invalid_idempotency_key']);
// SDK-synthesized codes NOT in the API registry: the 409-by-status fallback
// (`conflict`) + transport-layer failures (no HTTP response was received).
// All four ARE union members — this list is exact, not a superset: a union
// literal must be in the registry OR here, and everything here is in the union.
const SDK_LOCAL = new Set(['conflict', 'network_error', 'aborted', 'timeout']);

/** The string-literal members of the ScorezillaErrorCode union. */
function unionCodes(): Set<string> {
  // Strip comments BEFORE isolating the union. A member's JSDoc both quotes
  // other tokens ('over_cap' etc.) AND contains a literal `;`
  // ("…getWindowAround`); the submit path…") that would otherwise truncate the
  // block at the first member and hide the rest — the same comment-stripping
  // discipline as the monorepo's own scan guard.
  const src = readFileSync(TYPES_TS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const block = src.match(/export type ScorezillaErrorCode =([\s\S]*?);/)?.[1];
  if (!block) throw new Error('ScorezillaErrorCode union not found in src/types.ts');
  // Digit-inclusive so a future `turnstile_v2_failed`-style literal can't
  // slip past the scan unseen (superset of the snake_case convention).
  return new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!));
}

describe('ScorezillaErrorCode mirrors the API contract registry (#407)', () => {
  const union = unionCodes();

  it('the vendored registry was not hand-edited (matches its synced source hash)', () => {
    const file = readFileSync(VENDORED, 'utf8');
    const declared = file.match(/source-sha256: ([a-f0-9]{64})/)?.[1];
    const body = file.replace(/^[\s\S]*?source-sha256: [a-f0-9]{64}\n\n/, '');
    expect(
      createHash('sha256').update(body).digest('hex'),
      'test/contract/error-codes.generated.ts was edited by hand — re-run the monorepo contract sync instead of editing it',
    ).toBe(declared);
  });

  it('every public API error code is in ScorezillaErrorCode (except not-SDK-reachable)', () => {
    const missing = [...PUBLIC_ERROR_CODES]
      .filter((c) => !union.has(c) && !NON_SDK_REACHABLE.has(c))
      .sort();
    expect(
      missing,
      `API error code(s) missing from ScorezillaErrorCode — add them to src/types.ts (with JSDoc): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every ScorezillaErrorCode literal is a real API code (except SDK-local synthesized ones)', () => {
    const registry = new Set<string>(PUBLIC_ERROR_CODES);
    const extra = [...union].filter((c) => !registry.has(c) && !SDK_LOCAL.has(c)).sort();
    expect(
      extra,
      `ScorezillaErrorCode has code(s) not in the API registry — stale/typo, or add to SDK_LOCAL if SDK-synthesized: ${extra.join(', ')}`,
    ).toEqual([]);
  });

  it('SDK_LOCAL is exact — every allowlisted code is actually a union member', () => {
    // Keeps the allowlist honest: an entry that is neither in the registry nor
    // in the union is dead weight that silently weakens the reverse check.
    const stale = [...SDK_LOCAL].filter((c) => !union.has(c)).sort();
    expect(
      stale,
      `SDK_LOCAL allowlists code(s) absent from ScorezillaErrorCode: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
