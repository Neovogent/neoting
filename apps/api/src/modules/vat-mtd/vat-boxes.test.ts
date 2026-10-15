import { describe, expect, test } from 'vitest';

import {
  computeReturn,
  hmrcMoney,
  hmrcReturnBody,
  hmrcToPence,
  hmrcWholePounds,
  localPeriods,
  type VatDocument,
} from './vat-boxes.js';

function doc(over: Partial<VatDocument> & Pick<VatDocument, 'id' | 'inbox'>): VatDocument {
  return {
    label: over.id,
    date: '2026-05-10',
    creditNote: false,
    totalPence: 12000,
    taxPence: 2000,
    currency: 'GBP',
    categoryCode: 'SALES',
    state: 'READY',
    ...over,
  };
}

describe('standard (invoice) accounting', () => {
  test('sales to boxes 1/6, purchases to boxes 4/7, derived 3 and 5, 6–9 whole pounds', () => {
    const result = computeReturn(
      'STANDARD',
      null,
      [
        doc({ id: 's1', inbox: 'SALES', totalPence: 120099, taxPence: 20016 }),
        doc({ id: 'c1', inbox: 'COSTS', totalPence: 6000, taxPence: 1000 }),
        doc({ id: 'c2', inbox: 'COSTS', totalPence: 1200, taxPence: 200, creditNote: true }),
        doc({ id: 'r1', inbox: 'SALES', state: 'TO_REVIEW' }),
      ],
      [],
    );
    expect(result.boxes).toEqual({
      vatDueSalesPence: 20016,
      vatDueAcquisitionsPence: 0,
      totalVatDuePence: 20016,
      vatReclaimedCurrPeriodPence: 800,
      netVatDuePence: 19216,
      totalValueSalesExVatPence: 100000, // 1000.83 → 1000
      totalValuePurchasesExVatPence: 4000,
      totalValueGoodsSuppliedExVatPence: 0,
      totalAcquisitionsExVatPence: 0,
    });
    expect(result.documentCount).toBe(3);
    expect(result.warnings.some((w) => w.includes('still being reviewed'))).toBe(true);
  });

  test('box 5 is never negative (a repayment return)', () => {
    const result = computeReturn('STANDARD', null, [doc({ id: 'c1', inbox: 'COSTS' })], []);
    expect(result.boxes.totalVatDuePence).toBe(0);
    expect(result.boxes.netVatDuePence).toBe(2000);
  });

  test('adjustments land in their box; zero-VAT and uncategorised are warned', () => {
    const result = computeReturn(
      'STANDARD',
      null,
      [doc({ id: 's1', inbox: 'SALES', taxPence: 0, categoryCode: null })],
      [{ box: 2, amountPence: 150, reason: 'NI acquisition' }],
    );
    expect(result.boxes.vatDueAcquisitionsPence).toBe(150);
    expect(result.boxes.totalVatDuePence).toBe(150);
    expect(result.lines[0]?.flags).toContain('Uncategorised');
    expect(result.warnings.join(' ')).toMatch(/no VAT/);
  });
});

describe('cash accounting', () => {
  test('only what was paid in the period counts, pro rata', () => {
    const result = computeReturn(
      'CASH',
      null,
      [
        doc({ id: 's1', inbox: 'SALES', totalPence: 12000, taxPence: 2000, paidPence: 6000 }),
        doc({ id: 'c1', inbox: 'COSTS', totalPence: 6000, taxPence: 1000, paidPence: 9999 }),
      ],
      [],
    );
    expect(result.boxes.vatDueSalesPence).toBe(1000);
    expect(result.boxes.vatReclaimedCurrPeriodPence).toBe(1000);
    expect(result.boxes.totalValueSalesExVatPence).toBe(5000);
    expect(result.lines[0]?.flags).toContain('Part-paid in this period');
  });
});

