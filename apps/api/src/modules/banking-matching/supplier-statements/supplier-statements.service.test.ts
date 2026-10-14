import { expect, test } from 'vitest';

import { listSupplierStatementsResponse } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { SupplierStatementsService } from './supplier-statements.service.js';

/**
 * The read surface over a recording fake Prisma (the `chases.service.test.ts`
 * harness shape). The point is not that Prisma works — it is that the right
 * `where` reaches it, that every query runs inside the ONE scoped transaction,
 * that money passes through as the integer it was, and that the response is
 * exactly what the contract's own Zod accepts.
 */

const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const NOW = new Date('2026-09-05T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

interface StatementRow {
  id: string;
  businessId: string;
  documentId: string | null;
  supplierName: string;
  statementEndDate: Date | null;
  outstandingBalancePence: number | null;
  createdAt: Date;
  lines: { id: string; reference: string | null; lineDate: Date | null; amountPence: number | null }[];
}

interface DocumentRow {
  id: string;
  businessId: string | null;
  supplierName: string | null;
  totalPence: number | null;
  documentDate: Date | null;
  reference: string | null;
  docType: 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE' | 'STATEMENT' | 'OTHER' | null;
  originalFilename: string;
}

function statement(over: Partial<StatementRow> = {}): StatementRow {
  return {
    id: 'sst_1',
    businessId: 'biz_cosmo',
    documentId: 'doc_statement',
    supplierName: 'Brakes',
    statementEndDate: daysAgo(1),
    outstandingBalancePence: 486_030,
    createdAt: NOW,
    lines: [
      { id: 'ssl_1', reference: 'BRK-551204', lineDate: daysAgo(5), amountPence: 214_075 },
      { id: 'ssl_2', reference: 'BRK-551876', lineDate: daysAgo(9), amountPence: 84_215 },
    ],
    ...over,
  };
}

function document(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'doc_brakes',
    businessId: 'biz_cosmo',
    supplierName: 'Brakes',
    totalPence: 214_075,
    documentDate: daysAgo(5),
    reference: null,
    docType: 'INVOICE',
    originalFilename: 'brakes-doc_brakes.pdf',
    ...over,
  };
}

interface Calls {
  statementFindMany: { where?: unknown; orderBy?: unknown }[];
  documentFindMany: { where?: unknown; select?: unknown }[];
  transactions: number;
}

