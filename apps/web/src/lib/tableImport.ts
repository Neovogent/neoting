import { parseAmount, type ColumnMap, type SheetAnalysis, type SheetKind, type TableRow } from './spreadsheet';
import type { BankTransaction, Client, DocKind, Document, ExtractedField, SourceChannel } from './types';

/**
 * Turning a sheet's rows into the records the rest of the app deals in.
 *
 * A spreadsheet is not one document, it is a hundred of them, and every value
 * is already in a cell with a heading over it. That changes the honest
 * confidence to attach: a total read out of a column called Total was not
 * inferred from a photograph, so it is not 91% — it is simply what the file
 * says. Where a judgement is genuinely made — which way the money went, what
 * category this is — the confidence drops and says why.
 *
 * ## Why #65 extracted nothing here
 *
 * Every string this module writes lands on a record, and the records are what
 * the rest of the app joins on:
 *
 *   · `ExtractedField.label` — "Supplier", "Customer", "Document date",
 *     "Invoice number", "Total", "Tax amount", "Category", "Document type" —
 *     is compared by exact string in `lib/selectors.ts`, `lib/readiness.ts`,
 *     `views/ClientInbox.tsx`, `DynamicComponents/AnalysisModal.tsx` and
 *     `api/mocks/fixtures.ts`. They are keys into the extraction, and
 *     `lib/ingest.ts` writes the same ones from the OCR path.
 *   · `ExtractedField.value` and `.provenance` are read the same way —
 *     `AnalysisModal` tests the "Document type" value, `lib/dedupe.ts` matches
 *     a reference field by pattern.
 *   · `Document.supplier`, `.statusNote` and `BankTransaction.description` are
 *     matched too: `readiness.ts` holds a list of placeholder suppliers,
 *     `matching.ts` scores a transaction description against a supplier name,
 *     and `api/documents.ts` fills `statusNote` from the server's own
 *     `failureMessage` — a field that can hold a sentence written elsewhere
 *     cannot be a catalogue entry.
 *   · the `display()` date format below is a format, not a phrase (§12.6).
 *
 * The one genuine candidate left is `skipped[].reason`, which is transient UI
 * feedback. It stayed because `tableImport.test.ts` asserts it by substring
 * and `AnalysisModal` already interpolates it as a value — converting it needs
 * both of those files in the same change.
 */

let seq = 0;

/* ── dates ────────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const display = (d: Date) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/**
 * A date cell, in whichever of the four shapes a spreadsheet hands over.
 *
 * XLSX stores dates as a serial count of days, so a column that reads
 * "01/08/2026" on screen arrives here as 46235. Left as text that becomes a
 * supplier reference or a zero, and the whole import lands undated. The epoch
 * is 1899-12-30 rather than 12-31 because Excel believes 1900 was a leap year
 * and the offset absorbs that.
 *
 * Ambiguous slash dates are read day-first: this is a UK product, and
 * 03/08/2026 is the third of August to every client using it.
 */
/**
 * `new Date(y, m, d)` with an out-of-range component ROLLS OVER, and the result
 * is a perfectly valid Date — so a `Number.isNaN` guard never fires on it. An
 * impossible date does not become null, it becomes a different, plausible one.
 *
 * That is why this reads the components back rather than checking for NaN.
 * A US-formatted client export of `01/13/2026` was being read day-first as
 * "month 13", rolled forward, and imported as **1 January 2027** — the wrong
 * VAT quarter — with `status: 'ready'` and a confident "Document date" on
 * screen. `32/08/2026` became 1 September. Nothing indicated a guess.
 *
 * Reading day-first is correct and is the repo invariant (CLAUDE.md, "UK d/m/y
 * disambiguation in parsers"). Silently accepting month-first input and
 * re-dating it is not the same thing, and is what this refuses.
 *
 * Returning null is already handled: analyseSheet has a "Missing date" path, so
 * the row surfaces for review instead of importing a fiction.
 */
function exactDate(year: number, monthIndex: number, day: number): Date | null {
  const d = new Date(year, monthIndex, day);
  if (d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) return null;
  return d;
}

export function parseSheetDate(cell: string | undefined): string | null {
  if (!cell) return null;
  const raw = cell.trim();
  if (!raw) return null;

  // Excel serial.
  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const serial = Number.parseFloat(raw);
    const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86400000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : display(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  // ISO, which sorts and parses unambiguously. Every group in both patterns
  // below is unconditional, so a match carries all three of them.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso?.[1] && iso[2] && iso[3]) {
    const d = exactDate(+iso[1], +iso[2] - 1, +iso[3]);
    return d ? display(d) : null;
  }

  // Day-first slash or dot separated.
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(raw);
  if (slash?.[1] && slash[2] && slash[3]) {
    const year = slash[3].length === 2 ? 2000 + +slash[3] : +slash[3];
    const d = exactDate(year, +slash[2] - 1, +slash[1]);
    return d ? display(d) : null;
  }

  // "12 Aug 2026" and friends, which Date already understands.
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : display(parsed);
}

