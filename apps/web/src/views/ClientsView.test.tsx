import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';

import { ClientsView } from './ClientsView';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import { createProposal } from '../api/proposals';
import type { ClientStats } from '../lib/selectors';

/**
 * The remove-client affordance (feat/client-offboard).
 *
 * The spine is what earns the file: clicking Remove only ever ASKS, Cancel and
 * Escape write nothing, Confirm creates a `business.offboard` proposal — never
 * a local deletion — and the dialog's copy says honestly that the client
 * leaves the list only after approval and that books are retained. Both
 * layouts carry the affordance: the card grid and the table's rows.
 */

vi.mock('../api/proposals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/proposals')>();
  return { ...actual, createProposal: vi.fn() };
});

const STATS: ClientStats = {
  missing: 0,
  requested: 0,
  overdue: 0,
  unmatched: 0,
  statementGaps: 0,
  toReview: 0,
  ready: 0,
  processing: 0,
  rejected: 0,
  published: 0,
  duplicates: 0,
  approvals: 0,
  unverified: 0,
  health: 92,
  itemDelay: 0,
};

const CLIENTS = [
  { id: 'biz_sparkle', name: 'Sparkle Cleaning Ltd', industry: 'Cleaning', health: 92, missingDocs: 0, toReview: 0, deadline: '7 Sep 2026', bankConnected: true },
  { id: 'biz_ananda', name: 'Ananda Group', industry: 'Hospitality', health: 88, missingDocs: 0, toReview: 0, deadline: '14 Sep 2026', bankConnected: true },
];

// The affordance is live-gated on the businesses slice; the seed test flips it.
let businessesSource: 'api' | 'seed' = 'api';
const setActiveTab = vi.fn();

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    clients: CLIENTS,
    statsFor: () => STATS,
    openClient: vi.fn(),
    starredClientIds: [],
    toggleStarClient: vi.fn(),
    startConversation: vi.fn(),
    slices: { businesses: { source: businessesSource, loading: false, error: null } },
    setActiveTab,
  }),
}));

beforeEach(() => {
  businessesSource = 'api';
  vi.mocked(createProposal).mockResolvedValue({
    id: 'prop_1',
    kind: 'business.offboard',
    state: 'CREATED',
    payloadHash: 'a'.repeat(64),
    createdAt: '2026-08-31T10:00:00.000Z',
  } as Awaited<ReturnType<typeof createProposal>>);
});

afterEach(() => vi.clearAllMocks());

function renderView() {
  return render(
    <AppIntlProvider>
      <ClientsView />
    </AppIntlProvider>,
  );
}

const removeButtons = () => screen.getAllByTitle('Remove client…');

async function confirmRemoval() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Yes, queue the removal' }));
  });
}

// ── the affordance ───────────────────────────────────────────────────────────

test('the remove affordance renders on every client card', () => {
  renderView();
  const buttons = removeButtons();
  expect(buttons).toHaveLength(CLIENTS.length);
  for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(false);
});

test('the table view carries the same affordance per row, opening the dialog for that row', () => {
  renderView();
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));

  // DataTable renders the table AND its narrow-container card twin (CSS picks
  // one), so the assertion is scoped to the table's own rows.
  const table = screen.getByRole('table');
  expect(within(table).getAllByTitle('Remove client…')).toHaveLength(CLIENTS.length);

  // The row is the unit, so the dialog must name the row's own client —
  // found through the row rather than by button order, which sorting can move.
  const row = within(table).getByText('Ananda Group').closest('tr');
  expect(row).not.toBeNull();
  fireEvent.click(within(row as HTMLTableRowElement).getByTitle('Remove client…'));

  expect(screen.getByRole('dialog', { name: 'Remove Ananda Group?' })).toBeTruthy();
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
});

// ── the confirmation ─────────────────────────────────────────────────────────

test('clicking Remove asks first — naming the client, the approval gate and the retained books', () => {
  renderView();
  fireEvent.click(removeButtons()[0]!);

  const dialog = screen.getByRole('dialog', { name: 'Remove Sparkle Cleaning Ltd?' });
  const text = dialog.textContent ?? '';
  // Honest about the spine: nothing changes until the proposal is approved…
  expect(text).toContain('disappears from this list only after it is approved');
  // …and nothing is destroyed either way.
  expect(text).toContain('Documents, books and the audit trail are retained — nothing is deleted.');
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
});

test('Cancel closes the dialog and nothing is created', () => {
  renderView();
  fireEvent.click(removeButtons()[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
});

test('Escape is Cancel — the keyboard path closes without creating anything', () => {
  renderView();
  fireEvent.click(removeButtons()[0]!);
  fireEvent.keyDown(document, { key: 'Escape' });

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
});

// ── the proposal ─────────────────────────────────────────────────────────────

test('Confirm creates a business.offboard proposal carrying the businessId and the typed reason', async () => {
  renderView();
  fireEvent.click(removeButtons()[0]!);
  fireEvent.change(screen.getByPlaceholderText('Client moved to another practice'), {
    target: { value: 'Client moved on' },
  });
  await confirmRemoval();

  expect(vi.mocked(createProposal)).toHaveBeenCalledWith({
    kind: 'business.offboard',
    businessId: 'biz_sparkle',
    payload: { businessId: 'biz_sparkle', reason: 'Client moved on' },
  });

  // The dialog is done; the notice says what actually happened (queued, not
  // removed) and points at the queue that decides it.
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain(
    'Removal queued — Sparkle Cleaning Ltd stays on this list until the proposal is approved.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review in Approvals' }));
  expect(setActiveTab).toHaveBeenCalledWith('Approvals');
});

test('an empty reason is an omitted key, never an assertion of ""', async () => {
  renderView();
  fireEvent.click(removeButtons()[1]!);
  await confirmRemoval();

  expect(vi.mocked(createProposal)).toHaveBeenCalledWith({
    kind: 'business.offboard',
    businessId: 'biz_ananda',
    payload: { businessId: 'biz_ananda' },
  });
});

test('a refusal is shown in the dialog with its NT- code, and the dialog stays open', async () => {
  vi.mocked(createProposal).mockRejectedValue(
    new NtProblemError({
      status: 404,
      code: 'NT-VAL-001',
      title: 'Validation failed',
      detail: 'No business with that id is reachable',
    }),
  );
  renderView();
  fireEvent.click(removeButtons()[0]!);
  await confirmRemoval();

  expect(screen.getByRole('alert').textContent).toBe('No business with that id is reachable (NT-VAL-001)');
  // Still open — the person decides whether to retry or cancel; and no
  // success notice claims something that did not happen.
  expect(screen.getByRole('dialog', { name: 'Remove Sparkle Cleaning Ltd?' })).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

// ── seed data ────────────────────────────────────────────────────────────────

test('on seed data the affordance is disabled with the reason — a removal is never faked locally', () => {
  businessesSource = 'seed';
  renderView();

  const buttons = screen.getAllByTitle(
    'Demo data — removing a client goes through Review → Approve, and this build is not talking to a server.',
  );
  expect(buttons).toHaveLength(CLIENTS.length);
  for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
});
