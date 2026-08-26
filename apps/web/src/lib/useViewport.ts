import { useEffect, useState } from 'react';

/**
 * Small hooks for the three layout modes the app is designed against.
 *
 *   phone    < 768px   no rail, bottom tab bar, tables become cards
 *   tablet   768–1023  collapsed rail, two-column grids
 *   desktop  ≥ 1024    the original layout
 *
 * These match Tailwind's `md` and `lg` breakpoints exactly, so a component can
 * use CSS for most things and reach for the hook only when the *structure*
 * changes (render a drawer instead of a column, a sheet instead of a dialog).
 */

function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export interface Viewport {
  phone: boolean;
  tablet: boolean;
  desktop: boolean;
  /** Primary input is a finger — hover is not available. */
  coarse: boolean;
}

export function useViewport(): Viewport {
  const md = useMediaQuery('(min-width: 768px)');
  const lg = useMediaQuery('(min-width: 1024px)');
  const coarse = useMediaQuery('(pointer: coarse)');
  return { phone: !md, tablet: md && !lg, desktop: lg, coarse };
}

export { useMediaQuery };

/**
 * Keeps `--vvh` equal to the visible height. iOS Safari does not shrink the
 * layout viewport when the keyboard opens, so anything sized with `dvh` slides
 * under the keyboard; the visual viewport is the honest number. Mount once.
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.classList.toggle('keyboard-open', window.innerHeight - vv.height > 120);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.style.removeProperty('--vvh');
      root.classList.remove('keyboard-open');
    };
  }, []);
}
