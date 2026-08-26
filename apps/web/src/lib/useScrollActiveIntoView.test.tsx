import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useScrollActiveIntoView } from './useScrollActiveIntoView';

/**
 * The hook's whole job is to pick the ONE active element out of a strip. Which
 * element it picks is decided by a CSS selector, and a selector is exactly the
 * kind of thing that looks right and is wrong: `[aria-current]` matches the
 * attribute whatever it says, so a strip whose inactive items render
 * `aria-current="false"` had its FIRST item scrolled into view every time —
 * permanently hiding the item that was actually selected, on the deep-link
 * journey this hook exists to fix.
 *
 * `aria-current="false"` is valid ARIA and is what a `cond ? 'page' : 'false'`
 * ternary produces, so this is one refactor away at all times.
 */

interface Item {
  id: string;
  current?: 'page' | 'step' | 'true' | 'false' | '';
  selected?: 'true' | 'false';
  pressed?: 'true' | 'false';
}

/**
 * Spread rather than written as props, for one reason worth keeping: React's
 * own types forbid `aria-current=""`, so the empty value can only reach the
 * DOM the way it reaches it in real life — through a spread of props typed
 * more loosely, or out of a component this app did not write. Which is the
 * argument for the selector excluding it rather than trusting the prop types.
 */
function ariaOf(item: Item): Record<string, string> {
  return {
    ...(item.current === undefined ? {} : { 'aria-current': item.current }),
    ...(item.selected === undefined
      ? {}
      : // `aria-selected` is only supported on a handful of roles, and `button`
        // is not one of them — the a11y lint is right about that, so the item
        // carrying it says it is a tab.
        { role: 'tab', 'aria-selected': item.selected }),
    ...(item.pressed === undefined ? {} : { 'aria-pressed': item.pressed }),
  };
}

function Strip({ items, active }: { items: Item[]; active: string }) {
  const ref = useScrollActiveIntoView<HTMLDivElement>(active);
  return (
    <div ref={ref}>
      {items.map((item) => (
        <button key={item.id} type="button" data-testid={item.id} aria-label={item.id} {...ariaOf(item)} />
      ))}
    </div>
  );
}

/** The element the hook decided was active, or null if it scrolled nothing. */
function scrolledBy(items: Item[]): HTMLElement | null {
  const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  try {
    render(<Strip items={items} active="a" />);
    return (spy.mock.contexts[0] as HTMLElement | undefined) ?? null;
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useScrollActiveIntoView', () => {
  it('ignores aria-current="false" and scrolls the genuinely current item', () => {
    const target = scrolledBy([
      { id: 'one', current: 'false' },
      { id: 'two', current: 'false' },
      { id: 'three', current: 'page' },
    ]);

    expect(target).toHaveAttribute('data-testid', 'three');
  });

  it('ignores aria-current="" — an empty value maps to false in ARIA', () => {
    const target = scrolledBy([
      { id: 'one', current: '' },
      { id: 'two', current: 'true' },
    ]);

    expect(target).toHaveAttribute('data-testid', 'two');
  });

  it('accepts any current token, not just the ones this app writes today', () => {
    const target = scrolledBy([{ id: 'one', current: 'false' }, { id: 'two', current: 'step' }]);

    expect(target).toHaveAttribute('data-testid', 'two');
  });

  it('still answers to aria-selected and aria-pressed', () => {
    expect(
      scrolledBy([{ id: 'one', selected: 'false' }, { id: 'two', selected: 'true' }]),
    ).toHaveAttribute('data-testid', 'two');

    expect(
      scrolledBy([{ id: 'one', pressed: 'false' }, { id: 'two', pressed: 'true' }]),
    ).toHaveAttribute('data-testid', 'two');
  });

  it('scrolls nothing when the strip has no active item', () => {
    expect(
      scrolledBy([
        { id: 'one', current: 'false' },
        { id: 'two', selected: 'false' },
        { id: 'three', pressed: 'false' },
      ]),
    ).toBeNull();
  });
});
