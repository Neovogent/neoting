import { describe, expect, test } from 'vitest';

import { expectedPence, findExactCombinations, settle } from './allocation.js';
import { merchantScore, normaliseMerchant } from './merchant.js';
import { closedPeriodContaining, monthBounds, periodOf } from './periods.js';

describe('findExactCombinations — the bounded subset-sum allocator', () => {
  test('one £1,900 payment settles four invoices, and the decoy is left out', () => {
    const combos = findExactCombinations(-190000, [
      { id: 'inv1', amountPence: -50000 },
      { id: 'inv2', amountPence: -40000 },
      { id: 'inv3', amountPence: -60000 },
      { id: 'inv4', amountPence: -40000 },
      { id: 'decoy', amountPence: -12345 },
    ]);
    expect(combos[0]?.sort()).toEqual(['inv1', 'inv2', 'inv3', 'inv4']);
    for (const combo of combos) expect(combo).not.toContain('decoy');
  });

  test('a credit note nets inside a batch (mixed signs)', () => {
    const combos = findExactCombinations(-90000, [
      { id: 'inv1', amountPence: -50000 },
      { id: 'inv2', amountPence: -50000 },
      { id: 'cn', amountPence: 10000 },
    ]);
    expect(combos.map((c) => [...c].sort())).toContainEqual(['cn', 'inv1', 'inv2']);
  });

  test('exact to the penny or nothing', () => {
    expect(findExactCombinations(-100001, [{ id: 'a', amountPence: -50000 }, { id: 'b', amountPence: -50000 }])).toEqual([]);
    expect(findExactCombinations(0, [{ id: 'a', amountPence: -1 }])).toEqual([]);
  });

  test('fewest documents first, and the search stays bounded', () => {
    const combos = findExactCombinations(-1000, [
      { id: 'whole', amountPence: -1000 },
      { id: 'half1', amountPence: -500 },
      { id: 'half2', amountPence: -500 },
    ]);
    expect(combos[0]).toEqual(['whole']);
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, amountPence: -(1000 + i) }));
    expect(() => findExactCombinations(-1, many, { maxNodes: 1000 })).not.toThrow();
  });
});

describe('settle — when a document is paid', () => {
  const invoice = { inbox: 'COSTS', docType: 'INVOICE', totalPence: 100000 };
  test('partial then full', () => {
    expect(expectedPence(invoice)).toBe(-100000);
    expect(settle(invoice, [-40000]).status).toBe('part-paid');
    expect(settle(invoice, [-40000]).outstandingPence).toBe(-60000);
    expect(settle(invoice, [-40000, -60000]).status).toBe('paid');
  });
  test('a refund is counted against, not towards', () => {
    const s = settle(invoice, [-100000, 30000]);
    expect(s).toMatchObject({ paidPence: 100000, refundedPence: 30000, status: 'paid' });
  });
  test('a credit note expects money in; a legacy whole-line match settles it', () => {
    const cn = { inbox: 'COSTS', docType: 'CREDIT_NOTE', totalPence: 5000 };
    expect(expectedPence(cn)).toBe(5000);
    expect(settle(cn, [null]).status).toBe('paid');
  });
});

describe('merchant normalisation — the probabilistic tier', () => {
  test('card noise, references and legal forms are stripped', () => {
    expect(normaliseMerchant('CARD 4211 FRESH DIRECT LTD*AB12CD 12AUG')).toBe('fresh direct');
  });
  test('UK 18-character truncation still matches by prefix', () => {
    expect(merchantScore('Fresh Direct Wholesale Ltd', 'FRESH DIRECT WHOLE')).toBe(0.9);
    expect(merchantScore('Costa Coffee', 'COSTA COFFEE')).toBe(1);
    expect(merchantScore('Costco Wholesale', 'COSTA COFFEE 1234')).toBeLessThan(0.6);
  });
});

describe('periods', () => {
  test('month bounds are [first, next first) in UTC', () => {
    const { start, end } = monthBounds('2026-12');
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(periodOf(new Date('2026-08-31T23:59:59Z'))).toBe('2026-08');
  });
  test('closedPeriodContaining honours the exclusive end and ignores a null date', () => {
    const { start, end } = monthBounds('2026-08');
    const locks = [{ periodStart: start, periodEnd: end }];
    expect(closedPeriodContaining(locks, new Date('2026-08-01T00:00:00Z'))).not.toBeNull();
    expect(closedPeriodContaining(locks, new Date('2026-09-01T00:00:00Z'))).toBeNull();
    expect(closedPeriodContaining(locks, null)).toBeNull();
  });
});
