import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import App from '../App';
import { queryClient } from '../api/queryClient';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import { AppProvider } from '../context/AppContext';

/**
 * The public landing page (launch stage M3). What is pinned here is not the
 * layout but the claims: `/` renders OUTSIDE every wall and shell, the price
 * is the full VAT-exclusive phrase and never a bare figure, and the four
 * legal pages are linked where the Companies (Trading Disclosures)
 * Regulations expect the company identity to live. A copy edit that breaks
 * one of these is a legal or D42 problem, not a design choice.
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

describe('the landing page at /', () => {
  it('renders the public page, not the workspace shell and not a login wall', async () => {
    const { unmount } = renderAt('/');

    // findBy*: the landing is a lazy chunk, and a microtask flush is not
    // enough for a dynamic import() to resolve.
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();

    // No practice shell: neither the rail's control nor the bottom bar.
    expect(screen.queryByRole('button', { name: 'Expand navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();

    unmount();
  });

  it('shows the price as the full phrase, never a bare figure', async () => {
    const { unmount } = renderAt('/');

    // The exact rendering rule: prices are stored exclusive of VAT, so the
    // figure never appears without "+ VAT" beside it.
    expect(await screen.findByText('£8.50 + VAT per month')).toBeInTheDocument();
    expect(screen.getByText('per client business')).toBeInTheDocument();

    unmount();
  });

  it('links the four legal pages from the footer', async () => {
    const { unmount } = renderAt('/');
    await screen.findByRole('heading', { level: 1 });

    const links = [
      ['Terms of Service', '/legal/terms-of-service'],
      ['Privacy Notice', '/legal/privacy-notice'],
      ['Data Processing Terms', '/legal/data-processing-terms'],
      ['Refunds and Cancellation', '/legal/refund-and-cancellation'],
    ] as const;
    for (const [name, href] of links) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    }

    unmount();
  });

  it('sends sign-in to /app, where the workspace now lives', async () => {
    const { unmount } = renderAt('/');
    await screen.findByRole('heading', { level: 1 });

    // Header "Sign in" and the hero CTA both carry real addresses — a
    // cmd-click must open the app in a new tab, which is what linkProps is
    // for.
    for (const link of screen.getAllByRole('link', { name: /sign in/i })) {
      expect(link).toHaveAttribute('href', '/app');
    }

    unmount();
  });

  it('says what the product does not do, in as many words', async () => {
    const { unmount } = renderAt('/');

    // D42's most public surface: the pricing page must not imply a ledger
    // write, a bank connection, a Xero sync or an HMRC filing.
    expect(await screen.findByText('It does not post to a ledger')).toBeInTheDocument();
    expect(screen.getByText('It does not connect to your bank')).toBeInTheDocument();
    expect(screen.getByText('It does not sync with Xero or any accounting software')).toBeInTheDocument();
    expect(screen.getByText('It does not file with HMRC')).toBeInTheDocument();

    unmount();
  });
});
