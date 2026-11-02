import { describe, expect, test } from 'vitest';
import { periodPresets } from './taxEstimate';

const NOV_2026 = new Date('2026-11-02T10:00:00Z');

describe('periodPresets', () => {
  test('VAT/BAS: this and last calendar quarter', () => {
    expect(periodPresets('GB', 'VAT', NOV_2026)).toEqual([
      { key: 'thisQuarter', start: '2026-10-01', end: '2026-12-31' },
      { key: 'lastQuarter', start: '2026-07-01', end: '2026-09-30' },
    ]);
  });

  test('January: last quarter is in the previous year', () => {
    expect(periodPresets('AU', 'VAT', new Date('2027-01-15T00:00:00Z'))[1]).toEqual({
      key: 'lastQuarter',
      start: '2026-10-01',
      end: '2026-12-31',
    });
  });

  test('AU company tax: the income year runs 1 July – 30 June', () => {
    expect(periodPresets('AU', 'COMPANY_TAX', NOV_2026)).toEqual([
      { key: 'thisYear', start: '2026-07-01', end: '2027-06-30' },
      { key: 'lastYear', start: '2025-07-01', end: '2026-06-30' },
    ]);
  });

  test('UK company tax: the last 12 whole months, ending this month', () => {
    expect(periodPresets('GB', 'COMPANY_TAX', NOV_2026)).toEqual([{ key: 'last12Months', start: '2025-12-01', end: '2026-11-30' }]);
  });
});
