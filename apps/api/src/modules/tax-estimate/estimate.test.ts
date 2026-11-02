import { describe, expect, test } from 'vitest';

import {
  auCompanyTax,
  corporationTax,
  estimate,
  type AccountFacts,
  type BankFacts,
  type EstimateDocument,
  type EstimateInput,
  formatMoney,
  periodDays,
  taxShare,
} from './estimate.js';

const EXPENSE: AccountFacts = {
  code: 'SOFTWARE_AND_SUBSCRIPTIONS',
  ledger: 'Expenses',
  vatTreatment: 'STANDARD',
  taxConsequence: 'ALLOWABLE',
};
const ENTERTAINING: AccountFacts = {
  code: 'CLIENT_ENTERTAINING',
  ledger: 'Expenses',
  vatTreatment: 'BLOCKED',
  taxConsequence: 'DISALLOWABLE',
};
const PLANT: AccountFacts = {
  code: 'FA_PLANT_AND_EQUIPMENT',
  ledger: 'Fixed assets',
  vatTreatment: 'STANDARD',
  taxConsequence: 'CAPITAL',
};
const CAR: AccountFacts = {
  code: 'FA_MOTOR_VEHICLES',
  ledger: 'Fixed assets',
  vatTreatment: 'BLOCKED',
  taxConsequence: 'CAPITAL',
};

let n = 0;
function doc(
  inbox: 'SALES' | 'COSTS',
  totalPence: number,
  taxPence: number | null,
  account: AccountFacts | null = null,
  extra: Partial<EstimateDocument> = {},
): EstimateDocument {
  n += 1;
  return {
    id: `d${n}`,
    label: `doc ${n}`,
    date: '2026-08-15',
    inbox,
    creditNote: false,
    totalPence,
    taxPence,
    reviewed: true,
    account,
    ...extra,
  };
}

function input(over: Partial<EstimateInput>): EstimateInput {
  return {
    country: 'GB',
    kind: 'VAT',
    periodStart: '2026-07-01',
    periodEnd: '2026-09-30',
    vatRegistered: true,
    vatScheme: 'STANDARD',
    flatRateBasisPoints: null,
    legalStructure: 'LIMITED_COMPANY',
    documents: [],
    bank: null,
    skipped: { otherCurrency: 0, undated: 0 },
    ...over,
  };
}

const fullBank = (over: Partial<BankFacts> = {}): BankFacts => ({
  coveredDays: 92,
  debitsPence: 100_000,
  creditsPence: 100_000,
  unevidencedDebitsPence: 0,
  unevidencedCreditsPence: 0,
  ...over,
});

const fig = (e: ReturnType<typeof estimate>, code: string) => e.figures.find((f) => f.code === code)?.amountPence;

describe('UK VAT', () => {
  test('box 1 is VAT on sales, box 4 VAT on purchases, and blocked VAT is left out of box 4', () => {
    const e = estimate(
      input({
        documents: [doc('SALES', 12_000, 2_000), doc('COSTS', 6_000, 1_000, EXPENSE), doc('COSTS', 1_200, 200, ENTERTAINING)],
        bank: fullBank(),
      }),
    );
    expect(fig(e, '1')).toBe(2_000);
    expect(fig(e, '3')).toBe(2_000);
    expect(fig(e, '4')).toBe(1_000);
    expect(fig(e, '5')).toBe(1_000);
    expect(fig(e, '6')).toBe(10_000);
    expect(fig(e, '7')).toBe(6_000);
    expect(e.result).toEqual({
      amountPence: 1_000,
      lowPence: 1_000,
      highPence: 1_000,
    });
    expect(e.notes.some((s) => s.includes("£2.00 of VAT on purchases that can't be reclaimed"))).toBe(true);
  });

  test('bank money with no document widens the range by the VAT it could carry, never the central figure', () => {
    const e = estimate(
      input({
        documents: [doc('SALES', 12_000, 2_000), doc('COSTS', 6_000, 1_000, EXPENSE)],
        bank: fullBank({
          unevidencedDebitsPence: 600,
          unevidencedCreditsPence: 1_200,
        }),
      }),
    );
    expect(e.result).toEqual({
      amountPence: 1_000,
      lowPence: 900,
      highPence: 1_200,
    });
    expect(e.completeness.unevidencedDebitsPence).toBe(600);
  });

  test('a document whose VAT was not read counts as zero and widens the range', () => {
    const e = estimate(
      input({
        documents: [doc('COSTS', 1_200, null, EXPENSE)],
        bank: fullBank(),
      }),
    );
    expect(e.result).toEqual({ amountPence: 0, lowPence: -200, highPence: 0 });
  });

  test('a credit note reduces the box it lands in', () => {
    const e = estimate(
      input({
        documents: [doc('SALES', 12_000, 2_000), doc('SALES', 1_200, 200, null, { creditNote: true })],
      }),
    );
    expect(fig(e, '1')).toBe(1_800);
  });

  test('flat rate: box 1 is the flat percentage of VAT-inclusive turnover and ordinary input VAT is not reclaimed', () => {
    const e = estimate(
      input({
        vatScheme: 'FLAT_RATE',
        flatRateBasisPoints: 1650,
        documents: [doc('SALES', 12_000, 2_000), doc('COSTS', 6_000, 1_000, EXPENSE), doc('COSTS', 240_000, 40_000, PLANT)],
      }),
    );
    expect(fig(e, '1')).toBe(1_980);
    expect(fig(e, '4')).toBe(40_000); // capital purchase of £2,000+ only
    expect(fig(e, '6')).toBe(12_000);
    expect(e.assumptions.some((a) => a.includes('16.5%'))).toBe(true);
  });

  test('a client that is not VAT-registered has no return to estimate', () => {
    const e = estimate(input({ vatRegistered: false, documents: [doc('SALES', 12_000, 0)] }));
    expect(e.applicable).toBe(false);
    expect(e.figures).toEqual([]);
  });
});

