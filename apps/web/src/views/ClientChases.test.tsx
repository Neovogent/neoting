import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import ClientChases from './ClientChases';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import type { BankTransaction, Client } from '../lib/types';
import type { LiveChase } from '../api/chases';

/**
 * Review item 63: the client's Chases tab leads with the missing list. Pinned:
 *
 * - the missing rows are EXACTLY the `isUnexplained` set for this client —
 *   the one predicate (#255), never a re-derivation;
 * - a line inside an OPEN chase is marked "chased {date}, awaiting reply" and
 *   is NOT offered the chase button again;
 * - the chase affordance stages the REAL server-composed chase.send (item
 *   15's seam) and reports queued/failed above the table;
 * - a failed bank read says so instead of claiming nothing is missing;
 * - the sent-chases list shows this client's chases with honest state pills.
 */

const mocks = vi.hoisted(() => ({
  context: { value: {} as Record<string, unknown> },
  chases: { value: { chases: [] as LiveChase[], isLoading: false, error: null as unknown } },
  sendChaseNow: vi.fn(),
}));

vi.mock('../context/AppContext', () => ({ useAppContext: () => mocks.context.value }));
vi.mock('../api/chases', () => ({ useChases: () => mocks.chases.value }));
vi.mock('../api/proposals', () => ({ sendChaseNow: mocks.sendChaseNow }));

const row = (id: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
  id,
  clientId: 'biz_zeplow',
  clientName: 'Zeplow Inc.',
  description: `LINE ${id}`,
  date: '06 Aug 2026',
  amount: -99.5,
  isCredit: false,
  accountId: 'acc_1',
  matchState: 'UNMATCHED',
  chaseSuppressed: false,
  ...over,
});

const openChase = (id: string, txnIds: string[]): LiveChase => ({
  id,
  businessId: 'biz_zeplow',
  engine: 'UNMATCHED_TRANSACTION',
  state: 'SENT',
  open: true,
  items: txnIds.map((transactionId) => ({ transactionId, supplier: 'Currys', amount: 99.5, date: '06 Aug 2026', received: false })),
  messages: [],
  createdAt: '01 Sep 2026',
  lastSentAt: '2 Sep, 10:15',
  closedAt: null,
  closedReason: null,
  closedByDocumentId: null,
});

const client = { id: 'biz_zeplow', name: 'Zeplow Inc.' } as Client;

function renderTab(over: Record<string, unknown> = {}) {
  mocks.context.value = {
    transactions: [
      row('unexplained'),
      row('covered'),
      row('confirmed', { matchState: 'CONFIRMED', matchedDocId: 'doc_1' }),
      row('suppressed', { chaseSuppressed: true, description: 'STRIPE PAYOUT' }),
      row('other-client', { clientId: 'biz_other' }),
    ],
    slices: { bankTransactions: { source: 'api', loading: false, error: null } },
    isSameClient: (a: string, b: string) => a === b,
    ...over,
  };
  return render(
    <AppIntlProvider>
      <ClientChases client={client} />
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chases.value = { chases: [], isLoading: false, error: null };
  mocks.sendChaseNow.mockResolvedValue(undefined);
});

// ⚠ DataTable renders BOTH its table and card branches in the DOM (container
// queries hide one), so text inside it is asserted with getAllByText.
test('the missing list is the isUnexplained set for THIS client — matched, suppressed and foreign lines never appear', () => {
  renderTab();

  expect(screen.getAllByText('LINE unexplained').length).toBeGreaterThan(0);
  expect(screen.getAllByText('LINE covered').length).toBeGreaterThan(0);
  expect(screen.queryByText('LINE confirmed')).toBeNull();
  expect(screen.queryByText('STRIPE PAYOUT')).toBeNull();
  expect(screen.queryByText('LINE other-client')).toBeNull();
});

test('a line inside an OPEN chase is marked "chased, awaiting reply" and loses the chase button (item 30 from the other direction)', () => {
  mocks.chases.value = { chases: [openChase('chs_1', ['covered'])], isLoading: false, error: null };
  renderTab();

  // Marked, and still listed as missing — the paperwork has not arrived.
  expect(screen.getAllByText(/Chased 2 Sep, 10:15, awaiting reply/).length).toBeGreaterThan(0);
  // The covered TABLE row carries the mark and no chase button; the
  // uncovered row keeps its button.
  const coveredRow = screen.getAllByText('LINE covered').map((el) => el.closest('tr')).find((tr) => tr !== null)!;
  expect(within(coveredRow).queryByRole('button', { name: 'Chase' })).toBeNull();
  expect(within(coveredRow).getByText(/awaiting reply/)).toBeTruthy();
  const openRow = screen.getAllByText('LINE unexplained').map((el) => el.closest('tr')).find((tr) => tr !== null)!;
  expect(within(openRow).getByRole('button', { name: 'Chase' })).toBeTruthy();
});

test('the chase affordance SENDS the real chase.send for the row (item 3)', async () => {
  // ⚠ It reported "queued" until 8 Sep 2026, because `chase.send` was tier 1
  // and the message waited in Approvals for the firm's super admin. The owner
  // took it out of that tier, so the act finishes here — `sendChaseNow` still
  // drives create → review → approve, which is the record; what went is the
  // wait.
  renderTab();

  fireEvent.click(screen.getAllByRole('button', { name: 'Chase' })[0]!);
  await waitFor(() => expect(mocks.sendChaseNow).toHaveBeenCalledTimes(1));
  expect(mocks.sendChaseNow).toHaveBeenCalledWith('biz_zeplow', ['unexplained']);
  expect((await screen.findByRole('status')).textContent).toMatch(/Chase sent/);
});

test('a refused staging is an alert, not silence', async () => {
  mocks.sendChaseNow.mockRejectedValueOnce(new Error('boom'));
  renderTab();

  fireEvent.click(screen.getAllByRole('button', { name: 'Chase' })[0]!);
  expect((await screen.findByRole('alert')).textContent).toBeTruthy();
});

test('a failed bank read says so — never "nothing missing" over unread data', () => {
  renderTab({
    transactions: [],
    slices: { bankTransactions: { source: 'error', loading: false, error: 'NT-SRV-001' } },
  });

  expect(screen.getByRole('alert').textContent).toMatch(/could not be read/);
  expect(screen.queryByText(/Nothing is missing/)).toBeNull();
});

test('the sent-chases list shows this client\'s chases with honest state pills', () => {
  const received: LiveChase = {
    ...openChase('chs_2', ['x']),
    open: false,
    state: 'CLOSED_RECEIVED',
    closedReason: 'Receipt received',
  };
  const foreign: LiveChase = { ...openChase('chs_3', ['y']), businessId: 'biz_other' };
  mocks.chases.value = { chases: [openChase('chs_1', ['covered']), received, foreign], isLoading: false, error: null };
  renderTab();

  expect(screen.getByText('Awaiting reply')).toBeTruthy();
  expect(screen.getByText('Received')).toBeTruthy();
  // The other client's chase is not this tab's to show.
  expect(screen.getAllByText(/sent 2 Sep, 10:15|created 01 Sep 2026/)).toHaveLength(2);
});
