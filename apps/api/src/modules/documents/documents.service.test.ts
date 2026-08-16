import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { Document as DocumentRow, Extraction as ExtractionRow } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import type { AppException } from '../../common/problem/problem.js';
import type { DocumentStore } from '../ingestion-routing/storage/document-store.js';
import { DocumentsService } from './documents.service.js';

// `ScopeContext` is the schema's OUTPUT type, so the defaulted fields are
// required here even though a caller may omit them on the way in.
const CTX: ScopeContext = {
  actorId: 'usr_1',
  practiceId: 'prac_1',
  sessionScope: 'user',
  grantedItemIds: [],
};
const NOW = new Date('2026-08-16T09:00:00.000Z');

const DOCUMENT_DEFAULTS = {
  practiceId: 'prac_1',
  businessId: 'biz_1',
  s3Key: 'w/biz_1/documents/abc',
  originalFilename: 'invoice.pdf',
  mimeType: 'application/pdf',
  byteSize: 1024,
  byteHash: 'a'.repeat(64),
  perceptualHash: null,
  channel: 'WEB_UPLOAD',
  submitterUserId: null,
  submitterLabel: null,
  receivedAt: NOW,
  receivedLocal: null,
  routingDecision: null,
  routingConfidence: null,
  inbox: 'COSTS',
  state: 'RECEIVED',
  docType: null,
  supplierName: null,
  customerName: null,
  documentDate: null,
  dueDate: null,
  currency: null,
  totalPence: null,
  taxPence: null,
  reference: null,
  categoryCode: null,
  description: null,
  projectRef: null,
  parentDocumentId: null,
  failureCode: null,
  failureMessage: null,
  archivedAt: null,
  pageRange: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function doc(id: string, over: Partial<DocumentRow> = {}): DocumentRow {
  return { ...DOCUMENT_DEFAULTS, id, ...over } as unknown as DocumentRow;
}

interface Calls {
  documentFindMany: { where?: unknown; orderBy?: unknown; take?: number }[];
  childFindMany: unknown[];
  presignGet: unknown[];
}

/**
 * A fake Prisma that records what it was asked for. The queries themselves are
 * what these tests assert on — the point is not that Prisma works, it is that
 * the right `where`, `orderBy` and `take` reach it, and that the child queries
 * never run when the parent lookup came back empty.
 */
function harness(options: { document?: DocumentRow | null; children?: { id: string; createdAt: Date }[] } = {}) {
  const calls: Calls = { documentFindMany: [], childFindMany: [], presignGet: [] };
  const rows = options.document === undefined ? [doc('doc_1')] : options.document === null ? [] : [options.document];
  const children = options.children ?? [];

  const tx = {
    $executeRaw: async () => 0,
    document: {
      findMany: async (args: { where?: unknown; orderBy?: unknown; take?: number }) => {
        calls.documentFindMany.push(args);
        return rows;
      },
      findUnique: async () => (options.document === undefined ? doc('doc_1') : options.document),
    },
    documentEvent: {
      findMany: async (args: unknown) => {
        calls.childFindMany.push(args);
        return children;
      },
    },
    extraction: {
      findMany: async (args: unknown) => {
        calls.childFindMany.push(args);
        return children;
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  const store: DocumentStore = {
    put: async () => ({ key: 'k', sha256: 's', byteLength: 0 }),
    get: async () => Buffer.alloc(0),
    head: async () => null,
    presignPut: async () => ({ key: 'k', url: 'https://example.test/put', headers: {} }),
    presignGet: async (input) => {
      calls.presignGet.push(input);
      return { url: 'https://example.test/get?sig=x', expiresAt: new Date(NOW.getTime() + 300_000) };
    },
  };

  return { calls, service: new DocumentsService(prisma, store) };
}

/** The parsed-query shape the controller hands the service, with the contract's defaults applied. */
function listQuery(over: Record<string, unknown> = {}) {
  return { sort: 'receivedAt', order: 'desc', limit: 50, ...over } as never;
}

async function grab(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---- list ----

test('listDocuments returns the contract envelope and asks for limit + 1 rows', async () => {
  const { calls, service } = harness();
  const page = await service.listDocuments(CTX, listQuery({ limit: 2 }));

  expect(page.data).toHaveLength(1);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  const [call] = calls.documentFindMany;
  expect(call?.take).toBe(3); // the probe row, not a second COUNT query
  expect(call?.orderBy).toEqual([{ receivedAt: 'desc' }, { id: 'desc' }]);
});

test('listDocuments projects rows onto DocumentSummary, keeping pence an integer', async () => {
  const { service } = harness({ document: doc('doc_1', { totalPence: 1250, supplierName: 'Acme' }) });
  const page = await service.listDocuments(CTX, listQuery());
  const [row] = page.data;

  expect(row?.id).toBe('doc_1');
  expect(row?.totalPence).toBe(1250);
  expect(Number.isInteger(row?.totalPence)).toBe(true);
  expect(row?.receivedAt).toBe(NOW.toISOString()); // UTC on the wire, always
  // The detail half of `Document` must NOT leak into a summary listing.
  expect(row).not.toHaveProperty('byteHash');
  expect(row).not.toHaveProperty('s3Key');
});

test('a REJECTED document is marked retryable; a RECEIVED one is not', async () => {
  const rejected = harness({ document: doc('doc_1', { state: 'REJECTED' } as Partial<DocumentRow>) });
  expect((await rejected.service.listDocuments(CTX, listQuery())).data[0]?.retryable).toBe(true);

  const received = harness();
  expect((await received.service.listDocuments(CTX, listQuery())).data[0]?.retryable).toBe(false);
});

test('filters are ANDed into the where clause, and absent ones add nothing', async () => {
  const { calls, service } = harness();
  await service.listDocuments(CTX, listQuery({ state: ['READY', 'FAILED'], businessId: 'biz_9' }));

  expect(calls.documentFindMany[0]?.where).toEqual({
    businessId: 'biz_9',
    state: { in: ['READY', 'FAILED'] },
  });
});

test('a businessId filter is a FILTER, never a tenancy guard — no manual practice clause is added', async () => {
  // The guard is RLS inside `scopedDb`. If this test ever starts seeing a
  // hand-written practiceId/businessId clause that was not asked for, someone
  // has added a second enforcement mechanism that can disagree with the policy —
  // and the more permissive of the two wins exactly when it matters.
  const { calls, service } = harness();
  await service.listDocuments(CTX, listQuery());
  expect(calls.documentFindMany[0]?.where).toEqual({});
});

test('an unreachable businessId is an empty page — not 404, not 403', async () => {
  // RLS already removed the rows; the filter simply matches none of them. A 404
  // or a 403 here would confirm whether that business exists.
  const { service } = harness({ document: null });
  const page = await service.listDocuments(CTX, listQuery({ businessId: 'biz_other' }));
  expect(page.data).toEqual([]);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
});

test('the free-text q searches supplier, filename and reference case-insensitively', async () => {
  const { calls, service } = harness();
  await service.listDocuments(CTX, listQuery({ q: 'acme' }));
  expect(calls.documentFindMany[0]?.where).toEqual({
    OR: [
      { supplierName: { contains: 'acme', mode: 'insensitive' } },
      { originalFilename: { contains: 'acme', mode: 'insensitive' } },
      { reference: { contains: 'acme', mode: 'insensitive' } },
    ],
  });
});

test('sorting by a nullable column pins NULLS LAST; the required default sort does not', async () => {
  // Prisma throws on `nulls` for a required column, so these two cannot share a
  // shape. `receivedAt` is the default sort — getting it wrong 500s every list.
  const nullable = harness();
  await nullable.service.listDocuments(CTX, listQuery({ sort: 'documentDate' }));
  expect(nullable.calls.documentFindMany[0]?.orderBy).toEqual([
    { documentDate: { sort: 'desc', nulls: 'last' } },
    { id: 'desc' },
  ]);

  const required = harness();
  await required.service.listDocuments(CTX, listQuery());
  expect(required.calls.documentFindMany[0]?.orderBy).toEqual([{ receivedAt: 'desc' }, { id: 'desc' }]);
});

test('a malformed cursor is a 400, not a silent first page', async () => {
  const { service } = harness();
  const err = await grab(() => service.listDocuments(CTX, listQuery({ cursor: 'not-a-cursor!!' })));
  expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect((err as AppException).code).toBe('NT-VAL-001');
});

// ---- get ----

test('getDocument returns the full record with its accepted extraction', async () => {
  const extraction = {
    id: 'ext_1',
    documentId: 'doc_1',
    fields: { supplierName: { value: 'Acme' } },
    extractorKind: 'vision.workhorse',
    modelVersion: null,
    promptVersion: null,
    ladderRung: null,
    overallConfidence: 0.9,
    validatorResults: null,
    isAccepted: true,
    keyedByUserId: null,
    createdAt: NOW,
  } as unknown as ExtractionRow;
  const row = { ...doc('doc_1'), extractions: [extraction] } as unknown as DocumentRow;

  const { service } = harness({ document: row });
  const result = await service.getDocument(CTX, 'doc_1');

  expect(result.id).toBe('doc_1');
  expect(result.byteHash).toBe('a'.repeat(64)); // the detail half IS present here
  expect(result.acceptedExtraction?.id).toBe('ext_1');
  // Absent validator results are OMITTED, not nulled — the key missing means
  // "no validators ran", which is not the same claim as "they ran and passed".
  expect(result.acceptedExtraction).not.toHaveProperty('validatorResults');
});

test('a document with no accepted extraction reports null rather than omitting the key', async () => {
  const row = { ...doc('doc_1'), extractions: [] } as unknown as DocumentRow;
  const { service } = harness({ document: row });
  expect((await service.getDocument(CTX, 'doc_1')).acceptedExtraction).toBeNull();
});

test('a document RLS cannot see is 404 — never 403, and the reason never says which', async () => {
  // A 403 confirms the record exists. The message must read the same whether the
  // id is unknown or simply not the caller's.
  const { service } = harness({ document: null });
  const err = await grab(() => service.getDocument(CTX, 'doc_someone_else'));

  expect((err as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect((err as AppException).code).toBe('NT-VAL-001'); // NT-NOT-001 does not exist in the enum
  expect(JSON.stringify(err)).not.toContain('doc_someone_else'); // never echo the id back
});

// ---- original ----

test('getDocumentOriginal signs a short-lived URL pinned to the STORED mime type', async () => {
  const { calls, service } = harness({ document: doc('doc_1', { mimeType: 'image/jpeg' }) });
  const access = await service.getDocumentOriginal(CTX, 'doc_1');

  expect(access.url).toBe('https://example.test/get?sig=x');
  expect(access.mimeType).toBe('image/jpeg');
  expect(access.byteSize).toBe(1024);
  expect(access.filename).toBe('invoice.pdf');
  expect(access.expiresAt).toBe(new Date(NOW.getTime() + 300_000).toISOString());

  // Minutes, not hours: the URL is bearer authority with no RLS behind it.
  expect(calls.presignGet[0]).toMatchObject({ key: 'w/biz_1/documents/abc', expiresInSeconds: 300 });
  expect((calls.presignGet[0] as { expiresInSeconds: number }).expiresInSeconds).toBeLessThanOrEqual(900);
});

test('NOTHING is signed for a document RLS cannot see', async () => {
  // The 404 alone does not prove this. A refactor that presigned before the
  // lookup would still throw 404 and still have minted a working URL to another
  // practice's bytes — and object storage has no RLS to undo that.
  const { calls, service } = harness({ document: null });
  const err = await grab(() => service.getDocumentOriginal(CTX, 'doc_someone_else'));

  expect((err as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect(calls.presignGet).toHaveLength(0);
});

// ---- events and extractions ----

test('listDocumentEvents reads the log forward in time, scoped to the one document', async () => {
  const { calls, service } = harness({ children: [{ id: 'ev_1', createdAt: NOW }] });
  const page = await service.listDocumentEvents(CTX, 'doc_1', { limit: 50 } as never);

  expect(page.data).toHaveLength(1);
  expect(calls.childFindMany[0]).toMatchObject({
    where: { documentId: 'doc_1' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], // a processing log only reads forward
    take: 51,
  });
});

test('the child list is NEVER queried when the parent document is invisible', async () => {
  // document_events and extractions carry no tenant column of their own — they
  // hang off document_id. The parent lookup coming back null under RLS is the
  // ONLY thing between a caller and another practice's processing log.
  for (const call of [
    (s: DocumentsService) => s.listDocumentEvents(CTX, 'doc_x', { limit: 50 } as never),
    (s: DocumentsService) => s.listDocumentExtractions(CTX, 'doc_x', { limit: 50 } as never),
  ]) {
    const { calls, service } = harness({ document: null });
    const err = await grab(() => call(service));
    expect((err as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(calls.childFindMany).toHaveLength(0);
  }
});

test('listDocumentExtractions returns the ladder in the order it ran', async () => {
  const { calls, service } = harness({ children: [] });
  const page = await service.listDocumentExtractions(CTX, 'doc_1', { limit: 50 } as never);

  expect(page.data).toEqual([]);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  expect(calls.childFindMany[0]).toMatchObject({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
});
