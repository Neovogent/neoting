import { expect, test } from 'vitest';

import { isChaseSuppressed, SUPPRESSION_DESCRIPTORS } from './suppression.js';

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
