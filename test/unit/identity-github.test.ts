/**
 * Tests for the GitHub provider behind `useAuthProvider({ provider: 'github' })`.
 *
 * GitHub OAuth cannot be completed in the browser alone — the token
 * exchange happens at the developer-deployed `exchangeUrl` endpoint
 * (`createGitHubOAuthHandler` in `scorezilla/server`). The client half
 * under test here:
 *
 *   1. opens a popup to GitHub's authorize URL (client_id + redirect_uri
 *      pointing at `exchangeUrl` + a random `state`),
 *   2. waits for a `message` event posted by the exchange endpoint's
 *      callback page,
 *   3. validates the message origin AND the `state` echo,
 *   4. derives `github:<id>`, persists it, resolves the handle.
 *
 * We mock `window.open` and hand-dispatch MessageEvents to drive every
 * path: happy, declined (access_denied / popup closed), spoofed origin,
 * state mismatch, exchange failure, popup blocked, restore, signOut.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthProvider } from '../../src/identity';

const isBrowser = typeof window !== 'undefined';
const describeBrowser = isBrowser ? describe : describe.skip;

const STORAGE_KEY = 'mygame:gh-auth';
const CLIENT_ID = 'Iv1_test1234567890ab';
const EXCHANGE_URL = '/api/github-oauth';
// jsdom origin — relative exchangeUrl resolves against this. Guarded:
// the bun CI lane runs this file WITHOUT jsdom (describeBrowser skips the
// suites, but module top-level still executes).
const PAGE_ORIGIN = isBrowser ? window.location.origin : '';

const MESSAGE_SOURCE = 'scorezilla:github-oauth';

interface FakePopup {
  closed: boolean;
  close: () => void;
}

/** Install a `window.open` mock; returns the captured URL + popup stub. */
function installFakeOpen(opts: { blocked?: boolean } = {}): {
  openedUrl: () => URL | undefined;
  popup: FakePopup;
  openCalls: () => number;
} {
  let captured: URL | undefined;
  let calls = 0;
  const popup: FakePopup = {
    closed: false,
    close: vi.fn(() => {
      popup.closed = true;
    }) as unknown as () => void,
  };
  vi.spyOn(window, 'open').mockImplementation((url?: string | URL) => {
    calls += 1;
    if (opts.blocked) return null;
    captured = new URL(String(url));
    return popup as unknown as Window;
  });
  return { openedUrl: () => captured, popup, openCalls: () => calls };
}

function postCallbackMessage(data: unknown, origin: string = PAGE_ORIGIN): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin }));
}

