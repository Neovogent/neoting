import type { DocumentType } from '@prisma/client';

import type { SupplierStatementLineOutcome, SupplierStatementTotals } from '@neoting/contracts/model';

import {
  type ChaseCandidateDocument,
  type ChaseTargetTransaction,
  chaseMatchesDocument,
} from '../../chase/index.js';

/**
 * Supplier-statement reconciliation — the PURE half (issue #318).
 *
 * A supplier statement is the supplier's own list of what they invoiced in a
 * period. Reconciling it against the documents we hold finds the invoices
 * nobody knew were missing: SoT §4 detection engine (b),
 * `SUPPLIER_STATEMENT_GAP`. Until this module the accountant's Supplier
 * Statements tab computed its "on file / no document" marks in the browser out
 * of whatever happened to be on screen, plus one invented missing line. This
 * is the server-side computation that replaces it, read through
 * `GET /supplier-statements`.
 *
 * **One ruler.** The compare is the chase lane's own `chaseMatchesDocument` —
 * the predicate auto-close closes a chase on and the match suggester writes
 * SUGGESTED rows with — reached through the chase module's public seam. A
 * statement line stands in for the chased transaction: its amount is the
 * amount, its date the booked date, and the statement's supplier name is the
 * merchant label. No second tolerance, no second supplier rule exists here;
 * if the product's idea of "this document answers that line" ever changes it
 * changes in `auto-close.ts` and this follows.
 *
 * **Deterministic and explainable.** Same statement, same documents, same
 * answer, and every outcome has a one-sentence reason:
 *
 *  - lines are walked oldest first (undated last, then reference, then id);
 *  - a line with no amount is `UNREADABLE` — nothing can be checked against
 *    it, and a person has to read the statement;
 *  - a document answers AT MOST ONE line. When several documents fit one line
 *    the pick is: a matching printed reference first, then the closest
 *    amount, then the closest date, then the document id — so two identical
 *    lines against one document yield one `MATCHED` and one `MISSING`, which
 *    is the truth (one of them is missing);
 *  - a credit line (negative pence) answers only to a credit note, and an
 *    invoice line never does — `chaseMatchesDocument` compares magnitudes, so
 *    without this a £50 credit note would "answer" a £50 invoice.
 *
 * Money is integer pence throughout (R5): sums, deltas and tolerances are all
 * integer arithmetic on the values Prisma typed. Nothing here touches the
 * database, so it can never become a way around `scopedDb`.
 */

/** One stored line, as `supplier_statement_lines` holds it. */
export interface StatementLineInput {
  readonly id: string;
  readonly reference: string | null;
  readonly lineDate: Date | null;
  /** Signed integer pence: an invoice is positive, a credit is negative. Null when unread. */
  readonly amountPence: number | null;
}

/** The document header the compare reads — the minimum, so the predicate stays cheap and pure. */
export interface CandidateDocument {
  readonly id: string;
  readonly supplierName: string | null;
  readonly totalPence: number | null;
  readonly documentDate: Date | null;
  readonly reference: string | null;
  readonly docType: DocumentType | null;
}

export interface ReconciledLine {
  readonly id: string;
  readonly reference: string | null;
  readonly lineDate: Date | null;
  readonly amountPence: number | null;
  readonly outcome: SupplierStatementLineOutcome;
  /** Non-null exactly when `outcome` is `MATCHED`. */
  readonly matchedDocumentId: string | null;
}

export interface Reconciliation {
  /** In the order the lines were walked — oldest first, undated last. */
  readonly lines: readonly ReconciledLine[];
  readonly totals: SupplierStatementTotals;
}

/**
 * Does this document answer this statement line, by the product's one rule?
 *
 * Exported on its own so a test can pin the adapter, and so a later engine-(b)
 * chase can ask the same question of one line without re-running a statement.
 *
 * The line plays the chased transaction's part. A line with no date skips the
 * date gate the same way an undated DOCUMENT does in `chaseMatchesDocument`
 * (supplier + amount already identify the invoice) — expressed by nulling the
 * candidate's date, because the ruler owns that gate and this adapter must not
 * grow a second opinion about when a date is "close enough".
 */
export function statementLineMatchesDocument(
  line: Pick<StatementLineInput, 'amountPence' | 'lineDate'>,
  supplierName: string,
  document: Pick<CandidateDocument, 'supplierName' | 'totalPence' | 'documentDate' | 'docType'>,
): boolean {
  if (line.amountPence === null) return false;
  if (!creditKindAgrees(line.amountPence, document.docType)) return false;

  const target: ChaseTargetTransaction = {
    amountPence: line.amountPence,
    // Read by the ruler only when the candidate carries a date, and below the
    // candidate's date is nulled exactly when the line has none — so this
    // placeholder is never compared against anything.
    bookedAt: line.lineDate ?? UNDATED,
    merchantName: supplierName,
    descriptionRaw: supplierName,
  };
  const candidate: ChaseCandidateDocument = {
    supplierName: document.supplierName,
    totalPence: document.totalPence,
    documentDate: line.lineDate === null ? null : document.documentDate,
  };
  return chaseMatchesDocument(candidate, target);
}

/**
 * Reconcile one statement's lines against the documents we hold for that
 * client. `documents` is the caller's already-scoped candidate set (not
 * deleted, not the statement's own source file, has a supplier and a total);
 * this function decides nothing about tenancy.
 */
