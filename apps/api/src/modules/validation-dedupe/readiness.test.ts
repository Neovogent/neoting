import { expect, test } from 'vitest';

import { evaluateReadiness, resolveProcessedState } from './readiness.js';

const complete = { totalPence: 12750, supplierName: 'Bidfood', categoryCode: 'Cost of Sales — Food' };

test('total + supplier + category present and no validator failure → READY', () => {
  expect(evaluateReadiness(complete)).toEqual({ ready: true, missing: [], blockedByValidator: false });
  expect(resolveProcessedState(complete)).toBe('READY');
});

test('each missing field is named, and any missing field blocks READY', () => {
  expect(evaluateReadiness({ ...complete, totalPence: null }).missing).toEqual(['total']);
  expect(evaluateReadiness({ ...complete, supplierName: null }).missing).toEqual(['supplier']);
  expect(evaluateReadiness({ ...complete, categoryCode: null }).missing).toEqual(['category']);
  expect(
    evaluateReadiness({ totalPence: null, supplierName: null, categoryCode: null }).missing,
  ).toEqual(['total', 'supplier', 'category']);
  expect(resolveProcessedState({ ...complete, supplierName: null })).toBe('TO_REVIEW');
});

test('zero pence is a real total; whitespace is not a real supplier or category', () => {
  // A £0.00 credit line is extracted data; an unextracted total is null. The
  // distinction is the difference between "confirmed zero" and "unknown".
  expect(evaluateReadiness({ ...complete, totalPence: 0 }).ready).toBe(true);
  expect(evaluateReadiness({ ...complete, supplierName: '   ' }).missing).toEqual(['supplier']);
  expect(evaluateReadiness({ ...complete, categoryCode: '' }).missing).toEqual(['category']);
});

test('a failed validator blocks READY even with every field present', () => {
  const result = evaluateReadiness(complete, { validatorFailed: true });
  expect(result.ready).toBe(false);
  expect(result.missing).toEqual([]); // nothing to type in — the fields disagree, a human decides
  expect(result.blockedByValidator).toBe(true);
  expect(resolveProcessedState(complete, { validatorFailed: true })).toBe('TO_REVIEW');
});
