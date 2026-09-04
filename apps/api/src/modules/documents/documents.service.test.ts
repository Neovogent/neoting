import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { Document as DocumentRow, Extraction as ExtractionRow } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import type { AppException } from '../../common/problem/problem.js';
import type { DocumentStore } from '../ingestion-routing/index.js';
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
  deletedAt: null,
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
  counts: { model: string; where?: unknown }[];
}

/**
 * A fake Prisma that records what it was asked for. The queries themselves are
 * what these tests assert on — the point is not that Prisma works, it is that
 * the right `where`, `orderBy` and `take` reach it, and that the child queries
 * never run when the parent lookup came back empty.
 */
function harness(
  options: {
    document?: DocumentRow | null;
    /** More than one row, for the paging tests — `document` handles the single-row cases. */
    documents?: DocumentRow[];
    children?: { id: string; createdAt: Date }[];
  } = {},
) {
  const calls: Calls = { documentFindMany: [], childFindMany: [], presignGet: [], counts: [] };
  const rows =
    options.documents ??
    (options.document === undefined ? [doc('doc_1')] : options.document === null ? [] : [options.document]);
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
    // The header counts. Each fake returns a distinct number so a test can tell
    // which query produced which field — a header that silently paired the
    // right number with the wrong word is the exact defect this endpoint
    // replaces.
    vaultItem: {
      count: async (args: { where?: unknown }) => {
        calls.counts.push({ model: 'vaultItem', where: args.where });
        return calls.counts.length * 10;
      },
    },
  };
  (tx.document as Record<string, unknown>)['count'] = async (args: { where?: unknown }) => {
    calls.counts.push({ model: 'document', where: args.where });
    return calls.counts.length;
  };

  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  const store: DocumentStore = {
    put: async () => ({ key: 'k', sha256: 's', byteLength: 0 }),
    get: async () => Buffer.alloc(0),
    sha256: async () => 's',
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
    // `deletedAt: null` is present in EVERY listing where clause and is not a
    // filter the caller asked for — it is the Trash exclusion, applied by
    // `deletedFilterFor(query.deleted ?? false)` because the default belongs to
    // the server rather than to what a caller remembered to send.
    deletedAt: null,
    businessId: 'biz_9',
    state: { in: ['READY', 'FAILED'] },
  });
});

test('a businessId filter is a FILTER, never a tenancy guard — no manual practice clause is added', async () => {
  // The guard is RLS inside `scopedDb`. If this test ever starts seeing a
  // hand-written practiceId/businessId clause that was not asked for, someone
  // has added a second enforcement mechanism that can disagree with the policy —
  // and the more permissive of the two wins exactly when it matters.
  //
  // Asserted on the KEYS, not whole-object equality: the default where is no
  // longer empty (the ARCHIVED exclusion below lives there), and this test's
  // claim is about what must be ABSENT.
  const { calls, service } = harness();
  await service.listDocuments(CTX, listQuery());
  expect(Object.keys(calls.documentFindMany[0]?.where ?? {})).toEqual(['deletedAt', 'state']);
});

test('an omitted state filter excludes ARCHIVED; asking for ARCHIVED by name returns it', async () => {
  // The contract's `state` parameter: "Omitted means every state except
  // ARCHIVED". Archived documents are the vault's business — without the
  // default exclusion every working queue grows forever.
  const bare = harness();
  await bare.service.listDocuments(CTX, listQuery());
  expect(bare.calls.documentFindMany[0]?.where).toEqual({ deletedAt: null, state: { not: 'ARCHIVED' } });

  const explicit = harness();
  await explicit.service.listDocuments(CTX, listQuery({ state: ['ARCHIVED'] }));
  expect(explicit.calls.documentFindMany[0]?.where).toEqual({ deletedAt: null, state: { in: ['ARCHIVED'] } });
});

