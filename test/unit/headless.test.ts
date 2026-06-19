/**
 * Tests for the headless, never-throws client (`scorezilla/headless`).
 *
 * Coverage targets:
 *   • submit() maps a success to { ok, rank, totalEntries, isPersonalBest }
 *   • submit() returns null on ANY error — never throws
 *   • submit() forwards name + turnstileToken (cross-origin token path)
 *   • getLeaderboard() returns the entries (incl. display name) on success
 *   • getLeaderboard() returns [] on ANY error — never throws
 *   • isCrossOrigin() origin comparison + fail-safe branches
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeadlessClient, isCrossOrigin } from '../../src/headless';
import type { FetchImpl } from '../../src/transport';

const VALID_PUBLIC_KEY = 'pk_testgame_aBcDeFgHiJkLmNoPqR';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function makeHeadless(fetchImpl: FetchImpl) {
  return createHeadlessClient({
    publicKey: VALID_PUBLIC_KEY,
    baseUrl: 'https://api.example.com',
    fetch: fetchImpl,
    // 4xx never retries, but pin this so a stray 5xx in a future edit can't
    // make the "never throws" tests slow.
    maxRetries: 0,
  });
}

describe('createHeadlessClient — submit', () => {
  it('maps a successful submit to the headless result shape', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        keyId: 'k',
        rank: 3,
        totalEntries: 42,
        isPersonalBest: true,
      }),
    ) as unknown as FetchImpl;

    const sz = makeHeadless(fetchImpl);
    const result = await sz.submit({ boardId: 'b', playerId: 'p', score: 100 });

    expect(result).toEqual({ ok: true, rank: 3, totalEntries: 42, isPersonalBest: true });
  });

  it('returns null on an API error instead of throwing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'rate_limited' }, { status: 429 }),
    ) as unknown as FetchImpl;

    const sz = makeHeadless(fetchImpl);
    await expect(sz.submit({ boardId: 'b', playerId: 'p', score: 1 })).resolves.toBeNull();
  });

  it('returns null on a network failure instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as FetchImpl;

    const sz = makeHeadless(fetchImpl);
    await expect(sz.submit({ boardId: 'b', playerId: 'p', score: 1 })).resolves.toBeNull();
  });

  it('forwards name + turnstileToken on the wire (cross-origin token path)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        keyId: 'k',
        rank: 1,
        totalEntries: 1,
        isPersonalBest: true,
      }),
    ) as unknown as FetchImpl;

    const sz = makeHeadless(fetchImpl);
    await sz.submit({
      boardId: 'b',
      playerId: 'p',
      score: 100,
      name: 'Alice',
      turnstileToken: 'cf-token-xyz',
    });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe('Alice');
    expect(body.turnstileToken).toBe('cf-token-xyz');
  });
});

describe('createHeadlessClient — getLeaderboard', () => {
  it('returns the entries (incl. display name) on success', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        boardId: 'b',
        offset: 0,
        limit: 100,
        entries: [{ rank: 1, playerId: 'p1', score: 999, submittedAt: 1, name: 'Champ' }],
      }),
    ) as unknown as FetchImpl;

    const sz = makeHeadless(fetchImpl);
    const entries = await sz.getLeaderboard({ boardId: 'b' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rank: 1, playerId: 'p1', score: 999, name: 'Champ' });
  });

  it('returns [] on an API error instead of throwing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'not_found' }, { status: 404 }),
    ) as unknown as FetchImpl;

    const sz = makeHeadless(fetchImpl);
    await expect(sz.getLeaderboard({ boardId: 'missing' })).resolves.toEqual([]);
  });
});

describe('isCrossOrigin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is false when the page origin matches the home origin', () => {
    vi.stubGlobal('location', { origin: 'https://game.example.com' });
    expect(isCrossOrigin('https://game.example.com')).toBe(false);
    // A path/trailing slash on the home URL doesn't matter — only the origin.
    expect(isCrossOrigin('https://game.example.com/play')).toBe(false);
  });

  it('is true when embedded on a different origin', () => {
    vi.stubGlobal('location', { origin: 'https://itch.io' });
    expect(isCrossOrigin('https://game.example.com')).toBe(true);
  });

  it('is false outside a browser (no location)', () => {
    vi.stubGlobal('location', undefined);
    expect(isCrossOrigin('https://game.example.com')).toBe(false);
  });

  it('is false (fail-safe) when the home origin is not a valid URL', () => {
    vi.stubGlobal('location', { origin: 'https://game.example.com' });
    expect(isCrossOrigin('not-a-url')).toBe(false);
  });
});
