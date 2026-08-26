import type { ExportWarning } from '@neoting/contracts/model';

import {
  CanonicalRowsSchema,
  type CanonicalBankStatementLine,
  type CanonicalRow,
  type CanonicalSourceLink,
  type CanonicalTransactionDocument,
} from '../../canonical/canonical-row.js';
import { serialiseCsv } from '../csv/csv.js';
import { encodeCsv } from '../csv/encoding.js';
import type { EmittedFile, ExportEmitter } from '../export-emitter.js';

import { formatVtAmount, formatVtDate, vtTypeForBankLine, vtTypeForDocument } from './vt-format.js';
import { assertVtEntryDetailsSafe, breakLongNumericTokens } from './vt-safety.js';

/**
 * The VT Transaction+ emitter — the Universal Input Sheet layout.
 *
 * VT is a **solved target**, not a guess (§24.3.1): `Transactions › Universal
 * Input Sheet › Import from: CSV File`, column-mapped rather than
 * header-driven, staged onto the sheet for the accountant to review and press
 * **Post**. That last property is why VT suits this product — the import is a
 * review queue, which is the same shape as Review → Approve.
 *
 * **Nothing here transmits anything** (D42). This function returns bytes. The
 * accountant downloads them and imports them. *Published* is an internal state
 * meaning approved and released for export; the operation is **"Export for
 * VT"**, and any string in any surface implying that a ledger was written to is
 * a D42 defect.
 */

/**
 * ⚠ **VT's on-screen column order. Do not reorder.**
 *
 * The import dialog is column-mapped, so a different order is recoverable —
 * the accountant repoints each column by hand. Matching VT's own order is what
 * makes it one click instead, on every import, for ever.
 */
export const VT_UIS_COLUMNS = [
  'Type',
  'Ref no',
  'Date',
  'Primary account',
  'Details',
  'Total',
  'VAT',
  'Analysis',
  'Analysis account',
  'Entry details',
  'Transaction notes',
] as const;

/**
 * ⚠ **A10 CHANGES THIS LINE** (the second of the module's two open questions;
 * the other is `csv/encoding.ts`).
 *
 * VT's import is column-mapped, not header-driven, so a header row is a
 * convenience for the human choosing destinations rather than something VT
 * parses. The two ways to be wrong are symmetrical and both are cheap to fix
 * from here: with the header, VT may stage it as a junk first row the
 * accountant deletes; without it, the accountant maps eleven unlabelled
 * columns. Defaulting to *with*, because a labelled column is easier to map
 * than an unlabelled one and VT's dialog has a start-row control for the
 * former problem.
 */
export const VT_CSV_INCLUDE_HEADER = true;

/** §24.3.2 rung 3, and rule 9: this is provenance, not a claim that anything was sent. */
export const VT_PROVENANCE_TAG = 'Imported from Neo Accounting';

/**
 * VT stores a **VAT amount in pounds and has no tax codes at all** (§24.3.1) —
 * no T0/T1/T20, nothing to map. Whether something is in scope is a property of
 * the analysis account, not of the transaction. Recorded here because the
 * absence of a tax-code column is the kind of thing a future emitter author
 * assumes is an oversight.
 */

interface RowBuild {
  readonly cells: readonly string[];
  readonly warnings: readonly ExportWarning[];
}

/**
 * Free text on its way into a cell: guarded against landmine 1, and the guard's
 * repair reported rather than swallowed.
 */
function safeText(value: string, documentId: string, field: string, warnings: ExportWarning[]): string {
  const guarded = breakLongNumericTokens(value);
  if (guarded.changed) {
    warnings.push({
      documentId,
      code: 'long-numeric-token-broken',
      message: `The ${field} on this document contained a run of more than 16 digits, which crashes VT builds older than May 2025. It was split into groups so the file imports; check the value in VT before posting.`,
    });
  }
  return guarded.value;
}