describe('Australian GST (BAS)', () => {
  test('G1, G10, G11, 1A and 1B, and a refund comes back negative', () => {
    const e = estimate(
      input({
        country: 'AU',
        documents: [doc('SALES', 11_000, 1_000), doc('COSTS', 22_000, 2_000, PLANT), doc('COSTS', 5_500, 500, EXPENSE)],
      }),
    );
    expect(e.currency).toBe('AUD');
    expect(fig(e, 'G1')).toBe(11_000);
    expect(fig(e, 'G10')).toBe(22_000);
    expect(fig(e, 'G11')).toBe(5_500);
    expect(fig(e, '1A')).toBe(1_000);
    expect(fig(e, '1B')).toBe(2_500);
    expect(e.result.amountPence).toBe(-1_500);
  });

  test('the bank-side range uses 1/11, not 1/6', () => {
    const e = estimate(
      input({
        country: 'AU',
        documents: [doc('SALES', 11_000, 1_000)],
        bank: fullBank({ unevidencedCreditsPence: 11_000 }),
      }),
    );
    expect(e.result.highPence).toBe(2_000);
  });
});

describe('UK Corporation Tax', () => {
  test('the three bands for a 12-month period', () => {
    expect(corporationTax(4_000_000, 365)).toBe(760_000); // £40,000 at 19%
    expect(corporationTax(10_000_000, 365)).toBe(2_275_000); // £100,000: £25,000 less £2,250 relief
    expect(corporationTax(30_000_000, 365)).toBe(7_500_000); // £300,000 at 25%
    expect(corporationTax(5_000_000, 365)).toBe(950_000); // exactly the lower limit
    expect(corporationTax(0, 365)).toBe(0);
    expect(corporationTax(-500, 365)).toBe(0);
  });

  test('limits are pro-rated for a short period', () => {
    // 182 days: lower limit £24,931.51, so £20,000 is all at 19%.
    expect(corporationTax(2_000_000, 182)).toBe(380_000);
    // £40,000 over 182 days is inside marginal relief, so more than 19%.
    expect(corporationTax(4_000_000, 182)).toBeGreaterThan(760_000);
  });

  test('property: never decreasing in profit, and always between 19% and 25%', () => {
    let previous = 0;
    for (let profit = 0; profit <= 30_000_000; profit += 12_347) {
      const tax = corporationTax(profit, 365);
      expect(tax).toBeGreaterThanOrEqual(previous);
      expect(tax).toBeGreaterThanOrEqual(Math.floor((profit * 19) / 100));
      expect(tax).toBeLessThanOrEqual(Math.ceil((profit * 25) / 100));
      previous = tax;
    }
  });

  test('the estimate: AIA on plant, 18% on cars, disallowable costs added back', () => {
    const e = estimate(
      input({
        kind: 'COMPANY_TAX',
        periodStart: '2025-10-01',
        periodEnd: '2026-09-30',
        documents: [
          doc('SALES', 12_000_000, 2_000_000), // £100,000 net
          doc('COSTS', 1_200_000, 200_000, EXPENSE), // £10,000 net
          doc('COSTS', 600_000, 100_000, PLANT), // £5,000 AIA
          doc('COSTS', 1_000_000, 0, CAR), // £10,000 car → £1,800
          doc('COSTS', 120_000, 20_000, ENTERTAINING), // not deductible
        ],
      }),
    );
    expect(fig(e, 'TURNOVER')).toBe(10_000_000);
    expect(fig(e, 'EXPENSES')).toBe(1_000_000);
    expect(fig(e, 'CAPITAL_ALLOWANCES')).toBe(680_000);
    expect(fig(e, 'DISALLOWED')).toBe(120_000);
    expect(fig(e, 'PROFIT')).toBe(8_320_000);
    expect(e.result.amountPence).toBe(corporationTax(8_320_000, 365));
  });

  test('unexplained money in raises the high bound; unexplained money out lowers the low bound', () => {
    const e = estimate(
      input({
        kind: 'COMPANY_TAX',
        periodStart: '2025-10-01',
        periodEnd: '2026-09-30',
        documents: [doc('SALES', 6_000_000, 1_000_000)],
        bank: fullBank({
          coveredDays: 365,
          unevidencedCreditsPence: 1_200_000,
          unevidencedDebitsPence: 600_000,
        }),
      }),
    );
    expect(e.result.amountPence).toBe(950_000);
    expect(e.result.highPence).toBe(corporationTax(6_000_000, 365));
    expect(e.result.lowPence).toBe(corporationTax(4_500_000, 365));
  });

  test('a sole trader is not a company', () => {
    const e = estimate(
      input({
        kind: 'COMPANY_TAX',
        legalStructure: 'SOLE_TRADER',
        documents: [doc('SALES', 12_000, 2_000)],
      }),
    );
    expect(e.applicable).toBe(false);
  });
});

