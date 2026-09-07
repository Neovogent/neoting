import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';

import { OffboardClientDialog } from './OffboardClientDialog';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { createProposal } from '../../api/proposals';

/**
 * The "ask first" a client removal is behind. The spine is what earns the
 * file: Cancel and Escape write nothing, Confirm creates a `business.offboard`
 * proposal — never a local deletion — and the copy says honestly that the
 * client leaves only after approval and that books are retained.
 */

vi.mock('../../api/proposals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/proposals')>();
  return { ...actual, createProposal: vi.fn() };
});

/**
 * The dialog reads `session` since review items 24/66 — `business.offboard` is
 * TIER 1, so the copy names who releases. `isOwner` is a `let` so one case can
 * flip it; the default is the owner, which keeps every pre-existing case
 * meaning what it meant.
 */
let isOwner = true;
vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({
    session: { status: 'authenticated', me: { user: { id: 'usr_me' }, role: 'PRACTICE_ADMIN', isOwner } },
  }),
}));

const CLIENT = { id: 'biz_sparkle', name: 'Sparkle Cleaning Ltd' };
const onQueued = vi.fn();
const onCancel = vi.fn();

beforeEach(() => {
  vi.mocked(createProposal).mockResolvedValue({
    id: 'prop_1',
    kind: 'business.offboard',
    state: 'CREATED',
    payloadHash: 'a'.repeat(64),
    createdAt: '2026-08-31T10:00:00.000Z',
  } as Awaited<ReturnType<typeof createProposal>>);
});

afterEach(() => {
  vi.clearAllMocks();
  // One case flips it; the default is the owner.
  isOwner = true;
});

function renderDialog(documentCount = 3) {
  return render(
    <AppIntlProvider>
      <OffboardClientDialog
        client={CLIENT}
        documentCount={documentCount}
        onQueued={onQueued}
        onCancel={onCancel}
      />
    </AppIntlProvider>,
  );
}

async function confirmRemoval() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Yes, queue the removal' }));
  });
}

test('the dialog names the client, the approval gate and the retained books', () => {
  renderDialog();

  const dialog = screen.getByRole('dialog', { name: 'Remove Sparkle Cleaning Ltd?' });
  const text = dialog.textContent ?? '';
  // Honest about the spine: nothing changes until the proposal is approved…
  expect(text).toContain('once you have read that review and approved it');
  // …and nothing is destroyed either way.
  expect(text).toContain('Documents, books and the audit trail are retained — nothing is deleted.');
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
});

test('a member who cannot release is told WHO does, and that the client stays until then', () => {
  // Items 24 + 66. `business.offboard` is tier 1 now, so "after it is approved"
  // left a standard user thinking their confirm was the decision. Both branches
  // name the authority; neither claims one — the server is still the rule.
  isOwner = false;
  renderDialog();

  const text = screen.getByRole('dialog', { name: 'Remove Sparkle Cleaning Ltd?' }).textContent ?? '';
  expect(text).toContain('queues a removal proposal for your practice’s super admin');
  expect(text).toContain('stays on the client list until they approve it');
  // And it does not tell them they can do it.
  expect(text).not.toContain('once you have read that review and approved it');
});

test('Cancel closes without creating anything', () => {
  renderDialog();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
  expect(onQueued).not.toHaveBeenCalled();
});

test('Escape is Cancel — the keyboard path writes nothing', () => {
  renderDialog();
  fireEvent.keyDown(document, { key: 'Escape' });

  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
});

test('Confirm creates a business.offboard proposal carrying the businessId and the typed reason', async () => {
  renderDialog();
  fireEvent.change(screen.getByPlaceholderText('Client moved to another practice'), {
    target: { value: 'Client moved on' },
  });
  await confirmRemoval();

  expect(vi.mocked(createProposal)).toHaveBeenCalledWith({
    kind: 'business.offboard',
    businessId: 'biz_sparkle',
    payload: { businessId: 'biz_sparkle', documentScope: 'keep', reason: 'Client moved on' },
  });
  // Queued is the ONLY claim the dialog makes — deciding is the queue's move.
  expect(onQueued).toHaveBeenCalledTimes(1);
});

test('an empty reason is an omitted key, never an assertion of ""', async () => {
  renderDialog();
  await confirmRemoval();

  expect(vi.mocked(createProposal)).toHaveBeenCalledWith({
    kind: 'business.offboard',
    businessId: 'biz_sparkle',
    payload: { businessId: 'biz_sparkle', documentScope: 'keep' },
  });
});

test('a refusal is shown with its NT- code, and the dialog stays open', async () => {
  vi.mocked(createProposal).mockRejectedValue(
    new NtProblemError({
      status: 404,
      code: 'NT-VAL-001',
      title: 'Validation failed',
      detail: 'No business with that id is reachable',
    }),
  );
  renderDialog();
  await confirmRemoval();

  expect(screen.getByRole('alert').textContent).toBe('No business with that id is reachable (NT-VAL-001)');
  // Still open — the person decides whether to retry or cancel, and nothing
  // claims a queuing that did not happen.
  expect(screen.getByRole('dialog', { name: 'Remove Sparkle Cleaning Ltd?' })).toBeTruthy();
  expect(onQueued).not.toHaveBeenCalled();
});

/* ── The deletion scope (review item 67) ──────────────────────────────────── */

test('the three scopes are offered, safest first, and none of them says "delete"', () => {
  renderDialog(4);

  expect(screen.getByRole('radio', { name: /Keep everything/ })).toBeTruthy();
  expect(screen.getByRole('radio', { name: /Move their documents to Trash/ })).toBeTruthy();
  expect(screen.getByRole('radio', { name: /Mark for erasure/ })).toBeTruthy();

  // Every scope is reversible, so no label may promise destruction. The one
  // "deleted" in the dialog is the existing retained-books sentence saying
  // nothing IS deleted, which is the opposite claim.
  const scopes = screen.getByRole('group').textContent ?? '';
  expect(scopes).not.toMatch(/delete/i);
  expect(scopes).not.toMatch(/permanent/i);
});

test('⚠ mark-for-erasure says MARKED, never scheduled — there is no automatic date', () => {
  renderDialog();
  const scopes = screen.getByRole('group').textContent ?? '';

  expect(scopes).toContain('Nothing is erased and nothing is scheduled');
  // The owner ruled "erasure on request, no automatic date" (7 Sep 2026): any
  // window shorter than D12's six years would be this product deleting a UK
  // practice's statutory records on a timer.
  expect(scopes).not.toMatch(/erased (in|after) \d/i);
});

test('the blast radius is stated before anything is queued', () => {
  renderDialog(12);
  expect(document.body.textContent).toContain('This client has 12 documents.');
  expect(document.body.textContent).toContain('12 documents move to Trash');
  // ⚠ The sequencing, found by the 7 Sep walkthrough: a removed client's own
  // screens do not render, so its Trash comes back with the client. The dialog
  // must not imply the documents are one click away while the client is gone.
  expect(document.body.textContent).toContain('Restore the client and each one is restorable from their Trash');
});

test('the chosen scope rides the proposal payload', async () => {
  renderDialog(2);
  fireEvent.click(screen.getByRole('radio', { name: /Move their documents to Trash/ }));
  await confirmRemoval();

  expect(vi.mocked(createProposal)).toHaveBeenCalledWith({
    kind: 'business.offboard',
    businessId: 'biz_sparkle',
    payload: { businessId: 'biz_sparkle', documentScope: 'trash' },
  });
});
