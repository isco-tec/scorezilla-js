#!/usr/bin/env node
/* eslint-disable no-console -- CLI demo; `console.log` IS its output. */
/**
 * Scorezilla SDK — `scorezilla/server` HMAC adapter, Node CLI smoke test.
 *
 * This mirrors `examples/node-cli` but uses the SECRET-key path. The
 * secret key produces HMAC-signed requests that the Scorezilla API
 * verifies server-side, so players can't forge submissions even with
 * full client-side access.
 *
 * Usage:
 *   SCOREZILLA_SECRET_KEY=sk_live_<keyId>_<random> \
 *   BOARD_ID=<board-uuid> \
 *   PLAYER_ID=alice \
 *   node examples/node-server-hmac/index.mjs [score]
 *
 * Optional env:
 *   SCOREZILLA_BASE_URL  override the default API origin (default: https://api.scorezilla.dev)
 *
 * Reads from the built bundle at `../../dist/server.js` so you must
 * run `pnpm build` first. Imports through the public surface (NOT a
 * deep `../../src/*` path) so this script also serves as a smoke test
 * of the `scorezilla/server` published shape.
 *
 * ⚠️  NEVER paste a real `sk_live_*` into client-side code. The whole
 *     point of this adapter is that the secret stays server-side.
 */

import { Scorezilla, ScorezillaError } from '../../dist/server.js';

const secretKey = process.env.SCOREZILLA_SECRET_KEY;
const boardId = process.env.BOARD_ID;
const playerId = process.env.PLAYER_ID ?? 'alice';
const baseUrl = process.env.SCOREZILLA_BASE_URL;
const score = Number(process.argv[2] ?? Math.floor(Math.random() * 10_000));

if (!secretKey || !boardId) {
  console.error('Missing required env: SCOREZILLA_SECRET_KEY, BOARD_ID');
  console.error('  format: sk_live_<uuid-keyId>_<base62-random>');
  console.error(
    '  example: SCOREZILLA_SECRET_KEY=sk_live_… BOARD_ID=… node examples/node-server-hmac/index.mjs',
  );
  process.exit(2);
}

const sz = new Scorezilla({
  secretKey,
  timeoutMs: 10_000,
  ...(baseUrl ? { baseUrl } : {}),
});

console.log(`scorezilla-js (server) v${Scorezilla.version}`);
console.log(`Submitting HMAC-signed score ${score} as ${playerId} on board ${boardId}…`);

try {
  // Note: in the secure path the boardId travels INSIDE the JSON body
  // (and gets included in the HMAC signing string), not in the URL
  // path. The `/v1/secure/scores` endpoint expects this — the SDK
  // handles it transparently.
  const r = await sz.submitScore({
    boardId,
    playerId,
    score,
    metadata: { source: 'node-server-hmac-example' },
  });
  console.log('→', r);
  if (r.isPersonalBest) console.log('  🏆 Personal best!');
  else console.log('  (not a personal best — existing PB unchanged)');
} catch (e) {
  if (e instanceof ScorezillaError) {
    console.error(`ScorezillaError: code=${e.code} status=${e.status}`);
    if (e.requestId) console.error(`  requestId=${e.requestId}`);
    if (e.isRateLimited()) {
      console.error(`  retryAfter=${e.retryAfter ?? '?'}s layer=${e.layer ?? '?'}`);
    }
    if (e.isUsageCapExceeded()) {
      console.error(`  tier=${e.tier ?? '?'} cap=${e.cap ?? '?'} count=${e.count ?? '?'}`);
    }
    process.exit(1);
  }
  throw e;
}

// Read back top-N to confirm the score landed. The read path reuses
// the same instance — both signed and unsigned paths share the
// HMAC-signing transport on the server adapter for consistency.
try {
  const { entries } = await sz.getLeaderboard({ boardId, top: 10 });
  console.log('\nTop 10:');
  for (const e of entries) {
    const marker = e.playerId === playerId ? ' ← you' : '';
    console.log(`  ${String(e.rank).padStart(3)}. ${e.playerId}: ${e.score}${marker}`);
  }
} catch (e) {
  if (e instanceof ScorezillaError) {
    console.error(`Read-back failed: ${e.code}`);
  } else {
    throw e;
  }
}
