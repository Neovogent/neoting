import { describe, expect, it } from 'vitest';
import { createIntl } from 'react-intl';

import { DEFAULT_LOCALE } from '../i18n';
import {
  assessTransaction,
  autoMatches,
  CONFIDENT_MIN,
  DEFAULT_MATCH_SETTINGS,
  daysBetween,
  isMatched,
  isUnexplained,
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
 *
 * The match reasons are message descriptors formatted by the caller (#65), so
 * the matcher takes an `intl`. `locale` and `defaultLocale` are both the source
 * locale, which is how react-intl resolves each message to its own
 * `defaultMessage` without reporting a missing translation — the sentences
 * asserted below are the ones a user reads in en-GB.
 */

const intl = createIntl({ locale: DEFAULT_LOCALE, defaultLocale: DEFAULT_LOCALE });

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
    const other = txn({ clientId: '2', clientName: 'Ananda Group' });

    expect(matchCandidates(intl, other, seedDocuments, DEFAULT_MATCH_SETTINGS)).toEqual([]);
  });

  it('never offers a rejected document as the answer', () => {
    // d5 is Adobe, £61.99, rejected.
    const adobe = txn({ description: 'ADOBE', amount: 61.99, date: '02 Aug 2026' });
    const candidates = matchCandidates(intl, adobe, seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(candidates.map((c) => c.document.id)).not.toContain('d5');
  });

  it('drops a document that is older than the lookback allows', () => {
    const stale = txn({ date: '12 Aug 2030' });

    expect(matchCandidates(intl, stale, seedDocuments, DEFAULT_MATCH_SETTINGS)).toEqual([]);
  });

  it('drops a document dated after the payment by more than the due window', () => {
    const early = txn({ date: '12 Aug 2025' });

    expect(matchCandidates(intl, early, seedDocuments, DEFAULT_MATCH_SETTINGS)).toEqual([]);
  });

  it('offers no more than a screenful', () => {
    const busy = txn({ amount: 1 });

    expect(matchCandidates(intl, busy, seedDocuments, DEFAULT_MATCH_SETTINGS).length).toBeLessThanOrEqual(6);
  });
});

