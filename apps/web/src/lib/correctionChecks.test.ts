import { describe, expect, test } from 'vitest';

import type { CorrectionCheckContext } from '../api/document-detail';
import { correctionWarnings, IMPLAUSIBLY_OLD_YEARS, minusYears, todayInLondon } from './correctionChecks';

/**
 * ⚠ These MIRROR the server's checks
 * (`apps/api/src/modules/validation-dedupe/correction-checks.test.ts`) — same
 * firing conditions, so the dialog's warning and the review's restatement
 * cannot disagree. A rule changed on one side must change on both.
 */

const TODAY = '2026-09-05';

const invoice: CorrectionCheckContext = {
  docType: 'INVOICE',
  totalPence: 99_400,
  taxPence: 0,
  documentDate: '2025-07-30',
  currency: 'GBP',
  extractionHadValues: true,
};

const warn = (context: CorrectionCheckContext, fields: Parameters<typeof correctionWarnings>[1]) =>
  correctionWarnings(context, fields, TODAY);

describe('the arithmetic, as properties over ranges', () => {
  test('the £9,000-on-£994 shape warns, naming both figures and the export consequence (item 22)', () => {
    const warnings = warn(invoice, { taxPence: 900_000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('£9,000.00');
    expect(warnings[0]).toContain('£994.00');
    expect(warnings[0]).toContain('NO line in the export file');
  });

  test('tax over the total fires at every magnitude; tax at or under it never does', () => {
    for (const total of [1, 99, 12_750, 99_400, 5_000_000, 999_999_999]) {
      expect(warn({ ...invoice, totalPence: total }, { taxPence: total + 1 })).toHaveLength(1);
      expect(warn({ ...invoice, totalPence: total }, { taxPence: total })).toHaveLength(0);
      expect(warn({ ...invoice, totalPence: total }, { taxPence: Math.floor(total / 5) })).toHaveLength(0);
      // Magnitudes, not raw signs — a credit stored negative behaves the same.
      expect(warn({ ...invoice, totalPence: -total }, { taxPence: -(total + 1) })).toHaveLength(1);
    }
  });

  test('tax and total pointing in opposite directions warns; zeroes have no direction', () => {
    expect(warn(invoice, { totalPence: 99_400, taxPence: -1_000 })[0]).toContain('opposite directions');
    expect(warn(invoice, { totalPence: -99_400, taxPence: 1_000 })).toHaveLength(1);
    expect(warn(invoice, { totalPence: 99_400, taxPence: 0 })).toHaveLength(0);
  });

  test('checks read the AFTER values and fire only on what the correction touches', () => {
    const absurd = { ...invoice, taxPence: 900_000 };
    // Correcting the total past the stored tax clears the concern…
    expect(warn(absurd, { totalPence: 1_000_000 })).toHaveLength(0);
    // …and a supplier-name correction never re-litigates stored figures.
    expect(warn(absurd, { supplierName: 'Aldgate Meats Ltd' })).toHaveLength(0);
  });
});

describe('dates', () => {
  test('a future document date warns in UK d/m/y words (item 46)', () => {
    const warnings = warn(invoice, { documentDate: '2027-08-09' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('09 Aug 2027');
    expect(warnings[0]).toContain('in the future');
  });

  test('the implausibly-old boundary sits exactly at the window; due dates are never questioned', () => {
    const boundary = minusYears(TODAY, IMPLAUSIBLY_OLD_YEARS);
    expect(warn(invoice, { documentDate: boundary })).toHaveLength(0);
    expect(warn(invoice, { documentDate: '2019-09-04' })).toHaveLength(1);
    expect(warn(invoice, { documentDate: TODAY })).toHaveLength(0);
    expect(warn(invoice, { dueDate: '2027-08-09' })).toHaveLength(0);
  });

  test('minusYears clamps 29 Feb rather than inventing a date', () => {
    expect(minusYears('2028-02-29', 7)).toBe('2021-02-28');
  });
});

describe('the non-financial document (item 47)', () => {
  const selfie: CorrectionCheckContext = { ...invoice, docType: 'OTHER', extractionHadValues: false };

  test('money or category typed onto a Type OTHER document warns; naming the supplier does not', () => {
    expect(warn(selfie, { totalPence: 7_654_300 })[0]).toContain('does not appear to be a financial document');
    expect(warn(selfie, { categoryCode: 'jhngbhf' })).toHaveLength(1);
    expect(warn(selfie, { supplierName: 'gf' })).toHaveLength(0);
  });

  test('correcting Type in the same breath does not quiet it — the warning is about what the pipeline read', () => {
    expect(warn(selfie, { docType: 'RECEIPT', totalPence: 7_654_300 })).toHaveLength(1);
  });

  test('an extraction that read nothing warns even when the type was never classified', () => {
    expect(warn({ ...invoice, docType: null, extractionHadValues: false }, { totalPence: 12_000 })).toHaveLength(1);
    expect(warn({ ...invoice, docType: null, extractionHadValues: true }, { totalPence: 12_000 })).toHaveLength(0);
  });
});

test('todayInLondon answers the London calendar date, including the BST edge', () => {
  expect(todayInLondon(new Date('2026-09-05T12:00:00Z'))).toBe('2026-09-05');
  expect(todayInLondon(new Date('2026-07-04T23:30:00Z'))).toBe('2026-07-05');
});
