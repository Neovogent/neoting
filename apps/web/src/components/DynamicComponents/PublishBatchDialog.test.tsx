import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ActionProposal, CreateActionProposalRequest } from '@neoting/contracts/model';

import PublishBatchDialog from './PublishBatchDialog';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { Document } from '../../lib/types';

/**
 * The two rules that make a publish action safe rather than merely present.
 *
 * The user report this file answers was *"there is no option to publish it, if
 * not published then there is no option to export it"* — Published is the gate
 * to Export, so an unreachable publish makes the VT import file unreachable.
 * The fix is a real door, and a real door has to refuse honestly and must not
 * let anyone past the review gate:
 *
 * 1. **A selection with nothing Ready is refused**, counting the Published
 *    (already released) apart from the not-yet-Ready and NAMING both — the
 *    wording mirroring `shell.inboxTable.nothingToPublish*`, because the same
 *    refusal met on two surfaces must read the same.
 * 2. **Approve cannot precede Read review.** The button is not merely disabled
 *    before the server's review arrives; it is not in the DOM. Approve then
 *    echoes the review's `renderedSummaryHash` VERBATIM — the server and a DB
 *    trigger enforce this too, so this test pins the UI half of a rule that has
 *    three implementations and must not disagree with itself.
 *
 * Plus the two compliance guards no type can hold: D42 vocabulary (a copy
 * test, the `ExportView.test.tsx` shape) and D44's honest degradation.
 */

const createProposal = vi.fn();
const openReview = vi.fn();
const approveReviewed = vi.fn();

vi.mock('../../api/proposals', async (importOriginal) => ({
  // KIND_LABEL / KIND_NOTE stay REAL: the card's heading is the contract's own
  // label for `publish.batch`, and a stubbed one would let this pass while the
  // screen said something else.
  ...(await importOriginal<typeof import('../../api/proposals')>()),
  createProposal: (r: CreateActionProposalRequest) => createProposal(r),
  openReview: (id: string) => openReview(id),
  approveReviewed: (id: string, hash: string) => approveReviewed(id, hash),
}));

let role = 'PRACTICE_ADMIN';
const setActiveTab = vi.fn();

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({
    session: { status: 'authenticated', me: { role } },
    clientNameFor: (id: string) => (id === 'biz_nexora' ? 'Nexora Solutions LLC' : id),
    setActiveTab,
    logAudit: vi.fn(),
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
  role = 'PRACTICE_ADMIN';
});

function doc(over: Partial<Document> = {}): Document {
  return {
    id: 'doc_1',
    clientId: 'biz_nexora',
    clientName: 'Nexora Solutions LLC',
    supplier: 'Bidfood',
    date: '2026-08-14',
    total: 420,
    category: 'Food & drink',
    status: 'ready',
    source: 'email',
    uploader: 'accounts@nexora.example',
    currency: 'GBP',
    kind: 'cost',
    fields: [],
    lineItems: [],
    ...over,
  };
}

function open(selection: Document[]) {
  return render(
    <AppIntlProvider>
      <PublishBatchDialog selection={selection} onClose={vi.fn()} />
    </AppIntlProvider>,
  );
}

const proposal = {
  id: 'prop_pub_1',
  businessId: 'biz_nexora',
  kind: 'publish.batch',
  state: 'CREATED',
  payload: {},
  payloadHash: 'a'.repeat(64),
  createdByUserId: 'usr_1',
  createdAt: '2026-09-02T09:00:00.000Z',
} as ActionProposal;

const review = {
  proposalId: 'prop_pub_1',
  title: 'Release 1 item for export',
  sections: [{ heading: 'Batch', entries: [{ label: 'Items', value: '1' }, { label: 'Gross', value: '£420.00' }] }],
  warnings: [],
  renderedSummaryHash: 'f00dcafe'.repeat(8),
};

/* ── 1. the refusal ─────────────────────────────────────────────────────── */

