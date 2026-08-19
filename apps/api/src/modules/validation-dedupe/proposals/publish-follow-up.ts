import type { Document as DocumentRow, IntegrationKind } from '@prisma/client';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import type { LedgerAdapter, LedgerAttachment, LedgerPublishResult } from '../../publishing/index.js';
import { transitionDocument } from '../document-state.js';
import { archiveDocumentExecutor } from './archive-document.js';
import type { FollowUp } from './proposal-executor.js';

/**
 * The post-commit half of `publish.batch` (METH Stage 10) — the only place in
 * this codebase that calls a ledger.
 *
 * ⚠ **An external HTTP call must never hold a tenant transaction open.** That
 * one sentence is why this file exists rather than ten more lines inside
 * `publish-batch.ts`. A batch is up to 500 items (the contract), a real Xero
 * round trip lasts as long as someone else's network decides, and the effect
 * transaction holds row locks for the whole of it. So the executor commits
 * `publishes` rows in **QUEUED** — durable intent, atomically with the
 * approval, which is exactly what that state is for — and this runs afterwards,
 * per item, each resolution in its own short scoped transaction. The full
 * reasoning, including the option that was rejected, is in
 * `modules/publishing/CLAUDE.md`.
 *
 * Three properties worth stating, because each is load-bearing:
 *
 * 1. **Re-drivable.** The work list is "the QUEUED rows of this proposal", read
 *    from the database rather than carried in memory. A crash between commit
 *    and completion leaves QUEUED rows, which are visible
 *    (`@@index([businessId, state])`), truthful, and re-drivable by calling
 *    this function again — resolved rows are no longer QUEUED, so a second run
 *    never re-posts. This is the seam a BullMQ job replaces post-demo: one
 *    function, no call-site changes.
 * 2. **A per-item failure is a row, not an exception.** The adapter returns a
 *    result; item 12 of 40 failing must leave the other 39 published. Only the
 *    world being broken throws.
 * 3. **Nothing lands without a reason.** A FAILED `publishes` row always
 *    carries `failure_code` and `failure_message` (the contract: "a failure
 *    with no reason attached is a bug, not a state") and the document goes to
 *    the Rejected/Failed surface carrying the same pair, which is what makes it
 *    findable and retryable.
 */

/** What one queued item needs from the database before the vendor is called. */
interface PublishJob {
  readonly publishId: string;
  readonly document: Pick<
    DocumentRow,
    | 'id'
    | 'state'
    | 's3Key'
    | 'originalFilename'
    | 'mimeType'
    | 'supplierName'
    | 'categoryCode'
    | 'currency'
    | 'totalPence'
    | 'taxPence'
    | 'documentDate'
    | 'reference'
  >;
  readonly target: { integrationId: string; kind: IntegrationKind; orgRef: string | null };
  readonly attempt: number;
}

/**
 * Drive every QUEUED item of one approved batch. Sequential on purpose: the
 * demo adapter's latency is per item by design (it is what makes the batch feel
 * like a batch), and a real ledger's rate limit is the next reason. Concurrency
 * belongs to the BullMQ version, with the vendor's limits in hand.
 */
export async function runPublishFollowUp(
  prisma: PrismaClient,
  ctx: ScopeContext,
  followUp: Extract<FollowUp, { kind: 'publish' }>,
  ledger: LedgerAdapter,
  traceId: string,
): Promise<void> {
  const jobs = await scopedDb(prisma, ctx, (db) => loadJobs(db, followUp.proposalId));

  for (const job of jobs) {
    // The vendor call, OUTSIDE every transaction. This line is the point of
    // the whole file.
    const result = await ledger.publishBill({
      documentId: job.document.id,
      attempt: job.attempt,
      target: { integrationId: job.target.integrationId, kind: job.target.kind, orgRef: job.target.orgRef },
      supplierName: job.document.supplierName ?? '',
      categoryCode: job.document.categoryCode ?? '',
      // GBP when the document did not carry one: v1 is UK practices and the
      // preview sums a single currency. A multi-currency batch is a real
      // feature with real FX rules, and inventing one here would be worse than
      // not having it.
      currency: job.document.currency ?? 'GBP',
      totalPence: job.document.totalPence ?? 0,
      taxPence: job.document.taxPence ?? 0,
      documentDate: job.document.documentDate === null ? null : isoDate(job.document.documentDate),
      reference: job.document.reference,
      attachment: attachmentOf(job.document),
    });

    await scopedDb(prisma, ctx, (db) => resolve(db, job, result, { proposalId: followUp.proposalId, ctx, traceId }));
  }
}

/**
 * The queued work, joined to what the ledger needs. A QUEUED row whose document
 * or integration is unreachable THROWS rather than being quietly failed: the
 * effect committed both, so an absence here is a context bug, not a vendor
 * answer, and inventing a rejection reason for it would put a lie on the
 * Rejected/Failed surface. The row stays QUEUED and re-drivable.
 */
