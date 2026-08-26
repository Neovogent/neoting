import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import App from '../../App';
import { queryClient } from '../../api/queryClient';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { AppProvider } from '../../context/AppContext';

// The privacy notice as the BUILD renders it — through the plugin, not ?raw —
// so the assertions below follow the document's real state: while S6 leaves
// placeholders in it the draft banner must show, and the day they are all
// resolved the banner must be gone. Either state passes; lying about the
// state fails.
import * as privacyNotice from '../../../../../docs/legal/privacy-notice.md';

/**
 * The legal pages (launch stage M4). As with the landing suite, what is
 * pinned is the claims and not the layout: `/legal/*` renders OUTSIDE every
 * wall and shell (a client deciding whether to trust us is not asked to log
 * in first), the document arrives from docs/legal rather than from retyped
 * copy, unresolved placeholders are worn as a banner rather than hidden, and
 * a mistyped slug lands on the contents page instead of a dead end.
 */

function renderAt(address: string) {
  window.history.replaceState({}, '', address);
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

const DOC_LINKS = [
  ['Terms of Service', '/legal/terms-of-service'],
  ['Privacy Notice', '/legal/privacy-notice'],
  ['Data Processing Terms', '/legal/data-processing-terms'],
  ['Refunds and Cancellation', '/legal/refund-and-cancellation'],
] as const;

describe('the legal pages at /legal/*', () => {
  it('renders the contents page outside the workspace shell and the login wall', async () => {
    const { unmount } = renderAt('/legal');

    expect(await screen.findByRole('heading', { level: 1, name: 'Legal' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();

    // All four documents are one click away — twice over, in fact: the
    // contents cards and the footer nav both carry them, and every copy must
    // agree on the address.
    for (const [name, href] of DOC_LINKS) {
      const links = screen.getAllByRole('link', { name });
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link).toHaveAttribute('href', href);
    }

    unmount();
  });

  it('renders a document from docs/legal, headings and all', async () => {
    const { unmount } = renderAt('/legal/privacy-notice');

    // The document's own h1, from the markdown — not a label this app minted.
    // findBy*: the view is one lazy chunk and the document is another.
    expect(
      await screen.findByRole('heading', { level: 1, name: privacyNotice.title }),
    ).toBeInTheDocument();

    unmount();
  });

  it('wears the draft banner exactly while placeholders remain unresolved', async () => {
    const { unmount } = renderAt('/legal/privacy-notice');
    await screen.findByRole('heading', { level: 1, name: privacyNotice.title });

    if (privacyNotice.placeholderCount > 0) {
      expect(screen.getByRole('note')).toHaveTextContent(/draft/i);
    } else {
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    }

    unmount();
  });

  it('lands an unknown slug on the contents page rather than a dead end', async () => {
    const { unmount } = renderAt('/legal/no-such-document');

    expect(await screen.findByRole('heading', { level: 1, name: 'Legal' })).toBeInTheDocument();

    unmount();
  });

  it('offers the way back to the homepage', async () => {
    const { unmount } = renderAt('/legal');
    await screen.findByRole('heading', { level: 1, name: 'Legal' });

    expect(screen.getByRole('link', { name: 'Back to the homepage' })).toHaveAttribute('href', '/');

    unmount();
  });
});
