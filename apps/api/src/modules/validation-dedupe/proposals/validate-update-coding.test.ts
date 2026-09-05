import { expect, test } from 'vitest';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import {
  assertUpdateCodingAllowed,
  type ChartCategoriesReader,
  computeCorrectionAdvisory,
} from './validate-update-coding.js';

interface DocRow {
  id: string;
  businessId: string | null;
  docType: string | null;
  totalPence: number | null;
  taxPence: number | null;
  documentDate: Date | null;
  currency: string | null;
}

function fakeDb(rows: DocRow[], acceptedFields: Record<string, Record<string, unknown>> = {}): ScopedClient {
  const map = new Map(rows.map((r) => [r.id, r]));
  return {
    document: {
      findUnique: async ({ where }: { where: { id: string } }) => map.get(where.id) ?? null,
    },
    extraction: {
      findFirst: async ({ where }: { where: { documentId: string } }) => {
        const fields = acceptedFields[where.documentId];
        return fields === undefined ? null : { fields };
      },
    },
  } as unknown as ScopedClient;
}

const CHART: ChartCategoriesReader = async () => [
  { code: 'COS_FOOD' },
  { code: 'SOFTWARE_AND_SUBSCRIPTIONS' },
];

const zeplowInvoice: DocRow = {
  id: 'doc_1',
  businessId: 'biz_zeplow',
  docType: 'INVOICE',
  totalPence: 99_400,
  taxPence: 0,
  documentDate: new Date('2025-07-30T00:00:00.000Z'),
  currency: 'GBP',
};

/* ── the HARD rule: chart membership, refuse-never-fuzzy (item 47) ─────────── */

test('a category that is not a code on the chart is refused, naming the string and the rule', async () => {
  const db = fakeDb([zeplowInvoice]);
  await expect(
    assertUpdateCodingAllowed(db, { documentId: 'doc_1', fields: { categoryCode: 'jhngbhf' } }, CHART),
  ).rejects.toMatchObject({
    constructor: ProposalExecutionRefused,
    message: expect.stringContaining('"jhngbhf" is not a code on this client\'s chart of accounts'),
  });
});

test('a near miss is a refusal, never a match — one character away is still off the chart', async () => {
  const db = fakeDb([zeplowInvoice]);
  await expect(
    assertUpdateCodingAllowed(db, { documentId: 'doc_1', fields: { categoryCode: 'COS_FOODS' } }, CHART),
  ).rejects.toBeInstanceOf(ProposalExecutionRefused);
});

test('an exact chart code passes, and a correction naming no category never reads the chart', async () => {
  const db = fakeDb([zeplowInvoice]);
  await expect(
    assertUpdateCodingAllowed(db, { documentId: 'doc_1', fields: { categoryCode: 'COS_FOOD' } }, CHART),
  ).resolves.toBeUndefined();

  let chartRead = false;
  const spy: ChartCategoriesReader = async () => {
    chartRead = true;
    return [];
  };
  await assertUpdateCodingAllowed(db, { documentId: 'doc_1', fields: { supplierName: 'Aldgate Meats Ltd' } }, spy);
  expect(chartRead).toBe(false);
});

test('an unreachable document refuses at creation — 404-never-403 posture, before anything is stored', async () => {
  const db = fakeDb([]);
  await expect(
    assertUpdateCodingAllowed(db, { documentId: 'doc_missing', fields: { categoryCode: 'COS_FOOD' } }, CHART),
  ).rejects.toBeInstanceOf(ProposalExecutionRefused);
});

test('a chart that cannot be read SKIPS the check rather than deadlocking every correction', async () => {
  const db = fakeDb([zeplowInvoice]);
  const unreadable: ChartCategoriesReader = async () => null;
  await expect(
    assertUpdateCodingAllowed(db, { documentId: 'doc_1', fields: { categoryCode: 'jhngbhf' } }, unreadable),
  ).resolves.toBeUndefined();
  // Same when no reader was composed at all — a test-built engine.
  await expect(
    assertUpdateCodingAllowed(db, { documentId: 'doc_1', fields: { categoryCode: 'jhngbhf' } }),
  ).resolves.toBeUndefined();
});

/* ── the advisory compute, read against the stored document ────────────────── */

test('the £9,000-tax correction carries the advisory, computed against the stored total (item 22)', async () => {
  const db = fakeDb([zeplowInvoice], {
    doc_1: { supplierName: { value: 'Aldgate Meats Ltd', provenance: 'AI_SUGGESTED' } },
  });
  const checks = await computeCorrectionAdvisory(db, { documentId: 'doc_1', fields: { taxPence: 900_000 } }, '2026-09-05');
  expect(checks.map((check) => check.code)).toEqual(['tax-exceeds-total']);
  expect(checks[0]?.message).toContain('£9000.00');
  expect(checks[0]?.message).toContain('£994.00');
});

test('the selfie shape: a total typed onto a Type OTHER, nothing-extracted document warns (item 47)', async () => {
  const selfie: DocRow = { ...zeplowInvoice, id: 'doc_selfie', docType: 'OTHER', totalPence: null, taxPence: null };
  const db = fakeDb([selfie], {
    doc_selfie: {
      supplierName: { value: null, provenance: 'AI_SUGGESTED' },
      // A human's own earlier typing does NOT count as the document having
      // readable content — the flag is about what extraction read.
      totalPence: { value: 7_654_300, provenance: 'HUMAN_CONFIRMED' },
    },
  });
  const checks = await computeCorrectionAdvisory(db, { documentId: 'doc_selfie', fields: { totalPence: 7_654_300 } }, '2026-09-05');
  expect(checks.map((check) => check.code)).toEqual(['not-a-financial-document']);
});

test('a future document date warns; an unreadable document answers no advisory at all', async () => {
  const db = fakeDb([zeplowInvoice]);
  const checks = await computeCorrectionAdvisory(db, { documentId: 'doc_1', fields: { documentDate: '2027-08-09' } }, '2026-09-05');
  expect(checks.map((check) => check.code)).toEqual(['date-in-future']);

  const empty = await computeCorrectionAdvisory(fakeDb([]), { documentId: 'doc_gone', fields: { documentDate: '2027-08-09' } }, '2026-09-05');
  expect(empty).toEqual([]);
});
