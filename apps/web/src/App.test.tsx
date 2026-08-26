import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import App from './App';
import { queryClient } from './api/queryClient';
import { AppIntlProvider } from './i18n/AppIntlProvider';
import { AppProvider } from './context/AppContext';
import { setViewport } from './test/viewport';

/**
 * The shell switch — the one structural decision `App.tsx` takes in JS rather
 * than in CSS, and until now the only one nothing tested.
 *
 * `useViewport()` is read once in `App`, and on its answer the shell renders
 * EITHER the `Sidebar` rail OR the `BottomNav` tab bar. The suite could not
 * exercise that: `vitest.setup.ts` stubbed `matchMedia` to answer `false` to
 * every query, `useViewport` reads a universal false as `phone: true`, and so
 * all 300-odd tests rendered the phone shell and none of them the desktop one.
 * A rail that stopped rendering entirely would have gone green.
 *
 * These assertions are therefore about which shell is on screen and nothing
 * else. jsdom has no layout engine, so nothing here can — or tries to — say
 * anything about width, position or what is visible; `setViewport` moves the
 * media queries, and the media queries are exactly what the app branches on.
 */

/** The rail's own control. `expanded` starts false, so it offers to expand. */
const RAIL = { name: 'Expand navigation' } as const;
/** The tab bar's accessible name (`shell.bottomNav.primary`). */
const BAR = { name: 'Primary' } as const;

function renderShell() {
  // The practice shell, not one of the client-facing portals — those replace
  // it outright and have no rail or bar of their own.
  window.history.replaceState({}, '', '/');
  return render(
    <AppIntlProvider>
      <QueryClientProvider client={queryClient}>
        <AppProvider>
          <App />
        </AppProvider>
      </QueryClientProvider>
    </AppIntlProvider>,
  );
}

afterEach(() => {
  queryClient.clear();
});

describe('the app shell chooses its navigation by viewport', () => {
  it('renders the sidebar rail and no tab bar at desktop width', async () => {
    setViewport('desktop');
    const { unmount } = renderShell();
    await act(async () => {});

    expect(screen.getByRole('button', RAIL)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', BAR)).not.toBeInTheDocument();

    unmount();
  });

  it('still renders the rail at tablet width — the rail collapses, it is not replaced', async () => {
    // `useViewport` has three modes but the shell has two branches: only
    // `phone` swaps the component. A tablet gets a narrower rail, from CSS.
    setViewport('tablet');
    const { unmount } = renderShell();
    await act(async () => {});

    expect(screen.getByRole('button', RAIL)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', BAR)).not.toBeInTheDocument();

    unmount();
  });

  it('renders the tab bar and no rail at phone width', async () => {
    setViewport('phone');
    const { unmount } = renderShell();
    await act(async () => {});

    expect(screen.getByRole('navigation', BAR)).toBeInTheDocument();
    expect(screen.queryByRole('button', RAIL)).not.toBeInTheDocument();

    unmount();
  });

  /**
   * Narrowing an already-mounted shell is not a hypothetical: a rotate, a
   * desktop window dragged narrow and the iPad split-view divider all do it
   * without remounting anything. It is also the half of `useMediaQuery` that a
   * render-time-only stub cannot reach — the mode is read once into state and
   * then kept current by an effect subscribed to the query's `change` event,
   * so a subscription that broke would still pass every test above.
   */
  it('brings the tab bar in when a mounted desktop shell narrows to a phone', async () => {
    setViewport('desktop');
    const { unmount } = renderShell();
    await act(async () => {});
    expect(screen.getByRole('button', RAIL)).toBeInTheDocument();

    await act(async () => {
      setViewport('phone');
    });

    expect(screen.getByRole('navigation', BAR)).toBeInTheDocument();
    // The rail is deliberately NOT asserted gone here. It is wrapped in
    // `AnimatePresence`, so it stays mounted while it animates out and leaves
    // only when motion says the exit finished — real behaviour, and the reason
    // the absence assertions live in the mount-time tests above rather than
    // being chased through an animation this environment cannot run honestly.
    unmount();
  });

  it('takes the tab bar away when a mounted phone shell widens to a desktop', async () => {
    // The other direction is a plain conditional with no exit animation, so
    // both halves of the swap are assertable in one tick.
    setViewport('phone');
    const { unmount } = renderShell();
    await act(async () => {});
    expect(screen.getByRole('navigation', BAR)).toBeInTheDocument();

    await act(async () => {
      setViewport('desktop');
    });

    expect(screen.getByRole('button', RAIL)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', BAR)).not.toBeInTheDocument();

    unmount();
  });
});
