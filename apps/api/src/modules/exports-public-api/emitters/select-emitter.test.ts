import { expect, test } from 'vitest';

import type { CanonicalTransactionDocument } from '../canonical/canonical-row.js';

import { selectEmitter } from './select-emitter.js';

// The point of this file: prove VT is *an* emitter rather than *the*
// architecture (§24.3, §21). Two emitters read the same canonical rows and
// disagree about sign, date format and row count, and neither needed the model
// to change to disagree.

const twoNominals: CanonicalTransactionDocument = {
  family: 'TRANSACTION_DOCUMENT',
  documentId: 'doc_1',
  businessId: 'biz_1',
  sourceLink: { code: 'A7K2M9', url: 'https://neoacc.neovogent.com/d/A7K2M9' },
  party: 'SUPPLIER',
  instrument: 'CREDIT_NOTE',
  date: '2026-08-04',
  primaryAccount: 'Acme Ltd',
  reference: 'CRN-9',
  grossPence: -12000,
  vatPence: -2000,
  netPence: -10000,
  analysis: [
    { analysisAccount: 'Cost of sales: Purchases', netPence: -3000, vatPence: -600 },
    { analysisAccount: 'Expenses: Motor expenses', netPence: -7000, vatPence: -1400 },
  ],
};

test('each target resolves to its own emitter', () => {
  expect(selectEmitter('VT_TRANSACTION_PLUS').target).toBe('VT_TRANSACTION_PLUS');
  expect(selectEmitter('GENERIC_CSV').target).toBe('GENERIC_CSV');
});

test('one canonical row, two targets, two different files', () => {
  const vt = selectEmitter('VT_TRANSACTION_PLUS').emit([twoNominals]);
  const generic = selectEmitter('GENERIC_CSV').emit([twoNominals]);

  // VT collapses to one nominal per row and says so; generic keeps both.
  expect(vt.rowCount).toBe(1);
  expect(generic.rowCount).toBe(2);
  expect(vt.warnings.map((warning) => warning.code)).toContain('analysis-collapsed');
  expect(generic.warnings).toStrictEqual([]);

  const vtText = vt.bytes.toString('utf8');
  const genericText = generic.bytes.toString('utf8');

  // VT: magnitudes and UK d/m/y. Generic: the canonical sign and ISO dates.
  expect(vtText).toContain('04/08/2026');
  expect(vtText).toContain('PCR');
  expect(genericText).toContain('2026-08-04');
  expect(genericText).toContain('-30.00');
  expect(vtText).not.toContain('-30.00');
});
