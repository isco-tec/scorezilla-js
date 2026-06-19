/**
 * Headless, never-throws client (`scorezilla/headless`).
 *
 * The cross-platform integration surface. A game embedded on ANY host gets the
 * IDENTICAL API, and the calls NEVER throw — failures collapse to `null`
 * (submit) or `[]` (getLeaderboard) so a dropped network call can't crash a
 * game loop or force a try/catch around every score. This is the contract a
 * host (e.g. an `window`-installed global) wraps so embedded game code never
 * changes between platforms.
 *
 * It wraps the throwing {@link Scorezilla} client; reach for the class directly
 * (`scorezilla`) when you want typed errors (`ScorezillaError`) to branch on.
 *
 * Cross-origin note: when a game is embedded cross-site (see {@link isCrossOrigin})
 * and the board has Turnstile gating on, pass a `turnstileToken` on `submit` —
 * the host obtains it (e.g. via a hidden broker iframe on a trusted origin) and
 * the SDK forwards it. Same-origin submits need nothing extra.
 */
import { Scorezilla } from './client';
import type { PublicKeyConfig } from './config';
import type { RankedEntry } from './types';

/** The accepted score's standing, or `null` from {@link HeadlessClient.submit}
 *  when the submit failed for ANY reason (the call never throws). */
export interface HeadlessSubmitResult {
  ok: true;
  /** 1-based rank after the submit settled. */
  rank: number;
  totalEntries: number;
  isPersonalBest: boolean;
}

/** Input for {@link HeadlessClient.submit}. */
export interface HeadlessSubmitInput {
  boardId: string;
  playerId: string;
  score: number;
  metadata?: Record<string, unknown>;
  /** Public display name; rejected silently (→ `null`) if held by another
   *  player on the board. */
  name?: string;
  /** Cloudflare Turnstile token for the cross-origin token path. */
  turnstileToken?: string;
  signal?: AbortSignal;
}

/** Input for {@link HeadlessClient.getLeaderboard}. */
export interface HeadlessLeaderboardInput {
  boardId: string;
  top?: number;
  offset?: number;
  signal?: AbortSignal;
}

/** The never-throws surface returned by {@link createHeadlessClient}. */
export interface HeadlessClient {
  /** Submit a score. Resolves to the new standing, or `null` on ANY failure
   *  (network, rate-limit, validation, ban, name conflict, …). Never throws. */
  submit(input: HeadlessSubmitInput): Promise<HeadlessSubmitResult | null>;
  /** Fetch the top-N leaderboard. Resolves to the entries (each with at least
   *  `{ rank, playerId, name?, score }`), or `[]` on ANY failure. Never throws. */
  getLeaderboard(input: HeadlessLeaderboardInput): Promise<RankedEntry[]>;
}

/**
 * Create a headless, never-throws client over a public key. Identical surface
 * on every host; the only failure signal is `null` / `[]`.
 */
export function createHeadlessClient(config: PublicKeyConfig): HeadlessClient {
  const sz = new Scorezilla(config);
  return {
    async submit(input: HeadlessSubmitInput): Promise<HeadlessSubmitResult | null> {
      try {
        const r = await sz.submitScore(input);
        return {
          ok: true,
          rank: r.rank,
          totalEntries: r.totalEntries,
          isPersonalBest: r.isPersonalBest,
        };
      } catch {
        return null;
      }
    },
    async getLeaderboard(input: HeadlessLeaderboardInput): Promise<RankedEntry[]> {
      try {
        const { entries } = await sz.getLeaderboard(input);
        return entries;
      } catch {
        return [];
      }
    },
  };
}

/**
 * True when the current origin differs from `homeOrigin` — i.e. the game is
 * embedded cross-site (itch.io, a portal) rather than on its own first-party
 * host. Use it to decide whether the cross-origin token path (a device-token
 * identity + Turnstile + the board's origin allowlist) is needed.
 *
 * `currentOrigin` defaults to the page's (`globalThis.location.origin`); pass it
 * explicitly for SSR or tests. Returns `false` when there's no current origin
 * (non-browser, where the concept doesn't apply) and `false` if `homeOrigin`
 * can't be parsed (fail safe — don't force the heavier path on a config typo).
 */
export function isCrossOrigin(
  homeOrigin: string,
  currentOrigin: string | null | undefined = (globalThis as { location?: { origin?: string } })
    .location?.origin,
): boolean {
  if (!currentOrigin) return false;
  try {
    return currentOrigin !== new URL(homeOrigin).origin;
  } catch {
    return false;
  }
}
