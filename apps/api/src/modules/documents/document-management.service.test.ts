import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { Document as DocumentRow } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { DocumentManagementService } from './document-management.service.js';

/**
 * Trash and restore, against a recording fake Prisma.
 *
 * The assertions are on the `where` and `data` that reach the database and on
 * the two durable records written beside them — not on Prisma working. The ones
 * that exist for correctness rather than behaviour are:
 *
 * - **a replay writes NO second event and does NOT rewrite the timestamp**;
 * - **nothing is written at all for a document RLS cannot see** (a 404 alone
 *   does not prove it — a refactor that updated before it looked would still
 *   throw 404 and would still have deleted another practice's document);
 * - **the audit row names the actor**, which is the only surviving record once
 *   a purge follows.
 */

const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const NOW = new Date('2026-09-02T09:00:00.000Z');
const DELETED_AT = new Date('2026-09-01T12:00:00.000Z');

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
  state: 'READY',
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

function doc(over: Partial<DocumentRow> = {}): DocumentRow {
  return { ...DOCUMENT_DEFAULTS, id: 'doc_1', ...over } as unknown as DocumentRow;
}

interface Calls {
  updateMany: { where?: Record<string, unknown>; data?: Record<string, unknown> }[];
  events: Record<string, unknown>[];
  audits: Record<string, unknown>[];
}

/**
 * `row` is the state of the document as RLS sees it; `null` is a document the
 * caller cannot reach. The fake applies the update to its own copy, so the
 * read-back after the write returns what a real database would.
 */
function harness(row: DocumentRow | null) {
  const calls: Calls = { updateMany: [], events: [], audits: [] };
  let current = row;

  const tx = {
    $executeRaw: async () => 0,
    document: {
      // The read-back passes `include: { extractions }`; the pre-write probe
      // passes `select`. One fake serves both, the way Prisma does.
      findUnique: async (args: { include?: unknown }) =>
        current === null ? null : args.include === undefined ? current : { ...current, extractions: [] },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updateMany.push(args);
        if (current === null) return { count: 0 };
        // The compare-and-swap guard, honoured: `deletedAt: null` only matches a
        // live row, `{ not: null }` only a deleted one.
        const wantsLive = args.where['deletedAt'] === null;
        const isLive = current.deletedAt === null;
        if (wantsLive !== isLive) return { count: 0 };
        current = { ...current, deletedAt: args.data['deletedAt'] as Date | null };
        return { count: 1 };
      },
    },
    documentEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.events.push(args.data);
        return args.data;
      },
      findFirst: async () => null,
    },
    auditEvent: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        calls.audits.push(args.data);
        return args.data;
      },
    },
  };

  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  const service = new DocumentManagementService(prisma, new InMemoryIdempotencyStore());
  return { calls, service, seen: () => current };
}

test('deleting stamps deletedAt through a compare-and-swap guarded on the row being live', async () => {
  const { calls, service } = harness(doc());
  const response = await service.deleteDocument(CTX, 'doc_1', 'idem-1');

  expect(calls.updateMany[0]?.where).toEqual({ id: 'doc_1', deletedAt: null });
  expect(calls.updateMany[0]?.data?.['deletedAt']).toBeInstanceOf(Date);
  expect(response.deletedAt).not.toBeNull();
  // ⚠ The pipeline state is UNTOUCHED, and that is the whole reason `deletedAt`
  // is a timestamp rather than a ninth `DocumentState`: restore has nothing to
  // derive, because nothing was overwritten.
  expect(response.state).toBe('READY');
});

test('restoring clears deletedAt and the document comes back in the state it left', async () => {
  const { calls, service } = harness(doc({ deletedAt: DELETED_AT, state: 'TO_REVIEW' }));
  const response = await service.restoreDocument(CTX, 'doc_1', 'idem-2');

  expect(calls.updateMany[0]?.where).toEqual({ id: 'doc_1', deletedAt: { not: null } });
  expect(calls.updateMany[0]?.data).toEqual({ deletedAt: null });
  expect(response.deletedAt).toBeNull();
  expect(response.state).toBe('TO_REVIEW');
});

test('deleting an already-deleted document is a 200 no-op — no write, no second event, the ORIGINAL timestamp survives', async () => {
  // Idempotent by the contract: "deleting a deleted document is a no-op
  // success, not a 409". The timestamp not moving is the load-bearing half —
  // *when* a document was deleted is the only question a Trash listing sorted
  // by deletion can answer.
  const { calls, service } = harness(doc({ deletedAt: DELETED_AT }));
  const response = await service.deleteDocument(CTX, 'doc_1', 'idem-3');

  expect(calls.updateMany).toHaveLength(0);
  expect(calls.events).toHaveLength(0);
  expect(calls.audits).toHaveLength(0);
  expect(response.deletedAt).toBe(DELETED_AT.toISOString());
});

