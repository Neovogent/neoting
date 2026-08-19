import { expect, test } from 'vitest';

import {
  checkPublishMinimum,
  computePublishPreview,
  previewPublishBatch,
  PUBLISH_MINIMUM_CODE,
  type PublishPreviewItem,
} from './publish-preview.js';

/**
 * American Burger's three publishable Ready documents, with the seed's own
 * pence (seed.ts `withVat`, 20% inclusive): Bidfood £1,284.50, British Gas
 * £412.66, the Bidfood credit note £88.40. If the seed's arithmetic ever
 * changes, this test is where the demo's headline number changes with it.
 */
const READY_BATCH: readonly PublishPreviewItem[] = [
  { id: 'doc_001', supplierName: 'Bidfood', categoryCode: 'Cost of Sales — Food', totalPence: 128_450, taxPence: 21_408 },
  { id: 'doc_007', supplierName: 'British Gas', categoryCode: 'Utilities', totalPence: 41_266, taxPence: 6_878 },
  { id: 'doc_012', supplierName: 'Bidfood', categoryCode: 'Cost of Sales — Food', totalPence: 8_840, taxPence: 1_473 },
];

test('the preview is integer pence, summed and nothing else', () => {
  expect(computePublishPreview(READY_BATCH)).toEqual({ itemCount: 3, grossPence: 178_556, vatPence: 29_759 });
});

test('a null VAT contributes nothing and does not block the batch', () => {
  const preview = computePublishPreview([{ id: 'd', supplierName: 'Nisbets', categoryCode: 'Equipment', totalPence: 5_000, taxPence: null }]);

  expect(preview).toEqual({ itemCount: 1, grossPence: 5_000, vatPence: 0 });
  expect(Number.isInteger(preview.vatPence)).toBe(true);
});

test('an empty batch sums to zero — minItems 1 is the contract boundary job, not this one', () => {
  expect(previewPublishBatch([])).toEqual({ ok: true, preview: { itemCount: 0, grossPence: 0, vatPence: 0 } });
});

test('a £0.00 total is a confirmed value, not a missing one', () => {
  expect(checkPublishMinimum({ id: 'd', supplierName: 'Bidfood', categoryCode: 'Cost of Sales — Food', totalPence: 0, taxPence: 0 })).toBeNull();
});

test('a document with no category refuses with NT-PUB-001 naming the field', () => {
  // doc_004 in the seed: Currys, £1,299.00, extracted but uncoded.
  const refusal = checkPublishMinimum({ id: 'doc_004', supplierName: 'Currys', categoryCode: null, totalPence: 129_900, taxPence: 21_650 });

  expect(refusal?.code).toBe(PUBLISH_MINIMUM_CODE);
  expect(refusal?.documentId).toBe('doc_004');
  expect(refusal?.missing).toEqual(['category']);
  expect(refusal?.message).toContain('category');
});

test('a sales document with no supplier refuses too — the minimum is all three fields', () => {
  // doc_010 in the seed: Just Eat, SALES inbox, so supplier_name is null.
  const refusal = checkPublishMinimum({ id: 'doc_010', supplierName: null, categoryCode: 'Sales — Delivery', totalPence: 284_155, taxPence: 47_359 });

  expect(refusal?.missing).toEqual(['supplier']);
});

test('a whitespace-only supplier or category is an extraction artefact, not an answer', () => {
  const refusal = checkPublishMinimum({ id: 'd', supplierName: '   ', categoryCode: '', totalPence: 100, taxPence: 0 });

  expect(refusal?.missing).toEqual(['supplier', 'category']);
});

test('every missing field is named, in plain English', () => {
  const refusal = checkPublishMinimum({ id: 'd', supplierName: null, categoryCode: null, totalPence: null, taxPence: null });

  expect(refusal?.missing).toEqual(['total', 'supplier', 'category']);
  expect(refusal?.message).toContain('total, supplier and category');
});

test('one bad item refuses the whole batch, and EVERY bad item is reported', () => {
  const outcome = previewPublishBatch([
    ...READY_BATCH,
    { id: 'doc_004', supplierName: 'Currys', categoryCode: null, totalPence: 129_900, taxPence: 21_650 },
    { id: 'doc_010', supplierName: null, categoryCode: 'Sales — Delivery', totalPence: 284_155, taxPence: 47_359 },
  ]);

  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  // No totals are offered at all — a preview must never describe a batch that
  // cannot run, and one round trip tells the human everything to fix.
  expect(outcome.refusals.map((refusal) => refusal.documentId)).toEqual(['doc_004', 'doc_010']);
});

test('a fully coded batch previews exactly what Read review renders', () => {
  const outcome = previewPublishBatch(READY_BATCH);

  expect(outcome).toEqual({ ok: true, preview: { itemCount: 3, grossPence: 178_556, vatPence: 29_759 } });
});