function harness(options: { statements?: StatementRow[]; documents?: DocumentRow[] } = {}) {
  const calls: Calls = { statementFindMany: [], documentFindMany: [], transactions: 0 };
  const statements = options.statements ?? [statement()];
  const documents = options.documents ?? [document(), document({ id: 'doc_statement', docType: 'STATEMENT', originalFilename: 'brakes-statement-aug-2026.pdf' })];

  const tx = {
    $executeRaw: async () => 0,
    supplierStatement: {
      findMany: async (args: { where?: unknown; orderBy?: unknown }) => {
        calls.statementFindMany.push(args);
        return statements;
      },
    },
    document: {
      findMany: async (args: { where?: { id?: { in?: string[] } }; select?: unknown }) => {
        calls.documentFindMany.push(args);
        // The filename lookup asks by id; the candidate query asks by business.
        const ids = args.where?.id?.in;
        return ids === undefined ? documents : documents.filter((d) => ids.includes(d.id));
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      calls.transactions += 1;
      return fn(tx);
    },
  } as unknown as PrismaClient;
  return { calls, service: new SupplierStatementsService(prisma) };
}

test('the response is exactly what the contract’s Zod accepts, pence untouched', async () => {
  const { service } = harness();
  const items = await service.listSupplierStatements(CTX, 'biz_cosmo');

  // The contract's own parser is the oracle — a shape it refuses is a web contract error.
  expect(listSupplierStatementsResponse.parse({ items })).toEqual({ items });

  const [row] = items;
  expect(row).toMatchObject({
    id: 'sst_1',
    businessId: 'biz_cosmo',
    documentId: 'doc_statement',
    fileName: 'brakes-statement-aug-2026.pdf',
    supplierName: 'Brakes',
    statementEndDate: daysAgo(1).toISOString().slice(0, 10),
    outstandingBalancePence: 486_030,
    createdAt: NOW.toISOString(),
  });
  expect(row?.lines.map((l) => [l.id, l.outcome, l.matchedDocumentId, l.amountPence])).toEqual([
    // Oldest first: the 9-days-ago line has no document; the 5-days-ago line does.
    ['ssl_2', 'MISSING', null, 84_215],
    ['ssl_1', 'MATCHED', 'doc_brakes', 214_075],
  ]);
  expect(row?.totals).toEqual({
    lineCount: 2,
    matchedCount: 1,
    missingCount: 1,
    unreadableCount: 0,
    statementTotalPence: 298_290,
    matchedTotalPence: 214_075,
    missingTotalPence: 84_215,
  });
});

test('every query runs inside ONE scoped transaction', async () => {
  const { calls, service } = harness();
  await service.listSupplierStatements(CTX, 'biz_cosmo');
  expect(calls.transactions).toBe(1);
  expect(calls.statementFindMany).toHaveLength(1);
  // Candidates for the business + filenames for the source documents.
  expect(calls.documentFindMany).toHaveLength(2);
});

test('businessId narrows; no filter means an empty where — RLS is the only tenancy mechanism', async () => {
  const filtered = harness();
  await filtered.service.listSupplierStatements(CTX, 'biz_9');
  expect(filtered.calls.statementFindMany[0]?.where).toEqual({ businessId: 'biz_9' });

  const open = harness();
  await open.service.listSupplierStatements(CTX);
  expect(open.calls.statementFindMany[0]?.where).toEqual({});
});

test('newest statement period first, undated last, then newest row', async () => {
  const { calls, service } = harness();
  await service.listSupplierStatements(CTX);
  expect(calls.statementFindMany[0]?.orderBy).toEqual([
    { statementEndDate: { sort: 'desc', nulls: 'last' } },
    { createdAt: 'desc' },
  ]);
});

test('the candidate query excludes the Trash, refusals, statements and documents with no supplier or total', async () => {
  const { calls, service } = harness();
  await service.listSupplierStatements(CTX, 'biz_cosmo');
  const candidates = calls.documentFindMany.find((c) => (c.where as { businessId?: unknown }).businessId !== undefined);
  expect(candidates?.where).toEqual({
    businessId: { in: ['biz_cosmo'] },
    deletedAt: null,
    supplierName: { not: null },
    totalPence: { not: null },
    state: { notIn: ['REJECTED', 'FAILED'] },
    OR: [{ docType: null }, { docType: { not: 'STATEMENT' } }],
  });
});

test('the statement’s own source file never answers one of its lines', async () => {
  // The source document happens to look exactly like the line — same supplier,
  // same total, same day — because the extractor read the statement's own
  // header total. It must still not count as the invoice.
  const { service } = harness({
    documents: [document({ id: 'doc_statement', docType: null, totalPence: 214_075 })],
  });
  const [row] = await service.listSupplierStatements(CTX, 'biz_cosmo');
  expect(row?.lines.every((l) => l.outcome === 'MISSING')).toBe(true);
  expect(row?.fileName).toBe('brakes-doc_brakes.pdf');
});

test('documents of ANOTHER business never answer a line, even when returned in the same candidate query', async () => {
  const { service } = harness({
    statements: [statement({ documentId: null })],
    documents: [document({ businessId: 'biz_other' })],
  });
  const [row] = await service.listSupplierStatements(CTX);
  expect(row?.fileName).toBeNull();
  expect(row?.documentId).toBeNull();
  expect(row?.lines.every((l) => l.outcome === 'MISSING')).toBe(true);
});

test('a statement with no end date and no outstanding balance projects explicit nulls', async () => {
  const { service } = harness({
    statements: [statement({ statementEndDate: null, outstandingBalancePence: null, lines: [] })],
  });
  const [row] = await service.listSupplierStatements(CTX, 'biz_cosmo');
  expect(row?.statementEndDate).toBeNull();
  expect(row?.outstandingBalancePence).toBeNull();
  expect(row?.totals.lineCount).toBe(0);
  expect(listSupplierStatementsResponse.safeParse({ items: [row] }).success).toBe(true);
});

test('no statements means no document query at all', async () => {
  const { calls, service } = harness({ statements: [] });
  expect(await service.listSupplierStatements(CTX, 'biz_cosmo')).toEqual([]);
  expect(calls.documentFindMany).toHaveLength(0);
});

test('the service has exactly one method, and it reads — there is no write to find', () => {
  const methods = Object.getOwnPropertyNames(SupplierStatementsService.prototype).filter((n) => n !== 'constructor');
  expect(methods).toEqual(['listSupplierStatements']);
});
