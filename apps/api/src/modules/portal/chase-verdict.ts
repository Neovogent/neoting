/**
 * Chase validation feedback — the portal's answer to "did I upload the right
 * thing?" (SoT §4 Stage 8.5, METH Stage 9 build item 3).
 *
 * SoT specifies the beat exactly:
 *
 *   *"Validation against the chase: the AI checks the uploaded document against
 *    the chased transaction (supplier / amount / date). Mismatch → instant
 *    in-portal feedback: "This looks like a £420 invoice, but we need the £600
 *    Google transaction from 5 Aug.""*
 *
 * That sentence is the whole specification, and this file reproduces it
 * verbatim for the case it describes. Everything here is PURE — no clock, no
 * database, no model — so the copy shown on the client's phone is a function of
 * two rows and nothing else, and a test can pin it byte for byte.
 *
 * ## This is NOT a second auto-close
 *
 * Stage 8 already closes a matching chase from the ingest hook
 * (`chase/auto-close.ts`, wired in the ingest processor). This file changes no
 * state at all: it *describes* what the compare found so the portal can say
 * "received, thank you" or name the difference. A second closer would be a
 * second place for the rules to drift.
 *
 * ## Why the reasons are PROBED rather than re-implemented
 *
 * The verdict is `chaseMatchesDocument` — the same predicate auto-close uses,
 * imported through the chase seam, never copied. Naming *which* gate failed
 * needs per-gate answers, and the obvious way to get them (re-writing the three
 * comparisons here) is exactly the drift this module must not create: the copy
 * would start saying "the amount is wrong" on a day the tolerance changed and
 * the chase stayed open, or worse, stayed silent on a day it closed.
 *
 * So each gate is probed with the SAME predicate, holding the other two open by
 * construction:
 *
 * | Gate | Probe |
 * |---|---|
 * | supplier | the document's supplier, the transaction's own amount, no date |
 * | amount | the transaction's own label, the document's amount, no date |
 * | date | the transaction's own label, the transaction's own amount, the document's date |
 *
 * A probe that forces a field to the transaction's own value cannot fail on
 * that field, so the probe answers for exactly one gate. `chaseMatchesDocument`
 * skips the date gate when the document date is `null`, which is why "no date"
 * holds it open. The tolerances live in one place still — `chase/auto-close.ts`
 * — and are never read here.
 *
 * ## Untrusted content stays data
 *
 * `document.supplierName` comes out of an extractor reading a file a stranger
 * holding a forwarded link uploaded. It is echoed into copy shown to that same
 * client, as DATA: it is never fed to a model, never interpreted, whitespace-
 * collapsed and length-clamped so a hostile "supplier name" cannot reflow or
 * flood the message. The portal renders it as text.
 */

import {
  type ChaseCandidateDocument,
  chaseMatchesDocument,
  type ChaseTargetTransaction,
  formatDay,
  formatGbp,
  normaliseSupplier,
} from '../chase/index.js';

/**
 * Why an upload does not answer the chase.
 *
 * `unreadable` is not a difference — it is the absence of one side of the
 * compare (the extractor read no supplier, or no total), which cannot be
 * described as "£420 vs £600" because there is no £420.
 */
export type ChaseMismatchReason = 'amount' | 'date' | 'supplier' | 'unreadable';

/**
 * What the portal shows for one uploaded document against one chased item.
 * `reasons` is empty if and only if `kind` is `match` — asserted in the tests
 * against `chaseMatchesDocument` itself, so the two can never part company.
 */
export interface ChaseUploadVerdict {
  readonly kind: 'match' | 'mismatch';
  readonly reasons: readonly ChaseMismatchReason[];
  /** The one line the portal shows. Plain English, both sides named. */
  readonly message: string;
}

/**
 * A supplier label or bank descriptor as it may appear in client-facing copy.
 * Whitespace collapsed (an extraction can carry newlines) and clamped, because
 * the value is client-controlled and the message is a single sentence.
 */
const MAX_LABEL_CHARS = 60;

/**
 * The chase verdict for one uploaded document against one chased transaction.
 *
 * Returns a match verdict too — the name says "mismatch" because that is the
 * beat SoT names and the interesting half of the work; a description of no
 * difference is the success copy.
 *
 * Deterministic: same document header, same transaction, same sentence.
 */
