import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { LiveMissingCard } from './LiveMissingCard';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { SliceStatus } from '../../api/slices';
import type { BankTransaction } from '../../lib/types';

/**
 * Review item 25 (5 Sep 2026): chat answered "What is still missing for Zeplow
 * Inc.?" with a confident all-clear computed over data nobody read. The rule
 * these tests pin: **"nothing missing" may only render when the bank slice was
 * genuinely read and the scoped set is genuinely empty** — a failed read, an
 * unasked read, or a scope no server row carries answers honestly that it
 * cannot verify, never with an all-clear.
 */

vi.mock('../../api/config', () => ({
  API_ENABLED: true,
  API_MOCKED: false,
  API_BASE_URL: '',
  dataSourceLabel: () => 'live API' as const,
}));

vi.mock('../../api/chases', () => ({
  useChases: () => ({ chases: [], isLoading: false }),
}));

const row = (id: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
  id,
  clientId: 'biz_zeplow',
  clientName: 'Zeplow Inc.',
  description: `FASTER PAYMENT ${id}`,
  date: '06 Aug 2026',
  amount: 994.0,
  isCredit: false,
  accountId: 'acc_1',
  matchState: 'UNMATCHED',
  chaseSuppressed: false,
  ...over,
});

const API_SLICE: SliceStatus = { source: 'api', loading: false, error: null, truncated: false, loaded: 3 };

let ctx: {
  transactions: BankTransaction[];
  businesses: { id: string; name: string }[];
  session: { status: string };
  slices: { bankTransactions: SliceStatus };
  setActiveTab: () => void;
};

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ctx,
}));

beforeEach(() => {
  ctx = {
    transactions: [
      row('t1'),
      row('t2', { matchState: 'CONFIRMED', matchedDocId: 'doc_1' }),
      row('t3', { chaseSuppressed: true, isCredit: true, amount: -500 }),
      row('t4', { clientId: 'biz_other', clientName: 'Someone Else Ltd' }),
    ],
    businesses: [
      { id: 'biz_zeplow', name: 'Zeplow Inc.' },
      { id: 'biz_other', name: 'Someone Else Ltd' },
    ],
    session: { status: 'authenticated' },
    slices: { bankTransactions: API_SLICE },
    setActiveTab: () => {},
  };
});

function renderCard(props: { businessId?: string; businessName?: string } = {}) {
  return render(
    <AppIntlProvider>
      <LiveMissingCard {...props} />
    </AppIntlProvider>,
  );
}

test('enumerates exactly the isUnexplained set for the scoped client — the Bank headline’s own set', () => {
  renderCard({ businessId: 'biz_zeplow', businessName: 'Zeplow Inc.' });

  // t1 is the one unexplained line; the confirmed, the suppressed credit and
  // the other client's line must all be absent. All-queries throughout: the
  // DataTable renders each row twice (table + card layouts).
  expect(screen.getAllByText('FASTER PAYMENT t1').length).toBeGreaterThan(0);
  expect(screen.queryAllByText('FASTER PAYMENT t2')).toHaveLength(0);
  expect(screen.queryAllByText('FASTER PAYMENT t3')).toHaveLength(0);
  expect(screen.queryAllByText('FASTER PAYMENT t4')).toHaveLength(0);
  expect(screen.queryAllByText(/Nothing is missing/)).toHaveLength(0);
});

test('"nothing missing" renders only over a genuinely read, genuinely empty set', () => {
  ctx.transactions = [row('t2', { matchState: 'CONFIRMED', matchedDocId: 'doc_1' })];
  renderCard({ businessId: 'biz_zeplow', businessName: 'Zeplow Inc.' });

  expect(screen.getAllByText(/Nothing is missing/).length).toBeGreaterThan(0);
});

test('a FAILED bank read answers "can’t verify", never an all-clear', () => {
  ctx.slices = { bankTransactions: { source: 'error', loading: false, error: 'NT-SRV-001 — boom' } };
  renderCard({ businessId: 'biz_zeplow', businessName: 'Zeplow Inc.' });

  expect(screen.getByRole('alert').textContent).toMatch(/can’t verify/);
  expect(screen.queryAllByText(/Nothing is missing/)).toHaveLength(0);
});

test('a bank slice the session never filled answers "can’t verify" too', () => {
  // 'seed' while a session stands means the API was never asked — with M2 the
  // context array is empty, which is exactly the shape that produced the
  // confident lie: an empty set that means "unread", not "all clear".
  ctx.transactions = [];
  ctx.slices = { bankTransactions: { source: 'seed', loading: false, error: null } };
  renderCard({ businessId: 'biz_zeplow', businessName: 'Zeplow Inc.' });

  expect(screen.getByRole('alert').textContent).toMatch(/can’t verify/);
  expect(screen.queryAllByText(/Nothing is missing/)).toHaveLength(0);
});

test('a scope no server business carries is named, never answered about nobody', () => {
  // The seed↔server id bridge's failure shape: a businessId (e.g. a seed id or
  // a stale fixture id) that resolves to no server row makes every filter
  // match nothing — which used to render as the all-clear.
  renderCard({ businessId: 'biz_1', businessName: 'Zeplow Inc.' });

  expect(screen.getByRole('alert').textContent).toMatch(/did not match a client/);
  expect(screen.queryAllByText(/Nothing is missing/)).toHaveLength(0);
});

test('a still-loading read says it is reading, not that nothing is missing', () => {
  ctx.transactions = [];
  ctx.slices = { bankTransactions: { source: 'api', loading: true, error: null } };
  renderCard({ businessId: 'biz_zeplow' });

  expect(screen.getByText(/Reading the bank feed/)).toBeTruthy();
  expect(screen.queryAllByText(/Nothing is missing/)).toHaveLength(0);
});

test('a truncated read says which part of the feed the list covers', () => {
  ctx.slices = { bankTransactions: { ...API_SLICE, truncated: true, loaded: 5000 } };
  renderCard({ businessId: 'biz_zeplow' });

  expect(screen.getByText(/5,?000 most recent/)).toBeTruthy();
});
