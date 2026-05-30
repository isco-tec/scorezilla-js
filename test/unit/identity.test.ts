/**
 * Tests for the identity preset helpers (`scorezilla/identity`).
 *
 * Run under vitest's jsdom-backed environment (see vitest.config).
 *
 * Coverage targets:
 *   • useAnonymousPlayer mints + persists; same key returns same id
 *   • useAnonymousPlayer forget() clears storage; next call re-mints
 *   • usePromptedPlayer prompts on first call, persists, returns null on cancel
 *   • usePromptedPlayer returns null when window.prompt is unavailable
 *   • useServerAuthoritative returns the marker object
 *   • useAuthProvider throws with a helpful message
 *   • Input validation rejects empty/missing storageKey + prompt
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAnonymousPlayer,
  usePromptedPlayer,
  useServerAuthoritative,
  useAuthProvider,
} from '../../src/identity';

describe('useAnonymousPlayer', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('mints and persists a uuid on first call', () => {
    const p = useAnonymousPlayer({ storageKey: 'mygame:player' });
    expect(typeof p.id).toBe('string');
    expect(p.id.length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('mygame:player')).toBe(p.id);
  });

  it('returns the same id on subsequent calls with the same storageKey', () => {
    const a = useAnonymousPlayer({ storageKey: 'mygame:player' });
    const b = useAnonymousPlayer({ storageKey: 'mygame:player' });
    expect(b.id).toBe(a.id);
  });

  it('forget() clears storage and the next call mints a fresh id', () => {
    const a = useAnonymousPlayer({ storageKey: 'mygame:player' });
    a.forget();
    expect(window.localStorage.getItem('mygame:player')).toBeNull();
    const b = useAnonymousPlayer({ storageKey: 'mygame:player' });
    expect(b.id).not.toBe(a.id);
  });

  it('rejects missing storageKey', () => {
    // @ts-expect-error — testing runtime guard for invalid input
    expect(() => useAnonymousPlayer({})).toThrow(TypeError);
    // @ts-expect-error — testing runtime guard for invalid input
    expect(() => useAnonymousPlayer(undefined)).toThrow(TypeError);
    expect(() => useAnonymousPlayer({ storageKey: '' })).toThrow(TypeError);
  });
});

describe('usePromptedPlayer', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prompts on first call and persists the entered value', () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValueOnce('Alice');
    const p = usePromptedPlayer({
      storageKey: 'mygame:player',
      prompt: 'Your name?',
    });
    expect(promptSpy).toHaveBeenCalledWith('Your name?');
    expect(p).not.toBeNull();
    expect(p?.id).toBe('Alice');
    expect(window.localStorage.getItem('mygame:player')).toBe('Alice');
  });

  it('does not prompt on subsequent calls when storage has a value', () => {
    window.localStorage.setItem('mygame:player', 'Bob');
    const promptSpy = vi.spyOn(window, 'prompt');
    const p = usePromptedPlayer({
      storageKey: 'mygame:player',
      prompt: 'Your name?',
    });
    expect(promptSpy).not.toHaveBeenCalled();
    expect(p?.id).toBe('Bob');
  });

  it('returns null when the user cancels the prompt (null)', () => {
    vi.spyOn(window, 'prompt').mockReturnValueOnce(null);
    const p = usePromptedPlayer({
      storageKey: 'mygame:player',
      prompt: 'Your name?',
    });
    expect(p).toBeNull();
    expect(window.localStorage.getItem('mygame:player')).toBeNull();
  });

  it('returns null when the user enters an empty string', () => {
    vi.spyOn(window, 'prompt').mockReturnValueOnce('');
    const p = usePromptedPlayer({
      storageKey: 'mygame:player',
      prompt: 'Your name?',
    });
    expect(p).toBeNull();
  });

  it('forget() clears storage and the next call re-prompts', () => {
    const promptSpy = vi
      .spyOn(window, 'prompt')
      .mockReturnValueOnce('Carol')
      .mockReturnValueOnce('Dave');
    const a = usePromptedPlayer({
      storageKey: 'mygame:player',
      prompt: 'Your name?',
    });
    expect(a?.id).toBe('Carol');
    a?.forget();
    const b = usePromptedPlayer({
      storageKey: 'mygame:player',
      prompt: 'Your name?',
    });
    expect(b?.id).toBe('Dave');
    expect(promptSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects missing or empty prompt', () => {
    expect(() =>
      // @ts-expect-error — testing runtime guard for invalid input
      usePromptedPlayer({ storageKey: 'k' }),
    ).toThrow(TypeError);
    expect(() => usePromptedPlayer({ storageKey: 'k', prompt: '' })).toThrow(TypeError);
  });

  it('rejects missing storageKey', () => {
    // @ts-expect-error — testing runtime guard for invalid input
    expect(() => usePromptedPlayer({ prompt: 'x' })).toThrow(TypeError);
  });
});

describe('useServerAuthoritative', () => {
  it('returns the server-authoritative marker', () => {
    const m = useServerAuthoritative();
    expect(m).toEqual({ source: 'server-authoritative' });
  });
});

describe('useAuthProvider', () => {
  it('throws with a helpful message in the 0.3.0-next preview', () => {
    expect(() => useAuthProvider({ provider: 'google' })).toThrow(
      /not yet implemented/i,
    );
    expect(() => useAuthProvider({ provider: 'github' })).toThrow(
      /not yet implemented/i,
    );
  });
});