/* ── which way the money went ─────────────────────────────────────────────── */

const SALES_WORDS = /\b(sales|invoices? out|customers?|receivable|income|revenue)\b/i;
const COST_WORDS = /\b(purchases?|costs?|expenses?|suppliers?|payable|spend|bills?)\b/i;

/**
 * The sheet's own default direction, before any row is read.
 *
 * A file called `sales-august.csv` with a Customer column is a sales listing,
 * and every row in it is money in unless that row says otherwise. Guessing per
 * row from the sign alone gets this wrong constantly, because most exports
 * write every figure as a positive number.
 */
export function defaultKindFor(analysis: SheetAnalysis, fileName: string): { kind: DocKind; reason: string } {
  // The mapping's column indexes are positions in these same headers, so the
  // lookup only misses when there is no party column at all.
  const partyAt = analysis.mapping.party;
  const partyHeader = (partyAt === undefined ? '' : analysis.headers[partyAt]) ?? '';

  if (SALES_WORDS.test(partyHeader)) return { kind: 'sales', reason: `the "${partyHeader}" column names customers` };
  if (COST_WORDS.test(partyHeader)) return { kind: 'cost', reason: `the "${partyHeader}" column names suppliers` };
  if (SALES_WORDS.test(fileName)) return { kind: 'sales', reason: `the file name says sales` };
  if (COST_WORDS.test(fileName)) return { kind: 'cost', reason: `the file name says costs` };
  return { kind: 'cost', reason: 'no direction given, and money out is the common case' };
}

/**
 * Whether the amount column carries signs at all.
 *
 * It only means something if the sheet actually uses it. A purchase listing
 * where every figure is positive says nothing about direction; a ledger export
 * with negatives in it is stating the direction of every row, and a positive
 * line in that sheet is a refund or a credit note — money in, not another
 * cost. Deciding this per row instead of per column filed those refunds as
 * spend.
 */
function columnIsSigned(rows: TableRow[], mapping: ColumnMap): boolean {
  if (mapping.amount === undefined) return false;
  return rows.some((cells) => parseAmount(cells[mapping.amount!]) < 0);
}

/** A single row's direction, which can differ from the sheet's. */
function kindOfRow(
  cells: TableRow,
  mapping: ColumnMap,
  fallback: DocKind,
  signed: boolean,
): { kind: DocKind; sure: boolean } {
  const inValue = mapping.moneyIn !== undefined ? parseAmount(cells[mapping.moneyIn]) : 0;
  const outValue = mapping.moneyOut !== undefined ? parseAmount(cells[mapping.moneyOut]) : 0;
  if (inValue > 0 && outValue === 0) return { kind: 'sales', sure: true };
  if (outValue > 0 && inValue === 0) return { kind: 'cost', sure: true };

  if (signed && mapping.amount !== undefined) {
    const amount = parseAmount(cells[mapping.amount]);
    if (amount < 0) return { kind: 'cost', sure: true };
    if (amount > 0) return { kind: 'sales', sure: true };
  }
  return { kind: fallback, sure: false };
}

/** Rows that are arithmetic about the sheet rather than records in it. */
const TOTAL_WORDS = /^\s*(sub ?total|total|grand total|balance|carried forward|c\/f|b\/f|sum)\b/i;

/** The row's value, whichever way the sheet expresses it. */
export function amountOfRow(cells: TableRow, mapping: ColumnMap): number {
  if (mapping.moneyIn !== undefined || mapping.moneyOut !== undefined) {
    const inValue = mapping.moneyIn !== undefined ? parseAmount(cells[mapping.moneyIn]) : 0;
    const outValue = mapping.moneyOut !== undefined ? parseAmount(cells[mapping.moneyOut]) : 0;
    return Math.abs(inValue) || Math.abs(outValue);
  }
  return Math.abs(mapping.amount !== undefined ? parseAmount(cells[mapping.amount]) : 0);
}

/* ── rows to documents ────────────────────────────────────────────────────── */

/**
 * One spreadsheet being read, from the moment it is dropped.
 *
 * Kept apart from the documents it produces because until the parse finishes
 * there are no documents to point at, and because what the reader worked out —
 * which columns it matched, which rows it refused — is worth showing whether
 * or not the import went well.
 */
export interface SheetImport {
  id: string;
  fileName: string;
  status: 'reading' | 'done' | 'failed';
  /** What the sheet turned out to be, once known. */
  sheetKind?: SheetKind;
  reason?: string;
  headers?: string[];
  mapping?: ColumnMap;
  /** Column headings we could not place, so the UI can say what was ignored. */
  unmapped?: string[];
  documentIds: string[];
  transactionIds: string[];
  skipped: { row: number; reason: string }[];
  counts: { cost: number; sales: number; transactions: number };
  /** Set when the file could not be read at all. */
  error?: string;
}

export interface TableImportResult {
  documents: Document[];
  transactions: BankTransaction[];
  /** Rows we could not make a record out of, with the reason. */
  skipped: { row: number; reason: string }[];
}

