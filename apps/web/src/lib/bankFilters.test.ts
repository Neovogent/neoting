import { describe, expect, test } from 'vitest';
import {
  EMPTY_BANK_FILTERS,
  activeFilterCount,
  displayDateToIso,
  matchesBankFilters,
  type BankTxnFilters,
} from './bankFilters';
import type { BankTransaction } from './types';

/**
 * The Transactions tab's refinement predicate — the logic behind the filter
 * drawer. Pinned pure because it decides which rows an accountant is LOOKING
 * AT: a range boundary that silently excludes its own endpoint, or a credit
 * classified backwards, hides real money without any error to notice.
 */

const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 't1',
  clientId: '1',
  clientName: 'American Burger Ltd',
  description: 'BIDFOOD LTD',
  date: '29 Aug 2026',
  amount: 1284.5,
  isCredit: false,
  accountId: 'acc1',
  ...over,
});

const filters = (over: Partial<BankTxnFilters> = {}): BankTxnFilters => ({ ...EMPTY_BANK_FILTERS, ...over });

describe('displayDateToIso', () => {
  test('reads the shape every screen renders, single and double digit days', () => {
    expect(displayDateToIso('10 Aug 2026')).toBe('2026-08-10');
    expect(displayDateToIso('9 Jan 2026')).toBe('2026-01-09');
  });

  test('an unreadable date is empty, never a guess', () => {
    expect(displayDateToIso('—')).toBe('');
    expect(displayDateToIso('2026-08-10')).toBe('');
    expect(displayDateToIso('10 Août 2026')).toBe('');
  });
});

describe('matchesBankFilters', () => {
  test('no filters passes everything', () => {
    expect(matchesBankFilters(txn(), filters())).toBe(true);
  });

  test('the date range is inclusive at both ends', () => {
    const f = filters({ dateFrom: '2026-08-29', dateTo: '2026-08-29' });
    expect(matchesBankFilters(txn({ date: '29 Aug 2026' }), f)).toBe(true);
    expect(matchesBankFilters(txn({ date: '28 Aug 2026' }), f)).toBe(false);
    expect(matchesBankFilters(txn({ date: '30 Aug 2026' }), f)).toBe(false);
  });

  test('each end of the range works alone', () => {
    expect(matchesBankFilters(txn({ date: '30 Aug 2026' }), filters({ dateFrom: '2026-08-29' }))).toBe(true);
    expect(matchesBankFilters(txn({ date: '30 Aug 2026' }), filters({ dateTo: '2026-08-29' }))).toBe(false);
  });

  test('a row whose date cannot be read is outside any requested range', () => {
    expect(matchesBankFilters(txn({ date: '—' }), filters({ dateFrom: '2026-01-01' }))).toBe(false);
    // …but passes when no range was asked for.
    expect(matchesBankFilters(txn({ date: '—' }), filters())).toBe(true);
  });

  test('amounts compare on the absolute value, inclusive — a −£2,841.55 credit is a £2,841.55 line', () => {
    const credit = txn({ amount: -2841.55, isCredit: true });
    expect(matchesBankFilters(credit, filters({ amountMin: '2841.55' }))).toBe(true);
    expect(matchesBankFilters(credit, filters({ amountMin: '2841.56' }))).toBe(false);
    expect(matchesBankFilters(credit, filters({ amountMax: '2841.55' }))).toBe(true);
    expect(matchesBankFilters(credit, filters({ amountMax: '2841.54' }))).toBe(false);
  });

  test('an unparseable amount bound is no bound at all', () => {
    expect(matchesBankFilters(txn(), filters({ amountMin: 'abc', amountMax: '' }))).toBe(true);
  });

  test('direction: in is the credit/refund side, out the payments', () => {
    const credit = txn({ isCredit: true });
    expect(matchesBankFilters(credit, filters({ direction: 'in' }))).toBe(true);
    expect(matchesBankFilters(credit, filters({ direction: 'out' }))).toBe(false);
    expect(matchesBankFilters(txn(), filters({ direction: 'out' }))).toBe(true);
    expect(matchesBankFilters(txn(), filters({ direction: 'in' }))).toBe(false);
  });

  test('suppliers are exact descriptions, any of the chosen set', () => {
    const f = filters({ suppliers: ['BIDFOOD LTD', 'SHELL BRISTOL'] });
    expect(matchesBankFilters(txn(), f)).toBe(true);
    expect(matchesBankFilters(txn({ description: 'ADOBE SYSTEMS' }), f)).toBe(false);
    // Exact, not substring — 'BIDFOOD' alone chose nothing.
    expect(matchesBankFilters(txn(), filters({ suppliers: ['BIDFOOD'] }))).toBe(false);
  });
});

describe('activeFilterCount', () => {
  test('counts refinements, not fields — a range is one filter whichever ends are set', () => {
    expect(activeFilterCount(EMPTY_BANK_FILTERS)).toBe(0);
    expect(activeFilterCount(filters({ dateFrom: '2026-08-01', dateTo: '2026-08-31' }))).toBe(1);
    expect(activeFilterCount(filters({ amountMin: '5' }))).toBe(1);
    expect(
      activeFilterCount(
        filters({ dateFrom: '2026-08-01', amountMax: '100', direction: 'in', suppliers: ['BIDFOOD LTD'] }),
      ),
    ).toBe(4);
  });
});