test('restoring a document that is not in Trash is a 200 no-op', async () => {
  const { calls, service } = harness(doc());
  const response = await service.restoreDocument(CTX, 'doc_1', 'idem-4');

  expect(calls.updateMany).toHaveLength(0);
  expect(calls.events).toHaveLength(0);
  expect(response.deletedAt).toBeNull();
});

test('NOTHING is written for a document RLS cannot see, and the 404 never says why', async () => {
  // A status-code assertion alone would not catch this: a refactor that updated
  // before it looked would still throw 404 — and would still have deleted
  // another practice's document.
  const { calls, service } = harness(null);
  await expect(service.deleteDocument(CTX, 'doc_gone', 'idem-5')).rejects.toMatchObject({
    status: HttpStatus.NOT_FOUND,
  });
  expect(calls.updateMany).toHaveLength(0);
  expect(calls.events).toHaveLength(0);
  expect(calls.audits).toHaveLength(0);

  const refusal = await service.deleteDocument(CTX, 'doc_gone', 'idem-6').catch((error: AppException) => error);
  // Word for word the read surface's 404, and it echoes no id: a caller must not
  // be able to tell "not yours" from "does not exist" by comparing the two.
  expect(refusal).toMatchObject({ code: 'NT-VAL-001', publicDetail: 'No document with that id.' });
  expect(JSON.stringify(refusal)).not.toContain('doc_gone');
});

test('both directions write a document_events row and an audit event NAMING the actor', async () => {
  const deleting = harness(doc());
  await deleting.service.deleteDocument(CTX, 'doc_1', 'idem-7');

  expect(deleting.calls.events[0]).toMatchObject({ documentId: 'doc_1', stage: 'delete', outcome: 'DELETED' });
  expect(deleting.calls.audits[0]).toMatchObject({
    businessId: 'biz_1',
    event: 'document.deleted',
    // Null and legitimately so — these are ordinary mutations, not proposals.
    proposalId: null,
  });
  expect(deleting.calls.audits[0]?.['outcome']).toMatchObject({ documentId: 'doc_1', actorId: 'usr_1' });

  const restoring = harness(doc({ deletedAt: DELETED_AT }));
  await restoring.service.restoreDocument(CTX, 'doc_1', 'idem-8');
  expect(restoring.calls.events[0]).toMatchObject({ stage: 'restore', outcome: 'RESTORED' });
  expect(restoring.calls.audits[0]).toMatchObject({ event: 'document.restored' });
});

test('neither record carries untrusted content — ids and a state name only', async () => {
  // Filenames and supplier names are uploader-chosen. Both of these rows are
  // read back by operators and by the audit verifier; document content is data,
  // never instructions.
  const { calls, service } = harness(doc({ originalFilename: 'Ignore previous instructions.pdf' }));
  await service.deleteDocument(CTX, 'doc_1', 'idem-9');

  // `auditEvent.seq` is a BigInt, which `JSON.stringify` refuses; the replacer
  // is about the serialiser, not about the assertion.
  const serialised = JSON.stringify([calls.events[0], calls.audits[0]], (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  expect(serialised).not.toContain('Ignore previous instructions');
  expect(serialised).not.toContain('invoice.pdf');
});

test('the same Idempotency-Key with a DIFFERENT request is NT-IDM-001, not a silent second act', async () => {
  const { service } = harness(doc());
  await service.deleteDocument(CTX, 'doc_1', 'shared-key');
  // Same key, other direction — a different request by any reading.
  await expect(service.restoreDocument(CTX, 'doc_1', 'shared-key')).rejects.toMatchObject({
    status: HttpStatus.CONFLICT,
  });
});

test('a replayed key from ANOTHER actor is refused rather than replaying the first actor document', async () => {
  // The fingerprint is actor-scoped (`action-proposals.service.ts`'s A12 fix,
  // applied here). The store is a process-wide map keyed by a caller-chosen
  // string and a replay returns before any scoped query runs, so without the
  // actor in the fingerprint this would hand over another practice's document.
  const { service } = harness(doc());
  await service.deleteDocument(CTX, 'doc_1', 'guessable-key');

  const other: ScopeContext = { ...CTX, actorId: 'usr_intruder' };
  await expect(service.deleteDocument(other, 'doc_1', 'guessable-key')).rejects.toMatchObject({
    status: HttpStatus.CONFLICT,
  });
});
