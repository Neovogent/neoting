import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import CodingProposalModal from './CodingProposalModal';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { Document } from '../../lib/types';

/**
 * The correction dialog: the `Modal` frame around `CodingProposalCard`.
 *
 * Two of these are not render tests.
 *
 * · **Approve is ABSENT — not disabled — until Read review has been opened**,
 *   and nothing is created before it is pressed. This dialog is a presentation
 *   change around Review → Approve and must never become a shortcut past it;
 *   `PublishBatchDialog.test.tsx` pins the same rule on the live card, and the
 *   server plus a database trigger enforce it a third time.
 * · **The subtitle may not shout `UNKNOWN`.** `toLocalDocument` writes the
 *   placeholder `'Unknown'` for a row whose supplier extraction has not
 *   answered; uppercased by the review header it reached the product owner as
 *   `UNKNOWN · TYPE`, which says nothing true about the document.
 */

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({ updateDocumentField: vi.fn(), logAudit: vi.fn() }),
}));

const updateCodingProposal = vi.fn(async (_request: unknown) => {});

vi.mock('../../api/document-detail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/document-detail')>();
  return {
    ...actual,
    updateCodingProposal: (request: unknown) => updateCodingProposal(request as never),
    refreshDocument: vi.fn(async () => {}),
  };
});

afterEach(() => vi.clearAllMocks());

const doc: Document = {
  id: 'doc_f404e752a4fbb629b203dc04',
  clientId: 'biz_burger',
  clientName: 'American Burger',
  supplier: 'Nexora Solutions LLC',
  date: '12 May 2025',
  total: 54352.51,
  category: '—',
  status: 'review',
  source: 'web',
  uploader: 'invoice.png',
  currency: 'GBP',
  kind: 'cost',
  fields: [],
  lineItems: [],
};

function renderModal(over: Partial<Document> = {}, onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AppIntlProvider>
        <CodingProposalModal
          document={{ ...doc, ...over }}
          fieldLabel="Type"
          currentValue="—"
          nextValue="Invoice"
          fields={{ docType: 'INVOICE' }}
          onClose={onClose}
        />
      </AppIntlProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

test('Approve is absent from the DOM until Read review is opened, and nothing is created before it is pressed', () => {
  renderModal();

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Update coding')).toBeTruthy();

  // Not merely disabled — not mounted. There is no Approve to press.
  expect(within(dialog).queryByRole('button', { name: /Approve change/ })).toBeNull();
  expect(updateCodingProposal).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole('button', { name: /Read review/ }));

  expect(within(dialog).getByRole('button', { name: /Approve change/ })).toBeTruthy();
  // Opening the review still creates nothing: the proposal is minted by the
  // Approve click and by nothing else, so closing undecided leaves no record.
  expect(updateCodingProposal).not.toHaveBeenCalled();
});

test('a document whose supplier has not been read says so, and never the literal word Unknown', () => {
  renderModal({ supplier: 'Unknown' });

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('No supplier read · Type')).toBeTruthy();
  // The word itself, in any casing — the header uppercases with CSS, so the
  // rendered text node is what the accountant reads.
  expect(dialog.textContent).not.toMatch(/unknown/i);
});

test('the sales inbox reads a customer, not a supplier', () => {
  renderModal({ supplier: 'Unknown', kind: 'sales' });

  expect(within(screen.getByRole('dialog')).getByText('No customer read · Type')).toBeTruthy();
});

test('an empty or em-dash party is the same silence and gets the same sentence', () => {
  renderModal({ supplier: '   ' });

  expect(within(screen.getByRole('dialog')).getByText('No supplier read · Type')).toBeTruthy();
});

test('a real supplier is still named', () => {
  renderModal();

  expect(within(screen.getByRole('dialog')).getByText('Nexora Solutions LLC · Type')).toBeTruthy();
});

/**
 * jsdom computes no layout, so the only mechanical guard the clipping fix has
 * is the class contract on the frame itself: a bounded card with its own
 * scroll box. Without both, a dialog taller than the window runs off the bottom
 * edge — which is what was reported, with the last Path-to-Ready action button
 * cut off and unreachable.
 */
test('the frame bounds the card to the viewport and gives it a real scroll box', () => {
  renderModal();

  const dialog = screen.getByRole('dialog');
  expect(dialog.className).toContain('max-h-full');

  const scroller = dialog.querySelector('.overflow-y-auto');
  expect(scroller).not.toBeNull();
  // The close button is a SIBLING of the scroll box, so it neither scrolls
  // away nor gets clipped by it.
  expect(scroller?.contains(screen.getByRole('button', { name: 'Close' }))).toBe(false);
});

test('the scrim carries the dismiss click as presentation, and the dialog role sits on the card', () => {
  const { onClose } = renderModal();

  const scrim = screen.getByRole('presentation');
  expect(scrim.contains(screen.getByRole('dialog'))).toBe(true);

  fireEvent.click(scrim);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape closes the dialog through the useEscape stack', () => {
  const { onClose } = renderModal();

  // The stack listens on `document`, deliberately — see `lib/useEscape.ts`.
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});
