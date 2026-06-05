/**
 * Tests for the Google provider behind `useAuthProvider({ provider: 'google' })`.
 *
 * The real Google Identity Services (GIS) library is never available in the
 * test env — it's an external script loaded from accounts.google.com. We mock
 * the `window.google.accounts.id` surface and the One Tap moment callbacks,
 * then drive the sign-in flow exactly as a browser would.
 *
 * Coverage targets:
 *   • Happy path: One Tap returns a credential → derives `google:<sub>` and persists.
 *   • Returning visit: persisted id short-circuits, no second prompt.
 *   • signOut() clears storage AND disables GIS auto-select.
 *   • One Tap not displayed / dismissed by the user → rejects.
 *   • A success-dismissal (credential_returned) does NOT spuriously reject.
 *   • Malformed credential / missing `sub` claim → rejects.
 *   • Lazy GIS <script> injection: resolves on load, rejects on error + timeout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthProvider } from '../../src/identity';

const isBrowser = typeof window !== 'undefined';
const describeBrowser = isBrowser ? describe : describe.skip;

const STORAGE_KEY = 'mygame:auth';
const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';

// ---------------------------------------------------------------------------
// Test helpers — build a fake JWT and a fake GIS surface
// ---------------------------------------------------------------------------

function base64Url(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a structurally-valid (unsigned) ID token with the given payload. */
function makeIdToken(payload: Record<string, unknown>): string {
  const header = base64Url({ alg: 'RS256', typ: 'JWT' });
  return `${header}.${base64Url(payload)}.signature`;
}

type Moment =
  | 'success'
  | 'notDisplayed'
  | 'skipped'
  | 'dismissedUser'
  | 'dismissedSuccess'
  | 'successThenBlocked';

interface FakeGisOptions {
  readonly credential?: string;
  readonly moment?: Moment;
}

interface FakeGis {
  readonly calls: { initialize: number; prompt: number; disableAutoSelect: number };
  readonly lastConfig: () => { client_id: string; auto_select?: boolean } | undefined;
}

/** Install a fake `window.google.accounts.id` and return spies. */
function installFakeGis(options: FakeGisOptions = {}): FakeGis {
  const calls = { initialize: 0, prompt: 0, disableAutoSelect: 0 };
  let callback: ((response: { credential: string }) => void) | undefined;
  let lastConfig: { client_id: string; auto_select?: boolean } | undefined;
  const moment: Moment = options.moment ?? 'success';

  const id = {
    initialize(config: {
      client_id: string;
      callback: (response: { credential: string }) => void;
      auto_select?: boolean;
    }): void {
      calls.initialize += 1;
      callback = config.callback;
      lastConfig = { client_id: config.client_id, auto_select: config.auto_select };
    },
    prompt(listener?: (notification: Record<string, () => unknown>) => void): void {
      calls.prompt += 1;
      if (moment === 'success') {
        callback?.({ credential: options.credential ?? '' });
      } else if (moment === 'notDisplayed') {
        listener?.({ isNotDisplayed: () => true });
      } else if (moment === 'skipped') {
        listener?.({ isSkippedMoment: () => true });
      } else if (moment === 'dismissedUser') {
        listener?.({ isDismissedMoment: () => true, getDismissedReason: () => 'user_cancel' });
      } else if (moment === 'dismissedSuccess') {
        callback?.({ credential: options.credential ?? '' });
        listener?.({
          isDismissedMoment: () => true,
          getDismissedReason: () => 'credential_returned',
        });
      } else if (moment === 'successThenBlocked') {
        // The credential arrives, then a stray blocking moment fires after —
        // the settled guard must keep the sign-in resolved, not reject it.
        callback?.({ credential: options.credential ?? '' });
        listener?.({ isNotDisplayed: () => true });
      }
    },
    disableAutoSelect(): void {
      calls.disableAutoSelect += 1;
    },
  };

  (globalThis as { google?: unknown }).google = { accounts: { id } };
  return { calls, lastConfig: () => lastConfig };
}

function clearGis(): void {
  delete (globalThis as { google?: unknown }).google;
}

