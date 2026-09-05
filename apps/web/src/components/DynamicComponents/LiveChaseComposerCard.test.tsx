import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { LiveChaseComposerCard } from './LiveChaseComposerCard';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { SliceStatus } from '../../api/slices';
import type { BankTransaction } from '../../lib/types';

/**
 * Review item 30 (5 Sep 2026): the composer offered EVERY transaction on the
 * statement pre-ticked — a matched-and-published line and the settlement
 * credits included. Two rules pinned here:
 *
 * - the candidate list is exactly the `isUnexplained` set — no matched, no
 *   SUGGESTED, no suppressed lines, ever;
 * - chasing is OPT-IN per line: nothing is pre-selected, and staging is
 *   disabled until the accountant picks the lines the message is about.
 */

vi.mock('../../api/config', () => ({
  API_ENABLED: true,
  API_MOCKED: false,
  API_BASE_URL: '',
  dataSourceLabel: () => 'live API' as const,
}));

// The staging flow is its own component with its own tests; here it only has
// to reflect the `disabled` contract the composer drives it with.
vi.mock('./LiveProposalFlow', () => ({
  LiveProposalFlow: ({ stageLabel, disabled }: { stageLabel: string; disabled?: boolean }) => (
    <button disabled={disabled === true}>{stageLabel}</button>
  ),
}));

const row = (id: string, over: Partial<BankTransaction> = {}): BankTransaction => ({
  id,
  clientId: 'biz_zeplow',
  clientName: 'Zeplow Inc.',
  description: `LINE ${id}`,
  date: '06 Aug 2026',
  amount: 994.0,
  isCredit: false,
  accountId: 'acc_1',
  matchState: 'UNMATCHED',
  chaseSuppressed: false,
  ...over,
});

const API_SLICE: SliceStatus = { source: 'api', loading: false, error: null };

let ctx: {
  transactions: BankTransaction[];
  businesses: { id: string; name: string }[];
  clients: { id: string; name: string; mobile?: string }[];
  slices: { bankTransactions: SliceStatus };
};

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ctx,
}));

beforeEach(() => {
  ctx = {
    transactions: [
      row('unexplained'),
      row('confirmed', { matchState: 'CONFIRMED', matchedDocId: 'doc_1' }),
      row('suggested', { matchState: 'SUGGESTED' }),
      row('credit', { chaseSuppressed: true, isCredit: true, amount: -2841.55, description: 'WORLDPAY SETTLEMENT' }),
    ],
    businesses: [{ id: 'biz_zeplow', name: 'Zeplow Inc.' }],
    clients: [],
    slices: { bankTransactions: API_SLICE },
  };
});

function renderCard() {
  return render(
    <AppIntlProvider>
      <LiveChaseComposerCard businessId="biz_zeplow" businessName="Zeplow Inc." />
    </AppIntlProvider>,
  );
}

test('offers ONLY the isUnexplained lines — no matched, no suggested, no suppressed credits', () => {
  renderCard();

  expect(screen.getByText('LINE unexplained')).toBeTruthy();
  expect(screen.queryByText('LINE confirmed')).toBeNull();
  expect(screen.queryByText('LINE suggested')).toBeNull();
  expect(screen.queryByText('WORLDPAY SETTLEMENT')).toBeNull();
});

test('nothing is pre-ticked, staging is disabled, and a tick is what arms both', () => {
  renderCard();

  const checkbox = screen.getByRole('checkbox');
  expect(checkbox.getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByText('Draft message')).toBeNull();
  expect((screen.getByRole('button', { name: 'Stage for review' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(checkbox);

  expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('Draft message')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Stage for review' }) as HTMLButtonElement).disabled).toBe(false);
});

test('a failed bank read says so instead of claiming there is nothing to chase', () => {
  ctx.transactions = [];
  ctx.slices = { bankTransactions: { source: 'error', loading: false, error: 'NT-SRV-001 — boom' } };
  renderCard();

  expect(screen.getByRole('alert').textContent).toMatch(/could not be read/);
  expect(screen.queryByText(/Nothing to chase/)).toBeNull();
});
