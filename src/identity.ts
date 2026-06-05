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

import { signInWithGoogle } from './identity/google';

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

/** OAuth providers selectable via {@link useAuthProvider}. */
export type AuthProvider = 'google' | 'github';

/** Options for the Google provider (`provider: 'google'`). */
export interface GoogleAuthProviderOptions {
  readonly provider: 'google';
  /**
   * Your Google OAuth **client ID** (from the Google Cloud Console). The
   * helper never bundles Scorezilla-owned credentials — you bring your own so
   * revocation and consent stay under your control.
   */
  readonly clientId: string;
  /** localStorage key under which the derived player id is persisted. */
  readonly storageKey: string;
  /**
   * Let Google auto-select a returning account without an explicit tap
   * (GIS `auto_select`). Defaults to `false`.
   */
  readonly autoSelect?: boolean;
}

/**
 * Options for the GitHub provider (`provider: 'github'`).
 *
 * **Not available yet** — ships in `scorezilla@0.3.0-next.2`. GitHub OAuth
 * cannot be completed securely in the browser alone (the token exchange needs
 * a client secret and GitHub's token endpoint sends no CORS headers), so the
 * GitHub provider will require a server-side token exchange (your backend or
 * a Scorezilla Workers proxy). Calling it today rejects.
 */
export interface GitHubAuthProviderOptions {
  readonly provider: 'github';
  /** Reserved — your GitHub OAuth app client ID. */
  readonly clientId?: string;
  /** Reserved — localStorage key for the derived player id. */
  readonly storageKey?: string;
}

/** Discriminated union of {@link useAuthProvider} options, keyed on `provider`. */
export type AuthProviderOptions = GoogleAuthProviderOptions | GitHubAuthProviderOptions;

/**
 * Handle returned by {@link useAuthProvider}. `id` is the opaque, stable
 * player id derived from the provider account (e.g. `google:<sub>`).
 * `signOut()` clears the persisted id and, where supported, disables the
 * provider's auto sign-in. It does **not** delete server-side score history.
 */
export interface AuthPlayerHandle {
  readonly id: string;
  readonly provider: AuthProvider;
  readonly signOut: () => void;
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

function requireNonEmptyString(fnName: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fnName}: options.${field} is required (non-empty string)`);
  }
  return value;
}

function requireStorageKey(fnName: string, options: { storageKey?: unknown } | undefined): string {
  return requireNonEmptyString(fnName, 'storageKey', options?.storageKey);
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
 * OAuth-backed player identity. Signs the player in with the chosen provider
 * and resolves a stable, opaque `playerId` derived from their account.
 *
 * **Google** (stable since `0.3.0-next.1`) wraps Google Identity Services
 * "One Tap". The derived id is `google:<sub>`, where `sub` is the account's
 * stable Google subject identifier. The id is persisted in `localStorage`
 * under `storageKey`, so returning visitors are recognized without signing in
 * again; `signOut()` clears it.
 *
 * **GitHub** ships in `0.3.0-next.2` and currently rejects — see
 * {@link GitHubAuthProviderOptions}.
 *
 * **Privacy.** Only the derived `sub`-based id is stored and transmitted (on
 * score submission) — never the Google credential, email, or profile. The id
 * is persisted in browser localStorage and stored indefinitely in the
 * player's score-history rows. `signOut()` clears local state; for full
 * server-side erasure call the admin "delete player" endpoint.
 *
 * **Bundle.** The Google provider is a separate module that tree-shakes out
 * entirely for consumers who don't call `useAuthProvider` (the package is
 * `sideEffects: false`; a size-limit gate verifies it). The Google Identity
 * Services library itself is never bundled — it's loaded at runtime from
 * `accounts.google.com` the first time sign-in runs.
 *
 * @example
 * ```ts
 * import { Scorezilla } from 'scorezilla';
 * import { useAuthProvider } from 'scorezilla/identity';
 *
 * const player = await useAuthProvider({
 *   provider: 'google',
 *   clientId: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
 *   storageKey: 'mygame:player',
 * });
 *
 * const sz = new Scorezilla({ publicKey: 'pk_…' });
 * await sz.submitScore({ boardId, playerId: player.id, score: 42 });
 * ```
 *
 * @since 0.3.0-next.1
 * @stability stable (google) · preview (github)
 */
export async function useAuthProvider(options: AuthProviderOptions): Promise<AuthPlayerHandle> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('useAuthProvider: options is required ({ provider, … }).');
  }

  switch (options.provider) {
    case 'google':
      return signInWithGoogleProvider(options);
    case 'github':
      throw new Error(
        'useAuthProvider: the GitHub provider is not available yet. It ships in ' +
          'scorezilla@0.3.0-next.2 and will require a server-side token exchange ' +
          '(your backend or a Scorezilla Workers proxy), because GitHub OAuth cannot ' +
          'be completed securely in the browser alone. Until then use provider: "google", ' +
          'or drive your own GitHub OAuth flow and pass the resulting id to submitScore.',
      );
    default:
      throw new TypeError(
        `useAuthProvider: unknown provider ${JSON.stringify(
          (options as { provider?: unknown }).provider,
        )} (expected "google" or "github").`,
      );
  }
}

async function signInWithGoogleProvider(
  options: GoogleAuthProviderOptions,
): Promise<AuthPlayerHandle> {
  const clientId = requireNonEmptyString('useAuthProvider', 'clientId', options.clientId);
  const storageKey = requireNonEmptyString('useAuthProvider', 'storageKey', options.storageKey);

  // Return visit: trust the persisted id without re-running sign-in. Like the
  // other presets, this value is whatever is in localStorage under storageKey
  // — it is NOT a freshly re-verified Google identity. That's consistent with
  // ADR 0003's model (playerId is opaque attribution, never an auth credential;
  // the secure path signs submissions server-side). Call signOut() to force a
  // fresh sign-in next time.
  const persisted = readPersisted(storageKey);
  if (persisted !== null && persisted.length > 0) {
    return makeAuthHandle(persisted, 'google', storageKey);
  }

  if (!isBrowser()) {
    throw new Error('useAuthProvider: Google sign-in requires a browser environment.');
  }

  const sub = await signInWithGoogle({ clientId, autoSelect: options.autoSelect ?? false });
  const id = `google:${sub}`;
  writePersisted(storageKey, id);
  return makeAuthHandle(id, 'google', storageKey);
}

function makeAuthHandle(id: string, provider: AuthProvider, storageKey: string): AuthPlayerHandle {
  return {
    id,
    provider,
    signOut: () => {
      removePersisted(storageKey);
      if (provider === 'google') disableGoogleAutoSelect();
    },
  };
}

/**
 * Best-effort: tell Google Identity Services not to auto-select this account
 * next time. No-op if GIS was never loaded (e.g. a returning visit that
 * short-circuited on the persisted id). Kept inline — not imported from the
 * google provider module — so it doesn't pull that module into the core
 * `scorezilla/identity` bundle.
 */
function disableGoogleAutoSelect(): void {
  if (!isBrowser()) return;
  try {
    const gis = (
      window as unknown as {
        google?: { accounts?: { id?: { disableAutoSelect?: () => void } } };
      }
    ).google;
    gis?.accounts?.id?.disableAutoSelect?.();
  } catch {
    // GIS not present / not loaded — nothing to disable.
  }
}
