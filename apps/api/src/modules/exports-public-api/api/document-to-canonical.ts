import { CanonicalTransactionDocumentSchema, type CanonicalRow, type CanonicalSourceLink } from '../canonical/canonical-row.js';

import { type AnalysisAccountChart, resolveAnalysisAccount } from './analysis-account-chart.js';

/**
 * Prisma `documents` row → one canonical export row (A9).
 *
 * **Pure. No database, no clock, no config.** It is the one place a stored
 * document becomes something an emitter can write, so what the VT file says and
 * what the D43 manifest says cannot disagree about the same document.
 *
 * ## The nominal is RESOLVED here, and this is the only place it is
 *
 * `Analysis account` must carry the ledger prefix — literally
 * `Cost of sales: Purchases` — and until 2 Sep 2026 this function passed
 * `documents.category_code` straight into it, so the file carried a bare
 * `SUBSCRIPTIONS` and VT type-guessed it (§24.3.1). The chart now arrives as a
 * parameter: resolution happens where the ROWS are assembled, never inside the
 * emitter, which stays a pure function over rows with no idea a chart exists.
 * See `analysis-account-chart.ts` for why it arrives as data rather than as an
 * import of `rules-suggestions`.
 *
 * ## Every refusal is reported, never silently skipped
 *
 * A document that cannot become a row is returned as a `refused` result naming
 * the reason. The service turns that into an `ExportWarning` on the export.
 * SoT §24.3.4 names silent flattening as the failure mode this whole surface is
 * designed against, and a short file that looked complete is the same failure
 * one level up: an accountant reconciling `rowCount` against VT's own sheet has
 * no way to notice a row that was never written.
 *
 * In practice the refusals should not fire. Only `PUBLISHED` documents are
 * exported, and reaching `READY` already requires Total, Supplier and Category
 * (`validation-dedupe/readiness.ts`, which the publish minimum reuses). They are
 * here because "the state machine guarantees it" is exactly the assumption that
 * puts a wrong number — or no number — in someone's books.
 *
 * ## Money never stops being an integer here
 *
 * Pence in, pence out. `formatPenceDecimal` is the only thing in this module
 * that makes a decimal string, and it lives at the emitter boundary
 * (`canonical/money.ts`). Nothing in this file divides by 100.
 */

/**
 * The columns an export reads. Structural rather than Prisma's generated type,
 * so the unit tests build one by hand and the whole mapping is provable offline.
 */
export interface ExportableDocumentRow {
  readonly id: string;
  readonly businessId: string | null;
  /** `COSTS` → the counterparty is a supplier, `SALES` → a customer. */
  readonly inbox: 'COSTS' | 'SALES' | 'UNROUTED';
  readonly docType: 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE' | 'STATEMENT' | 'OTHER' | null;
  readonly supplierName: string | null;
  readonly customerName: string | null;
  readonly documentDate: Date | null;
  /** Gross, integer pence, as stored. The sign is re-derived below. */
  readonly totalPence: number | null;
  readonly taxPence: number | null;
  readonly reference: string | null;
  readonly categoryCode: string | null;
}

export type DocumentRefusalCode =
  | 'document-unrouted'
  | 'document-missing-date'
  | 'document-missing-total'
  | 'document-missing-counterparty'
  | 'document-missing-category'
  | 'document-not-representable';

export type DocumentRowResult =
  | { readonly ok: true; readonly row: CanonicalRow }
  | { readonly ok: false; readonly code: DocumentRefusalCode; readonly message: string };

/**
 * `YYYY-MM-DD` from a stored instant, read in **UTC**.
 *
 * Rule 8: UTC in storage, Europe/London in rendering. A document date is a
 * calendar date that was widened into a `timestamptz` by the column type, so the
 * honest read is the UTC one — re-interpreting midnight UTC in Europe/London
 * during BST turns 4 August into 3 August in the accountant's file, which is the
 * bug `canonical-row.ts` refuses to construct a `Date` in order to avoid.
 */
function calendarDateOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * **The sign is derived from the instrument, never trusted from the column.**
 *
 * `documents.total_pence` is written by extraction as the amount printed on the
 * paper, and a credit note prints a positive number with the word CREDIT beside
 * it. The canonical model wants one signed amount (§24.3.4, debit positive), so
 * the magnitude is taken from the column and the sign from what the document
 * *is*. Trusting the column would give a credit note that happened to be stored
 * negative a doubly-negated total — and VT drops the sign again anyway, so the
 * error would be invisible in the file and visible only in the manifest.
 */
function signFor(instrument: 'INVOICE' | 'CREDIT_NOTE'): 1 | -1 {
  return instrument === 'CREDIT_NOTE' ? -1 : 1;
}

