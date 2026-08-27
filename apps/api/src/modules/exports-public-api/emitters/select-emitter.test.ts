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

  // Both keep both nominals now. VT used to collapse to one row and warn; A10
  // showed VT imports a split analysis perfectly well, so that collapse — and
  // the `analysis-collapsed` warning that confessed to it — is gone.
  expect(vt.rowCount).toBe(2);
  expect(generic.rowCount).toBe(2);
  expect(vt.warnings.map((warning) => warning.code)).not.toContain('analysis-collapsed');
  expect(generic.warnings).toStrictEqual([]);

  // They still disagree, which is the point of the seam — just about different
  // things than before. VT is now an archive of per-date, per-direction CSVs
  // with no header, no type code and no date column; generic is one flat CSV
  // carrying the canonical sign and ISO dates.
  expect(selectEmitter('VT_TRANSACTION_PLUS').fileExtension).toBe('zip');
  expect(selectEmitter('GENERIC_CSV').fileExtension).toBe('csv');

  const genericText = generic.bytes.toString('utf8');
  expect(genericText).toContain('2026-08-04');
  expect(genericText).toContain('-30.00');

  // The VT bytes are a ZIP, so the CSV text lives inside it. Proving the date
  // reached the *filename* rather than a column is the whole A10 finding.
  const vtArchive = vt.bytes.toString('latin1');
  expect(vtArchive.startsWith('PK')).toBe(true);
  expect(vtArchive).toContain('2026-08-04-purchase-credit-notes.csv');
  // No type column any more: the format the accountant picks decides direction.
  expect(vtArchive).not.toContain('PCR');
});
