import { expect, test } from 'vitest';

import { parseSupplierStatements, toLiveSupplierStatement } from './supplierStatements';

/**
 * The boundary (issue #318): pence become pounds HERE and nowhere else, the
 * contract's own Zod is the oracle, and the generated envelope is unwrapped by
 * shape (the `documents.test.ts` both-shapes pin).
 */

const row = {
  id: 'sst_1',
  businessId: 'biz_cosmo',
  documentId: 'doc_statement',
  fileName: 'brakes-statement-aug-2026.pdf',
  supplierName: 'Brakes',
  statementEndDate: '2026-09-04',
  outstandingBalancePence: 486_030,
  lines: [
    { id: 'ssl_2', reference: 'BRK-551876', lineDate: '2026-08-27', amountPence: 84_215, outcome: 'MISSING', matchedDocumentId: null },
    { id: 'ssl_1', reference: 'BRK-551204', lineDate: '2026-08-31', amountPence: 214_075, outcome: 'MATCHED', matchedDocumentId: 'doc_brakes' },
    { id: 'ssl_3', reference: null, lineDate: null, amountPence: null, outcome: 'UNREADABLE', matchedDocumentId: null },
  ],
  totals: {
    lineCount: 3,
    matchedCount: 1,
    missingCount: 1,
    unreadableCount: 1,
    statementTotalPence: 298_290,
    matchedTotalPence: 214_075,
    missingTotalPence: 84_215,
  },
  createdAt: '2026-09-05T09:00:00.000Z',
} as const;

test('pence become pounds at the boundary, dates become UK display dates, nulls stay honest', () => {
  const live = toLiveSupplierStatement({ ...row, lines: [...row.lines] });
  expect(live).toMatchObject({
    id: 'sst_1',
    supplier: 'Brakes',
    fileName: 'brakes-statement-aug-2026.pdf',
    statementEndDate: '04 Sep 2026',
    outstandingBalance: 4860.3,
    uploadedAt: '05 Sep 2026',
  });
  expect(live.lines).toEqual([
    { id: 'ssl_2', reference: 'BRK-551876', date: '27 Aug 2026', amount: 842.15, outcome: 'MISSING', matchedDocumentId: null },
    { id: 'ssl_1', reference: 'BRK-551204', date: '31 Aug 2026', amount: 2140.75, outcome: 'MATCHED', matchedDocumentId: 'doc_brakes' },
    { id: 'ssl_3', reference: '—', date: '—', amount: null, outcome: 'UNREADABLE', matchedDocumentId: null },
  ]);
  expect(live.totals).toEqual({
    lineCount: 3,
    matchedCount: 1,
    missingCount: 1,
    unreadableCount: 1,
    statementTotal: 2982.9,
    matchedTotal: 2140.75,
    missingTotal: 842.15,
  });
});

test('an absent end date reads as null → em dash, never a guessed date', () => {
  const { statementEndDate: _dropped, ...withoutEnd } = row;
  const live = toLiveSupplierStatement({ ...withoutEnd, lines: [...row.lines] });
  expect(live.statementEndDate).toBe('—');
  expect(live.outstandingBalance).toBe(4860.3);
});

test('the parse accepts the raw body AND the typed envelope (the mutator returns the body)', () => {
  const body = { items: [row] };
  expect(parseSupplierStatements(body)).toHaveLength(1);
  expect(parseSupplierStatements({ data: body, status: 200 })).toHaveLength(1);
});

test('a float in a pence field is a contract error, not a wrong number on screen', () => {
  // Bound to a name first: the R5 lint rule refuses a float LITERAL in a
  // `*Pence` slot, which is exactly the shape this test feeds the parser to
  // prove the generated `.int()` refuses it at run time too.
  const notAnInteger = 4860.3;
  const bad = { items: [{ ...row, outstandingBalancePence: notAnInteger }] };
  expect(() => parseSupplierStatements(bad)).toThrow();
});
