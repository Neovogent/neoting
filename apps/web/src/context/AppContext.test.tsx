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

// '/app', not '/': the workspace root moved there when M3 gave `/` to the
// public landing page, and this loop is about the WORKSPACE under churn.
const ROUTES = ['/app', '/clients', '/inboxes', '/chases', '/approvals', '/documents', '/analytics', '/team', '/settings'];

/** Grabs the live context so the test can do what the workspace buttons do. */
let ctx!: ReturnType<typeof useAppContext>;
function Probe() {
  ctx = useAppContext();
  return null;
}

describe('AppProvider under rapid navigation (#87)', () => {
  it('survives the nine-route loop with conversation changes interleaved', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState({}, '', '/app');

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

/**
 * Review item 59 — *"Chat history gets vanished after reloading"*.
 *
 * The server persistence that item 9 built was real and worked; the transcript
 * was in the database the whole time. What lost it was a CONSTANT: the first
 * conversation of every session was minted as `'draft-initial'`, so that one
 * name meant a different conversation every time it was used.
 *
 * Two failures came out of it, and this test is over the first because the
 * second follows from it:
 *
 * 1. **A reload could not read the transcript back.** `hydrateConversations`
 *    is add-only by id — deliberately, so the open tab's live state is never
 *    clobbered by a stale summary — and the fresh, empty `draft-initial` was
 *    already in the array before the server answered. The saved row was
 *    therefore discarded, `remoteMessageCount` was never set, the sync hook
 *    never fetched its messages, and `LeftPanel` filtered the row out of
 *    RECENT HISTORY for having none. "No conversations yet.", over a
 *    conversation the server was holding.
 * 2. **The next session overwrote the last one.** Saving is a PUT under the
 *    conversation's own id, so session two's first conversation replaced
 *    session one's stored transcript. Silent, and unrecoverable.
 *
 * So what has to hold is that the first draft's id is the conversation's OWN
 * name and not a shared one — which is what makes a previous session's row an
 * id this mount has never seen, and therefore one that hydrates.
 */
describe('the first conversation of a session (review item 59)', () => {
  function mount() {
    let seen!: ReturnType<typeof useAppContext>;
    function Grab() {
      seen = useAppContext();
      return null;
    }
    const { unmount } = render(
      <AppIntlProvider>
        <QueryClientProvider client={queryClient}>
          <AppProvider>
            <Grab />
          </AppProvider>
        </QueryClientProvider>
      </AppIntlProvider>,
    );
    return { ctx: () => seen, unmount };
  }

  it('is named per session, and a previous session’s conversation hydrates into the drawer', async () => {
    window.history.replaceState({}, '', '/app');

    const first = mount();
    const earlierId = first.ctx().conversations[0]!.id;
    first.unmount();

    const second = mount();
    const freshId = second.ctx().conversations[0]!.id;

    // The whole of the defect in one assertion: two sessions, two names.
    expect(freshId).not.toBe(earlierId);
    expect(earlierId).toMatch(/^[A-Za-z0-9_-]{1,64}$/); // the contract's own id shape

    // What a reload does: the server answers with what it is holding.
    await act(async () => {
      second.ctx().hydrateConversations([
        {
          id: earlierId,
          title: 'How many documents are waiting for…',
          pinned: false,
          businessId: null,
          messageCount: 2,
          updatedAt: new Date().toISOString(),
        },
      ]);
    });

    const restored = second.ctx().conversations.find((c) => c.id === earlierId);
    expect(restored).toBeDefined();
    // `remoteMessageCount` is the marker with two jobs: it tells LeftPanel the
    // row is a real conversation despite carrying no messages yet, and it tells
    // `useConversationSync` the transcript still needs fetching.
    expect(restored?.remoteMessageCount).toBe(2);

    second.unmount();
  });
});