test('the default listing excludes Trash, and ?deleted=true returns ONLY Trash', async () => {
  // The whole soft-delete guarantee, at the layer that decides it. `deletedAt`
  // is a nullable timestamp and NOT a ninth `DocumentState` member, so the two
  // predicates are independent — which is what the third assertion pins.
  const bare = harness();
  await bare.service.listDocuments(CTX, listQuery());
  expect(bare.calls.documentFindMany[0]?.where).toMatchObject({ deletedAt: null });

  const trash = harness();
  await trash.service.listDocuments(CTX, listQuery({ deleted: true }));
  expect(trash.calls.documentFindMany[0]?.where).toMatchObject({ deletedAt: { not: null } });

  // Deletion is ORTHOGONAL to state: asking for Trash still applies the
  // contract's "every state except ARCHIVED" default, rather than replacing it.
  expect(trash.calls.documentFindMany[0]?.where).toEqual({
    deletedAt: { not: null },
    state: { not: 'ARCHIVED' },
  });

  // An explicit `false` is the default, not a third behaviour.
  const explicitFalse = harness();
  await explicitFalse.service.listDocuments(CTX, listQuery({ deleted: false }));
  expect(explicitFalse.calls.documentFindMany[0]?.where).toEqual(bare.calls.documentFindMany[0]?.where);
});

test('an unreachable businessId is an empty page — not 404, not 403', async () => {
  // RLS already removed the rows; the filter simply matches none of them. A 404
  // or a 403 here would confirm whether that business exists.
  const { service } = harness({ document: null });
  const page = await service.listDocuments(CTX, listQuery({ businessId: 'biz_other' }));
  expect(page.data).toEqual([]);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
});