export function reconcileSupplierStatement(
  supplierName: string,
  lines: readonly StatementLineInput[],
  documents: readonly CandidateDocument[],
): Reconciliation {
  const used = new Set<string>();
  const ordered = [...lines].sort(compareLines);

  const reconciled: ReconciledLine[] = ordered.map((line) => {
    if (line.amountPence === null) return outcomeOf(line, 'UNREADABLE', null);

    const pick = documents
      .filter((doc) => !used.has(doc.id) && statementLineMatchesDocument(line, supplierName, doc))
      .map((doc) => ({ doc, rank: rankOf(line, doc) }))
      .sort((a, b) => compareRanks(a.rank, b.rank))[0];

    if (pick === undefined) return outcomeOf(line, 'MISSING', null);
    used.add(pick.doc.id);
    return outcomeOf(line, 'MATCHED', pick.doc.id);
  });

  return { lines: reconciled, totals: totalsOf(reconciled) };
}

/** The arithmetic, integer pence throughout. A null amount counts toward nothing. */
export function totalsOf(lines: readonly ReconciledLine[]): SupplierStatementTotals {
  let statementTotalPence = 0;
  let matchedTotalPence = 0;
  let missingTotalPence = 0;
  let matchedCount = 0;
  let missingCount = 0;
  let unreadableCount = 0;

  for (const line of lines) {
    if (line.amountPence !== null) statementTotalPence += line.amountPence;
    switch (line.outcome) {
      case 'MATCHED':
        matchedCount += 1;
        matchedTotalPence += line.amountPence ?? 0;
        break;
      case 'MISSING':
        missingCount += 1;
        missingTotalPence += line.amountPence ?? 0;
        break;
      case 'UNREADABLE':
        unreadableCount += 1;
        break;
    }
  }

  return {
    lineCount: lines.length,
    matchedCount,
    missingCount,
    unreadableCount,
    statementTotalPence,
    matchedTotalPence,
    missingTotalPence,
  };
}

// ---- internals --------------------------------------------------------------

/** Never compared — see `statementLineMatchesDocument`. */
const UNDATED = new Date(0);

/** Ranks sort ascending; a smaller tuple is a better pick. */
interface Rank {
  /** 0 when the printed reference matches the document's, 1 otherwise. */
  readonly reference: 0 | 1;
  /** Absolute pence between the line and the document. */
  readonly amountDelta: number;
  /** Whole milliseconds between the dates; the sentinel when either is unknown. */
  readonly dateDelta: number;
  readonly id: string;
}

const UNKNOWN_DATE_DELTA = Number.MAX_SAFE_INTEGER;

function rankOf(line: StatementLineInput, doc: CandidateDocument): Rank {
  return {
    reference: referenceMatches(line.reference, doc.reference) ? 0 : 1,
    amountDelta: Math.abs(Math.abs(line.amountPence ?? 0) - Math.abs(doc.totalPence ?? 0)),
    dateDelta:
      line.lineDate === null || doc.documentDate === null
        ? UNKNOWN_DATE_DELTA
        : Math.abs(line.lineDate.getTime() - doc.documentDate.getTime()),
    id: doc.id,
  };
}

function compareRanks(a: Rank, b: Rank): number {
  return (
    a.reference - b.reference ||
    a.amountDelta - b.amountDelta ||
    a.dateDelta - b.dateDelta ||
    compareStrings(a.id, b.id)
  );
}

/**
 * Oldest first; undated lines last; then by printed reference (absent last);
 * then by id, so the walk order — and therefore which of two identical lines
 * takes the one document — is the same on every read.
 */
function compareLines(a: StatementLineInput, b: StatementLineInput): number {
  return (
    compareNullableNumbers(a.lineDate?.getTime() ?? null, b.lineDate?.getTime() ?? null) ||
    compareNullableStrings(a.reference, b.reference) ||
    compareStrings(a.id, b.id)
  );
}

/**
 * A credit line (negative pence) is answered only by a credit note; an invoice
 * line is answered by anything that is not one. An unknown `docType` is read
 * as "not a credit note", because the extractor leaves it null when it could
 * not tell, and a document it could not type is far more often an invoice.
 */
function creditKindAgrees(amountPence: number, docType: DocumentType | null): boolean {
  const lineIsCredit = amountPence < 0;
  const docIsCredit = docType === 'CREDIT_NOTE';
  return lineIsCredit === docIsCredit;
}

/**
 * Printed references compare after normalisation — case folded, everything
 * that is not a letter or digit dropped — so `INV-0042` and `inv 0042` agree.
 * Two absent references do NOT match: absence is not a shared value.
 */
function referenceMatches(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const na = normaliseReference(a);
  const nb = normaliseReference(b);
  return na !== '' && na === nb;
}

function normaliseReference(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function outcomeOf(
  line: StatementLineInput,
  outcome: SupplierStatementLineOutcome,
  matchedDocumentId: string | null,
): ReconciledLine {
  return {
    id: line.id,
    reference: line.reference,
    lineDate: line.lineDate,
    amountPence: line.amountPence,
    outcome,
    matchedDocumentId,
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Nulls sort last in both helpers below. */
function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStrings(a, b);
}

function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}
