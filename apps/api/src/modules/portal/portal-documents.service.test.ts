import { expect, test } from 'vitest';

import type { DocumentState, Document as DocumentRow } from '@prisma/client';

import { listPortalDocumentsResponse } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { PortalDocumentsService } from './portal-documents.service.js';
import { portalDocumentStatus } from './portal-document-status.js';
import type { PortalSessionFacts } from './portal-session-context.js';

/**
 * `GET /portal/documents` — what reaches the database, and what leaves for the
 * phone.
 *
 * Two questions, and only two:
 *
 * 1. **Is the tenancy filter there, every time?** This read runs under the
 *    practice SYSTEM context, which can see every business in the practice, so
 *    `where: { businessId }` is the ONLY thing narrowing it to one client. That
 *    is an application guarantee, and an application guarantee that nothing
 *    asserts is a comment. The end-to-end proof against real RLS —
 *    a second business in the same practice, invisible — is
 *    `portal-client-surface.integration.test.ts`; this is the unit half, which
 *    can see the `where` clause itself.
 * 2. **Is the projection the CLIENT's, not the practice's?** No state, no
 *    inbox, no coding, no failure code. Asserted as an exact object rather than
 *    field by field, because a field added to the row shape must fail this test
 *    rather than quietly reach a client.
 */

const NOW = new Date('2026-09-01T09:00:00.000Z');

const FACTS: PortalSessionFacts = {
  otpSessionId: 'otp_1',
  businessId: 'biz_burger',
  practiceId: 'prac_1',
  systemUserId: 'usr_system_1',
  actorId: 'usr_system_1',
  contactId: null,
  chaseId: null,
  grantedItemIds: [],
  expiresAt: new Date('2026-09-01T10:00:00.000Z'),
};

