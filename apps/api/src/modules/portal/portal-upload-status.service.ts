import { HttpStatus } from '@nestjs/common';

import type { ChaseState, DocumentState } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import type { ChaseTargetTransaction } from '../chase/index.js';
import { type ChaseMismatchReason, describeChaseMismatch } from './chase-verdict.js';
import { delegatedScopeFor, type PortalSessionFacts, systemScopeFor } from './portal-session-context.js';

/**
 * What the portal shows after an upload (SoT §4 Stage 8.4–8.5, METH Stage 9).
 *
 * The client taps Upload, watches a spinner, and then needs one of three
 * answers: *still reading*, *received, thank you*, or *that is not the one, and
 * here is the difference*. This service is that read — one document's own state,
 * its extracted header, and the chase verdict, in one poll-able call.
 *
 * ## It is a READ. It closes nothing.
 *
 * Stage 8 auto-closes a matching chase from the ingest hook
 * (`chase/auto-close.ts`), inside the worker, for every arrival channel. This
 * service never writes and never re-closes; it reports. A second closer would
 * be a second set of rules to drift.
 *
 * ## ⚠ NOTHING ROUTES TO THIS YET, and that is a contract fact, not an oversight
 *
 * `openapi.yaml` (LAW, G7) publishes three portal operations and **no status
 * path**, so there is no request that can reach this service: it is built,
 * tested and waiting for a path, and inventing a fourth route would be a
 * contract change this stage may not make. It is registered in no Nest
 * provider for the same reason — a provider nothing injects claims a live
 * surface that does not exist.
 *
 * What the client sees today instead: `GET /portal/context` reports arrival
 * through `ChaseItem.received`, which is the **chase module's own**
 * `toChaseItem` predicate (chase closed-received, or the transaction no longer
 * `UNMATCHED`) — the same flag the accountant's chase detail renders. That is
 * the ONE implementation of "has it arrived"; this file deliberately does not
 * carry a second. The portal names the difference from the chased item's side
 * (`ChasePortalView`'s unmatched copy) until `describeChaseMismatch`'s fuller
 * sentence has a route to travel on.
 *
 * ## The two scopes, and why it is two
 *
 * - The DOCUMENT and its extraction are read under the **delegated** context —
 *   `documents_delegated_upload` / `extractions_delegated_upload` key on the
 *   session's granted ids, so a document this session was never granted is not
 *   hidden by a filter here, it is invisible in SQL. That is the boundary test.
 * - The CHASE and its transaction are read under the practice **SYSTEM**
 *   context, because `chases` and `bank_transactions` have no delegated policy
 *   at all (see `portal-session-context.ts`) — and every such read is
 *   CONSTRAINED to `facts.chaseId` and `facts.businessId`, because that context
 *   can see the whole practice and the `otp_sessions` row is the only thing
 *   narrowing it to one chase.
 */

/** The five things a portal upload can be, in the order the client meets them. */
export type PortalUploadStage = 'failed' | 'match' | 'mismatch' | 'processing' | 'received';

/** The extracted header, as the portal's overlay renders it. Money is integer pence. */
export interface PortalExtractedHeader {
  readonly supplierName: string | null;
  readonly totalPence: number | null;
  readonly documentDate: Date | null;
  /** The accepted extraction's overall confidence, when one has been accepted. */
  readonly confidence: number | null;
}

/** One uploaded document's status for the session that uploaded it. */
export interface PortalUploadStatus {
  readonly documentId: string;
  /** The document row's own state, verbatim — the pipeline's truth, not a re-derivation. */
  readonly state: DocumentState;
  readonly stage: PortalUploadStage;
  /** The one line the portal shows. Always populated, for every stage. */
  readonly message: string;
  /** Empty unless `stage` is `mismatch`. */
  readonly reasons: readonly ChaseMismatchReason[];
  /** Null until extraction has finished. */
  readonly extracted: PortalExtractedHeader | null;
  /** The chased transaction this verdict is about — the `ChaseItem` it answers. */
  readonly transactionId: string | null;
  readonly chaseState: ChaseState | null;
}

/** The document row this read needs. Nothing else leaves the delegated scope. */
export interface PortalDocumentRow {
  readonly id: string;
  readonly state: DocumentState;
  readonly supplierName: string | null;
  readonly totalPence: number | null;
  readonly documentDate: Date | null;
  readonly confidence: number | null;
}

/** The chase this session exists to answer, and the single line it chases. */
export interface PortalChaseTarget {
  readonly chaseId: string;
  readonly chaseState: ChaseState;
  readonly transactionId: string | null;
  readonly transaction: ChaseTargetTransaction | null;
}

/** Still in the pipeline — no header to judge yet. */
const PROCESSING_STATES: readonly DocumentState[] = ['RECEIVED', 'PROCESSING'];
/** The read itself did not survive. There is nothing to compare, and saying so is the honest answer. */
const UNREADABLE_STATES: readonly DocumentState[] = ['FAILED', 'REJECTED'];

const PROCESSING_MESSAGE = "We're reading your document — this usually takes a few seconds.";
const FAILED_MESSAGE = "We couldn't read that file. Please try again with a clearer photo or a PDF.";
const RECEIVED_MESSAGE = "Received, thank you — we'll take it from here.";

