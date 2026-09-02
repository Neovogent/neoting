import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readStoredTheme,
  resolveInitialTheme,
  storeTheme,
  systemTheme,
  THEME_STORAGE_KEY,
} from './theme-preference';

/**
 * The whole point of this module is that it CANNOT throw. `localStorage`
 * throws — not returns null — in a browser with site data blocked, and this
 * runs before React mounts, so an unguarded access takes the app down at the
 * white screen rather than degrading to a preference that does not stick.
 *
 * So the interesting cases are all failure cases, plus the one behavioural
 * rule that is easy to get backwards: NEVER CHOSEN is not CHOSEN-LIGHT.
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
    // falls through to the operating system rather than to a broken class.
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

describe('systemTheme', () => {
  it('follows prefers-color-scheme in both directions', () => {
    setSystemDark(true);
    expect(systemTheme()).toBe('dark');
    vi.restoreAllMocks();
    setSystemDark(false);
    expect(systemTheme()).toBe('light');
  });

  it('falls back to light when matchMedia is unavailable', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      throw new Error('no matchMedia here');
    });
    expect(systemTheme()).toBe('light');
  });
});

describe('resolveInitialTheme', () => {
  it('prefers an explicit choice over the operating system', () => {
    setSystemDark(true);
    storeTheme('light');
    expect(resolveInitialTheme()).toBe('light');
  });

  it('⚠ falls back to the OS when the user has never chosen — not to light', () => {
    // This is the rule the old code got wrong: `DEFAULT_SETTINGS.theme` was a
    // hardcoded 'light', so a machine set to dark opened light and every
    // reload undid the toggle.
    setSystemDark(true);
    expect(readStoredTheme()).toBeNull();
    expect(resolveInitialTheme()).toBe('dark');
  });

  it('still answers a usable theme with storage blocked', () => {
    setSystemDark(true);
    const restore = blockStorage();
    try {
      expect(resolveInitialTheme()).toBe('dark');
    } finally {
      restore();
    }
  });
});