const ROW_DEFAULTS = {
  practiceId: 'prac_1',
  businessId: 'biz_burger',
  s3Key: 'w/biz_burger/documents/abc',
  originalFilename: 'receipt.jpg',
  mimeType: 'image/jpeg',
  byteSize: 2048,
  byteHash: 'a'.repeat(64),
  perceptualHash: null,
  channel: 'SMS_PORTAL',
  submitterUserId: null,
  submitterLabel: null,
  receivedAt: NOW,
  receivedLocal: null,
  routingDecision: null,
  routingConfidence: null,
  inbox: 'COSTS',
  state: 'TO_REVIEW',
  docType: 'RECEIPT',
  supplierName: 'Currys',
  customerName: null,
  documentDate: new Date('2026-08-09T00:00:00.000Z'),
  dueDate: null,
  currency: 'GBP',
  totalPence: 129_900,
  taxPence: 21_650,
  reference: 'INV-1',
  categoryCode: '7500',
  description: 'A laptop',
  projectRef: null,
  parentDocumentId: null,
  failureCode: null,
  failureMessage: null,
  archivedAt: null,
  pageRange: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function row(id: string, over: Partial<DocumentRow> = {}): DocumentRow {
  return { ...ROW_DEFAULTS, id, ...over } as unknown as DocumentRow;
}

interface Calls {
  findMany: { where?: unknown; orderBy?: unknown; take?: number }[];
  /** The `app.*` settings `scopedDb` wrote — the scope this read actually ran under. */
  scope: string[];
}

function harness(rows: DocumentRow[] = [row('doc_1')]) {
  const calls: Calls = { findMany: [], scope: [] };

  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.scope.push(String(values[0]));
      void strings;
      return 0;
    },
    document: {
      findMany: async (args: { where?: unknown; orderBy?: unknown; take?: number }) => {
        calls.findMany.push(args);
        return rows;
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  return { calls, service: new PortalDocumentsService(prisma) };
}

const query = (over: Record<string, unknown> = {}) => ({ limit: 50, ...over }) as never;

test('⚠ the query is filtered to the SESSION\'S OWN business — the whole of this endpoint\'s tenancy', async () => {
  // The context is the practice SYSTEM one and can see every business in
  // `prac_1`. If this clause is ever dropped, the client sees the practice's
  // entire book of business and every test below still passes.
  const { service, calls } = harness();
  await service.listDocuments(FACTS, query());

  expect(calls.findMany).toHaveLength(1);
  expect(calls.findMany[0]?.where).toEqual({
    businessId: 'biz_burger',
    state: { not: 'ARCHIVED' },
    // Trash, from `notDeleted()`. Asserted in the exact-match above rather than
    // in a test of its own so that the whole `where` stays pinned — this
    // endpoint's tenancy is the query, and an assertion that only checked the
    // clauses it knew about would not notice one going missing.
    deletedAt: null,
  });
});

test('the business comes from the session ROW and there is no parameter that could change it', async () => {
  // `listDocuments` takes the parsed query and nothing else — there is no
  // `businessId` argument to pass wrongly and none for a caller to supply, the
  // same move `PortalUploadRequest` makes by having no such field. A different
  // session filters differently only because its FACTS differ.
  const { service, calls } = harness();
  await service.listDocuments({ ...FACTS, businessId: 'biz_other' }, query());
  expect(calls.findMany[0]?.where).toMatchObject({ businessId: 'biz_other' });
});

test('ARCHIVED is excluded, because none of the five client-facing words is true of it', async () => {
  const { service, calls } = harness();
  await service.listDocuments(FACTS, query());
  expect(calls.findMany[0]?.where).toMatchObject({ state: { not: 'ARCHIVED' } });
});

test('newest first, tie-broken by id, and one row more than the page asked for', async () => {
  const { service, calls } = harness();
  await service.listDocuments(FACTS, query({ limit: 20 }));
  // `receivedAt` is NOT NULL on `documents`, so it must be the plain form —
  // Prisma throws on `{ sort, nulls }` for a required column, which would 500
  // the only request this endpoint serves.
  expect(calls.findMany[0]?.orderBy).toEqual([{ receivedAt: 'desc' }, { id: 'desc' }]);
  expect(calls.findMany[0]?.take).toBe(21);
});

test('the projection is the CLIENT\'s row, and the practice\'s working state is absent from it', async () => {
  const { service } = harness([row('doc_1')]);
  const page = await service.listDocuments(FACTS, query());

  // An exact object, deliberately: a field added to `DocumentRow` and carelessly
  // spread into the projection must FAIL here rather than quietly reach a
  // client. `state`, `inbox`, `categoryCode`, `docType`, `reference`,
  // `description`, `failureCode`, `taxPence` and `originalFilename` are all on
  // the row above and none of them is here.
  expect(page.data).toEqual([
    {
      id: 'doc_1',
      supplierName: 'Currys',
      documentDate: '2026-08-09',
      totalPence: 129_900,
      currency: 'GBP',
      channel: 'SMS_PORTAL',
      status: 'with_accountant',
      receivedAt: NOW.toISOString(),
    },
  ]);
});

test('the projection parses against the contract\'s own generated schema', async () => {
  // The contract checking the projection, not a hand-written expectation of it
  // — including the `.strict()` refusal of any extra key and `.int()` on the
  // money field.
  const { service } = harness([row('doc_1'), row('doc_2', { state: 'PUBLISHED' as DocumentState })]);
  const page = await service.listDocuments(FACTS, query());
  expect(() => listPortalDocumentsResponse.parse(page)).not.toThrow();
});

test('⚠ money travels as a PAIR — an amount with no currency is not money, and neither half is served alone', async () => {
  const { service } = harness([
    row('doc_no_currency', { currency: null }),
    row('doc_no_total', { totalPence: null }),
  ]);
  const page = await service.listDocuments(FACTS, query());

  // Not `129900` with a currency the screen would guess at, and not a bare
  // `GBP` against nothing. Both read as "we have not read a total off this
  // yet", which is true.
  expect(page.data.map((d) => [d.totalPence, d.currency])).toEqual([
    [null, null],
    [null, null],
  ]);
});

test('an unextracted document is honest about it rather than inventing a supplier or a date', async () => {
  const { service } = harness([row('doc_new', { state: 'RECEIVED', supplierName: null, documentDate: null })]);
  const page = await service.listDocuments(FACTS, query());
  expect(page.data[0]).toMatchObject({ supplierName: null, documentDate: null, status: 'processing' });
});

test('every status served is the shared mapping\'s answer, never a second opinion', async () => {
  // The anti-drift assertion: the service must not re-derive the vocabulary.
  const states: DocumentState[] = ['RECEIVED', 'PROCESSING', 'TO_REVIEW', 'READY', 'PUBLISHED', 'REJECTED', 'FAILED'];
  const { service } = harness(states.map((state, i) => row(`doc_${i}`, { state })));
  const page = await service.listDocuments(FACTS, query());
  expect(page.data.map((d) => d.status)).toEqual(states.map(portalDocumentStatus));
});

test('the read runs under the practice SYSTEM context, which is why the where clause has to be there', async () => {
  const { service, calls } = harness();
  await service.listDocuments(FACTS, query());
  // `scopedDb` sets `app.actor_id` first; the actor is the practice's SYSTEM
  // user, not the session's business. Stated here so the class header's claim
  // ("this context can see the whole practice") is asserted rather than assumed.
  expect(calls.scope[0]).toBe('usr_system_1');
});

test('page 1\'s own cursor is accepted by page 2 — the fingerprint covers the list, not the position in it', async () => {
  const { service, calls } = harness([row('doc_1'), row('doc_2')]);
  const first = await service.listDocuments(FACTS, query({ limit: 1 }));
  expect(first.pageInfo.hasMore).toBe(true);
  expect(first.pageInfo.nextCursor).not.toBeNull();

  await service.listDocuments(FACTS, query({ limit: 1, cursor: first.pageInfo.nextCursor as string }));
  // A seek predicate, not an offset.
  expect(calls.findMany[1]?.where).toMatchObject({ AND: expect.any(Array) });
});

test('⚠ a cursor minted for ANOTHER client\'s list is refused rather than mis-seeked', async () => {
  // The fingerprint covers `facts.businessId`. This is not the tenancy boundary
  // (the `where` clause is), but a cursor is caller-supplied input and a page
  // that means nothing in the list it is replayed against is a 400, never a
  // silently wrong page.
  const { service } = harness([row('doc_1'), row('doc_2')]);
  const first = await service.listDocuments(FACTS, query({ limit: 1 }));

  await expect(
    service.listDocuments({ ...FACTS, businessId: 'biz_other' }, query({ limit: 1, cursor: first.pageInfo.nextCursor as string })),
  ).rejects.toMatchObject({ code: 'NT-VAL-001' });
});
