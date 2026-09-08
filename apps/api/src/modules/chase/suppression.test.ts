import { describe, expect, it, test } from 'vitest';

import { ALL_SUPPRESSION_DESCRIPTORS, isChaseSuppressed, SUPPRESSION_DESCRIPTORS } from './suppression.js';

test('the list is the SoT Stage 7 descriptors, verbatim and upper-case', () => {
  // Pinned against SoT §4 Stage 7: SERVICE CHARGE · COMMISSION · CHG · CHAPS ·
  // UNPAID · OD INTEREST · SUMUP · WORLDPAY · STRIPE PAYOUT.
  expect([...SUPPRESSION_DESCRIPTORS]).toEqual([
    'SERVICE CHARGE',
    'COMMISSION',
    'CHG',
    'CHAPS',
    'UNPAID',
    'OD INTEREST',
    'SUMUP',
    'WORLDPAY',
    'STRIPE PAYOUT',
  ]);
});

test('a suppressed descriptor matches inside the bank feed free text, case-insensitively', () => {
  expect(isChaseSuppressed('STRIPE PAYOUT 12 AUG')).toBe(true);
  expect(isChaseSuppressed('service charge - Q3')).toBe(true); // lower-case feed
  expect(isChaseSuppressed('MONTHLY SERVICE CHARGE APPLIED')).toBe(true); // substring
  expect(isChaseSuppressed('OD INTEREST 0.4%')).toBe(true);
  expect(isChaseSuppressed('WORLDPAY SETTLEMENT')).toBe(true);
});

test('a real supplier line is NOT suppressed — nobody misses a chaseable receipt', () => {
  expect(isChaseSuppressed('CURRYS 1234 LONDON')).toBe(false);
  expect(isChaseSuppressed('GOOGLE ADS')).toBe(false);
  expect(isChaseSuppressed('BIDFOOD UK LTD')).toBe(false);
});

test('an empty descriptor never matches', () => {
  expect(isChaseSuppressed('')).toBe(false);
});

describe('the descriptors found live on 8 Sep 2026', () => {
  it('never asks a client for the receipt for their own payroll', () => {
    // The real chase that went out: "we're missing the receipts for FRESH
    // DIRECT CD 4211 on 14 Aug, PAYROLL AUG STAFF on 21 Aug and HMRC VAT on
    // 28 Aug." Two of those three have no supplier document in existence.
    expect(isChaseSuppressed('PAYROLL AUG STAFF')).toBe(true);
    expect(isChaseSuppressed('HMRC VAT')).toBe(true);
  });

  it('still chases an ordinary supplier payment', () => {
    // The cost of a false positive is a document never collected, so the
    // additions must not widen into anything with paperwork behind it.
    expect(isChaseSuppressed('FRESH DIRECT CD 4211')).toBe(false);
    expect(isChaseSuppressed('BIDFOOD LTD CD 4211')).toBe(false);
    expect(isChaseSuppressed('WOLSELEY UK CD 4211')).toBe(false);
    expect(isChaseSuppressed('LONDON LINEN DD')).toBe(false);
  });

  it('keeps the SoT-verbatim list quotable', () => {
    // The citation in this file must stay checkable against SoT §4 Stage 7,
    // which is why the additions are a separate export rather than appended.
    expect(SUPPRESSION_DESCRIPTORS).not.toContain('PAYROLL');
    expect(ALL_SUPPRESSION_DESCRIPTORS).toContain('PAYROLL');
  });
});
