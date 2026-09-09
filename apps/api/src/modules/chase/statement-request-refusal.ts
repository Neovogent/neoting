/**
 * Refuse a document that answers a STATEMENT request but is not a statement
 * (owner ruling, 9 Sep 2026 — the PM's "if I requested a bank statement and
 * they send some other document instead, that will be rejected").
 *
 * ## Why this is a refusal and not a flag
 *
 * D46 says unacceptable documents are flagged, never blocked, and that stands
 * for everything arriving unasked. This is the narrow case D46 does not
 * describe: the client was asked, by name, for one specific thing, and sent
 * something else. The owner ruled that the client should be told instantly
 * rather than have an accountant discover it later — so the document goes
 * REJECTED with a reason the client can act on, and the request stays OPEN,
 * because a statement is still owed.
 *
 * ## The scope is deliberately narrow: only the lane that says "against this"
 *
 * A document is only refused when it arrived through the chase link for a
 * `STATEMENT_PERIOD_GAP` chase — the one lane carrying "this upload answers
 * that request" as a fact rather than a guess. A client who emails an ordinary
 * receipt while a statement request happens to be open is NOT refused: nothing
 * in that lane says the receipt was meant to answer the request, and refusing
 * on a coincidence would bounce correct documents.
 *
 * ## The join already exists — no column was added for this
 *
 * `otp_sessions.granted_item_ids` holds the derived document id from intent
 * time (`PrismaPortalUploadService.grantDerivedDocument`) and
 * `otp_sessions.chase_id` names the request the link was minted for. That pair
 * IS "which request did this document answer", and it is written before the
 * bytes land. A `documents.chase_id` column would be a second copy of a fact
 * the session row already carries.
 *
 * ## It never fails the job
 *
 * Same rule, and the same reason, as chase auto-close and the statement step:
 * by the time this runs the document is persisted and extracted, and losing
 * that to a refusal error would invert "nothing is ever silently dropped". A
 * failure is logged and swallowed by the caller; the document stays where
 * extraction left it, which is the safe direction — an accountant seeing a
 * wrong document beats a client seeing a wrong refusal.
 */