async function loadJobs(db: ScopedClient, proposalId: string): Promise<PublishJob[]> {
  const queued = await db.publish.findMany({
    where: { actionProposalId: proposalId, state: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, documentId: true, integrationId: true, createdAt: true },
  });

  const jobs: PublishJob[] = [];
  for (const row of queued) {
    const document = await db.document.findUnique({
      where: { id: row.documentId },
      select: {
        id: true,
        state: true,
        s3Key: true,
        originalFilename: true,
        mimeType: true,
        supplierName: true,
        categoryCode: true,
        currency: true,
        totalPence: true,
        taxPence: true,
        documentDate: true,
        reference: true,
      },
    });
    if (document === null) {
      throw new Error(`publish follow-up: document ${row.documentId} is not reachable in this context`);
    }
    const integration =
      row.integrationId === null
        ? null
        : await db.integration.findUnique({ where: { id: row.integrationId }, select: { id: true, kind: true, orgRef: true } });
    if (integration === null) {
      throw new Error(`publish follow-up: the ledger connection for publish ${row.id} is not reachable in this context`);
    }

    // The attempt number for THIS document: the count of its `publishes` rows
    // up to and including this one. Retry is a new proposal over the failed
    // item, so the count IS the honest attempt number — and it is what lets a
    // scripted demo failure fail once and then succeed, without the seed
    // needing a flag column.
    const attempt = await db.publish.count({
      where: { documentId: row.documentId, createdAt: { lte: row.createdAt } },
    });

    jobs.push({
      publishId: row.id,
      document,
      target: { integrationId: integration.id, kind: integration.kind, orgRef: integration.orgRef },
      attempt,
    });
  }
  return jobs;
}

/**
 * Land one result: the `publishes` row and the document state, atomically.
 *
 * SUCCESS → the row carries the ledger's own reference, the document locks
 * (READY → PUBLISHED) and then **auto-archives** — via
 * `archiveDocumentExecutor` itself, not a second implementation of archiving.
 * That executor already owns the parts that are easy to get subtly wrong
 * (`state` AND `archivedAt` together, the pre-archive state recorded on the
 * event so an unarchive can restore it, the idempotent skip), and it takes a
 * `ScopedClient` precisely so another effect can compose it.
 *
 * FAILURE → the row is FAILED with code AND message, and the document goes to
 * **REJECTED** carrying the same pair. Why REJECTED and not FAILED: the machine
 * offers READY exactly one failure exit and it is REJECTED (`LEGAL_TRANSITIONS`),
 * and that is the right one on the meaning too — FAILED is our pipeline
 * breaking, and a ledger declining a bill is something refusing it. Both states
 * render on the same first-class surface (`GET /documents?state=REJECTED|FAILED`),
 * so nothing is hidden by the choice. Widening the machine so a vendor's "no"
 * could reach FAILED would be changing a shared state machine to avoid writing
 * this paragraph.
 */
async function resolve(
  db: ScopedClient,
  job: PublishJob,
  result: LedgerPublishResult,
  meta: { proposalId: string; ctx: ScopeContext; traceId: string },
): Promise<void> {
  const { proposalId, traceId } = meta;
  const document = await db.document.findUnique({ where: { id: job.document.id }, select: { id: true, state: true } });
  if (document === null) {
    throw new Error(`publish follow-up: document ${job.document.id} is not reachable in this context`);
  }

  if (!result.ok) {
    await db.publish.update({
      where: { id: job.publishId },
      data: {
        state: 'FAILED',
        failureCode: result.failure.code,
        failureMessage: result.failure.message,
        completedAt: new Date(),
      },
    });
    await transitionDocument(db, document, {
      to: 'REJECTED',
      failure: { code: result.failure.code, message: result.failure.message },
      traceId,
      // `retryable` is a HINT recorded with the attempt, never permission: a
      // retry is a new publish.batch proposal through Review → Approve.
      detail: { proposalId, via: 'publish', attempt: job.attempt, retryable: result.failure.retryable },
    });
    return;
  }

  await db.publish.update({
    where: { id: job.publishId },
    data: {
      state: 'SUCCEEDED',
      externalRef: result.externalRef,
      attachmentSent: result.attachmentSent,
      completedAt: new Date(),
    },
  });
  await transitionDocument(db, document, {
    to: 'PUBLISHED',
    traceId,
    detail: { proposalId, via: 'publish', attempt: job.attempt, externalRef: result.externalRef, attachmentSent: result.attachmentSent },
  });

  // Auto-archive (METH Stage 10: "→ PUBLISHED (locked) → auto-archive via
  // existing executor logic"). Reused, not re-implemented — and it re-reads the
  // document inside this same transaction, so it sees the PUBLISHED row this
  // function just wrote and records PUBLISHED as the pre-archive state, which
  // is what an unarchive needs to restore.
  await archiveDocumentExecutor.execute(db, {
    proposalId,
    payload: { documentIds: [document.id], archived: true },
    // The approver's own context and trace, not a synthetic one: the archive
    // event this writes belongs to the same human decision as the publish.
    ctx: meta.ctx,
    traceId,
  });
}

/**
 * The source document travelling with the bill (SoT Stage 10 — "the source
 * image always travels with the data"). A REFERENCE, never bytes: a 500-item
 * batch must not hold 500 buffers.
 */
function attachmentOf(document: Pick<DocumentRow, 's3Key' | 'originalFilename' | 'mimeType'>): LedgerAttachment {
  return { s3Key: document.s3Key, filename: document.originalFilename, mimeType: document.mimeType };
}

/** `YYYY-MM-DD` from a UTC-stored date. UTC in storage, Europe/London only at render. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
