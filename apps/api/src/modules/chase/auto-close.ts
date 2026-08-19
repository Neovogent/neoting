/**
 * Auto-close on inbound match (SoT §4 Stage 8.5 / METH Stage 8).
 *
 * *"Chasing is SMS-only — but the client may respond through any inbound channel
 * (OTP link, WhatsApp, email); an inbound document that matches the chased
 * transaction closes the chase automatically regardless of arrival channel."*
 *
 * This is REAL product logic, not a mock: when an ingested document finishes
 * extraction, if its supplier + amount (+ a date window) match an OPEN chase's
 * target transaction in the same business, the chase closes, an event is written
 * to the chase's own log, and the accountant gets an in-app notification. The
 * compare is DETERMINISTIC — same document, same open chases, same outcome — so
 * nothing here reaches for a model.
 *
 * The reserved seam on `index.ts` names exactly this: the extraction/ingest hook
 * calls `run` THROUGH the module's public seam rather than reaching into it. The
 * step runs under the practice's SYSTEM actor through `scopedDb`, exactly like
 * the extraction pipeline that precedes it — machine writes go through the same
 * RLS predicate as human ones, and `audit`/event rows name a real actor.
 *
 * // DEMO-MOCK: only detection engine (a)'s single-transaction chase is matched.
 * // The four other close paths SoT §4 Stage 8.6 names (marked-unavailable,
 * // dismissed, cash-coded, exception-approved) and the fuzzy cross-type /
 * // OCR-similarity signals of a real matcher are not built here — a deterministic
 * // supplier + amount + date-window compare is the one auto-close beat the demo
 * // needs, and it is honest.
 */

import { resolveSystemActor } from '../../common/db/resolve-system-actor.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import { systemContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';

/**
 * Amount tolerance, in integer pence. A photographed receipt and the bank line
 * for the same purchase agree to the penny in the demo cast, but a real feed
 * rounds tips and FX — so a small window keeps the match honest without inventing
 * a fuzzy score. Integer pence throughout (R5: no float pence, ever).
 * // DEMO-MOCK: a real matcher tolerance is eval-calibrated, not a constant here.
 */
export const CHASE_MATCH_AMOUNT_TOLERANCE_PENCE = 100;

/**
 * Date window, in days, around the chased transaction's booked date. A receipt is
 * dated the day of purchase; the bank books it within a few days. `null` on the
 * document date means "date unread" — it does NOT block a match (supplier +
 * amount already identify the transaction), it only skips the date gate.
 */
export const CHASE_MATCH_DATE_WINDOW_DAYS = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The extracted header the ingest/extraction hook hands in. Money is integer pence. */
export interface ChaseAutoCloseInput {
  readonly documentId: string;
  /** The routed business — auto-close only runs for a business-anchored document. */
  readonly businessId: string;
  /**
   * The practice that anchors the document — the SYSTEM actor's scope, supplied by
   * the caller for the same reason extraction needs it: the scoped context must be
   * built BEFORE any row is read under RLS, and it is the one thing the hook cannot
   * read for itself (`businesses` is a policed table; an unscoped read sees nothing).
   */
  readonly practiceId: string;
  readonly supplierName: string | null;
  readonly totalPence: number | null;
  /** The document date as a UTC instant, or null when the extractor left it unread. */
  readonly documentDate: Date | null;
  readonly traceId: string;
}

export interface ChaseAutoCloseResult {
  /** The chases this document closed — empty is the normal, non-error case. */
  readonly closedChaseIds: readonly string[];
}

/** The auto-close step, injected as a dep the house way (interface + fixture + impl). */
export interface ChaseAutoClose {
  run(input: ChaseAutoCloseInput): Promise<ChaseAutoCloseResult>;
}

/** The transaction fields the compare reads — kept minimal so the predicate is pure. */
export interface ChaseTargetTransaction {
  readonly amountPence: number;
  readonly bookedAt: Date;
  readonly merchantName: string | null;
  readonly descriptionRaw: string;
}

/** The document header the compare reads. */
export interface ChaseCandidateDocument {
  readonly supplierName: string | null;
  readonly totalPence: number | null;
  readonly documentDate: Date | null;
}