/**
 * The PURE mapping from a document row plus the chased line to what the portal
 * shows. No clock, no database — so every branch is unit-testable offline and
 * the service below is only the two scoped reads.
 *
 * The verdict itself comes from `describeChaseMismatch`, which is
 * `chaseMatchesDocument` — the predicate the chase actually closes on.
 */
export function portalUploadStatus(document: PortalDocumentRow, target: PortalChaseTarget | null): PortalUploadStatus {
  const base = {
    documentId: document.id,
    state: document.state,
    transactionId: target?.transactionId ?? null,
    chaseState: target?.chaseState ?? null,
  };

  if (PROCESSING_STATES.includes(document.state)) {
    return { ...base, stage: 'processing', message: PROCESSING_MESSAGE, reasons: [], extracted: null };
  }
  if (UNREADABLE_STATES.includes(document.state)) {
    return { ...base, stage: 'failed', message: FAILED_MESSAGE, reasons: [], extracted: null };
  }

  const extracted: PortalExtractedHeader = {
    supplierName: document.supplierName,
    totalPence: document.totalPence,
    documentDate: document.documentDate,
    confidence: document.confidence,
  };

  // A chase with no single target line — a grouped chase from an engine that
  // does not exist yet, or a session whose chase has been retargeted. We have
  // the document and we will not pretend to have judged it.
  // // DEMO-MOCK: per-item verdicts for grouped chases land with engines (b)–(e).
  if (target === null || target.transaction === null) {
    return { ...base, stage: 'received', message: RECEIVED_MESSAGE, reasons: [], extracted };
  }

  const verdict = describeChaseMismatch(extracted, target.transaction);
  return { ...base, stage: verdict.kind, message: verdict.message, reasons: verdict.reasons, extracted };
}

export class PortalUploadStatusService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * One document's status for this session — 404 when the session was never
   * granted it.
   *
   * 404, never 403: a 403 confirms the document exists
   * (`packages/contracts/CLAUDE.md`). Nothing here filters by grant either —
   * the delegated context makes an ungranted document invisible in SQL, and the
   * absence is what becomes the 404.
   */
  async statusFor(facts: PortalSessionFacts, documentId: string): Promise<PortalUploadStatus> {
    const rows = await this.readDocuments(facts, [documentId]);
    const row = rows[0];
    if (row === undefined) {
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'No such document', 'No document with that id is reachable.');
    }
    return portalUploadStatus(row, await this.readTarget(facts));
  }

  /** Every document this session has uploaded, oldest first. Empty before the first upload. */
  async statusesForSession(facts: PortalSessionFacts): Promise<readonly PortalUploadStatus[]> {
    const rows = await this.readDocuments(facts, facts.grantedItemIds);
    if (rows.length === 0) return [];
    const target = await this.readTarget(facts);
    return rows.map((row) => portalUploadStatus(row, target));
  }

  /**
   * The documents, under the DELEGATED context — the RLS document boundary.
   * An id outside the grant comes back absent, which is the guarantee, not a
   * convenience. An empty grant (a session before its first upload) cannot build
   * a delegated context at all, and reads as nothing granted.
   */
  private async readDocuments(facts: PortalSessionFacts, ids: readonly string[]): Promise<readonly PortalDocumentRow[]> {
    if (ids.length === 0) return [];
    const scope = delegatedScopeFor(facts);
    if (!scope.ok) return [];

    return scopedDb(this.prisma, scope.context, async (db) => {
      const documents = await db.document.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, state: true, supplierName: true, totalPence: true, documentDate: true },
        orderBy: { receivedAt: 'asc' },
      });
      if (documents.length === 0) return [];

      // The accepted extraction carries the confidence the overlay renders. The
      // header itself is read from `documents` — the extraction pipeline owns
      // that projection (prisma/CLAUDE.md open question 3) and duplicating the
      // JSON read here would be a second parser of the same fields.
      const extractions = await db.extraction.findMany({
        where: { documentId: { in: documents.map((document) => document.id) }, isAccepted: true },
        select: { documentId: true, overallConfidence: true },
        orderBy: { createdAt: 'asc' },
      });
      const confidenceByDocument = new Map(extractions.map((row) => [row.documentId, row.overallConfidence]));

      return documents.map((document) => ({
        id: document.id,
        state: document.state,
        supplierName: document.supplierName,
        totalPence: document.totalPence,
        documentDate: document.documentDate,
        confidence: confidenceByDocument.get(document.id) ?? null,
      }));
    });
  }

  /**
   * The chase and its line, under the practice SYSTEM context — the only context
   * that can see them — CONSTRAINED to this session's own chase and business.
   * Those two `where` clauses are the chase boundary; RLS is not enforcing it
   * here and this module does not claim it is.
   */
  private async readTarget(facts: PortalSessionFacts): Promise<PortalChaseTarget | null> {
    const chaseId = facts.chaseId;
    if (chaseId === null) return null;

    return scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      const chase = await db.chase.findFirst({
        where: { id: chaseId, businessId: facts.businessId },
        select: {
          id: true,
          state: true,
          transactionId: true,
          transaction: { select: { amountPence: true, bookedAt: true, merchantName: true, descriptionRaw: true } },
        },
      });
      if (chase === null) return null;
      return {
        chaseId: chase.id,
        chaseState: chase.state,
        transactionId: chase.transactionId,
        transaction: chase.transaction,
      };
    });
  }
}
