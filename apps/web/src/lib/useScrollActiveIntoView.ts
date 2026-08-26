import { useEffect, useRef } from 'react';

/**
 * For a horizontally scrolling strip: whenever `active` changes, bring the
 * element marked `aria-current`, `aria-selected="true"` or `aria-pressed="true"`
 * into view. A deep link into the eleventh of fourteen tabs should not land
 * on a strip where the selected pill is off-screen.
 */
export function useScrollActiveIntoView<T extends HTMLElement>(active: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(
      '[aria-current], [aria-selected="true"], [aria-pressed="true"]',
    );
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [active]);
  return ref;
}
