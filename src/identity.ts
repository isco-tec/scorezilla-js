/**
 * Identity preset helpers — opinionated, selectable ways for your game to
 * generate or fetch a `playerId` for score submission.
 *
 * Background: every Scorezilla score carries an opaque `playerId`. The SDK
 * doesn't care whether it's a UUID, a nickname, an email, or a server
 * session token. But _how_ your game decides on that value is a UX +
 * privacy decision the team should make explicitly. These presets are the
 * blessed patterns; pick one per integration.
 *
 * See ADR 0003 (MCP identity axis) for the design rationale:
 * https://github.com/isco-tec/scorezilla/blob/main/docs/adr/0003-mcp-identity-axis.md
 *
 * @module scorezilla/identity
 * @since 0.3.0
 */

export interface AnonymousPlayerOptions {
  /** localStorage key under which the generated UUID is persisted. */
  readonly storageKey: string;
}

export interface PromptedPlayerOptions {
  /** localStorage key under which the user-entered name is persisted. */
  readonly storageKey: string;
  /** Message shown in `window.prompt()` on first run. */
  readonly prompt: string;
}

/**
 * Identity handle returned by the storage-backed presets.
 *
 * `forget()` clears the persisted value from browser storage. It does
 * **not** delete server-side score history for this player — to fully
 * erase a player's data, call the admin "delete player" endpoint.
 */
export interface PlayerHandle {
  readonly id: string;
  readonly forget: () => void;
}

/**
 * Marker returned by `useServerAuthoritative()` to signal that the
 * game's backend (not the browser) owns the `playerId` via the
 * HMAC-signed secure path (`scorezilla/server`).
 */
export interface ServerAuthoritativeMarker {
  readonly source: 'server-authoritative';
}

const isBrowser = (): boolean => typeof window !== 'undefined';

function readPersisted(key: string): string | null {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage may throw in sandboxed iframes, privacy mode, or when the
    // user has disabled site data. Treat as "missing"; the caller will
    // mint or re-prompt.
    return null;
  }
}

function writePersisted(key: string, value: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore; next call will re-mint or re-prompt
  }
}