describeBrowser('useAuthProvider — google', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearGis();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearGis();
  });

  it('signs in via One Tap, derives google:<sub>, and persists it', async () => {
    const gis = installFakeGis({ credential: makeIdToken({ sub: '108451' }), moment: 'success' });

    const handle = await useAuthProvider({
      provider: 'google',
      clientId: CLIENT_ID,
      storageKey: STORAGE_KEY,
    });

    expect(handle.id).toBe('google:108451');
    expect(handle.provider).toBe('google');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('google:108451');
    expect(gis.calls.initialize).toBe(1);
    expect(gis.calls.prompt).toBe(1);
    expect(gis.lastConfig()?.client_id).toBe(CLIENT_ID);
  });

  it('forwards autoSelect to GIS initialize', async () => {
    const gis = installFakeGis({ credential: makeIdToken({ sub: 'a' }), moment: 'success' });
    await useAuthProvider({
      provider: 'google',
      clientId: CLIENT_ID,
      storageKey: STORAGE_KEY,
      autoSelect: true,
    });
    expect(gis.lastConfig()?.auto_select).toBe(true);
  });

  it('returns the persisted id on a return visit without prompting again', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'google:returning');
    const gis = installFakeGis({ credential: makeIdToken({ sub: 'unused' }) });

    const handle = await useAuthProvider({
      provider: 'google',
      clientId: CLIENT_ID,
      storageKey: STORAGE_KEY,
    });

    expect(handle.id).toBe('google:returning');
    expect(gis.calls.initialize).toBe(0);
    expect(gis.calls.prompt).toBe(0);
  });

  it('signOut() clears storage and disables GIS auto-select', async () => {
    const gis = installFakeGis({ credential: makeIdToken({ sub: 'z' }), moment: 'success' });
    const handle = await useAuthProvider({
      provider: 'google',
      clientId: CLIENT_ID,
      storageKey: STORAGE_KEY,
    });

    handle.signOut();

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(gis.calls.disableAutoSelect).toBe(1);
  });

  it('does not spuriously reject on a success-dismissal (credential_returned)', async () => {
    installFakeGis({ credential: makeIdToken({ sub: 'ok' }), moment: 'dismissedSuccess' });
    const handle = await useAuthProvider({
      provider: 'google',
      clientId: CLIENT_ID,
      storageKey: STORAGE_KEY,
    });
    expect(handle.id).toBe('google:ok');
  });

  it('ignores a blocking moment that arrives after a successful credential', async () => {
    installFakeGis({ credential: makeIdToken({ sub: 'race' }), moment: 'successThenBlocked' });
    const handle = await useAuthProvider({
      provider: 'google',
      clientId: CLIENT_ID,
      storageKey: STORAGE_KEY,
    });
    expect(handle.id).toBe('google:race');
  });

  it('rejects when One Tap is not displayed', async () => {
    installFakeGis({ moment: 'notDisplayed' });
    await expect(
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: STORAGE_KEY }),
    ).rejects.toThrow(/dismissed or could not be displayed/i);
  });

  it('rejects when One Tap is skipped', async () => {
    installFakeGis({ moment: 'skipped' });
    await expect(
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: STORAGE_KEY }),
    ).rejects.toThrow(/dismissed or could not be displayed/i);
  });

  it('rejects when the user dismisses One Tap', async () => {
    installFakeGis({ moment: 'dismissedUser' });
    await expect(
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: STORAGE_KEY }),
    ).rejects.toThrow(/dismissed/i);
  });

  it('rejects an empty credential', async () => {
    installFakeGis({ credential: '', moment: 'success' });
    await expect(
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: STORAGE_KEY }),
    ).rejects.toThrow(/empty credential/i);
  });

  it('rejects a malformed credential (not a JWT)', async () => {
    installFakeGis({ credential: 'not-a-jwt', moment: 'success' });
    await expect(
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: STORAGE_KEY }),
    ).rejects.toThrow(/malformed/i);
  });

  it('rejects a credential whose payload is missing the sub claim', async () => {
    installFakeGis({ credential: makeIdToken({ email: 'a@b.c' }), moment: 'success' });
    await expect(
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: STORAGE_KEY }),
    ).rejects.toThrow(/sub/i);
  });

  it('injects the GIS script when window.google is absent, then resolves on load', async () => {
    // No fake GIS installed yet — force the script-injection path.
    const credential = makeIdToken({ sub: 'lazy' });
    const appendSpy = vi
      .spyOn(document.head, 'appendChild')
      .mockImplementation(<T extends Node>(node: T): T => {
        const script = node as unknown as HTMLScriptElement;
        // Simulate the browser fetching + executing the GIS bundle: install
        // the global, then fire the load event on the next microtask.
        queueMicrotask(() => {
          installFakeGis({ credential, moment: 'success' });
          script.dispatchEvent(new Event('load'));
        });
        return node;
      });

    const handle = await useAuthProvider({
      provider: 'google',
      clientId: CLIENT_ID,
      storageKey: STORAGE_KEY,
    });

    expect(handle.id).toBe('google:lazy');
    expect(appendSpy).toHaveBeenCalledOnce();
  });

  it('injects the GIS script only once for concurrent sign-ins', async () => {
    const credential = makeIdToken({ sub: 'concurrent' });
    let appendCount = 0;
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      appendCount += 1;
      const script = node as unknown as HTMLScriptElement;
      queueMicrotask(() => {
        installFakeGis({ credential, moment: 'success' });
        script.dispatchEvent(new Event('load'));
      });
      return node;
    });

    const [a, b] = await Promise.all([
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: 'k1' }),
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: 'k2' }),
    ]);

    expect(appendCount).toBe(1);
    expect(a.id).toBe('google:concurrent');
    expect(b.id).toBe('google:concurrent');
  });

  it('rejects when the GIS script fails to load', async () => {
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      const script = node as unknown as HTMLScriptElement;
      queueMicrotask(() => script.dispatchEvent(new Event('error')));
      return node;
    });

    await expect(
      useAuthProvider({ provider: 'google', clientId: CLIENT_ID, storageKey: STORAGE_KEY }),
    ).rejects.toThrow(/failed to load/i);
  });

  it('rejects when loading the GIS script times out', async () => {
    vi.useFakeTimers();
    // appendChild does nothing — the load event never fires.
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => node);

    const pending = useAuthProvider({
      provider: 'google',
      clientId: CLIENT_ID,
      storageKey: STORAGE_KEY,
    });
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(11_000);
    await assertion;
  });
});
