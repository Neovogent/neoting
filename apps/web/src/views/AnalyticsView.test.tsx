import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AnalyticsView } from './AnalyticsView';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import { deriveClientStats } from '../lib/selectors';
import type { BankTransaction, Client } from '../lib/types';

/**
 * ⚠ THE TILE AND THE COLUMN BENEATH IT USED TO DISAGREE, on the same screen,
 * about the same clients.
 *
 * The "Unmatched transactions" tile was `scopedTxns.filter((t) => !t.matchedDocId)`
 * — a third definition again, and the one `lib/matching.ts` warns against by
 * name: a server row carries no `matchedDocId` until a match is CONFIRMED, so
 * on live data that expression counted the whole bank feed. The per-client
 * Unmatched column right below it goes through `statsFor`, which answers from
 * the server's own counts. Both are on `isUnexplained` now.
 *
 * This test fails against the old tile: it reads 6 where the column reads 2.
 */

const CLIENT: Client = {
  id: '1',
  name: 'American Burger Ltd',
  industry: 'Hospitality',
  health: 92,
  missingDocs: 0,
  toReview: 0,
  deadline: '7 Sep 2026',
  bankConnected: true,
};

const txn = (over: Partial<BankTransaction> & { id: string }): BankTransaction => ({
  clientId: '1',
  clientName: 'American Burger Ltd',
  description: 'BIDFOOD UK LTD',
  date: '12 Aug 2026',
  amount: 1420.5,
  isCredit: false,
  accountId: 'acct-1-1',
  ...over,
});

/** Two the server would chase, four it would not. */
const TRANSACTIONS: BankTransaction[] = [
  txn({ id: 'a', matchState: 'UNMATCHED', chaseSuppressed: false }),
  txn({ id: 'b', matchState: 'UNMATCHED', chaseSuppressed: false }),
  txn({ id: 'c', matchState: 'SUGGESTED', chaseSuppressed: false }),
  txn({ id: 'd', matchState: 'EXCLUDED', chaseSuppressed: false }),
  txn({ id: 'e', description: 'SERVICE CHARGE', matchState: 'UNMATCHED', chaseSuppressed: true }),
  txn({ id: 'f', matchState: 'CONFIRMED', chaseSuppressed: false }),
];

const EMPTY = { documents: [], missing: [], chases: [], approvals: [], duplicates: [], statementGaps: [] };

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    clients: [CLIENT],
    documents: [],
    missing: [],
    chases: [],
    approvals: [],
    transactions: TRANSACTIONS,
    statementGaps: [],
    auditLog: [],
    // The real selector, so the column is answered the way the app answers it.
    statsFor: () => deriveClientStats(CLIENT, { ...EMPTY, transactions: TRANSACTIONS }),
  }),
}));

function renderView() {
  return render(
    <AppIntlProvider>
      <AnalyticsView />
    </AppIntlProvider>,
  );
}

/** A KPI tile renders its label and its value as siblings inside one card. */
function tileValue(label: string): string {
  const labelEl = screen.getByText(label);
  const value = labelEl.nextElementSibling?.textContent;
  if (value === undefined || value === null) throw new Error(`no value beside the "${label}" tile`);
  return value.trim();
}

describe('the Unmatched tile and the per-client Unmatched column', () => {
  it('report the same number, and it is the number the chase engine would chase', () => {
    renderView();

    expect(tileValue('Unmatched transactions')).toBe('2');

    // The same figure in the per-client table. The row carries several
    // right-aligned counts, so the column is located by its header position
    // rather than by looking for a bare "2" anywhere on the screen.
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    const index = headers.indexOf('Unmatched');
    expect(index).toBeGreaterThan(-1);

    const cells = screen.getAllByRole('row')[1]?.querySelectorAll('td');
    expect(cells?.[index]?.textContent?.trim()).toBe('2');
  });
});