function removePersisted(key: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function mintUuid(): string {
  if (isBrowser() && typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Best-effort fallback: timestamp + random suffix. Not cryptographically
  // strong, but opaque enough for the identifier-only use case. The
  // browsers we target (Chrome 92+, Firefox 95+, Safari 15.4+) all have
  // crypto.randomUUID — this branch is reached only in non-browser
  // environments where useAnonymousPlayer shouldn't be called anyway.
  return `anon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function requireStorageKey(fnName: string, options: { storageKey?: unknown } | undefined): string {
  if (!options || typeof options.storageKey !== 'string' || options.storageKey.length === 0) {
    throw new TypeError(`${fnName}: options.storageKey is required (non-empty string)`);
  }
  return options.storageKey;
}

/**
 * Anonymous player identity. Generates an opaque UUID on first run and
 * persists it in `localStorage` so the same browser keeps the same ID
 * across page reloads.
 *
 * **Privacy.** Stores a randomly-generated UUID in browser localStorage;
 * the value is sent to the API on every score submission and persisted
 * indefinitely in the player's score-history rows. No PII is collected.
 * `forget()` removes the localStorage entry; for full server-side erasure
 * call the admin "delete player" endpoint.
 *
 * @example
 * ```ts
 * import { Scorezilla } from 'scorezilla';
 * import { useAnonymousPlayer } from 'scorezilla/identity';
 *
 * const player = useAnonymousPlayer({ storageKey: 'mygame:player' });
 * const sz = new Scorezilla({ publicKey: 'pk_…' });
 * await sz.submitScore({ boardId, playerId: player.id, score: 42 });
 * ```
 *
 * @since 0.3.0
 * @stability stable
 */
export function useAnonymousPlayer(options: AnonymousPlayerOptions): PlayerHandle {
  const storageKey = requireStorageKey('useAnonymousPlayer', options);
  let id = readPersisted(storageKey);
  if (id === null || id.length === 0) {
    id = mintUuid();
    writePersisted(storageKey, id);
  }
  return {
    id,
    forget: () => removePersisted(storageKey),
  };
}

/**
 * Prompted player identity. On first run shows a `window.prompt()` asking
 * the user for a name, then persists it in `localStorage` for subsequent
 * visits. Returns `null` if there is no browser (SSR), no `window.prompt`,
 * or if the user cancelled / entered an empty value.
 *
 * **Privacy.** The user-entered string is stored in browser localStorage,
 * transmitted to the API on every score submission, and persisted
 * indefinitely on the leaderboard. The persisted value is whatever the
 * user typed — sanitize at the UI layer if you care. `forget()` clears
 * local state but does NOT delete server-side history.
 *
 * **UX caveat.** `window.prompt()` blocks the main thread and looks
 * dated in modern apps. For a polished flow, build your own inline form
 * and pass the result to `submitScore` directly — the preset is here to
 * cover quick prototypes and jam-style integrations.
 *
 * @example
 * ```ts
 * import { Scorezilla } from 'scorezilla';
 * import { usePromptedPlayer } from 'scorezilla/identity';
 *
 * const player = usePromptedPlayer({
 *   storageKey: 'mygame:player',
 *   prompt: 'Enter a name for the leaderboard:',
 * });
 *
 * if (player) {
 *   const sz = new Scorezilla({ publicKey: 'pk_…' });
 *   await sz.submitScore({ boardId, playerId: player.id, score: 42 });
 * }
 * ```
 *
 * @since 0.3.0
 * @stability stable
 */
export function usePromptedPlayer(options: PromptedPlayerOptions): PlayerHandle | null {
  const storageKey = requireStorageKey('usePromptedPlayer', options);
  if (typeof options.prompt !== 'string' || options.prompt.length === 0) {
    throw new TypeError('usePromptedPlayer: options.prompt is required (non-empty string)');
  }

  let id = readPersisted(storageKey);
  if (id === null || id.length === 0) {
    if (!isBrowser() || typeof window.prompt !== 'function') {
      return null;
    }
    const entered = window.prompt(options.prompt);
    if (entered === null || entered.length === 0) {
      return null;
    }
    id = entered;
    writePersisted(storageKey, id);
  }
  return {
    id,
    forget: () => removePersisted(storageKey),
  };
}

/**
 * Server-authoritative identity marker. Signals that the game's backend
 * is responsible for the `playerId` via the HMAC-signed secure path
 * (`scorezilla/server`). The browser SDK does no identity work — the
 * server picks the value, signs the submission, and posts.
 *
 * The return value is a no-op marker; you don't pass it anywhere. It
 * exists so MCP-returned snippets can emit a single line that
 * unambiguously says "this game uses the secure path; identity is
 * server-authoritative."
 *
 * @example
 * ```ts
 * // Client (no identity helper needed):
 * import { useServerAuthoritative } from 'scorezilla/identity';
 * useServerAuthoritative();
 *
 * // Server (where the real work happens):
 * import { Scorezilla } from 'scorezilla/server';
 * const sz = new Scorezilla({ secretKey: process.env.SCOREZILLA_SECRET_KEY! });
 * await sz.submitScore({ boardId, playerId: serverDerivedId, score });
 * ```
 *
 * @since 0.3.0
 * @stability stable
 */
export function useServerAuthoritative(): ServerAuthoritativeMarker {
  return { source: 'server-authoritative' };
}

/**
 * OAuth-backed player identity. **Preview stub in 0.3.0-next.x** — throws
 * on call. Full implementation (Google + GitHub for v1, Apple + Discord
 * deferred) lands in a follow-up release on the `next` dist-tag, before
 * the `latest` 0.3.0 ships.
 *
 * Until then: drive your own OAuth flow and pass the resulting user
 * identifier to `submitScore` directly.
 *
 * @since 0.3.0
 * @stability preview
 */
export function useAuthProvider(_options: { readonly provider: 'google' | 'github' }): never {
  throw new Error(
    'useAuthProvider is not yet implemented in this 0.3.0-next preview. ' +
      'OAuth provider helpers (Google + GitHub for v1) ship in a follow-up ' +
      'release on the `next` dist-tag. Until then, drive your own OAuth flow ' +
      'and pass the resulting user identifier to submitScore directly.',
  );
}