test('a selection with nothing Ready is refused, counting Published apart from not-yet-Ready and naming both', () => {
  open([
    doc({ id: 'd_pub', supplier: 'Currys', status: 'published' }),
    doc({ id: 'd_rev', supplier: 'Bidfood', status: 'review' }),
    doc({ id: 'd_proc', supplier: 'Amazon', status: 'processing' }),
  ]);

  const text = document.body.textContent ?? '';
  expect(screen.getByRole('heading', { name: 'Nothing selected can publish' })).toBeTruthy();
  // Counted by state — an already-released document is not a candidate, and
  // saying so is the difference between a refusal and a shrug.
  expect(text).toContain('1 is already Published — approved and released for export.');
  expect(text).toContain('2 must reach Ready before they can publish.');
  // And named, so the accountant knows WHICH rows they are.
  expect(text).toContain('Already Published: Currys');
  expect(text).toContain('Not Ready yet: Bidfood, Amazon');

  // Nothing can be staged out of a refusal.
  expect(screen.queryByRole('button', { name: 'Stage for review' })).toBeNull();
  expect(createProposal).not.toHaveBeenCalled();
});

/* ── 2. the review gate ─────────────────────────────────────────────────── */

test('Approve is absent until Read review returns, and then echoes the review hash verbatim', async () => {
  createProposal.mockResolvedValue(proposal);
  openReview.mockResolvedValue(review);
  approveReviewed.mockResolvedValue(undefined);

  open([doc()]);

  // Before staging: no card, no Approve.
  expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
  expect(await screen.findByRole('button', { name: /Read review/ })).toBeTruthy();

  // The proposal the server was asked for: the contract's kind, this client,
  // and the selected document. The preview is a placeholder the engine
  // discards — the figures a human approves are recomputed server-side.
  expect(createProposal).toHaveBeenCalledWith({
    kind: 'publish.batch',
    businessId: 'biz_nexora',
    payload: { documentIds: ['doc_1'], integrationId: null, preview: { itemCount: 1, grossPence: 0, vatPence: 0 } },
  });

  // ⚠ The gate: staged is not reviewed. Approve is not in the DOM at all.
  expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  expect(approveReviewed).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /Read review/ }));
  const approve = await screen.findByRole('button', { name: /^Approve/ });
  // The server's own rendered review is what is on screen, not a local summary.
  expect(document.body.textContent).toContain('£420.00');

  fireEvent.click(approve);
  expect(approveReviewed).toHaveBeenCalledWith('prop_pub_1', review.renderedSummaryHash);
});

/* ── 3. D42 vocabulary ──────────────────────────────────────────────────── */

test('no copy on the staging surface claims a ledger was written to', async () => {
  createProposal.mockResolvedValue(proposal);
  open([doc()]);

  fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
  await screen.findByRole('button', { name: /Read review/ });

  const text = document.body.textContent ?? '';
  for (const forbidden of [/posted/i, /synced/i, /sync\b/i, /sent to VT/i, /publish to VT/i, /Xero/i, /QuickBooks/i]) {
    expect(text).not.toMatch(forbidden);
  }
  // And the one claim it IS allowed to make, in the sanctioned words.
  expect(text).toContain('approved and released for export');
});

/* ── 4. D44, two authorities ────────────────────────────────────────────── */

test('a role that cannot release is told who can, and is NOT denied the staging action', () => {
  role = 'PRACTICE_STANDARD';
  open([doc()]);

  expect(document.body.textContent).toContain('Your role does not release.');
  // Degrade honestly, never hide: composing and staging is every member's, and
  // the server — not this screen — refuses the approval.
  expect(screen.getByRole('button', { name: 'Stage for review' })).toBeTruthy();
});

test('the release role is not told it lacks the permission it may well hold', () => {
  open([doc()]);

  const text = document.body.textContent ?? '';
  expect(text).not.toContain('Your role does not release.');
  // `/me` carries no `is_owner`, so the note names who releases and never
  // promises this session is them.
  expect(text).toContain('only your practice’s super admin can approve one');
});