import type { DocumentState, DocumentType } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import { resolveSystemActor } from '../../common/db/resolve-system-actor.js';
import { systemContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { chaseItemRefs } from './chase-projection.js';
import { statementPeriodOf } from './statement-request.js';

/** The NT- code a refused-because-wrong-type document carries. */
export const STATEMENT_REQUEST_REFUSAL_CODE = 'NT-STM-002';

/**
 * Only a document that LANDED can be refused. RECEIVED/PROCESSING means
 * extraction has not finished (there is no type to judge), and a document
 * already FAILED/REJECTED/ARCHIVED is not ours to move.
 */
const REFUSABLE_STATES: readonly DocumentState[] = ['READY', 'TO_REVIEW'];

/** The chase states in which a request is still outstanding. */
const OPEN_CHASE_STATES = ['DETECTED', 'PROPOSED', 'APPROVED', 'SENT', 'REMINDED', 'ESCALATED'] as const;

export interface StatementRequestRefusalInput {
  readonly documentId: string;
  /** Null while unrouted — a chase belongs to a business, so there is nothing to check. */
  readonly businessId: string | null;
  readonly practiceId: string;
  readonly traceId: string;
}

export interface StatementRequestRefusalResult {
  /** True when this document was moved to REJECTED. */
  readonly refused: boolean;
}

export interface StatementRequestRefusal {
  run(input: StatementRequestRefusalInput): Promise<StatementRequestRefusalResult>;
}

const NOT_REFUSED: StatementRequestRefusalResult = { refused: false };

const DOC_TYPE_WORDS: Readonly<Record<DocumentType, string>> = {
  INVOICE: 'an invoice',
  RECEIPT: 'a receipt',
  CREDIT_NOTE: 'a credit note',
  STATEMENT: 'a bank statement',
  OTHER: 'something else',
};

/**
 * The client-facing sentence. Names BOTH sides — what was asked for and what
 * arrived — because a refusal the client cannot act on is just a wall. The
 * document type is our own enum, never client text, so nothing untrusted is
 * interpolated here.
 */
export function statementRefusalMessage(docType: DocumentType | null, period: string | null): string {
  const asked = period === null ? 'a bank statement' : `your bank statement for ${period}`;
  const got = DOC_TYPE_WORDS[docType ?? 'OTHER'];
  return `We asked for ${asked}, but this looks like ${got}. Please send the statement — the request is still open.`;
}

export class PrismaStatementRequestRefusal implements StatementRequestRefusal {
  constructor(private readonly prisma: PrismaClient) {}

  async run(input: StatementRequestRefusalInput): Promise<StatementRequestRefusalResult> {
    const businessId = input.businessId;
    if (businessId === null) return NOT_REFUSED;

    const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);
    const ctx = systemContext(input.practiceId, systemUserId);

    return scopedDb(this.prisma, ctx, (db) => this.refuseIfWrongType(db, input, businessId));
  }

  private async refuseIfWrongType(
    db: ScopedClient,
    input: StatementRequestRefusalInput,
    businessId: string,
  ): Promise<StatementRequestRefusalResult> {
    const document = await db.document.findUnique({
      where: { id: input.documentId },
      select: { id: true, state: true, docType: true },
    });
    if (document === null) return NOT_REFUSED;
    if (!REFUSABLE_STATES.includes(document.state)) return NOT_REFUSED;
    // A statement is what was asked for, so it is accepted. A NULL type is
    // "the extractor could not say", which is not evidence of the wrong thing —
    // refusing on it would bounce a statement we simply failed to read.
    if (document.docType === 'STATEMENT' || document.docType === null) return NOT_REFUSED;

    // Which request did this answer? Only the chase-link lane knows, and it
    // knows because the grant was written at intent time.
    const session = await db.otpSession.findFirst({
      where: { businessId, chaseId: { not: null }, grantedItemIds: { has: input.documentId } },
      select: { chaseId: true },
      orderBy: { createdAt: 'desc' },
    });
    const chaseId = session?.chaseId ?? null;
    if (chaseId === null) return NOT_REFUSED;

    const chase = await db.chase.findFirst({
      where: {
        id: chaseId,
        businessId,
        detectionEngine: 'STATEMENT_PERIOD_GAP',
        state: { in: [...OPEN_CHASE_STATES] },
      },
      select: { id: true, itemRefs: true, transactionId: true },
    });
    if (chase === null) return NOT_REFUSED;

    const message = statementRefusalMessage(document.docType, statementPeriodOf(chaseItemRefs(chase)));

    // Guarded on the state we read, so a document another worker moved in the
    // meantime is left alone (count 0) rather than clobbered.
    const updated = await db.document.updateMany({
      where: { id: document.id, state: document.state },
      data: { state: 'REJECTED', failureCode: STATEMENT_REQUEST_REFUSAL_CODE, failureMessage: message },
    });
    if (updated.count === 0) return NOT_REFUSED;

    await db.documentEvent.create({
      data: {
        documentId: document.id,
        stage: 'state',
        outcome: 'REJECTED',
        traceId: input.traceId,
        detail: {
          from: document.state,
          to: 'REJECTED',
          failureCode: STATEMENT_REQUEST_REFUSAL_CODE,
          failureMessage: message,
          chaseId: chase.id,
          docType: document.docType,
        },
      },
    });

    // The chase's own event log — a ChaseMessage with a non-SMS channel, the
    // same audit surface auto-close writes to. The chase STAYS OPEN.
    await db.chaseMessage.create({
      data: {
        chaseId: chase.id,
        channel: 'event',
        body: `Document ${document.id} was refused — a bank statement was requested and a ${document.docType} arrived. The request remains open.`,
      },
    });

    await db.notification.create({
      data: {
        businessId,
        event: 'document.refused',
        payload: {
          chaseId: chase.id,
          documentId: document.id,
          reason: STATEMENT_REQUEST_REFUSAL_CODE,
          docType: document.docType,
          traceId: input.traceId,
        },
      },
    });

    return { refused: true };
  }
}

/** Offline fixture — records the calls, refuses nothing (house pattern). */
export class RecordingStatementRequestRefusal implements StatementRequestRefusal {
  readonly runs: StatementRequestRefusalInput[] = [];

  async run(input: StatementRequestRefusalInput): Promise<StatementRequestRefusalResult> {
    this.runs.push(input);
    return NOT_REFUSED;
  }
}