describe('Australian company tax', () => {
  test('25%, with small assets written off centrally and the range covering the write-off rules', () => {
    const e = estimate(
      input({
        country: 'AU',
        kind: 'COMPANY_TAX',
        periodStart: '2025-07-01',
        periodEnd: '2026-06-30',
        documents: [
          doc('SALES', 11_000_000, 1_000_000), // A$100,000
          doc('COSTS', 1_100_000, 100_000, PLANT), // A$10,000 asset: written off
          doc('COSTS', 5_500_000, 500_000, PLANT), // A$50,000 asset: not deducted centrally
        ],
      }),
    );
    expect(fig(e, 'TAXABLE_INCOME')).toBe(9_000_000);
    expect(e.result.amountPence).toBe(2_250_000);
    expect(e.result.highPence).toBe(auCompanyTax(10_000_000));
    expect(e.result.lowPence).toBe(auCompanyTax(4_000_000));
  });
});

describe('completeness', () => {
  test('score = statement coverage × evidenced share; review status is shown, not multiplied in', () => {
    const e = estimate(
      input({
        documents: [doc('SALES', 6_000, 1_000), doc('COSTS', 6_000, 1_000, EXPENSE, { reviewed: false })],
        bank: fullBank({
          coveredDays: 46,
          debitsPence: 100_000,
          creditsPence: 100_000,
          unevidencedDebitsPence: 40_000,
        }),
      }),
    );
    expect(e.completeness.statementCoveragePercent).toBe(50);
    expect(e.completeness.evidencedPercent).toBe(80);
    expect(e.completeness.reviewedPercent).toBe(50);
    expect(e.completeness.scorePercent).toBe(40);
  });

  test('no bank statement scores zero and says so', () => {
    const e = estimate(input({ documents: [doc('SALES', 6_000, 1_000)] }));
    expect(e.completeness.scorePercent).toBe(0);
    expect(e.notes.some((s) => s.startsWith('There is no bank statement'))).toBe(true);
  });
});

describe('helpers', () => {
  test('taxShare and money formatting are integer-exact', () => {
    expect(taxShare(1_200, 20)).toBe(200);
    expect(taxShare(1_100, 10)).toBe(100);
    expect(formatMoney(123_456_78, 'GB')).toBe('£123,456.78');
    expect(formatMoney(-5, 'AU')).toBe('-A$0.05');
    expect(periodDays('2026-07-01', '2026-09-30')).toBe(92);
  });
});
