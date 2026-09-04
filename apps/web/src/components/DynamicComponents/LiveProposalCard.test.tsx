import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionProposal } from '@neoting/contracts/model';

import { LiveProposalCard } from './LiveProposalCard';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { openReview } from '../../api/proposals';

/**
 * How a `business.offboard` proposal reads on the Approvals queue — the
 * kind→copy mapping (`KIND_LABEL` / `KIND_NOTE` in api/proposals), not a
 * bespoke card. The copy has to be truthful before Read review is even
 * opened: the client's name, the queued reason, and that books are retained.
 */

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({ logAudit: vi.fn() }),
}));

vi.mock('../../api/proposals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/proposals')>();
  return { ...actual, openReview: vi.fn() };
});

afterEach(() => vi.clearAllMocks());

function proposal(over: Partial<ActionProposal> = {}): ActionProposal {
  return {
    id: 'prop_off_1',
    businessId: 'biz_sparkle',
    kind: 'business.offboard',
    state: 'CREATED',
    payload: { businessId: 'biz_sparkle', reason: 'Client moved to another practice' },
    payloadHash: 'a'.repeat(64),
    createdByUserId: 'usr_1',
    createdAt: '2026-08-31T10:00:00.000Z',
    ...over,
  } as ActionProposal;
}

function renderCard(p: ActionProposal, clientName: string | null = 'Sparkle Cleaning Ltd') {
  return render(
    <AppIntlProvider>
      <LiveProposalCard proposal={p} clientName={clientName} />
    </AppIntlProvider>,
  );
}

test('a business.offboard proposal renders its label, the client, the reason and the retained-books note', () => {
  renderCard(proposal());

  expect(screen.getByRole('heading', { name: 'Remove a client' })).toBeTruthy();
  const text = document.body.textContent ?? '';
  expect(text).toContain('Sparkle Cleaning Ltd');
  expect(text).toContain('Reason given: “Client moved to another practice”');
  // What approving does — and what it deliberately does not.
  expect(text).toContain('the client leaves the client list and every working surface');
  expect(text).toContain('Documents, books and the audit trail are retained — nothing is deleted.');
});

test('a proposal with no reason renders the note alone, never an empty quotation', () => {
  renderCard(proposal({ payload: { businessId: 'biz_sparkle' } }));

  const text = document.body.textContent ?? '';
  expect(text).not.toContain('Reason given');
  expect(text).toContain('Documents, books and the audit trail are retained — nothing is deleted.');
});

test('other kinds carry neither the offboard note nor a reason line', () => {
  renderCard(
    proposal({
      kind: 'chase.send',
      payload: { messages: [] },
    }),
    'Ananda Group',
  );

  const text = document.body.textContent ?? '';
  expect(screen.getByRole('heading', { name: 'Send chase email' })).toBeTruthy();
  expect(text).not.toContain('Reason given');
  expect(text).not.toContain('retained');
});

// ── the bookkeeping entry, on the release review ────────────────────────────

/**
 * *"Before publishing show the accountant the actual accounting entry that will
 * be put into the VT software."*
 *
 * The card is not where that is built — the review is **server-rendered**, and
 * this component renders exactly the sections the server sent and withholds
 * Approve if it cannot render one. So what these tests pin is the two halves
 * this side owns: the entry reaches the screen verbatim, and **Approve is still
 * unreachable until Read review has been opened**. The preview is part of the
 * review, never a substitute for it.
 */
const RELEASE_REVIEW = {
  proposalId: 'prop_rel_1',
  title: 'Release 1 document for export — gross $54352.51, VAT $0.00',
  renderedSummaryHash: 'b'.repeat(64),
  warnings: [],
  sections: [
    {
      heading: 'Server-computed preview',
      entries: [
        { label: 'Items', value: '1' },
        { label: 'Gross', value: '$54352.51' },
        { label: 'Currency', value: 'USD' },
      ],
    },
    {
      heading: 'The accounting entry this release will put in the import file',
      entries: [
        { label: 'Import file', value: 'VT Transaction+ — Transaction ▸ Journal ▸ Import…' },
        { label: 'Lines the file will carry', value: '1' },
        {
          label: 'What approving does',
          value:
            'Releases these documents for export. The file is produced when you download it on the Export screen, and you import it yourself — nothing here reaches accounting software.',
        },
      ],
    },
    {
      heading: 'Entry 1 — Nexora Solutions LLC',
      entries: [
        { label: 'Document', value: 'doc_1' },
        { label: 'Lands in', value: '2025-05-12-purchase-invoices.csv — data format "Payments list/purchase invoices list"' },
        { label: "Bank account name/supplier's name", value: 'Nexora Solutions LLC' },
        { label: 'Gross amount', value: '54352.51' },
        { label: 'Analysis account name', value: 'SUBSCRIPTIONS' },
        {
          label: 'Check before you import — analysis-account-unprefixed',
          value: 'The analysis account "SUBSCRIPTIONS" has no ledger prefix.',
        },
      ],
    },
  ],
};

function releaseProposal(): ActionProposal {
  return proposal({
    id: 'prop_rel_1',
    kind: 'publish.batch',
    payload: { documentIds: ['doc_1'], preview: { itemCount: 1, grossPence: 5_435_251, vatPence: 0, currency: 'USD' } },
  });
}

test('⚠ Approve is unreachable until Read review has been opened — the entry does not replace the gate', () => {
  renderCard(releaseProposal(), 'Neovogent');

  expect(screen.getByRole('button', { name: 'Read review' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  // And the entry is not on screen before the review that carries it.
  expect(document.body.textContent).not.toContain('Nexora Solutions LLC');
});

test('the opened review shows the bookkeeping entry the import file will contain, verbatim', async () => {
  vi.mocked(openReview).mockResolvedValue(RELEASE_REVIEW);
  renderCard(releaseProposal(), 'Neovogent');

  fireEvent.click(screen.getByRole('button', { name: 'Read review' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());

  const text = document.body.textContent ?? '';
  // The emitter's own column names and its own cells, unchanged on the way
  // through — including the money rendering, which is what the file carries.
  expect(text).toContain("Bank account name/supplier's name");
  expect(text).toContain('Nexora Solutions LLC');
  expect(text).toContain('54352.51');
  expect(text).toContain('2025-05-12-purchase-invoices.csv');
  // The emitter's warning for this document reaches the human BEFORE approval.
  expect(text).toContain('has no ledger prefix');
});

test('⚠ D42: the release review never implies anything reaches accounting software', async () => {
  vi.mocked(openReview).mockResolvedValue(RELEASE_REVIEW);
  renderCard(releaseProposal(), 'Neovogent');

  fireEvent.click(screen.getByRole('button', { name: 'Read review' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());

  // Read off the DOM, the ExportView.test.tsx way: the copy is server-rendered,
  // so this is the assertion that catches a server-side wording change too.
  const text = document.body.textContent ?? '';
  for (const forbidden of [
    /send(ing)? to VT/i,
    /sent to VT/i,
    /publish(ing|ed)? to/i,
    /\bsync(ed|ing)?\b/i,
    /\bposted to\b/i,
    /\bXero\b/i,
    /\bQuickBooks\b/i,
    /connect(ed|ion)? to VT/i,
  ]) {
    expect(text).not.toMatch(forbidden);
  }
  expect(text).toContain('Releases these documents for export');
});
