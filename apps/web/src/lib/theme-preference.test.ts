import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readStoredTheme,
  resolveInitialTheme,
  storeTheme,
  THEME_STORAGE_KEY,
} from './theme-preference';

/**
 * The whole point of this module is that it CANNOT throw. `localStorage`
 * throws — not returns null — in a browser with site data blocked, and this
 * runs before React mounts, so an unguarded access takes the app down at the
 * white screen rather than degrading to a preference that does not stick.
 *
 * So the interesting cases are all failure cases, plus the one behavioural
 * rule: NEVER CHOSEN IS LIGHT — the owner's 5 Sep 2026 ruling ("default color
 * mode should be white mode, can be changed manually using switcher"), which
 * REVERSED this suite's earlier pin that never-chosen followed the OS. The OS
 * preference is deliberately not consulted anywhere in the module now.
 */

/** Replace `window.localStorage` with something that throws on every access. */
function blockStorage() {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  return () => {
    if (original) Object.defineProperty(window, 'localStorage', original);
  };
}

/** Point `prefers-color-scheme: dark` at a fixed answer. */
function setSystemDark(dark: boolean) {
  return vi
    .spyOn(window, 'matchMedia')
    .mockImplementation(
      (query: string) => ({ matches: dark && query.includes('dark'), media: query }) as MediaQueryList,
    );
}

afterEach(() => {
  vi.restoreAllMocks();
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* nothing to clean up */
  }
});

describe('readStoredTheme', () => {
  it('reads back exactly what was stored', () => {
    storeTheme('dark');
    expect(readStoredTheme()).toBe('dark');
    storeTheme('light');
    expect(readStoredTheme()).toBe('light');
  });

  it('answers null when nothing was ever chosen', () => {
    expect(readStoredTheme()).toBeNull();
  });

  it('ignores a value that is not one of the two themes', () => {
    // Someone else's key collision, a half-written value, a hand-edited
    // devtools entry. Anything but the two words is "no choice made", which
    // falls through to the default rather than to a broken class.
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(readStoredTheme()).toBeNull();
  });

  it('answers null instead of throwing when storage is blocked', () => {
    const restore = blockStorage();
    try {
      expect(() => readStoredTheme()).not.toThrow();
      expect(readStoredTheme()).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('storeTheme', () => {
  it('swallows a storage failure rather than breaking the caller', () => {
    // `updateSettings` calls this in the same tick it sets React state. A throw
    // here would take the theme toggle — and whatever else was in that patch —
    // down with it.
    const restore = blockStorage();
    try {
      expect(() => storeTheme('dark')).not.toThrow();
    } finally {
      restore();
    }
  });
});

describe('resolveInitialTheme', () => {
  it('prefers an explicit choice, in both directions', () => {
    storeTheme('dark');
    expect(resolveInitialTheme()).toBe('dark');
    storeTheme('light');
    expect(resolveInitialTheme()).toBe('light');
  });

  it('⚠ never chosen is LIGHT, even on an OS set to dark', () => {
    // The owner's ruling (5 Sep 2026). A dark-set machine still opens light
    // until the switcher is used — prefers-color-scheme must not be consulted,
    // so the spy also proves matchMedia is never even asked.
    const media = setSystemDark(true);
    expect(readStoredTheme()).toBeNull();
    expect(resolveInitialTheme()).toBe('light');
    expect(media).not.toHaveBeenCalled();
  });

  it('still answers light with storage blocked', () => {
    setSystemDark(true);
    const restore = blockStorage();
    try {
      expect(resolveInitialTheme()).toBe('light');
    } finally {
      restore();
    }
  });
});
