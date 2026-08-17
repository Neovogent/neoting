import { StrictMode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import App from '../App';
import { queryClient } from '../api/queryClient';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import { AppProvider, useAppContext } from './AppContext';

/**
 * Issue #87: rapid route changes crashed the whole tree with "Rendered fewer
 * hooks than expected", consistently preceded by "Cannot update a component
 * (AppProvider) while rendering a different component (AppProvider)".
 *
 * Cause: navigate() ran inside a useState updater. React replays updaters
 * during the render phase, so a conversation change queued behind another
 * state write dispatched 'app:navigate' mid-render and yanked the address
 * back to /chat/<id> from inside AppProvider's own render.
 *
 * This drives that exact interleaving: a conversation change and a route
 * change in one batch, across the nine sidebar routes, twice over. Offline by
 * construction — the API query is disabled without VITE_API_ENABLED, nothing
 * opens a socket, and nothing waits on a timer; everything flushes via act().
 */

const ROUTES = ['/', '/clients', '/inboxes', '/chases', '/approvals', '/documents', '/analytics', '/team', '/settings'];

/** Grabs the live context so the test can do what the workspace buttons do. */
let ctx!: ReturnType<typeof useAppContext>;
function Probe() {
  ctx = useAppContext();
  return null;
}

describe('AppProvider under rapid navigation (#87)', () => {
  it('survives the nine-route loop with conversation changes interleaved', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/');

    const { container, unmount } = render(
      <StrictMode>
        <AppIntlProvider>
          <QueryClientProvider client={queryClient}>
            <AppProvider>
              <Probe />
              <App />
            </AppProvider>
          </QueryClientProvider>
        </AppIntlProvider>
      </StrictMode>,
    );

    for (let pass = 0; pass < 2; pass++) {
      for (const route of ROUTES) {
        // One batch: the conversation updater queues first, so the render the
        // navigation forces is the render that replays it — the interleaving
        // that crashed.
        await act(async () => {
          ctx.newConversation();
          window.history.pushState({}, '', route);
          window.dispatchEvent(new Event('app:navigate'));
        });
      }
    }
    // Let any in-flight lazy view settle.
    await act(async () => {});

    // The tree survived — the crash emptied #root.
    expect(container.firstChild).not.toBeNull();

    // The address is the last place the user went; before the fix the
    // render-phase navigate() yanked it back to /chat/<draft id>.
    expect(window.location.pathname).toBe('/settings');

    // And no render-phase update was scheduled from AppProvider.
    const renderPhaseWarnings = consoleError.mock.calls.filter((args) =>
      String(args[0]).includes('Cannot update a component'),
    );
    expect(renderPhaseWarnings).toEqual([]);

    consoleError.mockRestore();
    unmount();
  });
});
