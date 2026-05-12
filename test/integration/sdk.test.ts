/**
 * SDK integration tests.
 *
 * This suite SKIPS unless two env vars are set:
 *
 *   • `SCOREZILLA_INTEGRATION_BASE_URL` — origin of a running API (e.g.
 *     `http://localhost:8787` from a local API dev server)
 *   • `SCOREZILLA_INTEGRATION_ADMIN_SECRET` — admin Bearer token that the
 *     target API recognizes; used to provision a one-shot test game + board
 *     via the admin endpoints. The CI runner generates a fresh test value
 *     per run — never reuse a production admin secret here.
 *
 * Skipping (vs. failing) when env is missing keeps `pnpm test` green on
 * fresh checkouts. CI here doesn't wire those vars by default — running
 * the suite requires admin access to a Scorezilla API instance, so it's
 * a local-dev tool for engineers who have it.
 *
 * The suite is intentionally hands-off about HOW the API runs — it could
 * be a local dev worker, a deployed staging worker, or anything that
 * speaks the documented `/v1/*` contract. The SDK talks to the API over
 * HTTP only — no source-level dependency.
 *
 * Each suite run provisions a fresh game so test data doesn't accumulate.
 * Boards are deliberately not cleaned up — short-lived test data is fine,
 * and a "clean test boards" admin op isn't on the v0.1.0 API yet.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scorezilla, ScorezillaError } from '../../src/client';

const baseUrl = process.env.SCOREZILLA_INTEGRATION_BASE_URL;
const adminSecret = process.env.SCOREZILLA_INTEGRATION_ADMIN_SECRET;
const enabled = Boolean(baseUrl && adminSecret);

// CI must NEVER silently skip the integration suite — a missing env in CI
// is a config bug, not a developer running tests on a fresh checkout. The
// `CI` env is set by GitHub Actions (and every other major CI). Locally,
// skipping is the right behaviour.
if (process.env.CI && !enabled) {
  throw new Error(
    'scorezilla integration suite: CI=true but SCOREZILLA_INTEGRATION_BASE_URL ' +
      'and/or SCOREZILLA_INTEGRATION_ADMIN_SECRET are unset. ' +
      'These must be wired in the workflow (see .github/workflows/sdk-ci.yml).',
  );
}

// `describe.skipIf` reports the suite as skipped in the output rather than
// silently absent. Surface the reason in the description so a confused CI
// reader can debug without digging into env.
const describeIf = enabled ? describe : describe.skip;

describeIf(`SDK integration (env: SCOREZILLA_INTEGRATION_BASE_URL=${baseUrl ?? '<unset>'})`, () => {
  let publicKey: string;
  let boardId: string;
  let sdk: Scorezilla;

  beforeAll(async () => {
    // baseUrl + adminSecret are non-null inside this branch (gated by `enabled`).
    // Type-narrow for TS strict mode.
    if (!baseUrl || !adminSecret) {
      throw new Error('unreachable: gated by `enabled` above');
    }

    // 1. Provision a one-shot game.
    const slug =
      'sdk-int-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const gameRes = await fetch(`${baseUrl}/v1/admin/games`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        gameSlug: slug,
        gameName: 'SDK Integration Test',
      }),
    });
    if (!gameRes.ok) {
      throw new Error(`Failed to provision game: HTTP ${gameRes.status} ${await gameRes.text()}`);
    }
    const gameBody = (await gameRes.json()) as {
      gameId: string;
      keys: { publicKey: { plaintext: string } };
    };
    const gameId = gameBody.gameId;
    publicKey = gameBody.keys.publicKey.plaintext;

    // 2. Provision a board on that game.
    const boardRes = await fetch(`${baseUrl}/v1/admin/games/${gameId}/boards`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'b-' + Date.now().toString(36),
        name: 'Integration Test Board',
      }),
    });
    if (!boardRes.ok) {
      throw new Error(
        `Failed to provision board: HTTP ${boardRes.status} ${await boardRes.text()}`,
      );
    }
    const boardBody = (await boardRes.json()) as { boardId: string };
    boardId = boardBody.boardId;

    // 3. Construct the SDK pointing at the test API.
    sdk = new Scorezilla({
      publicKey,
      baseUrl,
      // Tight timeout so test failures surface quickly rather than hanging.
      timeoutMs: 10_000,
      // No retries — integration assertions should be deterministic.
      maxRetries: 0,
    });
  }, 60_000);

  afterAll(() => {
    // No board cleanup — short-lived test data. See module comment.
  });

  it('submitScore — first submission is rank 1 and personal best', async () => {
    const r = await sdk.submitScore({
      boardId,
      playerId: 'alice',
      score: 100,
    });
    expect(r.ok).toBe(true);
    expect(r.rank).toBe(1);
    expect(r.totalEntries).toBe(1);
    expect(r.isPersonalBest).toBe(true);
    expect(r.boardId).toBe(boardId);
    expect(typeof r.keyId).toBe('string');
  });

  it('submitScore — lower follow-up score does NOT replace the PB', async () => {
    const r = await sdk.submitScore({
      boardId,
      playerId: 'alice',
      score: 50, // < 100
    });
    expect(r.isPersonalBest).toBe(false);
    // Rank position unchanged.
    expect(r.rank).toBe(1);
    expect(r.totalEntries).toBe(1);
  });

  it('submitScore — higher follow-up score REPLACES the PB', async () => {
    const r = await sdk.submitScore({
      boardId,
      playerId: 'alice',
      score: 200, // > 100
    });
    expect(r.isPersonalBest).toBe(true);
    expect(r.rank).toBe(1);
  });

  it('getLeaderboard — reflects the latest state', async () => {
    // Add a second player so the leaderboard has two entries.
    await sdk.submitScore({ boardId, playerId: 'bob', score: 150 });
    const board = await sdk.getLeaderboard({ boardId, top: 10 });
    expect(board.ok).toBe(true);
    expect(board.entries.length).toBeGreaterThanOrEqual(2);
    // Alice's 200 should outrank Bob's 150.
    const alice = board.entries.find((e) => e.playerId === 'alice');
    const bob = board.entries.find((e) => e.playerId === 'bob');
    expect(alice?.rank).toBe(1);
    expect(bob?.rank).toBe(2);
    expect(alice?.score).toBe(200);
    expect(bob?.score).toBe(150);
  });

  it('getPlayerRank — returns the canonical rank for an existing player', async () => {
    const r = await sdk.getPlayerRank({ boardId, playerId: 'alice' });
    expect(r.ok).toBe(true);
    expect(r.rank).toBe(1);
    expect(r.score).toBe(200);
    expect(r.playerId).toBe('alice');
  });

  it('getPlayerRank — throws ScorezillaError.not_found for unknown player', async () => {
    try {
      await sdk.getPlayerRank({ boardId, playerId: 'no-such-player' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorezillaError);
      const err = e as ScorezillaError;
      expect(err.code).toBe('not_found');
      expect(err.status).toBe(404);
      expect(err.isNotFound()).toBe(true);
    }
  });

  it('getWindowAround — returns the slice of entries surrounding a player', async () => {
    const r = await sdk.getWindowAround({
      boardId,
      playerId: 'bob',
      before: 5,
      after: 5,
    });
    expect(r.ok).toBe(true);
    expect(r.playerId).toBe('bob');
    // At minimum, Bob himself should appear in the window.
    const bobInWindow = r.entries.find((e) => e.playerId === 'bob');
    expect(bobInWindow).toBeDefined();
    expect(bobInWindow?.rank).toBe(2);
  });

  it('submitScore with metadata — round-trips through the leaderboard', async () => {
    await sdk.submitScore({
      boardId,
      playerId: 'carol',
      score: 250, // new PB; outranks alice
      metadata: { difficulty: 'nightmare', clientVersion: '1.2.3' },
    });
    const board = await sdk.getLeaderboard({ boardId, top: 10 });
    const carol = board.entries.find((e) => e.playerId === 'carol');
    expect(carol).toBeDefined();
    expect(carol?.score).toBe(250);
    expect(carol?.rank).toBe(1);
    expect(carol?.metadata).toEqual({
      difficulty: 'nightmare',
      clientVersion: '1.2.3',
    });
  });
});
