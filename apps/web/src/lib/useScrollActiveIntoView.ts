import { useEffect, useRef } from 'react';

/**
 * For a horizontally scrolling strip: whenever `active` changes, bring the
 * element marked `aria-current`, `aria-selected="true"` or `aria-pressed="true"`
 * into view. A deep link into the eleventh of fourteen tabs should not land
 * on a strip where the selected pill is off-screen.
 */

/**
 * ⚠ EVERY CLAUSE HERE MATCHES ON A VALUE, INCLUDING `aria-current`.
 *
 * A bare `[aria-current]` matches the ATTRIBUTE, whatever it says — so a strip
 * that renders `aria-current="false"` on its inactive items (which is valid
 * ARIA, and what a `cond ? 'page' : 'false'` ternary produces) would have its
 * FIRST item scrolled into view on every change, permanently hiding the item
 * that is actually selected. `aria-selected` and `aria-pressed` were already
 * value-matched; `aria-current` was the odd one out.
 *
 * `aria-current` is an enumerated token, not a boolean: `page`, `step`,
 * `location`, `date`, `time` and `true` all mean current, and only `false`,
 * the empty string and the absent attribute do not. So it is written as an
 * exclusion rather than as a list of the tokens this app happens to use today
 * — a view that starts marking `aria-current="step"` should keep working
 * without anyone having to edit this file.
 */
const ACTIVE_SELECTOR = [
  '[aria-current]:not([aria-current="false"]):not([aria-current=""])',
  '[aria-selected="true"]',
  '[aria-pressed="true"]',
].join(', ');

export function useScrollActiveIntoView<T extends HTMLElement>(active: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(ACTIVE_SELECTOR);
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [active]);
  return ref;
}
