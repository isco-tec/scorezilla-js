// Vanilla example — exercises the four public-key methods through the
// CDN-published ESM bundle. No build step; this file runs straight in the
// browser.
//
// For production, pin to a specific version + add an `integrity="sha384-…"`
// attribute to the <script> tag (see index.html). For this development
// example we use the floating `@next` tag so contributors can run the
// example against the latest pre-release without picking a version.
// Once v0.1.0 stable ships, swap `@next` for `@latest`.

import {
  Scorezilla,
  ScorezillaError,
} from 'https://cdn.jsdelivr.net/npm/scorezilla@next/dist/index.js';

const out = document.getElementById('out');
const form = document.getElementById('cfg');

function log(label, value) {
  const cur = out.textContent === 'Awaiting input…' ? '' : out.textContent;
  out.textContent =
    cur +
    `\n──── ${label} ────\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`;
}

function logError(label, err) {
  const cur = out.textContent === 'Awaiting input…' ? '' : out.textContent;
  out.textContent =
    cur +
    `\n──── ${label} (ERROR) ────\n` +
    `code:       ${err.code}\n` +
    `status:     ${err.status}\n` +
    `reason:     ${err.reason ?? '—'}\n` +
    `retryAfter: ${err.retryAfter ?? '—'}\n` +
    `requestId:  ${err.requestId ?? '—'}\n` +
    `message:    ${err.message}\n`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  out.textContent = 'Working…';

  const publicKey = /** @type {HTMLInputElement} */ (document.getElementById('pk')).value.trim();
  const boardId = /** @type {HTMLInputElement} */ (document.getElementById('board')).value.trim();
  const playerId = /** @type {HTMLInputElement} */ (document.getElementById('player')).value.trim();
  const score = Number(/** @type {HTMLInputElement} */ (document.getElementById('score')).value);

  const sz = new Scorezilla({ publicKey, timeoutMs: 8_000 });

  // 1. submitScore
  try {
    const r = await sz.submitScore({ boardId, playerId, score });
    log('submitScore', r);
  } catch (err) {
    if (err instanceof ScorezillaError) return logError('submitScore', err);
    throw err;
  }

  // 2. getLeaderboard
  try {
    const r = await sz.getLeaderboard({ boardId, top: 10 });
    log('getLeaderboard (top 10)', r);
  } catch (err) {
    if (err instanceof ScorezillaError) return logError('getLeaderboard', err);
    throw err;
  }

  // 3. getPlayerRank
  try {
    const r = await sz.getPlayerRank({ boardId, playerId });
    log('getPlayerRank', r);
  } catch (err) {
    if (err instanceof ScorezillaError) {
      if (err.isNotFound()) {
        log('getPlayerRank', '(player has no submission on this board)');
      } else {
        logError('getPlayerRank', err);
      }
      return;
    }
    throw err;
  }

  // 4. getWindowAround
  try {
    const r = await sz.getWindowAround({
      boardId,
      playerId,
      before: 2,
      after: 2,
    });
    log('getWindowAround ±2', r);
  } catch (err) {
    if (err instanceof ScorezillaError) return logError('getWindowAround', err);
    throw err;
  }
});