export function describeChaseMismatch(
  document: ChaseCandidateDocument,
  transaction: ChaseTargetTransaction,
): ChaseUploadVerdict {
  const need = describeTransaction(transaction);

  // The verdict is the chase module's predicate, always. Everything below only
  // explains a `false`.
  if (chaseMatchesDocument(document, transaction)) {
    return { kind: 'match', reasons: [], message: `Received, thank you — that's ${need}.` };
  }

  // One side of the compare is missing. Name what could not be read rather than
  // inventing a difference against a value we never had.
  const supplierName = document.supplierName;
  const totalPence = document.totalPence;
  if (supplierName === null || totalPence === null || normaliseSupplier(supplierName) === '') {
    const supplierUnread = supplierName === null || normaliseSupplier(supplierName) === '';
    const missing =
      supplierUnread && totalPence === null
        ? 'that document'
        : supplierUnread
          ? 'the supplier on that document'
          : 'the amount on that document';
    return {
      kind: 'mismatch',
      reasons: ['unreadable'],
      message: `We couldn't read ${missing}, but we need ${need}. Please try a clearer photo.`,
    };
  }

  const label = transaction.merchantName ?? transaction.descriptionRaw;
  const targetPence = Math.abs(transaction.amountPence);

  // Can the transaction's own label anchor a compare at all? A descriptor with
  // no word of three characters or more ("OD", "") matches nothing by design
  // (`supplierTokenMatch` drops short tokens as too collision-prone), so every
  // probe below would fail and we would report three differences where there is
  // only one thing to say: this upload is not that line.
  const labelUsable = chaseMatchesDocument({ supplierName: label, totalPence: targetPence, documentDate: null }, transaction);
  const read = { supplierName, totalPence, documentDate: document.documentDate };
  if (!labelUsable) {
    return { kind: 'mismatch', reasons: ['supplier'], message: mismatchMessage(read, ['supplier'], need) };
  }

  const reasons: ChaseMismatchReason[] = [];
  if (!chaseMatchesDocument({ supplierName, totalPence: targetPence, documentDate: null }, transaction)) {
    reasons.push('supplier');
  }
  if (!chaseMatchesDocument({ supplierName: label, totalPence, documentDate: null }, transaction)) {
    reasons.push('amount');
  }
  if (!chaseMatchesDocument({ supplierName: label, totalPence: targetPence, documentDate: document.documentDate }, transaction)) {
    reasons.push('date');
  }

  // Unreachable: the three gates are independent conjuncts of the predicate, so
  // all three passing means the predicate passed and we returned above. Left
  // without a throw because a portal screen is the wrong place to discover a
  // logic bug — the copy below still names both sides and stays true.
  return { kind: 'mismatch', reasons, message: mismatchMessage(read, reasons, need) };
}

/** The document header once both halves of the compare are known to be present. */
interface ReadDocumentHeader {
  readonly supplierName: string;
  readonly totalPence: number;
  readonly documentDate: Date | null;
}

/**
 * "This looks like a £420 Amazon invoice from 1 Jul, but we need the £600
 * Google transaction from 5 Aug."
 *
 * The lead names the document's amount always, and its supplier and date ONLY
 * when they are what differs — so the single-difference case reads exactly as
 * SoT writes it ("This looks like a £420 invoice, but we need the £600 Google
 * transaction from 5 Aug") rather than repeating a supplier that already
 * agrees. The "we need" clause is always complete: whatever went wrong, the
 * client is told the whole of what to look for.
 *
 * "invoice" is SoT's own noun for the uploaded thing. The compare input carries
 * no document type (`ChaseCandidateDocument` is supplier + total + date), so
 * the copy does not claim one it cannot read.
 */
function mismatchMessage(document: ReadDocumentHeader, reasons: readonly ChaseMismatchReason[], need: string): string {
  const supplier = reasons.includes('supplier') ? ` ${displayLabel(document.supplierName)}` : '';
  const from = reasons.includes('date') && document.documentDate !== null ? ` from ${formatDay(document.documentDate)}` : '';
  return `This looks like a ${formatGbp(document.totalPence)}${supplier} invoice${from}, but we need ${need}.`;
}

/**
 * "the £600 Google transaction from 5 Aug" — the chased line, in the client's
 * own terms. The label is the enriched merchant name when the feed has one and
 * the raw bank descriptor otherwise, the same fallback the compare and the SMS
 * copy use; a feed line with neither drops the label rather than printing a
 * gap.
 */
function describeTransaction(transaction: ChaseTargetTransaction): string {
  const label = displayLabel(transaction.merchantName ?? transaction.descriptionRaw);
  const named = label === '' ? '' : ` ${label}`;
  return `the ${formatGbp(transaction.amountPence)}${named} transaction from ${formatDay(transaction.bookedAt)}`;
}

/** Client-controlled text on its way into a sentence: one line, bounded length. */
function displayLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS).trim();
}
