import { expect, test } from 'vitest';

import { CHASE_MATCH_AMOUNT_TOLERANCE_PENCE, CHASE_MATCH_DATE_WINDOW_DAYS } from '../../chase/index.js';
import {
  type CandidateDocument,
  reconcileSupplierStatement,
  type StatementLineInput,
  statementLineMatchesDocument,
  totalsOf,
} from './reconcile.js';

/**
 * The pure reconciliation (issue #318). What is pinned:
 *
 *  - the ruler is the chase lane's `chaseMatchesDocument` — the shared
 *    tolerance and window are read off the seam, not restated here;
 *  - one document answers at most one line, and the pick order is reference →
 *    amount → date → id, so the result is the same on every read;
 *  - a credit line answers only to a credit note;
 *  - an unread amount is `UNREADABLE`, never silently `MISSING`;
 *  - the totals are integer pence and add up.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-09-05T00:00:00.000Z');
const at = (days: number): Date => new Date(T0.getTime() + days * DAY);

function line(id: string, over: Partial<StatementLineInput> = {}): StatementLineInput {
  return { id, reference: `BRK-${id}`, lineDate: T0, amountPence: 214_075, ...over };
}

function doc(id: string, over: Partial<CandidateDocument> = {}): CandidateDocument {
  return {
    id,
    supplierName: 'Brakes Foodservice',
    totalPence: 214_075,
    documentDate: T0,
    reference: null,
    docType: 'INVOICE',
    ...over,
  };
}

// ---- the adapter onto the one ruler ----

test('a line is answered by a document that agrees on supplier, amount and date', () => {
  expect(statementLineMatchesDocument(line('1'), 'Brakes', doc('d1'))).toBe(true);
});

test('the amount tolerance is the chase lane’s — on the boundary passes, one penny over fails', () => {
  const onBoundary = doc('d1', { totalPence: 214_075 + CHASE_MATCH_AMOUNT_TOLERANCE_PENCE });
  const overBoundary = doc('d2', { totalPence: 214_075 + CHASE_MATCH_AMOUNT_TOLERANCE_PENCE + 1 });
  expect(statementLineMatchesDocument(line('1'), 'Brakes', onBoundary)).toBe(true);
  expect(statementLineMatchesDocument(line('1'), 'Brakes', overBoundary)).toBe(false);
});

test('the date window is the chase lane’s — inside passes, outside fails', () => {
  expect(statementLineMatchesDocument(line('1'), 'Brakes', doc('d1', { documentDate: at(CHASE_MATCH_DATE_WINDOW_DAYS) }))).toBe(true);
  expect(statementLineMatchesDocument(line('1'), 'Brakes', doc('d2', { documentDate: at(CHASE_MATCH_DATE_WINDOW_DAYS + 1) }))).toBe(false);
});

test('an undated line skips the date gate, exactly as an undated document does', () => {
  const farAway = doc('d1', { documentDate: at(400) });
  expect(statementLineMatchesDocument(line('1', { lineDate: null }), 'Brakes', farAway)).toBe(true);
  expect(statementLineMatchesDocument(line('1'), 'Brakes', doc('d2', { documentDate: null }))).toBe(true);
});

test('a different supplier never answers, whatever the amount', () => {
  expect(statementLineMatchesDocument(line('1'), 'Brakes', doc('d1', { supplierName: 'Bidfood' }))).toBe(false);
  // The ruler's whole-token rule: `Bra` must not answer `Brakes`.
  expect(statementLineMatchesDocument(line('1'), 'Bra', doc('d2'))).toBe(false);
});

test('a line with no amount can be answered by nothing', () => {
  expect(statementLineMatchesDocument(line('1', { amountPence: null }), 'Brakes', doc('d1'))).toBe(false);
});

test('a credit line answers only to a credit note, and an invoice line never does', () => {
  const credit = line('1', { amountPence: -8_840 });
  expect(statementLineMatchesDocument(credit, 'Brakes', doc('cn', { totalPence: 8_840, docType: 'CREDIT_NOTE' }))).toBe(true);
  expect(statementLineMatchesDocument(credit, 'Brakes', doc('inv', { totalPence: 8_840, docType: 'INVOICE' }))).toBe(false);
  expect(statementLineMatchesDocument(line('2', { amountPence: 8_840 }), 'Brakes', doc('cn2', { totalPence: 8_840, docType: 'CREDIT_NOTE' }))).toBe(false);
  // An untyped document reads as "not a credit note".
  expect(statementLineMatchesDocument(line('3', { amountPence: 8_840 }), 'Brakes', doc('untyped', { totalPence: 8_840, docType: null }))).toBe(true);
});

// ---- the reconciliation ----

test('matched, missing and unreadable lines each carry their outcome, and the totals add up', () => {
  const result = reconcileSupplierStatement(
    'Brakes',
    [
      line('held', { amountPence: 214_075 }),
      line('gone', { amountPence: 84_215, lineDate: at(-3) }),
      line('blank', { amountPence: null, lineDate: at(-5) }),
    ],
    [doc('d1', { totalPence: 214_075 })],
  );

  const byId = new Map(result.lines.map((l) => [l.id, l]));
  expect(byId.get('held')).toMatchObject({ outcome: 'MATCHED', matchedDocumentId: 'd1' });
  expect(byId.get('gone')).toMatchObject({ outcome: 'MISSING', matchedDocumentId: null });
  expect(byId.get('blank')).toMatchObject({ outcome: 'UNREADABLE', matchedDocumentId: null, amountPence: null });
  expect(result.totals).toEqual({
    lineCount: 3,
    matchedCount: 1,
    missingCount: 1,
    unreadableCount: 1,
    statementTotalPence: 214_075 + 84_215,
    matchedTotalPence: 214_075,
    missingTotalPence: 84_215,
  });
});

test('lines come back oldest first, undated last, so the walk order is stable', () => {
  const result = reconcileSupplierStatement(
    'Brakes',
    [line('c', { lineDate: null }), line('b', { lineDate: at(2) }), line('a', { lineDate: at(-2) })],
    [],
  );
  expect(result.lines.map((l) => l.id)).toEqual(['a', 'b', 'c']);
});

test('one document answers at most one line — two identical lines against one document yield one MATCHED and one MISSING', () => {
  const result = reconcileSupplierStatement(
    'Brakes',
    [line('first', { lineDate: at(0) }), line('second', { lineDate: at(1) })],
    [doc('d1')],
  );
  expect(result.lines.map((l) => [l.id, l.outcome, l.matchedDocumentId])).toEqual([
    ['first', 'MATCHED', 'd1'],
    ['second', 'MISSING', null],
  ]);
  expect(result.totals.missingCount).toBe(1);
});

test('when several documents fit, a matching printed reference wins over a closer amount', () => {
  const result = reconcileSupplierStatement(
    'Brakes',
    [line('1', { reference: 'INV-0042', amountPence: 214_075 })],
    [
      doc('closer', { totalPence: 214_075, reference: 'INV-0099' }),
      doc('referenced', { totalPence: 214_075 + 50, reference: 'inv 0042' }),
    ],
  );
  expect(result.lines[0]?.matchedDocumentId).toBe('referenced');
});

test('with no reference match the closest amount wins, then the closest date, then the id', () => {
  const byAmount = reconcileSupplierStatement(
    'Brakes',
    [line('1', { reference: null })],
    [doc('off-by-50', { totalPence: 214_125 }), doc('exact', { totalPence: 214_075 })],
  );
  expect(byAmount.lines[0]?.matchedDocumentId).toBe('exact');

  const byDate = reconcileSupplierStatement(
    'Brakes',
    [line('1', { reference: null })],
    [doc('three-days', { documentDate: at(3) }), doc('one-day', { documentDate: at(1) })],
  );
  expect(byDate.lines[0]?.matchedDocumentId).toBe('one-day');

  const byId = reconcileSupplierStatement('Brakes', [line('1', { reference: null })], [doc('z'), doc('a')]);
  expect(byId.lines[0]?.matchedDocumentId).toBe('a');
});

test('the same statement and documents reconcile identically whatever order they arrive in', () => {
  const lines = [line('a', { lineDate: at(0) }), line('b', { lineDate: at(1), amountPence: 84_215 })];
  const docs = [doc('d1'), doc('d2', { totalPence: 84_215, documentDate: at(1) })];
  const forward = reconcileSupplierStatement('Brakes', lines, docs);
  const backward = reconcileSupplierStatement('Brakes', [...lines].reverse(), [...docs].reverse());
  expect(backward).toEqual(forward);
});

test('totals of nothing are zeros, not nulls', () => {
  expect(totalsOf([])).toEqual({
    lineCount: 0,
    matchedCount: 0,
    missingCount: 0,
    unreadableCount: 0,
    statementTotalPence: 0,
    matchedTotalPence: 0,
    missingTotalPence: 0,
  });
});