describe('flat rate scheme', () => {
  test('box 1 is the flat % of VAT-inclusive turnover; no input VAT', () => {
    const result = computeReturn(
      'FLAT_RATE',
      1650,
      [
        doc({ id: 's1', inbox: 'SALES', totalPence: 120000, taxPence: 20000 }),
        doc({ id: 'c1', inbox: 'COSTS', totalPence: 6000, taxPence: 1000 }),
      ],
      [],
    );
    expect(result.boxes.vatDueSalesPence).toBe(19800); // 16.5% × £1,200
    expect(result.boxes.vatReclaimedCurrPeriodPence).toBe(0);
    expect(result.boxes.totalValueSalesExVatPence).toBe(120000);
    expect(result.boxes.totalValuePurchasesExVatPence).toBe(6000);
  });

  test('refuses without a rate', () => {
    expect(() => computeReturn('FLAT_RATE', null, [], [])).toThrow(/flat-rate/);
  });
});

describe('pence → HMRC formatting', () => {
  test('two-decimal pounds by integer formatting', () => {
    expect(hmrcMoney(10550)).toBe('105.50');
    expect(hmrcMoney(-45)).toBe('-0.45');
    expect(hmrcMoney(0)).toBe('0.00');
    expect(hmrcMoney(7)).toBe('0.07');
    expect(hmrcMoney(-1000045)).toBe('-10000.45');
    expect(() => hmrcMoney(1.5)).toThrow();
  });

  test('whole pounds truncate toward zero', () => {
    expect(hmrcWholePounds(100099)).toBe('1000');
    expect(hmrcWholePounds(-100099)).toBe('-1000');
    expect(hmrcWholePounds(-99)).toBe('0');
  });

  test('the submit body is valid JSON carrying the exact decimals', () => {
    const body = hmrcReturnBody('18A1', {
      vatDueSalesPence: 10550,
      vatDueAcquisitionsPence: -10045,
      totalVatDuePence: 505,
      vatReclaimedCurrPeriodPence: 10515,
      netVatDuePence: 10010,
      totalValueSalesExVatPence: 30000,
      totalValuePurchasesExVatPence: 30000,
      totalValueGoodsSuppliedExVatPence: 300000,
      totalAcquisitionsExVatPence: 300000,
    });
    expect(body).toContain('"vatDueSales":105.50');
    expect(body).toContain('"totalValueGoodsSuppliedExVAT":3000,');
    expect(JSON.parse(body)).toMatchObject({ periodKey: '18A1', netVatDue: 100.1, finalised: true });
  });

  test('HMRC figures back to pence', () => {
    expect(hmrcToPence(105.5)).toBe(10550);
    expect(hmrcToPence(0.07)).toBe(7);
    expect(hmrcToPence(-1000.45)).toBe(-100045);
  });
});

describe('local periods from the stagger', () => {
  test('quarters ending Mar/Jun/Sep/Dec', () => {
    expect(localPeriods('QUARTERLY', 3, new Date('2026-10-15T00:00:00Z'), 2)).toEqual([
      { start: '2026-10-01', end: '2026-12-31' },
      { start: '2026-07-01', end: '2026-09-30' },
    ]);
  });

  test('quarters ending Jan/Apr/Jul/Oct, and across a year boundary', () => {
    expect(localPeriods('QUARTERLY', 1, new Date('2026-01-05T00:00:00Z'), 2)).toEqual([
      { start: '2025-11-01', end: '2026-01-31' },
      { start: '2025-08-01', end: '2025-10-31' },
    ]);
  });

  test('monthly and annual', () => {
    expect(localPeriods('MONTHLY', 3, new Date('2026-02-20T00:00:00Z'), 1)).toEqual([
      { start: '2026-02-01', end: '2026-02-28' },
    ]);
    expect(localPeriods('ANNUAL', 3, new Date('2026-10-15T00:00:00Z'), 1)).toEqual([
      { start: '2026-04-01', end: '2027-03-31' },
    ]);
  });
});
