import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

// ⚠ `isOwner` defaults TRUE since review items 24/66: `document.update-coding`
// is TIER 1, so a session without it STAGES rather than applies, and every
// pre-existing case here is about the apply path. The stage path flips it.
let isOwner = true;
const updateDocumentField = vi.fn();

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({
    updateDocumentField,
    logAudit: vi.fn(),
    session: { status: 'authenticated', me: { user: { id: 'usr_me' }, role: 'PRACTICE_ADMIN', isOwner } },
  }),
}));

const updateCodingProposal = vi.fn(async (_request: unknown, _options?: unknown) => ({ released: true }));

vi.mock('../../api/document-detail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/document-detail')>();
  return {
    ...actual,
    updateCodingProposal: (request: unknown, options?: unknown) => updateCodingProposal(request as never, options),
    refreshDocument: vi.fn(async () => {}),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  // One case flips it; the default is the release-holder.
  isOwner = true;
});

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

test('the correction applies on open — there is no gate left to press', () => {
  // ⚠ TIER 2 since 9 Sep 2026. The owner, third time of asking: "No approval
  // will be required for anything, except for when the document is going for
  // publishing." `document.update-coding` left the release tier with that
  // ruling, so a Read review → Approve dialog here would be asking the same
  // person to agree with themselves.
  renderModal();

  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Update coding')).toBeTruthy();

  // The three server calls still run in order behind the one click that opened
  // this card — created, reviewed with its hash recorded, approved echoing it.
  // What is gone is the WAIT, not the record.
  expect(updateCodingProposal).toHaveBeenCalledWith(expect.anything(), { canRelease: true });

  // And no ceremony is left on screen pretending a second signature is owed.
  expect(within(dialog).queryByRole('button', { name: /Read review/ })).toBeNull();
  expect(within(dialog).queryByRole('button', { name: /Approve change/ })).toBeNull();
  expect(within(dialog).queryByRole('button', { name: /Send for approval/ })).toBeNull();
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
 * The class contract on the frame: a bounded card with its own scroll box,
 * whose children may not flex-shrink. jsdom computes no layout, so this can
 * only pin the CLASSES — it proved twice (review items 23+40) that it cannot
 * prove the mechanism: with every class below present, dialog cards carrying
 * `overflow-hidden` were silently SHRUNK to fit the scroll box (flexbox zeroes
 * the automatic minimum size of a non-visible-overflow item) and clipped their
 * own tails. `[&>*]:shrink-0` is the fix; the guard that runs real layout is
 * `scripts/measure/modal-reachability.mjs`, and this test is only the tripwire
 * for someone deleting a class.
 */
test('the frame bounds the card to the viewport and gives it a real scroll box', () => {
  renderModal();

  const dialog = screen.getByRole('dialog');
  expect(dialog.className).toContain('max-h-full');

  const scroller = dialog.querySelector('.overflow-y-auto');
  expect(scroller).not.toBeNull();
  // Without this, a card with `overflow-hidden` (the rounded-corner idiom)
  // shrinks to fit instead of overflowing, and the scroll box has nothing to
  // scroll — the items 23+40 defect.
  expect(scroller?.className).toContain('[&>*]:shrink-0');
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

/* ── 9 Sep 2026: coding no longer waits for the super admin ─────────────── */

test('a member who is not the super admin applies the correction too', () => {
  // ⚠ This REPLACES the stage-and-stop behaviour of items 24 + 66. Coding was
  // tier 1 between 6 and 9 Sep, so a member staged and the firm's principal
  // released. The owner has now taken coding out of the release tier, and the
  // reason he gave for chases applies here twice over: the person correcting a
  // category IS the bookkeeper, and making every category tap wait for the
  // principal made the principal the bottleneck.
  isOwner = false;

  renderModal();

  expect(updateCodingProposal).toHaveBeenCalledWith(expect.anything(), { canRelease: true });
  // The value is painted immediately, because it really does apply now.
  expect(updateDocumentField).toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Send for approval' })).toBeNull();
  expect(document.body.textContent).not.toContain('released by your practice’s super admin');
});

/* ── item 20: the dialog dismisses itself after the confirmation ─────────── */

test('the dialog shows the confirmation and then closes itself, backdrop and all', async () => {
  // > After changing the category of an invoice manually the modal backdrop
  // > with the blend balk screen must disappear after showing the confirmation
  //
  // The reported defect: the green banner appeared and the document stayed
  // behind a dark scrim the user had to dismiss by hand.
  vi.useFakeTimers();
  try {
    const { onClose } = renderModal();

    // The confirmation is READ first — it is on screen and the dialog is still
    // open. A dialog that vanishes on the click is the mirror-image defect.
    expect(document.body.textContent).toContain('Applying');
    expect(onClose).not.toHaveBeenCalled();

    // Let the server call settle, then let the dwell elapse.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('⚠ a REFUSED correction keeps the dialog open — the red alert is the only place it is said', async () => {
  // The dismissal fires on the SERVER SETTLE, never on mount, precisely because
  // the card paints its confirmation optimistically and a refusal a moment
  // later swaps it to `failedOnCard`. Closing early would throw away the one
  // screen telling somebody their correction was not saved.
  updateCodingProposal.mockRejectedValueOnce(new Error('NT-PRP-006 — that category is not on the chart'));
  vi.useFakeTimers();
  try {
    const { onClose } = renderModal();

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('That correction was NOT saved');
  } finally {
    vi.useRealTimers();
  }
});