/**
 * One document → one canonical row, or a named refusal.
 *
 * ⚠ **Every document becomes a `TRANSACTION_DOCUMENT`, never a
 * `BANK_STATEMENT_LINE`.** The second record family is fed by bank lines, not by
 * documents, and ID has no bank-line export at all: D40 makes manual statement
 * upload the only bank input and statement extraction is on the launch plan's
 * cut list. A `STATEMENT` document exported here is exported as what it is — a
 * document — rather than being silently expanded into lines nobody extracted.
 */
export function documentToCanonicalRow(
  document: ExportableDocumentRow,
  sourceLink: CanonicalSourceLink | null,
  chart: AnalysisAccountChart | null = null,
): DocumentRowResult {
  if (document.businessId === null) {
    // `document_links` requires a business and so does `exports`. A document
    // nobody has assigned to a client cannot be on a client's export.
    return refuse('document-unrouted', 'This document has not been assigned to a client, so it cannot be exported.');
  }
  if (document.documentDate === null) {
    return refuse(
      'document-missing-date',
      'This document has no date, so there is nothing to put in the Date column. Add one and export again.',
    );
  }
  if (document.totalPence === null) {
    return refuse(
      'document-missing-total',
      'This document has no total, so it was left out of the file rather than exported as zero.',
    );
  }

  const party = document.inbox === 'SALES' ? 'CUSTOMER' : 'SUPPLIER';
  // The name VT's Converter keys its saved supplier mapping on. Read from the
  // side the inbox says, with the other as a fallback — a sales document with
  // only `supplier_name` filled in is a mis-extraction, not a reason to export
  // it against a blank account.
  const primaryAccount = (party === 'CUSTOMER' ? document.customerName : document.supplierName)?.trim() ?? '';
  const fallbackAccount = (party === 'CUSTOMER' ? document.supplierName : document.customerName)?.trim() ?? '';
  const account = primaryAccount !== '' ? primaryAccount : fallbackAccount;
  if (account === '') {
    return refuse(
      'document-missing-counterparty',
      'This document has no supplier or customer name, so VT would have nothing to post it against.',
    );
  }

  const categoryCode = document.categoryCode?.trim() ?? '';
  if (categoryCode === '') {
    return refuse(
      'document-missing-category',
      'This document has not been coded to a nominal, so it was left out rather than exported to a guessed one.',
    );
  }

  /**
   * ⚠ **The unresolvable case falls back to the bare code, and is never
   * silent.**
   *
   * Three answers were available and two of them are worse. *Guessing* a ledger
   * for an off-chart code puts a wrong nominal in somebody's books, which is the
   * one thing §24.4.6 ranks above every other coding error. *Refusing* the
   * document drops a row an accountant asked for, and a short export file that
   * looked complete is the failure this whole surface is designed against
   * (§24.3.4) — worse still here, because `documents.category_code` is free text
   * in the schema and an accountant's own explicit rule may legitimately name a
   * code the chart does not carry.
   *
   * So the row travels carrying exactly what the column holds, and the emitter
   * raises `analysis-account-unprefixed` against this document. That warning is
   * on the publish review card (the entry preview is built by the real emitter),
   * so the accountant sees it BEFORE the release rather than discovering an
   * unmatched nominal inside VT afterwards.
   */
  const analysisAccount = resolveAnalysisAccount(chart, categoryCode) ?? categoryCode;

  const instrument = document.docType === 'CREDIT_NOTE' ? 'CREDIT_NOTE' : 'INVOICE';
  const sign = signFor(instrument);
  const grossPence = Math.abs(document.totalPence) * sign;
  const vatPence = Math.abs(document.taxPence ?? 0) * sign;
  const netPence = grossPence - vatPence;

  const candidate = {
    family: 'TRANSACTION_DOCUMENT' as const,
    documentId: document.id,
    businessId: document.businessId,
    sourceLink,
    party,
    instrument,
    date: calendarDateOf(document.documentDate),
    primaryAccount: account,
    reference: document.reference?.trim() ?? '',
    grossPence,
    vatPence,
    netPence,
    analysis: [{ analysisAccount, netPence, vatPence }],
  };

  // Parsed rather than asserted, at the one place this module builds a row.
  // The refusals above cover the absences; this catches the arithmetic — VAT
  // recorded larger than the total flips the net's sign, which the canonical
  // model refuses as "a parsing accident, not a transaction". A 500 would be
  // the wrong answer to one bad document in a month's export.
  const parsed = CanonicalTransactionDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    return refuse(
      'document-not-representable',
      `This document's figures do not add up, so it was left out rather than exported wrong: ${parsed.error.issues
        .map((issue) => issue.message)
        .join(' ')}`,
    );
  }

  return { ok: true, row: parsed.data };
}

function refuse(code: DocumentRefusalCode, message: string): DocumentRowResult {
  return { ok: false, code, message };
}
