import { useCallback, useSyncExternalStore } from 'react';

/**
 * A small history-based router.
 *
 * Every place you can stand in this app has an address, so a tab, a sub-tab, a
 * conversation and an open modal can all be linked, bookmarked and shared, and
 * the browser's Back button does what it looks like it does. Nothing ever
 * reloads the page — navigation is a `pushState` and a re-render.
 *
 * Deliberately hand-rolled rather than a router dependency: the whole app is
 * already one context of state, so what is needed is a way to read and write
 * the address bar, not a second tree that owns rendering.
 *
 * The shape is:
 *
 *     /clients/1/costs/review?doc=d1
 *     └──────┬──────┘└──┬──┘└──┬──┘ └──┬──┘
 *       where you are   tab  sub-tab  what is open on top
 *
 * Path segments say *where* you are; the query says what is layered over it.
 * That split is what lets a modal have its own link without every screen
 * needing to know about every modal that could open on it.
 */

const EVENT = 'app:navigate';

/** Subscribers re-run on both our own navigations and the browser's. */
function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

const currentHref = () => window.location.pathname + window.location.search;

/** The live address, as a string. Re-renders the caller when it changes. */
export function useHref(): string {
  return useSyncExternalStore(subscribe, currentHref, () => '/');
}

/**
 * Go somewhere. `replace` swaps the current entry instead of adding one — used
 * for redirects and for state the user should not have to press Back through,
 * like normalising a URL on load.
 */
export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (to === currentHref()) return;
  window.history[options.replace ? 'replaceState' : 'pushState']({}, '', to);
  window.dispatchEvent(new Event(EVENT));
}

/** The path split into segments, with empties dropped. */
export function usePath(): string[] {
  const href = useHref();
  return href.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
}

/**
 * One query parameter, and a setter that keeps the rest of the address intact.
 * This is how a modal gets a link: opening it sets a param, closing it clears
 * one, and Back closes it because that is what the previous entry says.
 */
export function useQueryParam(key: string): [string | null, (value: string | null, options?: { replace?: boolean }) => void] {
  const href = useHref();
  const value = new URLSearchParams(href.split('?')[1] ?? '').get(key);

  const set = useCallback(
    (next: string | null, options: { replace?: boolean } = {}) => {
      const [path, search] = currentHref().split('?');
      const params = new URLSearchParams(search ?? '');
      if (next === null) params.delete(key);
      else params.set(key, next);
      const query = params.toString();
      navigate(query ? `${path}?${query}` : path, options);
    },
    [key],
  );

  return [value, set];
}

/**
 * One path segment, plus a setter that rewrites the address from that depth
 * down — selecting a tab drops whatever sub-tab was open under the old one,
 * which is what you want and what a naive replace would get wrong.
 */
export function useSegment(index: number): [string | undefined, (value: string | null) => void] {
  const segments = usePath();
  const set = useCallback(
    (value: string | null) => {
      const parts = currentHref().split('?')[0].split('/').filter(Boolean);
      const next = value === null ? parts.slice(0, index) : [...parts.slice(0, index), value];
      // The query is dropped: whatever was layered over the old tab — a
      // preview, a compare — belonged to it, and carrying it across would
      // reopen a modal about something you are no longer looking at.
      navigate('/' + next.join('/'));
    },
    [index],
  );
  return [segments[index], set];
}

/** Build a path from segments, encoding each so ids with slashes survive. */
export const path = (...segments: (string | null | undefined)[]) =>
  '/' + segments.filter((s): s is string => !!s).map(encodeURIComponent).join('/');

/**
 * Tabs and sub-tabs live in the address as slugs — a URL is read by people, so
 * "supplier-statements" beats "Supplier%20Statements".
 */
export const slug = (label: string) =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Finds which of a known set of labels a slug refers to. */
export const fromSlug = <T extends string>(value: string | undefined, options: readonly T[]): T | undefined =>
  options.find((o) => slug(o) === value);

/**
 * Intercepts plain left-clicks on in-app links so they navigate without a
 * reload, while leaving modified clicks alone — cmd-click still opens a new
 * tab, which is the whole point of having real addresses.
 */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: React.MouseEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
