import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BankView, csvAmount, txnAmountLabel } from './BankView';
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
  // A credit with no document — the live encoding (money in is negative in the
  // local ledger shape, `isCredit` the reconciled truth), chase-suppressed so
  // none of the figures above move.
  txn({ id: 'g', description: 'WORLDPAY SETTLEMENT', amount: -543.98, isCredit: true, matchState: 'UNMATCHED', chaseSuppressed: true }),
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

    // All seven rows are listed — the lens is 'all' — and two of them are
    // without evidence. The footer used to say five.
    expect(screen.getByText('7 transactions • 2 without evidence')).toBeTruthy();
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

/**
 * Review item 17 — Mubashir's two display rules for the transactions table.
 *
 * 1. Money INTO the account wears a PLUS. The cell used to render the local
 *    ledger amount raw and colour anything negative green, so a credit read
 *    "−£543.98" in green — sign and colour contradicting each other.
 * 2. Missing evidence is a RED flag regardless of direction. The credit pill
 *    keeps its own wording but must not soften to blue just because money
 *    came in.
 */
describe('credits in the transactions table', () => {
  it('render money in with a plus sign, direction from isCredit and never from the local sign', () => {
    renderView();

    // The credit's local amount is -543.98; the honest render is +£543.98.
    // The table renders each row twice (table and card layouts), so every
    // instance is checked.
    const credits = screen.getAllByText('+£543.98');
    expect(credits.length).toBeGreaterThan(0);
    expect(screen.queryByText('−£543.98')).toBeNull();
    // Green marks direction, so it keys on the same signal as the sign.
    for (const cell of credits) expect(cell.className).toContain('text-emerald-400');
    // Money out stays unsigned and unpainted, however the ledger signed it.
    expect(screen.getAllByText('£100.00')[0]?.className).toContain('text-white');
  });

  it('flag a credit with no document in red, same as a debit', () => {
    renderView();

    for (const pill of screen.getAllByText('Credit — no document')) {
      expect(pill.className).toContain('text-red-400');
    }
    for (const pill of screen.getAllByText('No document')) {
      expect(pill.className).toContain('text-red-400');
    }
  });
});

describe('the CSV export', () => {
  it('signs amounts by direction — money in positive, money out negative', () => {
    expect(csvAmount(txn({ id: 'x', amount: -543.98, isCredit: true }))).toBe(543.98);
    expect(csvAmount(txn({ id: 'y', amount: 100, isCredit: false }))).toBe(-100);
  });

  it('labels agree with the helper the table cell uses', () => {
    expect(txnAmountLabel(txn({ id: 'x', amount: -543.98, isCredit: true }))).toBe('+£543.98');
    expect(txnAmountLabel(txn({ id: 'y', amount: 100, isCredit: false }))).toBe('£100.00');
  });
});