test('the free-text q searches supplier, description, reference and filename case-insensitively', async () => {
  // The contract's field list is "supplier, description, reference and
  // extracted document text" — the first three are pinned here; extracted text
  // waits on the FTS contract change. `originalFilename` is a deliberate
  // addition beyond the documented set, pinned so it cannot silently vanish.
  const { calls, service } = harness();
  await service.listDocuments(CTX, listQuery({ q: 'acme' }));
  expect(calls.documentFindMany[0]?.where).toMatchObject({
    OR: [
      { supplierName: { contains: 'acme', mode: 'insensitive' } },
      { description: { contains: 'acme', mode: 'insensitive' } },
      { reference: { contains: 'acme', mode: 'insensitive' } },
      { originalFilename: { contains: 'acme', mode: 'insensitive' } },
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

test("page 1's own cursor is accepted by page 2 and seeks past the last row", async () => {
  // REGRESSION. The fingerprint was computed over the whole parsed query,
  // *including* `cursor` — which is undefined on page 1 and a token on page 2, so
  // the digest could never match on the way back and EVERY page-2 request 400'd
  // with "issued for a different set of filters". Nothing caught it: the only
  // cursor test asserted a malformed one is refused, which a broken fingerprint
  // does correctly. It would have surfaced on the first real paginated request.
  const rows = [doc('doc_1'), doc('doc_2'), doc('doc_3')];
  const query = { limit: 2, state: ['READY'] };

  const first = harness({ documents: rows });
  const page1 = await first.service.listDocuments(CTX, listQuery(query));
  expect(page1.pageInfo.hasMore).toBe(true);
  const cursor = page1.pageInfo.nextCursor;
  expect(cursor).not.toBeNull();

  const second = harness({ documents: rows });
  const page2 = await second.service.listDocuments(CTX, listQuery({ ...query, cursor }));

  // Not a 400 — and more than that, the cursor was decoded and turned into a
  // seek, ANDed under the same filters rather than replacing them.
  expect(second.calls.documentFindMany[0]?.where).toEqual({
    AND: [
      { deletedAt: null, state: { in: ['READY'] } },
      {
        OR: [
          { receivedAt: { lt: NOW } }, // a Date, never the ISO string — Postgres would compare text
          { receivedAt: NOW, id: { lt: 'doc_2' } }, // the id tie-break, since every row shares receivedAt
        ],
      },
    ],
  });
  expect(page2.data).toHaveLength(2);
});

test('receivedFrom is INCLUSIVE and receivedTo is EXCLUSIVE, so a midnight document belongs to one day only', async () => {
  // Half-open is what makes day-by-day paging work: yesterday's `receivedTo` is
  // today's `receivedFrom`. `lte` would show a document landing exactly on
  // midnight in both days, and the contract says "Exclusive upper bound".
  const { calls, service } = harness();
  await service.listDocuments(
    CTX,
    listQuery({ receivedFrom: '2026-08-01T00:00:00.000Z', receivedTo: '2026-09-01T00:00:00.000Z' }),
  );

  // toMatchObject: the claim here is the two operators, not the whole where —
  // the default ARCHIVED exclusion also lives in it.
  expect(calls.documentFindMany[0]?.where).toMatchObject({
    receivedAt: {
      gte: new Date('2026-08-01T00:00:00.000Z'),
      lt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
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

test('listDocumentExtractions returns the ladder newest first, as the contract declares', async () => {
  // "Every extraction attempt, newest first" (`openapi.yaml`). This shipped
  // oldest-first on a narrative argument the spec does not make — the spec is
  // LAW, and re-arguing it belongs on a contract-change issue, not in orderBy.
  const { calls, service } = harness({ children: [] });
  const page = await service.listDocumentExtractions(CTX, 'doc_1', { limit: 50 } as never);

  expect(page.data).toEqual([]);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  expect(calls.childFindMany[0]).toMatchObject({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
});

test("an events cursor is refused by extractions — the list's identity is in the fingerprint", async () => {
  // Both children sort on createdAt + id, so without a discriminator their
  // cursor payloads are interchangeable — and the two lists read in OPPOSITE
  // directions, so a swapped cursor would not error, it would silently serve a
  // wrong page of the other list.
  const events = harness({ children: [{ id: 'ev_1', createdAt: NOW }, { id: 'ev_2', createdAt: NOW }] });
  const page1 = await events.service.listDocumentEvents(CTX, 'doc_1', { limit: 1 } as never);
  const cursor = page1.pageInfo.nextCursor;
  expect(cursor).not.toBeNull();

  const extractions = harness({ children: [] });
  const err = await grab(() =>
    extractions.service.listDocumentExtractions(CTX, 'doc_1', { limit: 1, cursor } as never),
  );
  expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect((err as AppException).code).toBe('NT-VAL-001');
});


// ---- the header counts ----

test('getDocumentCounts issues five counts in ONE transaction, and each asks the right question', async () => {
  // The header read `3 documents · 0 archived · 0 in vault · 0 expiring` and
  // three of those four were not answers. Every number here is the server's,
  // over the whole RLS-visible set rather than over a page — `PageInfo` carries
  // no total and keyset pagination has none to carry.
  const { calls, service } = harness();
  const counts = await service.getDocumentCounts(CTX, { businessId: 'biz_9', expiringWithinDays: 30 } as never);

  expect(calls.counts.map((c) => c.model)).toEqual(['document', 'document', 'document', 'vaultItem', 'vaultItem']);

  // `total` is EXACTLY what `GET /documents` serves with no filters — not
  // deleted, not ARCHIVED — so the header and the list beneath it cannot
  // disagree. It is deliberately not "every document the practice holds".
  expect(calls.counts[0]?.where).toEqual({ businessId: 'biz_9', deletedAt: null, state: { not: 'ARCHIVED' } });
  expect(calls.counts[1]?.where).toEqual({ businessId: 'biz_9', deletedAt: null, state: 'ARCHIVED' });
  // Trash, whatever pipeline state it holds — deletion is orthogonal to state.
  expect(calls.counts[2]?.where).toEqual({ businessId: 'biz_9', deletedAt: { not: null } });
  // ⚠ The last two are `vault_items`, NOT documents. `documents` has no expiry
  // or retention column at all, so there is no expiring DOCUMENT to count and
  // none is being approximated.
  expect(calls.counts[3]?.where).toEqual({ businessId: 'biz_9' });

  expect(counts).toMatchObject({ total: 1, archived: 2, deleted: 3, inVault: 40, expiring: 50 });
  // The horizon is echoed back: a number on a screen that cannot say which
  // window produced it is not one anyone can check.
  expect(counts.expiringWithinDays).toBe(30);
});

test('expiring counts vault items ALREADY past their date as well as those approaching it', async () => {
  // An expired certificate is the most expiring thing on the screen. A window
  // with a lower bound would silently drop it, which is a worse lie than the
  // zero this replaces.
  const { calls, service } = harness();
  await service.getDocumentCounts(CTX, { expiringWithinDays: 14 } as never);

  const expiring = calls.counts[4]?.where as { expiresAt?: { not?: unknown; lt?: Date }; businessId?: string };
  expect(expiring.expiresAt?.not).toBeNull(); // items with no expiry never count
  expect(expiring.expiresAt?.lt).toBeInstanceOf(Date);
  expect(expiring).not.toHaveProperty('businessId'); // omitted filter narrows nothing
  // Fourteen days out, not thirty: the horizon is the caller's.
  const horizonMs = (expiring.expiresAt?.lt as Date).getTime() - Date.now();
  expect(horizonMs).toBeGreaterThan(13.9 * 24 * 60 * 60 * 1000);
  expect(horizonMs).toBeLessThan(14.1 * 24 * 60 * 60 * 1000);
});
