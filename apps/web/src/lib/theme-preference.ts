/**
 * The one persisted UI preference: which theme the accountant chose.
 *
 * ## Why this exists
 *
 * The theme was a class on `<html>` driven by `settings.theme`, and
 * `settings` is React state seeded from `DEFAULT_SETTINGS` — so it lived
 * exactly as long as the tab did. Switching to dark and reloading put you back
 * in light, every time, on every screen. The product owner hit this repeatedly
 * while reporting the Chases board being white in dark mode; half of what they
 * were experiencing was the choice not sticking at all.
 *
 * ## What is stored, and what is emphatically not
 *
 * One key holding one of two words, `'dark'` or `'light'`. It carries no
 * identity, no practice, no scope and nothing derived from any of them — read
 * it and you learn which of two stylesheets somebody prefers.
 *
 * ⚠ **Nothing else in this app may join it.** `nt_session` is HttpOnly on
 * purpose, and the portal bearers live in React state and die with the tab
 * (see `views/business/*` and `api/portal.ts`) precisely so a credential over a
 * client's financial records is never left on a shared phone. `localStorage` is
 * for preferences that are safe to leak, and the bar for adding a second key is
 * the bar this one cleared: it must be worthless to an attacker.
 *
 * The only precedent alongside it is `lib/signed-in-hint.ts`, whose header
 * makes the same argument at greater length. This module deliberately copies
 * its shape — guarded access, fail back to a default, never throw.
 *
 * ## Never chosen is not the same as chosen-light
 *
 * If the key is absent the answer is the operating system's own
 * `prefers-color-scheme`, not a hardcoded light. That is why `storeTheme` is
 * called ONLY from an explicit user action (`updateSettings({ theme })`, which
 * is what both the sidebar toggle and the Settings radio call) and never from
 * the effect that applies the class: writing on mount would pin whatever the OS
 * happened to be saying at first load and silently stop following it after.
 *
 * ## Every access is guarded
 *
 * `localStorage` **throws** rather than returning null in real browsers — a
 * setting that blocks site data, an embedded context, Safari's private mode
 * historically. An unguarded read here would take down the whole app before
 * React mounted, so both functions swallow it. The reader then answers `null`,
 * the resolver falls through to `prefers-color-scheme`, and the app runs
 * normally with a theme that simply does not survive the reload — degraded,
 * never broken.
 *
 * ⚠ `index.html` carries a HAND-INLINED copy of the read half. It has to: this
 * module is a deferred ES module and anything it does happens after the first
 * paint, which is the white flash this change exists to remove. The key name
 * and the class name are duplicated there on purpose and the comment in that
 * file says so — if you rename either, rename it in both places.
 */

import type { Theme } from './types';

/** The `localStorage` key. Mirrored, deliberately, in `index.html`. */
export const THEME_STORAGE_KEY = 'nt.theme';

const isTheme = (v: unknown): v is Theme => v === 'dark' || v === 'light';

/** The stored choice, or `null` if none was made (or storage is unavailable). */
export function readStoredTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    // Storage blocked. No stored choice is indistinguishable from none made.
    return null;
  }
}

/**
 * Record an EXPLICIT choice.
 *
 * Called from `updateSettings` when the patch names a theme, which is the only
 * signal in this app that a human picked one. Never called on mount.
 */
export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Nothing to do: persistence is the improvement, never the requirement.
    // The theme still applies for this tab.
  }
}

/** What the operating system asks for, defaulting to light if it will not say. */
export function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * The theme to start in: the stored choice, else the operating system's.
 *
 * Read once, to seed `settings.theme`. `index.html` computes the same answer
 * inline so the class is on `<html>` before the first paint; this call is what
 * makes React's state agree with what the user is already looking at, so the
 * class-applying effect is a no-op on load instead of a second flash.
 */
export function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? systemTheme();
}