/**
 * `Entry details` — **D43 rung 1**, the field VT itself designates for extra
 * per-line detail and exactly where Dext puts its link.
 *
 * ⚠ **THE A8 ATTACHMENT POINT (1 of 2).** A8 mints the capability code and
 * fills `row.sourceLink`; this function is where it lands, and it needs no
 * change to do so. Until A8 merges, `sourceLink` is null, the cell is blank and
 * the export says so — D43 requires every exported transaction to carry a
 * resolvable link, and an export that quietly carries none is the failure this
 * whole surface exists to prevent.
 */
function entryDetailsCell(
  sourceLink: CanonicalSourceLink | null,
  documentId: string,
  warnings: ExportWarning[],
): string {
  if (sourceLink === null) {
    warnings.push({
      documentId,
      code: 'source-link-missing',
      message:
        'This row has no source-document link, so the Entry details column is blank. D43 requires one on every exported transaction.',
    });
    return assertVtEntryDetailsSafe('');
  }
  // Landmine 2. Throws on a letterless code rather than silently emitting one
  // that VT will render as a number — see `vt-safety.ts`.
  return assertVtEntryDetailsSafe(sourceLink.code);
}

/**
 * `Transaction notes` — **D43 rung 3**: the code again, the full URL, and the
 * provenance tag, in a field with no length limit. Also what makes our rows
 * findable and reversible inside VT.
 *
 * ⚠ **THE A8 ATTACHMENT POINT (2 of 2).** A8's `https://…/d/{code}` URL is
 * written here. It passes the landmine-1 guard like any other text: a URL is a
 * place a long digit run hides, and VT does not care that the digits were part
 * of a link when it crashes on them.
 */
function transactionNotesCell(
  sourceLink: CanonicalSourceLink | null,
  reference: string,
  documentId: string,
  warnings: ExportWarning[],
): string {
  const parts: string[] = [];
  if (reference.length > 0) parts.push(reference);
  if (sourceLink !== null) parts.push(sourceLink.code, sourceLink.url);
  parts.push(VT_PROVENANCE_TAG);
  return safeText(parts.join(' · '), documentId, 'transaction notes', warnings);
}

/**
 * `Analysis account` **carries the ledger prefix** — `Cost of sales:
 * Purchases`, `Expenses: Motor expenses` — where `Primary account` carries the
 * name alone. Getting these two the wrong way round is the single most likely
 * way to produce a file that imports cleanly and posts to the wrong place.
 */
function analysisAccountCell(
  account: string,
  documentId: string,
  warnings: ExportWarning[],
): string {
  if (!account.includes(':')) {
    warnings.push({
      documentId,
      code: 'analysis-account-unprefixed',
      message: `The analysis account "${account}" has no ledger prefix. VT expects "Cost of sales: Purchases" form and may not match it to a nominal without one.`,
    });
  }
  return safeText(account, documentId, 'analysis account', warnings);
}

/**
 * **One nominal per row** (§24.3.4). VT cannot import a split analysis, and
 * this is where that constraint is paid.
 *
 * The choice is collapse-and-tell, not split. Splitting a document into several
 * UIS rows would create several *transactions* in VT — several supplier
 * balances where the accountant has one invoice — which reconciles to a wrong
 * creditor. Collapsing keeps `Total` equal to the document's gross, which is
 * the number that reconciles against the supplier statement, and puts the whole
 * net against the largest line's nominal.
 *
 * That misposts part of the value, on purpose, and says so. §24.3.4: *silent
 * flattening is the failure mode to design against.*
 */
function collapseAnalysis(
  row: CanonicalTransactionDocument,
  warnings: ExportWarning[],
): string {
  const [dominant, ...rest] = [...row.analysis].sort(
    (a, b) => Math.abs(b.netPence) - Math.abs(a.netPence),
  );
  const account = dominant?.analysisAccount ?? '';

  if (rest.length > 0) {
    const dropped = rest.map((line) => line.analysisAccount).join(', ');
    warnings.push({
      documentId: row.documentId,
      code: 'analysis-collapsed',
      message: `VT accepts one nominal per row, so this document was exported against "${account}" for its full net. Reallocate in VT after posting: ${dropped}.`,
    });
  }

  return account;
}