describe('assessTransaction', () => {
  it('settles equal totals from the same merchant without asking', () => {
    const verdict = assessTransaction(intl, find('t2'), seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(verdict.kind).toBe('confident');
    expect(verdict.best?.document.id).toBe('d1');
    expect(verdict.best?.kind).toBe('exact');
    expect(verdict.reason).toContain('2 days after');
  });

  it('hands over a refund it cannot pin down rather than guessing', () => {
    // t4 is a £212.40 Bidfood refund; no document explains it.
    const verdict = assessTransaction(intl, find('t4'), seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(verdict.kind).toBe('confused');
    expect(verdict.best?.kind).toBe('probable');
    expect(verdict.reason).toContain('probable fit');
  });

  it('says plainly when nothing could explain a payment', () => {
    const verdict = assessTransaction(intl, find('t3'), seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(verdict.kind).toBe('none');
    expect(verdict.candidates).toEqual([]);
    expect(verdict.best).toBeUndefined();
  });

  it('asks rather than picking when two documents fit equally well', () => {
    const twin = { ...seedDocuments[0]!, id: 'd1-twin' };
    const verdict = assessTransaction(intl, find('t2'), [...seedDocuments, twin], DEFAULT_MATCH_SETTINGS);

    expect(verdict.kind).toBe('confused');
    expect(verdict.candidates.length).toBeGreaterThan(1);
    expect(verdict.reason).toContain('equally well');
  });

  it('will not offer a probable fit at all when the practice has turned them off', () => {
    const verdict = assessTransaction(intl, find('t4'), seedDocuments, {
      ...DEFAULT_MATCH_SETTINGS,
      allowProbable: false,
    });

    expect(verdict.kind).toBe('none');
  });
});

describe('autoMatches', () => {
  it('links only what it can settle, and leaves the rest as questions', () => {
    const linked = autoMatches(intl, seedTransactions, seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(linked.map((m) => [m.txnId, m.candidate.document.id])).toEqual([['t1', 'd4']]);
  });

  it('skips a transaction that already has its document', () => {
    // t2 arrives with matchedDocId 'd1' and must not be linked a second time.
    const linked = autoMatches(intl, seedTransactions, seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(linked.map((m) => m.txnId)).not.toContain('t2');
  });

  it('never lets one document explain two payments', () => {
    const twice = [find('t1'), { ...find('t1'), id: 't1-again' }];
    const linked = autoMatches(intl, twice, seedDocuments, DEFAULT_MATCH_SETTINGS);

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

/**
 * Regressions. Both of these auto-linked or silently re-dated real data before
 * they were fixed, and neither failed loudly — which is why they are pinned
 * here with the exact inputs that reproduced them.
 */
describe('credit notes do not auto-link across suppliers (#67)', () => {
  const currys = seedDocuments.find((d) => d.id === 'd4')!;

  const refundFrom = (description: string): BankTransaction => ({
    id: 'refund-1',
    clientId: currys.clientId,
    clientName: currys.clientName,
    description,
    date: '12 Aug 2026',
    amount: -currys.total,
    isCredit: true,
    accountId: find('t1').accountId,
  });

  it('does not offer an unrelated supplier a confident credit-note match', () => {
    const best = matchCandidates(intl, refundFrom('RANDOM UNRELATED CO'), [currys], DEFAULT_MATCH_SETTINGS)[0];

    // It still appears — a person should be asked — but never above the bar
    // that autoMatches links without asking.
    expect(best?.confidence).toBeLessThan(CONFIDENT_MIN);
  });

  it('never auto-links it', () => {
    const linked = autoMatches(intl, [refundFrom('RANDOM UNRELATED CO')], [currys], DEFAULT_MATCH_SETTINGS);

    expect(linked).toHaveLength(0);
  });

  it('still auto-links a refund that is genuinely from the same supplier', () => {
    const linked = autoMatches(intl, [refundFrom('CURRYS REFUND')], [currys], DEFAULT_MATCH_SETTINGS);

    expect(linked.map((m) => m.candidate.document.id)).toEqual(['d4']);
    expect(linked[0]?.candidate.kind).toBe('credit-note');
  });

  it('keeps the unrelated refund visible rather than dropping it from review', () => {
    const candidates = matchCandidates(intl, refundFrom('RANDOM UNRELATED CO'), [currys], DEFAULT_MATCH_SETTINGS);

    expect(candidates).not.toHaveLength(0);
  });
});

/**
 * Review item 32 (5 Sep 2026), pinned with the shape that shipped: transaction
 * FASTER PAYMENT TO ALDGATE MEATS LTD · 26 Aug · £674.46, candidate Aldgate
 * Meats Ltd · £994.00 · 30 Jul, tagged "Probable 48%". A supplier a restaurant
 * pays weekly makes a name-only hit the EXPECTED collision — the name carries
 * no information, and the amount is the evidence.
 */
describe('the probable tier requires amount agreement on a debit (item 32)', () => {
  const aldgateDoc = {
    ...seedDocuments[0]!,
    id: 'd-aldgate',
    supplier: 'Aldgate Meats Ltd',
    total: 994.0,
    date: '30 Jul 2026',
  };

  const paymentOf = (amount: number, date = '26 Aug 2026'): BankTransaction =>
    txn({ description: 'FASTER PAYMENT TO ALDGATE MEATS LTD', amount, date, isCredit: false });

  it('refuses a name-only hit whose amount is far off, rather than calling it probable', () => {
    const candidates = matchCandidates(intl, paymentOf(674.46), [aldgateDoc], DEFAULT_MATCH_SETTINGS);

    expect(candidates).toEqual([]);
  });

  it('still offers a near-miss amount, scored below the far-off shape ever was', () => {
    const candidates = matchCandidates(intl, paymentOf(950.0), [aldgateDoc], DEFAULT_MATCH_SETTINGS);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('probable');
    expect(candidates[0]?.confidence).toBeLessThanOrEqual(0.48);
    expect(candidates[0]?.confidence).toBeGreaterThan(0.4);
  });

  it('keeps the credit (refund) question open even when the amounts disagree', () => {
    // A partial refund genuinely differs from its invoice — the seeded £212.40
    // Bidfood refund case, restated with this supplier. Pinned so the debit
    // rule can never quietly swallow it.
    const refund = txn({
      description: 'ALDGATE MEATS REFUND',
      amount: -212.4,
      date: '26 Aug 2026',
      isCredit: true,
    });
    const candidates = matchCandidates(intl, refund, [aldgateDoc], DEFAULT_MATCH_SETTINGS);

    expect(candidates.map((c) => c.kind)).toContain('probable');
  });
});

/**
 * Item 32's second half: one receipt cannot answer two bank lines. The claimed
 * set used to be consulted only by `autoMatches`' own link decision — the
 * candidate DIALOG happily offered a matched-and-published document as a
 * candidate for a second transaction.
 */
describe('a claimed document is out of the candidate pool', () => {
  const doc = seedDocuments[0]!; // d1, Bidfood £1,420.50

  it('never offers a document another transaction already claimed', () => {
    const claimed = new Set([doc.id]);
    const exact = txn({ description: 'BIDFOOD UK LTD', amount: doc.total, date: '12 Aug 2026' });

    const withClaim = matchCandidates(intl, exact, seedDocuments, DEFAULT_MATCH_SETTINGS, claimed);
    const without = matchCandidates(intl, exact, seedDocuments, DEFAULT_MATCH_SETTINGS);

    expect(without.map((c) => c.document.id)).toContain(doc.id);
    expect(withClaim.map((c) => c.document.id)).not.toContain(doc.id);
  });

  it('assessTransaction passes the claimed set through', () => {
    const exact = txn({ description: 'BIDFOOD UK LTD', amount: doc.total, date: '12 Aug 2026' });
    const verdict = assessTransaction(intl, exact, seedDocuments, DEFAULT_MATCH_SETTINGS, new Set([doc.id]));

    expect(verdict.candidates.map((c) => c.document.id)).not.toContain(doc.id);
  });
});

describe('merchantSimilarity measures overlap, not alignment (#67)', () => {
  it('scores a shifted prefix as similar', () => {
    // The old positional comparison scored this near zero: every character is
    // offset by one, so nothing lined up.
    expect(sameMerchant('JSAINSBURY', 'Sainsburys')).toBe(true);
  });

  it('still keeps Costco off Costa', () => {
    expect(sameMerchant('COSTCO WHOLESALE', 'Costa Coffee')).toBe(false);
  });

  it('does not reward a repeated bigram that is not in both', () => {
    expect(sameMerchant('AAAA', 'AA')).toBe(true); // substring rule, not bigrams
    expect(sameMerchant('ABABABAB', 'ZZZZ')).toBe(false);
  });
});

/**
 * ⚠ THREE SURFACES USED TO ANSWER "how many bank lines are unexplained?" WITH
 * THREE DIFFERENT DEFINITIONS, and an accountant reads them side by side.
 *
 * `statsFor` answered from the server's `BusinessSummary.counts`
 * (`UNMATCHED AND NOT chase_suppressed` — the set the chase engine actually
 * chases); `BankView`'s header used `!isMatched(t)`, which adds SUGGESTED and
 * EXCLUDED and ignores suppression entirely; and `AnalyticsView` used
 * `!t.matchedDocId`, which on live data counts EVERY transaction because a
 * server row carries no document id until a match is CONFIRMED.
 *
 * `isUnexplained` is the one definition. These cases pin it against the
 * server's, and — the point — against `isMatched`, which answers a different
 * question and must not be repurposed into this one.
 */
describe('isUnexplained — the counting predicate, and not isMatched negated', () => {
  it('counts a server row the chase engine would chase', () => {
    expect(isUnexplained(txn({ matchState: 'UNMATCHED', chaseSuppressed: false }))).toBe(true);
  });

  it('does NOT count a SUGGESTED line, though the matcher still calls it unmatched', () => {
    const suggested = txn({ matchState: 'SUGGESTED', chaseSuppressed: false });
    // The two questions, on one row, giving opposite answers — which is the
    // whole reason there are two functions.
    expect(isMatched(suggested)).toBe(false);
    expect(isUnexplained(suggested)).toBe(false);
  });

  it('does NOT count an EXCLUDED line — a human has already said so out loud', () => {
    const excluded = txn({ matchState: 'EXCLUDED', chaseSuppressed: false });
    expect(isMatched(excluded)).toBe(false);
    expect(isUnexplained(excluded)).toBe(false);
  });

  it('does NOT count a chase-suppressed line, because no chase can ever bring it down', () => {
    // SERVICE CHARGE, STRIPE PAYOUT: bank-originated, no paperwork in
    // existence to find. The server's own `where` excludes them.
    expect(isUnexplained(txn({ matchState: 'UNMATCHED', chaseSuppressed: true }))).toBe(false);
  });

  it('does NOT count a CONFIRMED server row that carries no matchedDocId', () => {
    // The shape that broke AnalyticsView: confirmed on the server, no document
    // id on the wire, so `!t.matchedDocId` reported it as unexplained.
    const confirmed = txn({ matchState: 'CONFIRMED', chaseSuppressed: false });
    expect(confirmed.matchedDocId).toBeUndefined();
    expect(isUnexplained(confirmed)).toBe(false);
  });

  it('does NOT count a seeded row with a matchedDocId and no matchState', () => {
    // The synthetic cast (METH_MODE §1): the local id is the whole of the
    // truth, so a strict `matchState === 'UNMATCHED'` test would have emptied
    // the demo instead of fixing live data.
    const seeded = txn({ matchedDocId: 'd1' });
    expect(seeded.matchState).toBeUndefined();
    expect(isUnexplained(seeded)).toBe(false);
  });

  it('counts a seeded row with neither signal', () => {
    expect(isUnexplained(txn())).toBe(true);
  });

  it('agrees with the seed cast wherever the seed cast can speak', () => {
    // No seeded row carries `matchState` or `chaseSuppressed`, so for the demo
    // the two predicates are the same set and the tour cannot have changed.
    expect(seedTransactions.every((t) => t.matchState === undefined)).toBe(true);
    expect(seedTransactions.filter(isUnexplained)).toEqual(seedTransactions.filter((t) => !isMatched(t)));
  });

  it('is a strict subset of not-matched, so no count can exceed the list it sits above', () => {
    const every: BankTransaction[] = [
      txn({ id: 'a', matchState: 'UNMATCHED', chaseSuppressed: false }),
      txn({ id: 'b', matchState: 'SUGGESTED', chaseSuppressed: false }),
      txn({ id: 'c', matchState: 'EXCLUDED', chaseSuppressed: false }),
      txn({ id: 'd', matchState: 'UNMATCHED', chaseSuppressed: true }),
      txn({ id: 'e', matchState: 'CONFIRMED', chaseSuppressed: false }),
      txn({ id: 'f', matchedDocId: 'd1' }),
      txn({ id: 'g' }),
    ];
    for (const t of every) {
      if (isUnexplained(t)) expect(isMatched(t)).toBe(false);
    }
  });

  it('implements the server predicate exactly, on server-shaped rows', () => {
    const server: BankTransaction[] = [
      txn({ id: 'a', matchState: 'UNMATCHED', chaseSuppressed: false }),
      txn({ id: 'b', matchState: 'SUGGESTED', chaseSuppressed: false }),
      txn({ id: 'c', matchState: 'EXCLUDED', chaseSuppressed: false }),
      txn({ id: 'd', matchState: 'UNMATCHED', chaseSuppressed: true }),
      txn({ id: 'e', matchState: 'CONFIRMED', chaseSuppressed: false }),
    ];
    // The `where` clause in `apps/api/src/modules/auth-tenancy/businesses.service.ts`,
    // written out by hand rather than derived from the thing under test.
    const asTheServerCounts = server.filter((t) => t.matchState === 'UNMATCHED' && t.chaseSuppressed === false);

    expect(server.filter(isUnexplained)).toEqual(asTheServerCounts);
    // And what the two old definitions would have said about the same rows.
    expect(server.filter((t) => !isMatched(t))).toHaveLength(4);
    expect(server.filter((t) => !t.matchedDocId)).toHaveLength(5);
  });
});
