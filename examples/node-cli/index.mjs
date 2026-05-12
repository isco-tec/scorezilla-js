#!/usr/bin/env node
/* eslint-disable no-console -- CLI demo; `console.log` IS its output. */
/**
 * Scorezilla SDK — Node CLI example.
 *
 * Usage:
 *   SCOREZILLA_PUBLIC_KEY=pk_mygame_… \
 *   BOARD_ID=board-uuid \
 *   PLAYER_ID=alice \
 *   node examples/node-cli/index.mjs [score]
 *
 * Optional env:
 *   SCOREZILLA_BASE_URL  override the default API origin (default: https://api.scorezilla.dev)
 *
 * Reads from the built bundle at `../../dist/index.js` so you must run
 * `pnpm build` first. Imports through the public surface (NOT a deep
 * `../../src/*` path) so this script also serves as a smoke test of
 * the published shape.
 */

import { Scorezilla, ScorezillaError } from '../../dist/index.js';

const publicKey = process.env.SCOREZILLA_PUBLIC_KEY;
const boardId = process.env.BOARD_ID;
const playerId = process.env.PLAYER_ID ?? 'alice';
const baseUrl = process.env.SCOREZILLA_BASE_URL;
const score = Number(process.argv[2] ?? Math.floor(Math.random() * 10_000));

if (!publicKey || !boardId) {
  console.error('Missing required env: SCOREZILLA_PUBLIC_KEY, BOARD_ID');
  console.error(
    '  example: SCOREZILLA_PUBLIC_KEY=pk_… BOARD_ID=… node examples/node-cli/index.mjs',
  );
  process.exit(2);
}

const sz = new Scorezilla({
  publicKey,
  timeoutMs: 10_000,
  ...(baseUrl ? { baseUrl } : {}),
});

console.log(`scorezilla-js v${Scorezilla.version}`);
console.log(`Submitting score ${score} as ${playerId} on board ${boardId}…`);

try {
  const r = await sz.submitScore({ boardId, playerId, score });
  console.log('→', r);
  if (r.isPersonalBest) console.log('  🏆 Personal best!');
  else console.log('  (not a personal best — existing PB unchanged)');
} catch (e) {
  if (e instanceof ScorezillaError) {
    console.error(`× ${e.code} (${e.status}): ${e.message}`);
    if (e.requestId) console.error(`  request-id: ${e.requestId}`);
    if (e.code === 'rate_limited') console.error(`  retry-after: ${e.retryAfter}s`);
    if (e.code === 'out_of_bounds') console.error(`  ${e.reason} bound: ${e.bound}`);
    process.exit(1);
  }
  throw e;
}

console.log('\nLeaderboard (top 5):');
const board = await sz.getLeaderboard({ boardId, top: 5 });
for (const entry of board.entries) {
  console.log(
    `  ${String(entry.rank).padStart(3, ' ')}. ${entry.playerId.padEnd(20, ' ')} ${entry.score}`,
  );
}
