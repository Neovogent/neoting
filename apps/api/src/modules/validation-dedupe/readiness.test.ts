import { expect, test } from 'vitest';

import { evaluateReadiness, resolveProcessedState } from './readiness.js';

const complete = { totalPence: 12750, supplierName: 'Bidfood', categoryCode: 'Cost of Sales — Food', docType: 'INVOICE' as const };

test('total + supplier + category present and no validator failure → READY', () => {
  expect(evaluateReadiness(complete)).toEqual({ ready: true, missing: [], blockedByValidator: false });
  expect(resolveProcessedState(complete)).toBe('READY');
});

test('each missing field is named, and any missing field blocks READY', () => {
  expect(evaluateReadiness({ ...complete, totalPence: null }).missing).toEqual(['total']);
  expect(evaluateReadiness({ ...complete, supplierName: null }).missing).toEqual(['supplier']);
  expect(evaluateReadiness({ ...complete, categoryCode: null }).missing).toEqual(['category']);
  expect(
    evaluateReadiness({ totalPence: null, supplierName: null, categoryCode: null, docType: null }).missing,
  ).toEqual(['type', 'total', 'supplier', 'category']);
  expect(resolveProcessedState({ ...complete, supplierName: null })).toBe('TO_REVIEW');
});

test('a zero total blocks READY — the publish gates have never accepted £0.00', () => {
  // This pinned the opposite until 2026-09-03 ("a £0.00 credit line is a real
  // total"). Both publish surfaces refuse a zero total, so a 0p document
  // classified READY here rendered "Ready — blocked" there — a document in the
  // nothing-left-to-do tab wearing a something-left-to-do badge. Readiness
  // cannot tell a placeholder zero from a confirmed one; TO_REVIEW can.
  expect(evaluateReadiness({ ...complete, totalPence: 0 }).missing).toEqual(['total']);
  expect(resolveProcessedState({ ...complete, totalPence: 0 })).toBe('TO_REVIEW');
  // A credit stored as negative pence is a real total.
  expect(evaluateReadiness({ ...complete, totalPence: -8_840 }).ready).toBe(true);
  expect(evaluateReadiness({ ...complete, supplierName: '   ' }).missing).toEqual(['supplier']);
  expect(evaluateReadiness({ ...complete, categoryCode: '' }).missing).toEqual(['category']);
});

test('placeholder junk is not a supplier and not a category', () => {
  // What an extractor leaves where a value should be — the literal word
  // "Unknown", an "n/a", a "—" — counts as missing exactly like null does,
  // matching the web's EMPTY list (apps/web/src/lib/readiness.ts). Before this,
  // a placeholder classified READY and the publish gate refused it: the
  // "Ready — blocked" contradiction.
  for (const junk of ['Unknown', 'unknown', ' UNKNOWN ', '—', '-', 'n/a', 'N/A', 'extracting…', 'Extracting...']) {
    expect(evaluateReadiness({ ...complete, supplierName: junk }).missing).toEqual(['supplier']);
    expect(evaluateReadiness({ ...complete, categoryCode: junk }).missing).toEqual(['category']);
  }
  // A real name that merely contains a placeholder word is untouched.
  expect(evaluateReadiness({ ...complete, supplierName: 'Unknown Pleasures Ltd' }).ready).toBe(true);
});

test('a placeholder-filled document is TO_REVIEW; filling the fields makes it READY', () => {
  // The observed defect, end to end at the unit: supplier "Unknown", £0.00,
  // category "—" must never classify READY — it belongs in To Review, the
  // queue for a human to finish it. Supplying real values flips the answer.
  const placeholders = { totalPence: 0, supplierName: 'Unknown', categoryCode: '—', docType: 'RECEIPT' as const };
  expect(evaluateReadiness(placeholders).missing).toEqual(['total', 'supplier', 'category']);
  expect(resolveProcessedState(placeholders)).toBe('TO_REVIEW');

  // Each fill removes exactly its own name from the answer…
  expect(evaluateReadiness({ ...placeholders, totalPence: 12_750 }).missing).toEqual(['supplier', 'category']);
  expect(evaluateReadiness({ ...placeholders, totalPence: 12_750, supplierName: 'Bidfood' }).missing).toEqual(['category']);
  // …and the last one moves the document to READY.
  expect(resolveProcessedState({ totalPence: 12_750, supplierName: 'Bidfood', categoryCode: 'Cost of Sales — Food', docType: 'RECEIPT' })).toBe('READY');
});

test('a failed validator blocks READY even with every field present', () => {
  const result = evaluateReadiness(complete, { validatorFailed: true });
  expect(result.ready).toBe(false);
  expect(result.missing).toEqual([]); // nothing to type in — the fields disagree, a human decides
  expect(result.blockedByValidator).toBe(true);
  expect(resolveProcessedState(complete, { validatorFailed: true })).toBe('TO_REVIEW');
});

test('the TYPE gate (items 36/47): OTHER or unclassified blocks READY, first in the answer', () => {
  // The selfie shape: extractor said OTHER, a human typed junk into the three
  // field slots — before 2026-09-05 that satisfied the whole rule.
  expect(evaluateReadiness({ ...complete, docType: 'OTHER' }).missing).toEqual(['type']);
  expect(resolveProcessedState({ ...complete, docType: 'OTHER' })).toBe('TO_REVIEW');
  // Never classified is not classified-as-financial.
  expect(evaluateReadiness({ ...complete, docType: null }).missing).toEqual(['type']);
  // 'type' leads the list: "confirm what this document is" precedes its fields.
  expect(
    evaluateReadiness({ totalPence: null, supplierName: 'Bidfood', categoryCode: 'Food', docType: 'OTHER' }).missing,
  ).toEqual(['type', 'total']);
  // Every financial type passes; STATEMENT is deliberately not gated here (it
  // can never reach READY on its fields, and 'type' would mislabel the reason).
  for (const docType of ['INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'STATEMENT'] as const) {
    expect(evaluateReadiness({ ...complete, docType }).ready).toBe(true);
  }
});