const cellAt = (cells: TableRow, at: number | undefined) => (at === undefined ? '' : (cells[at] ?? '').trim());

export function importSheet(
  analysis: SheetAnalysis,
  fileName: string,
  client: Client | undefined,
  source: SourceChannel,
  uploader: string,
  /** Which account a bank sheet belongs to; ignored for document sheets. */
  accountId = '',
): TableImportResult {
  const { mapping, headers, rows } = analysis;
  const documents: Document[] = [];
  const transactions: BankTransaction[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const fallback = defaultKindFor(analysis, fileName);
  const signed = columnIsSigned(rows, mapping);
  let runningTotal = 0;

  rows.forEach((cells, i) => {
    const rowNumber = i + 2; // 1-indexed, and the header took row 1.
    const amount = amountOfRow(cells, mapping);
    const date = parseSheetDate(cellAt(cells, mapping.date));
    const party = cellAt(cells, mapping.party);
    const description = cellAt(cells, mapping.description);
    const label = party || description;

    // A row with no money in it is a spacer or a note.
    if (!amount) { skipped.push({ row: rowNumber, reason: 'no amount in the row' }); return; }

    /**
     * A totals line is not a document.
     *
     * Left in, "SUBTOTAL 3,330.40" becomes a document for the value of the
     * whole sheet — the entire month booked twice, once in pieces and once
     * again in one lump. Two signals catch it: the word itself in a row with
     * no date and no counterparty, and an amount that equals what has already
     * been counted.
     */
    const looksLikeTotal = TOTAL_WORDS.test(description || party) && !date && !party;
    const equalsRunningTotal = runningTotal > 0 && Math.abs(amount - runningTotal) < 0.005;
    if (looksLikeTotal || equalsRunningTotal) {
      skipped.push({
        row: rowNumber,
        reason: equalsRunningTotal ? 'the amount equals the rows above it — a totals line' : 'a totals line',
      });
      return;
    }

    if (analysis.kind === 'bank') {
      runningTotal += amount;
      const paidIn = mapping.moneyIn !== undefined ? parseAmount(cellAt(cells, mapping.moneyIn)) : 0;
      // Money out is negative on the feed, which is how the matcher and every
      // balance in the app already read it.
      const signed = paidIn > 0 ? amount : -amount;
      transactions.push({
        id: `imp-txn-${Date.now()}-${seq++}`,
        clientId: client?.id ?? '',
        clientName: client?.name ?? '',
        accountId,
        date: date ?? '—',
        description: label || 'Unnamed transaction',
        amount: signed,
        isCredit: signed > 0,
      });
      return;
    }

    runningTotal += amount;
    const { kind, sure } = kindOfRow(cells, mapping, fallback.kind, signed);
    const category = cellAt(cells, mapping.category);
    const tax = cellAt(cells, mapping.tax);
    const reference = cellAt(cells, mapping.reference);

    const fields: ExtractedField[] = [];
    const add = (labelText: string, value: string, at: number | undefined, confidence = 0.99) => {
      if (!value) return;
      fields.push({
        label: labelText,
        value,
        confidence,
        // Provenance is the cell, because that is literally where it came from.
        provenance: at === undefined ? 'read from the sheet' : `row ${rowNumber}, "${headers[at]}" column`,
      });
    };

    add(kind === 'sales' ? 'Customer' : 'Supplier', label, mapping.party ?? mapping.description);
    if (date) add('Document date', date, mapping.date);
    if (reference) add('Invoice number', reference, mapping.reference);
    add('Total', `£${amount.toFixed(2)}`, mapping.moneyIn ?? mapping.moneyOut ?? mapping.amount);
    if (tax) add('Tax amount', `£${Math.abs(parseAmount(tax)).toFixed(2)}`, mapping.tax);
    if (description && description !== label) add('Description', description, mapping.description);
    fields.push({
      label: 'Document type',
      value: kind === 'sales' ? 'Money in — sales invoice' : 'Money out — bill or receipt',
      confidence: sure ? 0.99 : 0.72,
      provenance: sure
        ? `the ${kind === 'sales' ? 'money-in' : 'money-out'} column carries the value`
        : fallback.reason,
    });
    add('Category', category, mapping.category, 0.95);

    const needsReview = !category || !label || !date;
    documents.push({
      id: `imp-${Date.now()}-${seq++}`,
      clientId: client?.id ?? '',
      clientName: client?.name ?? '',
      supplier: label || 'Unnamed row',
      date: date ?? '—',
      total: amount,
      category: category || '—',
      status: needsReview ? 'review' : 'ready',
      statusNote: !label
        ? 'Missing supplier'
        : !date
        ? 'Missing date'
        : !category
        ? 'Missing Category'
        : undefined,
      source,
      uploader,
      currency: 'GBP',
      kind,
      fields,
      lineItems: [],
      // Named so the row it came from is findable in the original file.
      splitFrom: `${fileName} — row ${rowNumber}`,
    });
  });

  return { documents, transactions, skipped };
}
