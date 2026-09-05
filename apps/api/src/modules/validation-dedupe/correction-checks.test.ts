import { expect, test } from 'vitest';

import {
  type CorrectionCheckContext,
  evaluateCorrectionChecks,
  IMPLAUSIBLY_OLD_YEARS,
  minusYears,
  money,
  todayInLondon,
} from './correction-checks.js';

const TODAY = '2026-09-05';

const invoice: CorrectionCheckContext = {
  docType: 'INVOICE',
  totalPence: 99_400,
  taxPence: 0,
  documentDate: '2025-07-30',
  currency: 'GBP',
  extractionHadValues: true,
};

const codes = (context: CorrectionCheckContext, fields: Parameters<typeof evaluateCorrectionChecks>[1]) =>
  evaluateCorrectionChecks(context, fields, TODAY).map((check) => check.code);

/* ── the arithmetic, as properties over ranges rather than one example ─────── */

test('tax exceeding the total warns, at every magnitude — the £9,000-on-£994 shape (item 22)', () => {
  // The reviewer's exact case, verbatim: £9,000.00 tax typed onto a £994.00
  // zero-rated invoice, accepted silently, dead at export.
  const flagship = evaluateCorrectionChecks(invoice, { taxPence: 900_000 }, TODAY);
  expect(flagship.map((c) => c.code)).toEqual(['tax-exceeds-total']);
  expect(flagship[0]?.message).toContain('Tax £9000.00 is larger than the total £994.00');
  expect(flagship[0]?.message).toContain('NO line in the export file');

  // Property: for totals spanning five orders of magnitude, any tax whose
  // magnitude exceeds the total's fires the check; any tax at or under it does
  // not (sign-agreement permitting).
  for (const total of [1, 99, 12_750, 99_400, 5_000_000, 999_999_999]) {
    expect(codes({ ...invoice, totalPence: total }, { taxPence: total + 1 })).toContain('tax-exceeds-total');
    expect(codes({ ...invoice, totalPence: total }, { taxPence: total })).not.toContain('tax-exceeds-total');
    expect(codes({ ...invoice, totalPence: total }, { taxPence: Math.floor(total / 5) })).toEqual([]);
    // The same property on a credit stored negative — magnitudes, not raw signs.
    expect(codes({ ...invoice, totalPence: -total }, { taxPence: -(total + 1) })).toContain('tax-exceeds-total');
    expect(codes({ ...invoice, totalPence: -total }, { taxPence: -Math.floor(total / 5) })).toEqual([]);
  }
});

test('tax and total pointing in opposite directions warns — the mixed-signs export refusal, said early', () => {
  expect(codes(invoice, { totalPence: 99_400, taxPence: -1_000 })).toEqual(['tax-total-signs-disagree']);
  expect(codes(invoice, { totalPence: -99_400, taxPence: 1_000 })).toEqual(['tax-total-signs-disagree']);
  // A zero on either side is not a direction; agreement is not questioned.
  expect(codes(invoice, { totalPence: 99_400, taxPence: 0 })).toEqual([]);
  expect(codes(invoice, { totalPence: 0, taxPence: 0 })).toEqual([]);
});

test('the checks read the AFTER values: a correction that also fixes the other figure is clean', () => {
  // A document already storing absurd tax, corrected total upward past it.
  const absurd = { ...invoice, taxPence: 900_000 };
  expect(codes(absurd, { totalPence: 1_000_000 })).toEqual([]);
  // And a correction that touches neither money field never re-litigates the
  // stored figures — confirming a supplier is not a tax review.
  expect(codes(absurd, { supplierName: 'Aldgate Meats Ltd' })).toEqual([]);
});

/* ── dates ─────────────────────────────────────────────────────────────────── */

test('a future document date warns; today and the past do not (item 46)', () => {
  const future = evaluateCorrectionChecks(invoice, { documentDate: '2027-08-09' }, TODAY);
  expect(future.map((c) => c.code)).toEqual(['date-in-future']);
  expect(future[0]?.message).toContain('9 Aug 2027');
  expect(codes(invoice, { documentDate: '2026-09-06' })).toEqual(['date-in-future']);
  expect(codes(invoice, { documentDate: TODAY })).toEqual([]);
  expect(codes(invoice, { documentDate: '2026-09-04' })).toEqual([]);
});

test('an implausibly old document date warns, with the boundary exactly at the window', () => {
  const boundary = minusYears(TODAY, IMPLAUSIBLY_OLD_YEARS); // 2019-09-05
  expect(codes(invoice, { documentDate: boundary })).toEqual([]);
  expect(codes(invoice, { documentDate: '2019-09-04' })).toEqual(['date-implausibly-old']);
  expect(codes(invoice, { documentDate: '1999-01-01' })).toEqual(['date-implausibly-old']);
  // A DUE date is routinely in the future and never questioned.
  expect(codes(invoice, { dueDate: '2027-08-09' })).toEqual([]);
});

test('minusYears is string arithmetic, and 29 Feb clamps rather than inventing a date', () => {
  expect(minusYears('2026-09-05', 7)).toBe('2019-09-05');
  expect(minusYears('2028-02-29', 7)).toBe('2021-02-28');
});

/* ── the non-financial document (item 47) ──────────────────────────────────── */

test('money or category typed onto a Type OTHER document warns; the same edit on an invoice does not', () => {
  const selfie: CorrectionCheckContext = { ...invoice, docType: 'OTHER', extractionHadValues: false };
  for (const fields of [
    { totalPence: 7_654_300 },
    { categoryCode: 'SOFTWARE_AND_SUBSCRIPTIONS' },
    { currency: 'GBP' },
  ] as const) {
    expect(codes(selfie, fields)).toContain('not-a-financial-document');
  }
  // A non-financial correction (naming the supplier, fixing the date) does not
  // carry the warning — it asserts no figure.
  expect(codes(selfie, { supplierName: 'gf' })).toEqual([]);
  // And correcting Type in the same breath does not quiet it: the image is
  // still the image, and the warning is about what the PIPELINE read.
  expect(codes(selfie, { docType: 'RECEIPT', totalPence: 7_654_300 })).toContain('not-a-financial-document');
});

test('an extraction that read nothing warns on financial corrections even when the type is unclassified', () => {
  const blank: CorrectionCheckContext = { ...invoice, docType: null, extractionHadValues: false };
  expect(codes(blank, { totalPence: 12_000 })).toContain('not-a-financial-document');
  const readable: CorrectionCheckContext = { ...invoice, docType: null, extractionHadValues: true };
  expect(codes(readable, { totalPence: 12_000 })).toEqual([]);
});

/* ── the helpers the messages depend on ────────────────────────────────────── */

test('money renders integer pence by string arithmetic, in the document currency, bare when unknown', () => {
  // No thousands separator — the render-summary penceToMoney convention.
  expect(money(900_000, 'GBP')).toBe('£9000.00');
  expect(money(99_400, 'GBP')).toBe('£994.00');
  expect(money(-8_840, 'GBP')).toBe('-£88.40');
  expect(money(5_435_251, 'USD')).toBe('$54352.51');
  expect(money(1, null)).toBe('0.01');
  expect(money(123, 'JPY')).toBe('JPY 1.23');
});

test('todayInLondon answers a calendar date shape', () => {
  expect(todayInLondon(new Date('2026-09-05T12:00:00Z'))).toBe('2026-09-05');
  // The BST edge: 23:30 UTC on the 4th is already the 5th in London in summer.
  expect(todayInLondon(new Date('2026-07-04T23:30:00Z'))).toBe('2026-07-05');
});