/** Pull the `state` the helper generated out of the captured authorize URL. */
function capturedState(openedUrl: () => URL | undefined): string {
  const url = openedUrl();
  expect(url).toBeDefined();
  const state = url!.searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

function startSignIn(overrides: Partial<Record<string, string>> = {}) {
  return useAuthProvider({
    provider: 'github',
    clientId: CLIENT_ID,
    exchangeUrl: EXCHANGE_URL,
    storageKey: STORAGE_KEY,
    ...overrides,
  } as Parameters<typeof useAuthProvider>[0]);
}

describeBrowser('useAuthProvider({ provider: "github" })', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it('rejects with TypeError when clientId is missing', async () => {
    await expect(
      useAuthProvider({
        provider: 'github',
        exchangeUrl: EXCHANGE_URL,
        storageKey: STORAGE_KEY,
      } as never),
    ).rejects.toThrow(TypeError);
  });

  it('rejects with TypeError when exchangeUrl is missing', async () => {
    await expect(
      useAuthProvider({
        provider: 'github',
        clientId: CLIENT_ID,
        storageKey: STORAGE_KEY,
      } as never),
    ).rejects.toThrow(TypeError);
  });

  it('rejects with TypeError when storageKey is missing', async () => {
    await expect(
      useAuthProvider({
        provider: 'github',
        clientId: CLIENT_ID,
        exchangeUrl: EXCHANGE_URL,
      } as never),
    ).rejects.toThrow(TypeError);
  });

  // -------------------------------------------------------------------------
  // Authorize URL construction
  // -------------------------------------------------------------------------

  it('opens GitHub authorize with client_id, absolute redirect_uri, and a state', async () => {
    const { openedUrl, popup } = installFakeOpen();
    const promise = startSignIn();

    const url = openedUrl();
    expect(url).toBeDefined();
    expect(url!.origin).toBe('https://github.com');
    expect(url!.pathname).toBe('/login/oauth/authorize');
    expect(url!.searchParams.get('client_id')).toBe(CLIENT_ID);
    // Relative exchangeUrl is resolved absolute against the page.
    expect(url!.searchParams.get('redirect_uri')).toBe(`${PAGE_ORIGIN}${EXCHANGE_URL}`);
    // state is URL/HTML-safe and non-trivial.
    expect(url!.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    // Identity-only: no scopes requested.
    expect(url!.searchParams.get('scope')).toBeNull();

    // Settle the promise so the test doesn't leak a listener.
    postCallbackMessage({ source: MESSAGE_SOURCE, state: capturedState(openedUrl), id: '99' });
    await promise;
    expect(popup.close).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path + persistence
  // -------------------------------------------------------------------------

  it('resolves github:<id>, persists it, and closes the popup', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    postCallbackMessage({
      source: MESSAGE_SOURCE,
      state: capturedState(openedUrl),
      id: '583231',
    });

    const handle = await promise;
    expect(handle).not.toBeNull();
    expect(handle!.id).toBe('github:583231');
    expect(handle!.provider).toBe('github');
    expect(handle!.source).toBe('signed-in');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('github:583231');
  });

  it('returning visit restores the persisted id without opening a popup', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'github:583231');
    const { openCalls } = installFakeOpen();

    const handle = await startSignIn();
    expect(handle).not.toBeNull();
    expect(handle!.id).toBe('github:583231');
    expect(handle!.source).toBe('restored');
    expect(openCalls()).toBe(0);
  });

  it('signOut() clears the persisted id', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    postCallbackMessage({ source: MESSAGE_SOURCE, state: capturedState(openedUrl), id: '7' });
    const handle = await promise;

    handle!.signOut();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Message validation — spoofing resistance
  // -------------------------------------------------------------------------

  it('ignores messages from a different origin', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    const state = capturedState(openedUrl);

    // Attacker-origin message with otherwise-perfect payload: ignored.
    postCallbackMessage({ source: MESSAGE_SOURCE, state, id: '666' }, 'https://evil.example');
    // The genuine message still wins afterwards.
    postCallbackMessage({ source: MESSAGE_SOURCE, state, id: '583231' });

    const handle = await promise;
    expect(handle!.id).toBe('github:583231');
  });

  it('ignores messages with a wrong or missing state', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    const state = capturedState(openedUrl);

    postCallbackMessage({ source: MESSAGE_SOURCE, state: 'forged-state', id: '666' });
    postCallbackMessage({ source: MESSAGE_SOURCE, id: '666' });
    postCallbackMessage({ source: MESSAGE_SOURCE, state, id: '583231' });

    const handle = await promise;
    expect(handle!.id).toBe('github:583231');
  });

  it('ignores unrelated messages (no source marker)', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    const state = capturedState(openedUrl);

    postCallbackMessage('just-a-string');
    postCallbackMessage({ totally: 'unrelated' });
    postCallbackMessage({ source: MESSAGE_SOURCE, state, id: '42' });

    const handle = await promise;
    expect(handle!.id).toBe('github:42');
  });

  // -------------------------------------------------------------------------
  // Decline + failure semantics (ADR 0009: null = declined, throw = broken)
  // -------------------------------------------------------------------------

  it('resolves null when GitHub reports access_denied (user cancelled)', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    postCallbackMessage({
      source: MESSAGE_SOURCE,
      state: capturedState(openedUrl),
      error: 'access_denied',
    });

    await expect(promise).resolves.toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('resolves null when the player closes the popup without signing in', async () => {
    vi.useFakeTimers();
    const { popup } = installFakeOpen();
    const promise = startSignIn();

    popup.closed = true;
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(promise).resolves.toBeNull();
  });

  it('rejects when the exchange endpoint reports a failure', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    postCallbackMessage({
      source: MESSAGE_SOURCE,
      state: capturedState(openedUrl),
      error: 'exchange_failed',
    });

    await expect(promise).rejects.toThrow(/exchange/i);
  });

  it('clamps an arbitrary error string to the known vocabulary (no injection into Error)', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    const hostile = 'oops\n[FAKE LOG LINE] admin token: hunter2\nmore';
    postCallbackMessage({
      source: MESSAGE_SOURCE,
      state: capturedState(openedUrl),
      error: hostile,
    });

    await expect(promise).rejects.toSatisfy((e: unknown) => {
      const message = (e as Error).message;
      return message.includes('exchange_failed') && !message.includes('hunter2');
    });
  });

  it('rejects a non-numeric id as a malformed endpoint (never persists it)', async () => {
    const { openedUrl } = installFakeOpen();
    const promise = startSignIn();
    postCallbackMessage({
      source: MESSAGE_SOURCE,
      state: capturedState(openedUrl),
      id: 'google:stolen-identity',
    });

    await expect(promise).rejects.toThrow(/malformed/i);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('rejects after the sign-in timeout when nothing ever arrives', async () => {
    vi.useFakeTimers();
    installFakeOpen();
    // Attach the rejection handler BEFORE advancing timers — the timeout
    // fires mid-advance and must not surface as an unhandled rejection.
    const assertion = expect(startSignIn()).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1_000);
    await assertion;
  });

  it('rejects when the popup is blocked', async () => {
    installFakeOpen({ blocked: true });
    await expect(startSignIn()).rejects.toThrow(/popup|gesture/i);
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  it('coalesces concurrent sign-ins for the same storageKey into one popup', async () => {
    const { openedUrl, openCalls } = installFakeOpen();
    const p1 = startSignIn();
    const p2 = startSignIn();
    expect(openCalls()).toBe(1);

    postCallbackMessage({ source: MESSAGE_SOURCE, state: capturedState(openedUrl), id: '11' });
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1!.id).toBe('github:11');
    expect(h2!.id).toBe('github:11');
  });
});