/**
 * Normalise a supplier / merchant label for comparison: lower-cased, punctuation
 * dropped, whitespace collapsed. `CURRYS 1234 LONDON` and `Currys` share the
 * `currys` token; the compare asks whether either normalised label CONTAINS the
 * other's leading word, so the bank's noisy descriptor still matches the clean
 * extracted name without a fuzzy score. Never fed to a model — pure string work.
 */
export function normaliseSupplier(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The DETERMINISTIC compare — the heart of auto-close, pure and unit-tested in
 * isolation. A document matches a chased transaction when ALL hold:
 *
 *  - **supplier** — the document's normalised supplier and the transaction's
 *    normalised merchant/descriptor share a WHOLE leading token (never a
 *    substring — see supplierTokenMatch). A document with no supplier cannot
 *    match — we will not close a chase on an amount coincidence alone.
 *  - **amount** — the absolute pence agree within `CHASE_MATCH_AMOUNT_TOLERANCE_PENCE`.
 *    The transaction amount is signed (negative is money out); the document total
 *    is unsigned, so the compare is on absolute values. Integer arithmetic only.
 *  - **date** — when the document carries a date, it falls within
 *    `CHASE_MATCH_DATE_WINDOW_DAYS` of the transaction's booked date. An unread
 *    date skips this gate rather than blocking the match.
 */
export function chaseMatchesDocument(document: ChaseCandidateDocument, transaction: ChaseTargetTransaction): boolean {
  if (document.supplierName === null || document.totalPence === null) return false;

  const docSupplier = normaliseSupplier(document.supplierName);
  if (docSupplier === '') return false;
  const txnLabel = normaliseSupplier(transaction.merchantName ?? transaction.descriptionRaw);
  if (txnLabel === '') return false;
  if (!supplierTokenMatch(docSupplier, txnLabel)) return false;

  const amountDelta = Math.abs(Math.abs(transaction.amountPence) - Math.abs(document.totalPence));
  if (amountDelta > CHASE_MATCH_AMOUNT_TOLERANCE_PENCE) return false;

  if (document.documentDate !== null) {
    const dayDelta = Math.abs(document.documentDate.getTime() - transaction.bookedAt.getTime()) / MS_PER_DAY;
    if (dayDelta > CHASE_MATCH_DATE_WINDOW_DAYS) return false;
  }

  return true;
}

/**
 * A shared WHOLE token anchors the match — never a substring. The document's
 * brand token (its first meaningful word) must appear as a whole word in the
 * bank descriptor, or the descriptor's leading brand as a whole word in the
 * document — so a noisy descriptor still matches either way. Whole-token, not
 * `includes`, is the whole point: `Sap` must NOT close `SAPPHIRE RESTAURANTS`,
 * `Al` must NOT close `Aldi`, `Co` must NOT close `Costa` — the substring
 * version silently closed the wrong supplier's chase. Tokens under 3 chars are
 * dropped: too collision-prone to anchor an auto-close on.
 */
function supplierTokenMatch(a: string, b: string): boolean {
  const tokens = (s: string): string[] => s.split(' ').filter((t) => t.length >= 3);
  const tokensA = tokens(a);
  const tokensB = tokens(b);
  const headA = tokensA[0];
  const headB = tokensB[0];
  if (headA === undefined || headB === undefined) return false;
  return tokensB.includes(headA) || tokensA.includes(headB);
}

/** The states an OPEN chase can be in — everything before a CLOSED_* terminal. */
const OPEN_CHASE_STATES = ['DETECTED', 'PROPOSED', 'APPROVED', 'SENT', 'REMINDED', 'ESCALATED'] as const;

/**
 * The real implementation. Resolves the practice SYSTEM actor, then in ONE
 * `scopedDb` transaction: reads the business's open chases with their target
 * transaction, closes each one the document matches (state → CLOSED_RECEIVED,
 * `closedByDocumentId` + `closedReason` + `closedAt` stamped), writes an event
 * onto the chase's own log (a `ChaseMessage` with `channel: 'event'` — the chase
 * has no separate event table, and this is its audit surface), and writes an
 * in-app `Notification` for the accountant. Idempotent: a chase already closed by
 * THIS document is skipped, so a redelivery or a re-extraction closes nothing
 * twice and writes no duplicate event or notification.
 */
export class PrismaChaseAutoClose implements ChaseAutoClose {
  constructor(private readonly prisma: PrismaClient) {}

  async run(input: ChaseAutoCloseInput): Promise<ChaseAutoCloseResult> {
    // A document with no supplier or no total can match nothing — skip before we
    // even resolve an actor. This is the quiet no-match, not an error.
    if (input.supplierName === null || input.totalPence === null) {
      return { closedChaseIds: [] };
    }

    const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);
    const ctx = systemContext(input.practiceId, systemUserId);

    return scopedDb(this.prisma, ctx, (db) => this.closeMatching(db, input));
  }

  private async closeMatching(db: ScopedClient, input: ChaseAutoCloseInput): Promise<ChaseAutoCloseResult> {
    const openChases = await db.chase.findMany({
      where: {
        businessId: input.businessId,
        state: { in: [...OPEN_CHASE_STATES] },
        // Engine (a) is a single-transaction chase — only those with a target can
        // be auto-closed by a matching document. // DEMO-MOCK: grouped multi-item
        // chases close per-item once item-level match tracking exists (engines b–e).
        transactionId: { not: null },
      },
      select: {
        id: true,
        closedByDocumentId: true,
        transaction: {
          select: { amountPence: true, bookedAt: true, merchantName: true, descriptionRaw: true },
        },
      },
    });

    const document: ChaseCandidateDocument = {
      supplierName: input.supplierName,
      totalPence: input.totalPence,
      documentDate: input.documentDate,
    };

    const closedChaseIds: string[] = [];
    for (const chase of openChases) {
      // Idempotency: a chase this exact document already closed is a no-op — no
      // second event, no second notification (a re-extraction must not re-fire).
      if (chase.closedByDocumentId === input.documentId) continue;
      if (chase.transaction === null) continue;
      if (!chaseMatchesDocument(document, chase.transaction)) continue;

      const now = new Date();
      // Compare-and-swap on the OPEN states, so a chase another worker closed
      // between the read and here is left alone (updateMany returns count 0).
      const updated = await db.chase.updateMany({
        where: { id: chase.id, state: { in: [...OPEN_CHASE_STATES] } },
        data: {
          state: 'CLOSED_RECEIVED',
          closedAt: now,
          closedReason: 'matched-inbound-document',
          closedByDocumentId: input.documentId,
        },
      });
      if (updated.count === 0) continue;

      // The chase's own event log. There is no ChaseEvent table (no schema change
      // in this stage); a ChaseMessage with a non-SMS channel is the chase's event
      // surface — it is NOT an outbound SMS (no recipient, never "sent").
      await db.chaseMessage.create({
        data: {
          chaseId: chase.id,
          channel: 'event',
          body: `Chase closed automatically — inbound document ${input.documentId} matched the chased transaction.`,
        },
      });

      // The accountant's in-app notification (SoT §4 Stage 8.8 — notify on close).
      // // DEMO-MOCK: notification delivery channels (email/SMS fan-out) are not
      // // built; the row IS the in-app toast the workspace reads.
      await db.notification.create({
        data: {
          businessId: input.businessId,
          event: 'chase.closed',
          payload: {
            chaseId: chase.id,
            documentId: input.documentId,
            reason: 'matched-inbound-document',
            traceId: input.traceId,
          },
        },
      });

      closedChaseIds.push(chase.id);
    }

    return { closedChaseIds };
  }
}

/**
 * Offline fixture — records the calls so the ingest processor's unit tests stay
 * offline (the house pattern shared with `RecordingExtractionStep`). Closes
 * nothing; it only remembers what it was asked to close.
 */
export class RecordingChaseAutoClose implements ChaseAutoClose {
  readonly runs: ChaseAutoCloseInput[] = [];

  async run(input: ChaseAutoCloseInput): Promise<ChaseAutoCloseResult> {
    this.runs.push(input);
    return { closedChaseIds: [] };
  }
}
