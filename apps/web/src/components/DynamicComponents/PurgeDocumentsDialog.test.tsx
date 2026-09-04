import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';
import type { ActionProposal, CreateActionProposalRequest } from '@neoting/contracts/model';

import PurgeDocumentsDialog from './PurgeDocumentsDialog';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { PURGE_BATCH_MAX } from '../../api/document-lifecycle';
import type { Document } from '../../lib/types';

/**
 * Permanent deletion is the one irreversible act on a document, and this file
 * pins the four things that make it safe rather than merely possible.
 *
 * 1. **Approve is ABSENT — not disabled — until `POST …/review` returns**, and
 *    then echoes the review's `renderedSummaryHash` verbatim. The server and a
 *    database trigger enforce the same rule, so this is the one of three
 *    implementations that could silently drift.
 * 2. **The request is the contract's `document.purge`**, one per client, with
 *    the reason on the payload — the only surviving explanation of why a
 *    document is gone once it stops existing.
 * 3. **The refusal is the SERVER's**, rendered with its `NT-` code and its own
 *    sentence. Nothing here decides what may be purged: the rule is
 *    published-or-exported, checked as rows server-side (D43), and a mirror of
 *    it written in the browser could disagree with the one enforced.
 * 4. **The 100 cap is stated before it is hit**, and honoured by splitting —
 *    `documentIds` is all-or-nothing, and the contract's own reason for that
 *    ("a partially purged batch cannot be re-run to completion, because the
 *    successful half no longer exists") is exactly why discovering the cap from
 *    a refusal is not acceptable.
 */

const createProposal = vi.fn();
const openReview = vi.fn();
const approveReviewed = vi.fn();

vi.mock('../../api/proposals', async (importOriginal) => ({
  // KIND_LABEL / KIND_NOTE stay REAL: the card's heading and its second line
  // are the contract's own words for `document.purge`, and a stub would let
  // this pass while the screen said something else.
  ...(await importOriginal<typeof import('../../api/proposals')>()),
  createProposal: (r: CreateActionProposalRequest) => createProposal(r),
  openReview: (id: string) => openReview(id),
  approveReviewed: (id: string, hash: string) => approveReviewed(id, hash),
}));

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({
    session: { status: 'authenticated', me: { role: 'PRACTICE_ADMIN' } },
    clientNameFor: (id: string) => (id === 'biz_nexora' ? 'Nexora Solutions LLC' : id),
    logAudit: vi.fn(),
  }),
}));

afterEach(() => vi.clearAllMocks());

function doc(over: Partial<Document> = {}): Document {
  return {
    id: 'doc_1',
    clientId: 'biz_nexora',
    clientName: 'Nexora Solutions LLC',
    supplier: 'Bidfood',
    date: '14 Aug 2026',
    total: 420,
    category: 'Food & drink',
    status: 'review',
    source: 'email',
    uploader: 'invoice.pdf',
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
      <PurgeDocumentsDialog selection={selection} onClose={vi.fn()} />
    </AppIntlProvider>,
  );
}

const proposal = {
  id: 'prop_purge_1',
  businessId: 'biz_nexora',
  kind: 'document.purge',
  state: 'CREATED',
  payload: {},
  payloadHash: 'a'.repeat(64),
  createdByUserId: 'usr_1',
  createdAt: '2026-09-02T09:00:00.000Z',
} as ActionProposal;

const review = {
  proposalId: 'prop_purge_1',
  title: 'Permanently delete 1 document',
  sections: [{ heading: 'Documents', entries: [{ label: 'Bidfood', value: '14 Aug 2026' }] }],
  warnings: [],
  renderedSummaryHash: 'f00dcafe'.repeat(8),
};

/* ── 1. the review gate ─────────────────────────────────────────────────── */

test('⚠ Approve is absent until Read review returns, and then echoes the review hash verbatim', async () => {
  createProposal.mockResolvedValue(proposal);
  openReview.mockResolvedValue(review);
  approveReviewed.mockResolvedValue(undefined);

  open([doc()]);

  // Before staging: no card, no Approve.
  expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
  expect(await screen.findByRole('button', { name: /Read review/ })).toBeTruthy();

  // ⚠ Staged is not reviewed. Approve is not in the DOM at all.
  expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  expect(approveReviewed).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /Read review/ }));
  const approve = await screen.findByRole('button', { name: /^Approve/ });
  // The server's own rendered review is what is on screen, not a local summary.
  expect(document.body.textContent).toContain('Permanently delete 1 document');

  fireEvent.click(approve);
  expect(approveReviewed).toHaveBeenCalledWith('prop_purge_1', review.renderedSummaryHash);
});

/* ── 2. the request ─────────────────────────────────────────────────────── */

test('the request is a `document.purge` naming one client, with the typed reason on the payload', async () => {
  createProposal.mockResolvedValue(proposal);
  open([doc(), doc({ id: 'doc_2', supplier: 'Currys' })]);

  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Duplicate scans  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
  await screen.findByRole('button', { name: /Read review/ });

  expect(createProposal).toHaveBeenCalledWith({
    kind: 'document.purge',
    businessId: 'biz_nexora',
    payload: { documentIds: ['doc_1', 'doc_2'], reason: 'Duplicate scans' },
  });
});

test('an untouched reason is an OMITTED key, never an empty string filed on the audit record', async () => {
  createProposal.mockResolvedValue(proposal);
  open([doc()]);

  fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
  await screen.findByRole('button', { name: /Read review/ });

  expect(createProposal).toHaveBeenCalledWith({
    kind: 'document.purge',
    businessId: 'biz_nexora',
    payload: { documentIds: ['doc_1'] },
  });
});

/* ── 3. the refusal is the server's ─────────────────────────────────────── */

test('a refused purge shows the server’s own sentence WITH its NT- code, and stages nothing', async () => {
  createProposal.mockRejectedValue(
    new NtProblemError({
      title: 'Cannot purge an exported document',
      status: 409,
      code: 'NT-DOC-002',
      detail: 'Bidfood was exported on 1 August 2026; purging it would break the link in that VT file.',
    }),
  );

  open([doc()]);
  fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));

  const text = await screen.findByText(/NT-DOC-002/);
  expect(text.textContent).toContain('Bidfood was exported on 1 August 2026');
  // No card came out of a refusal, so there is nothing to approve.
  expect(screen.queryByRole('button', { name: /Read review/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
});

/* ── 4. the cap, stated before it is hit ────────────────────────────────── */

test('a selection past the contract cap is SPLIT and says so, rather than meeting a refusal', () => {
  const many = Array.from({ length: PURGE_BATCH_MAX + 5 }, (_, i) => doc({ id: `doc_${i}` }));
  open(many);

  const text = document.body.textContent ?? '';
  expect(text).toContain(`A permanent deletion carries at most ${PURGE_BATCH_MAX} documents`);
  expect(text).toContain('split into 2 requests');
  expect(text).toContain('Request 1 of 2');
});

/* ── 5. the empty state teaches the next action ─────────────────────────── */

test('nothing selected is a state that teaches, not a dead dialog', () => {
  open([]);
  expect(screen.getByRole('heading', { name: 'Nothing selected to delete' })).toBeTruthy();
  expect(document.body.textContent).toContain('Tick the documents you want removed for good');
  expect(screen.queryByRole('button', { name: 'Stage for review' })).toBeNull();
});
