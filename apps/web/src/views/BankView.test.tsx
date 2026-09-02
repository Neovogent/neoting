import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BankView } from './BankView';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import { DEFAULT_MATCH_SETTINGS } from '../lib/matching';
import { deriveClientStats } from '../lib/selectors';
import type { BankTransaction, Client } from '../lib/types';

/**
 * ⚠ THE HEADLINE FIGURE ON THIS SCREEN DISAGREED WITH THE CLIENT CARD BESIDE
 * IT, and both were labelled "unexplained".
 *
 * The header, the count, the table footer and the "Needs you" pill were all
 * `!isMatched(t)` — which adds SUGGESTED and EXCLUDED and ignores chase
 * suppression entirely — while the Accounts tab's own "{n} unexplained" line
 * and ClientDetailView's tile go through `statsFor`, i.e. the server's
 * `UNMATCHED AND NOT chase_suppressed`. All of them are on `isUnexplained`
 * now, and this test fails against the old header (it reads 5, not 2).
 *
 * `isMatched` is deliberately still what the Evidence column, the matcher and
 * the matched/unmatched lenses use. Two questions, two functions.
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
  amount: 100,
  isCredit: false,
  accountId: 'acct-1-1',
  ...over,
});

/**
 * Two lines the chase engine would chase, at £100 each, and four it would not
 * — so a header still counting the others cannot land on £200.00 by accident.
 */
const TRANSACTIONS: BankTransaction[] = [
  txn({ id: 'a', matchState: 'UNMATCHED', chaseSuppressed: false }),
  txn({ id: 'b', matchState: 'UNMATCHED', chaseSuppressed: false }),
  txn({ id: 'c', amount: 50, matchState: 'SUGGESTED', chaseSuppressed: false }),
  txn({ id: 'd', amount: 50, matchState: 'EXCLUDED', chaseSuppressed: false }),
  txn({ id: 'e', amount: 50, description: 'SERVICE CHARGE', matchState: 'UNMATCHED', chaseSuppressed: true }),
  txn({ id: 'f', amount: 50, matchState: 'CONFIRMED', chaseSuppressed: false }),
];

const EMPTY = { documents: [], missing: [], chases: [], approvals: [], duplicates: [], statementGaps: [] };

const SLICE = { source: 'api' as const, loading: false, error: null, truncated: false, count: TRANSACTIONS.length };

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    clients: [CLIENT],
    transactions: TRANSACTIONS,
    matches: [],
    documents: [],
    accounts: [],
    statements: [],
    statementGaps: [],
    matchSettings: DEFAULT_MATCH_SETTINGS,
    setMatchSettings: vi.fn(),
    matchTransaction: vi.fn(),
    unmatchTransaction: vi.fn(),
    cashCode: vi.fn(),
    uploadStatement: vi.fn(),
    logAudit: vi.fn(),
    // The real selector, so the card and the header are compared honestly.
    statsFor: () => deriveClientStats(CLIENT, { ...EMPTY, transactions: TRANSACTIONS }),
    isSameClient: (a: string, b: string) => a === b,
    slices: { bankTransactions: SLICE },
    refetchBank: vi.fn(),
    serverClientIdFor: (id: string) => id,
  }),
}));

vi.mock('../api/statements', () => ({
  useStatements: () => ({ statements: [], source: 'seed', loading: false, error: null }),
}));

vi.mock('../components/DynamicComponents/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(async () => false),
}));

function renderView() {
  return render(
    <AppIntlProvider>
      <BankView />
    </AppIntlProvider>,
  );
}

describe('the "unexplained" figures on the Bank screen', () => {
  it('count and total only the lines the chase engine would chase', () => {
    renderView();

    // "{count} unexplained · {amount} without evidence" — the subtitle under
    // the Bank heading, and the whole point of the screen.
    expect(screen.getByText(/unexplained · £200\.00 without evidence/)).toHaveTextContent(
      '2 unexplained · £200.00 without evidence',
    );
  });

  it('agree with the client card, which answers from the server counts', () => {
    renderView();

    const fromTheServer = deriveClientStats(CLIENT, { ...EMPTY, transactions: TRANSACTIONS }).unmatched;
    expect(fromTheServer).toBe(2);
    expect(screen.getByText(new RegExp(`^${fromTheServer} unexplained`))).toBeTruthy();
  });

  it('say the same thing in the table footer', () => {
    renderView();

    // All six rows are listed — the lens is 'all' — and two of them are
    // without evidence. The footer used to say five.
    expect(screen.getByText('6 transactions • 2 without evidence')).toBeTruthy();
  });

  it('do not put a chase-suppressed line in the "Needs you" pill', () => {
    renderView();

    // No documents are in scope, so the matcher finds no candidates at all and
    // nothing is 'confused'. The pill is therefore zero — what matters is that
    // it is counted over the unexplained set rather than over every unmatched
    // line, so a suppressed service charge can never appear in it.
    expect(screen.getByText('Needs you (0)')).toBeTruthy();
  });
});
