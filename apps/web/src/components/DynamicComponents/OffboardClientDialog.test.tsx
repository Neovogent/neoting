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

afterEach(() => vi.clearAllMocks());

function renderDialog() {
  return render(
    <AppIntlProvider>
      <OffboardClientDialog client={CLIENT} onQueued={onQueued} onCancel={onCancel} />
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
  expect(text).toContain('disappears from the client list only after it is approved');
  // …and nothing is destroyed either way.
  expect(text).toContain('Documents, books and the audit trail are retained — nothing is deleted.');
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
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
    payload: { businessId: 'biz_sparkle', reason: 'Client moved on' },
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
    payload: { businessId: 'biz_sparkle' },
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
