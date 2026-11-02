import { describe, expect, test } from 'vitest';

import { bankFacts, coveredDays } from './tax-estimate.service.js';

const Q = { periodStart: '2026-07-01', periodEnd: '2026-09-30' };
const at = (day: string) => new Date(`${day}T12:00:00Z`);

describe('coveredDays', () => {
  test('overlapping statements are counted once, and clipped to the period', () => {
    expect(
      coveredDays(
        [
          ['2026-06-15', '2026-07-31'],
          ['2026-07-20', '2026-08-31'],
        ],
        Q.periodStart,
        Q.periodEnd,
      ),
    ).toBe(62);
  });

  test('a gap stays a gap', () => {
    expect(
      coveredDays(
        [
          ['2026-07-01', '2026-07-31'],
          ['2026-09-01', '2026-09-30'],
        ],
        Q.periodStart,
        Q.periodEnd,
      ),
    ).toBe(61);
  });

  test('a statement wholly outside the period covers nothing', () => {
    expect(coveredDays([['2026-10-01', '2026-10-31']], Q.periodStart, Q.periodEnd)).toBe(0);
  });
});

describe('bankFacts', () => {
  const row = (amountPence: number, matchState: string, descriptionRaw = 'SHOP', chaseSuppressed = false) => ({
    amountPence,
    matchState,
    chaseSuppressed,
    descriptionRaw,
    bookedAt: at('2026-08-01'),
  });

  test('evidenced = SUGGESTED or CONFIRMED; excluded, suppressed and tax-authority lines are left out', () => {
    const facts = bankFacts(
      [
        row(-1_000, 'SUGGESTED'),
        row(-2_000, 'UNMATCHED'),
        row(3_000, 'CONFIRMED'),
        row(4_000, 'UNMATCHED'),
        row(-9_000, 'EXCLUDED'),
        row(-9_000, 'UNMATCHED', 'TRANSFER', true),
        // Every credit is chase-suppressed automatically; card takings still count as possible sales.
        row(5_000, 'UNMATCHED', 'SQUARE PAYMENTS SETTLEMENT', true),
        row(-9_000, 'UNMATCHED', 'DD HMRC VAT'),
        row(-9_000, 'UNMATCHED', 'ATO PAYMENT'),
      ],
      [{ periodStart: at('2026-07-01'), periodEnd: at('2026-09-30') }],
      Q,
    );
    expect(facts).toEqual({
      coveredDays: 92,
      debitsPence: 3_000,
      creditsPence: 12_000,
      unevidencedDebitsPence: 2_000,
      unevidencedCreditsPence: 9_000,
    });
  });

  test('no statement and no lines means no bank evidence at all', () => {
    expect(bankFacts([], [], Q)).toBeNull();
  });

  test('lines with no dated statement still count, covering only the days they span', () => {
    const facts = bankFacts(
      [
        { ...row(-1_000, 'UNMATCHED'), bookedAt: at('2026-07-01') },
        { ...row(-1_000, 'UNMATCHED'), bookedAt: at('2026-07-10') },
      ],
      [],
      Q,
    );
    expect(facts?.coveredDays).toBe(10);
  });
});