function buildDocumentRow(row: CanonicalTransactionDocument): RowBuild {
  const warnings: ExportWarning[] = [];

  const cells = [
    vtTypeForDocument(row),
    // `Ref no` is LEFT BLANK, deliberately (§24.3.1): VT assigns its own
    // reference at post time, and our document code goes to Entry details and
    // Transaction notes. Writing here would collide with VT's own numbering.
    '',
    formatVtDate(row.date),
    // Passed through byte-for-byte. VT's Converter saves the supplier mapping
    // against this exact string; re-casing or re-trimming it makes every future
    // import manual again (§24.3.1).
    safeText(row.primaryAccount, row.documentId, 'supplier or customer name', warnings),
    // `Details` is SHORT on purpose — VT's AutoComplete keys off it and VT's own
    // help warns against padding it. The invoice number, not a sentence.
    safeText(row.reference, row.documentId, 'document reference', warnings),
    formatVtAmount(row.grossPence),
    formatVtAmount(row.vatPence),
    formatVtAmount(row.netPence),
    analysisAccountCell(collapseAnalysis(row, warnings), row.documentId, warnings),
    entryDetailsCell(row.sourceLink, row.documentId, warnings),
    transactionNotesCell(row.sourceLink, row.reference, row.documentId, warnings),
  ];

  return { cells, warnings };
}

/**
 * A bank line in the general UIS layout.
 *
 * §24.3.1 notes that VT also has a dedicated bank-statement import mode mapping
 * only Date / Description / Payment / Receipt, and that bank rows are not
 * forced through the general layout. That second file is not A7's — ID's bank
 * input is a manual statement upload (D40) and statement extraction is on the
 * plan's own cut list. What is here is the `PAY`/`CHQ`/`REC` mapping the stage
 * specifies, so the canonical model's second record family has a real emitter
 * behind it rather than a `throw`.
 */
function buildBankRow(row: CanonicalBankStatementLine): RowBuild {
  const warnings: ExportWarning[] = [];

  const cells = [
    vtTypeForBankLine(row),
    '',
    formatVtDate(row.date),
    safeText(row.bankAccount, row.documentId, 'bank account name', warnings),
    safeText(row.description, row.documentId, 'statement narrative', warnings),
    formatVtAmount(row.grossPence),
    formatVtAmount(row.vatPence),
    formatVtAmount(row.netPence),
    analysisAccountCell(row.contraAccount, row.documentId, warnings),
    entryDetailsCell(row.sourceLink, row.documentId, warnings),
    transactionNotesCell(row.sourceLink, row.description, row.documentId, warnings),
  ];

  return { cells, warnings };
}

class VtTransactionPlusEmitter implements ExportEmitter {
  readonly target = 'VT_TRANSACTION_PLUS' as const;
  readonly fileExtension = 'csv';
  readonly contentType = 'text/csv';

  emit(rows: readonly CanonicalRow[]): EmittedFile {
    // Rule 4, at the one boundary this module has. The rows were assembled by
    // our own code, which is exactly the argument that stops people parsing.
    const parsed = CanonicalRowsSchema.parse(rows);

    const warnings: ExportWarning[] = [];
    const cells: string[][] = [];

    if (VT_CSV_INCLUDE_HEADER) cells.push([...VT_UIS_COLUMNS]);

    for (const row of parsed) {
      const built = row.family === 'TRANSACTION_DOCUMENT' ? buildDocumentRow(row) : buildBankRow(row);
      cells.push([...built.cells]);
      warnings.push(...built.warnings);
    }

    return {
      bytes: encodeCsv(serialiseCsv(cells)),
      rowCount: parsed.length,
      warnings,
    };
  }
}

export const vtTransactionPlusEmitter: ExportEmitter = new VtTransactionPlusEmitter();
