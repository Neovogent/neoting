import { describe, expect, it } from 'vitest';

import {
  assessTransaction,
  autoMatches,
  DEFAULT_MATCH_SETTINGS,
  daysBetween,
  matchCandidates,
  normaliseMerchant,
  parseDate,
  sameMerchant,
  shortLabel,
  txnLabel,
} from './matching';
import { seedDocuments, seedTransactions } from './seed';
import type { BankTransaction } from './types';

/**
 * Bank matching decides what a person is asked about. A matcher that is too
 * eager links the wrong invoice to the wrong payment silently; one that is too
 * shy buries the accountant in questions. The tests below are about which of
 * the two happens for a given transaction, not about the scoring internals.
 */

const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 't-test',
  clientId: '1',
  clientName: 'American Burger Ltd',
  description: 'BIDFOOD UK LTD',
  date: '12 Aug 2026',
  amount: 1420.5,
  isCredit: false,
  accountId: 'acct-1-1',
  ...over,
});

const find = (id: string) => seedTransactions.find((t) => t.id === id)!;

describe('parseDate', () => {
  it('reads the format the whole pipeline speaks', () => {
    expect(parseDate('09 Aug 2026')).toBe(Date.UTC(2026, 7, 9));
    expect(parseDate('9 Aug 2026')).toBe(Date.UTC(2026, 7, 9));
    expect(parseDate('09 August 2026')).toBe(Date.UTC(2026, 7, 9));
  });

  it('refuses anything else rather than guessing', () => {
    expect(parseDate('2026-08-09')).toBeNull();
    expect(parseDate('09/08/2026')).toBeNull();
    expect(parseDate('09 Xyz 2026')).toBeNull();
    expect(parseDate('—')).toBeNull();
    expect(parseDate('')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts whole days, signed by which came first', () => {
    expect(daysBetween('12 Aug 2026', '10 Aug 2026')).toBe(2);
    expect(daysBetween('10 Aug 2026', '12 Aug 2026')).toBe(-2);
    expect(daysBetween('10 Aug 2026', '10 Aug 2026')).toBe(0);
  });

  it('crosses a month and a year boundary', () => {
    expect(daysBetween('01 Sep 2026', '31 Aug 2026')).toBe(1);
    expect(daysBetween('01 Jan 2027', '31 Dec 2026')).toBe(1);
  });

  it('is null when either side is undated, rather than zero', () => {
    expect(daysBetween('—', '10 Aug 2026')).toBeNull();
    expect(daysBetween('10 Aug 2026', '—')).toBeNull();
  });
});

describe('normaliseMerchant', () => {
  it('drops the noise a bank line adds to a trading name', () => {
    expect(normaliseMerchant('BIDFOOD UK LTD')).toBe('bidfood');
    expect(normaliseMerchant('Bidfood UK')).toBe('bidfood');
    expect(normaliseMerchant('CURRYS ONLINE')).toBe('currys');
    expect(normaliseMerchant('SQUARE UP PAYMENT')).toBe('squareup');
  });

  it('leaves a name that is only noise empty rather than inventing one', () => {
    expect(normaliseMerchant('UK LTD')).toBe('');
    expect(normaliseMerchant('   ')).toBe('');
  });
});

describe('sameMerchant', () => {
  it('sees through the suffixes a bank feed prints', () => {
    expect(sameMerchant('BIDFOOD UK LTD', 'Bidfood UK')).toBe(true);
    expect(sameMerchant('Brakes Bros Limited', 'Brakes')).toBe(true);
    expect(sameMerchant('Screwfix Direct', 'Screwfix')).toBe(true);
  });

  it('keeps Costco off Costa and Amazon Business off Amazon Web Services', () => {
    expect(sameMerchant('Costco', 'Costa')).toBe(false);
    expect(sameMerchant('Amazon Business', 'Amazon Web Services')).toBe(false);
    expect(sameMerchant('Bidfood UK', 'Booker')).toBe(false);
  });

  it('never matches on an empty name', () => {
    expect(sameMerchant('', 'Bidfood UK')).toBe(false);
    expect(sameMerchant('UK LTD', 'Bidfood UK')).toBe(false);
  });
});

describe('matchCandidates', () => {
  it('never reaches into another client’s documents', () => {
    const other = txn({ clientId: '2', clientName: 'Cosmo Restaurants' });

    expect(matchCandidates(other, seedDocuments, DEFAULT_MATCH_SETTINGS)).toEqual([]);
  });

  it('never offers a rejected document as the answer', () => {
    // d5 is Adobe, £61.99, rejected.
    const adobe = txn({ description: 'ADOBE', amount: 61.99, date: '02 Aug 2026' });
    const candidates = matchCandidates(adobe, seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(candidates.map((c) => c.document.id)).not.toContain('d5');
  });

  it('drops a document that is older than the lookback allows', () => {
    const stale = txn({ date: '12 Aug 2030' });

    expect(matchCandidates(stale, seedDocuments, DEFAULT_MATCH_SETTINGS)).toEqual([]);
  });

  it('drops a document dated after the payment by more than the due window', () => {
    const early = txn({ date: '12 Aug 2025' });

    expect(matchCandidates(early, seedDocuments, DEFAULT_MATCH_SETTINGS)).toEqual([]);
  });

  it('offers no more than a screenful', () => {
    const busy = txn({ amount: 1 });

    expect(matchCandidates(busy, seedDocuments, DEFAULT_MATCH_SETTINGS).length).toBeLessThanOrEqual(6);
  });
});

describe('assessTransaction', () => {
  it('settles equal totals from the same merchant without asking', () => {
    const verdict = assessTransaction(find('t2'), seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(verdict.kind).toBe('confident');
    expect(verdict.best?.document.id).toBe('d1');
    expect(verdict.best?.kind).toBe('exact');
    expect(verdict.reason).toContain('2 days after');
  });

  it('hands over a refund it cannot pin down rather than guessing', () => {
    // t4 is a £212.40 Bidfood refund; no document explains it.
    const verdict = assessTransaction(find('t4'), seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(verdict.kind).toBe('confused');
    expect(verdict.best?.kind).toBe('probable');
    expect(verdict.reason).toContain('probable fit');
  });

  it('says plainly when nothing could explain a payment', () => {
    const verdict = assessTransaction(find('t3'), seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(verdict.kind).toBe('none');
    expect(verdict.candidates).toEqual([]);
    expect(verdict.best).toBeUndefined();
  });

  it('asks rather than picking when two documents fit equally well', () => {
    const twin = { ...seedDocuments[0]!, id: 'd1-twin' };
    const verdict = assessTransaction(find('t2'), [...seedDocuments, twin], DEFAULT_MATCH_SETTINGS);

    expect(verdict.kind).toBe('confused');
    expect(verdict.candidates.length).toBeGreaterThan(1);
    expect(verdict.reason).toContain('equally well');
  });

  it('will not offer a probable fit at all when the practice has turned them off', () => {
    const verdict = assessTransaction(find('t4'), seedDocuments, {
      ...DEFAULT_MATCH_SETTINGS,
      allowProbable: false,
    });

    expect(verdict.kind).toBe('none');
  });
});

describe('autoMatches', () => {
  it('links only what it can settle, and leaves the rest as questions', () => {
    const linked = autoMatches(seedTransactions, seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(linked.map((m) => [m.txnId, m.candidate.document.id])).toEqual([['t1', 'd4']]);
  });

  it('skips a transaction that already has its document', () => {
    // t2 arrives with matchedDocId 'd1' and must not be linked a second time.
    const linked = autoMatches(seedTransactions, seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(linked.map((m) => m.txnId)).not.toContain('t2');
  });

  it('never lets one document explain two payments', () => {
    const twice = [find('t1'), { ...find('t1'), id: 't1-again' }];
    const linked = autoMatches(twice, seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(linked).toHaveLength(1);
    expect(linked[0]?.candidate.document.id).toBe('d4');
  });
});

describe('labels', () => {
  it('reads as a line an accountant can scan', () => {
    expect(shortLabel(seedDocuments[0]!)).toBe('Bidfood UK · £1420.50 · 10 Aug');
    expect(txnLabel(find('t4'))).toBe('BIDFOOD UK LTD REFUND · £212.40 · 14 Aug');
  });
});
