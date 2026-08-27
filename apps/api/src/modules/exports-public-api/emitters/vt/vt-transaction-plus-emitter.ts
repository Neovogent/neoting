import type { ExportWarning } from '@neoting/contracts/model';

import { buildZipArchive } from '../../bundle/zip.js';
import type {
  CanonicalBankStatementLine,
  CanonicalRow,
  CanonicalSourceLink,
  CanonicalTransactionDocument,
} from '../../canonical/canonical-row.js';
import { CanonicalRowsSchema } from '../../canonical/canonical-row.js';
import { serialiseCsv } from '../csv/csv.js';
import { encodeCsv } from '../csv/encoding.js';
import type { EmittedFile, ExportEmitter } from '../export-emitter.js';
import { formatVtAmount, vtTypeForBankLine, vtTypeForDocument } from './vt-format.js';
import type { VtType } from './vt-format.js';
import { assertVtEntryDetailsSafe, breakLongNumericTokens } from './vt-safety.js';

/**
 * VT Transaction+ — the emitter, rewritten against the real import (A10).
 *
 * ⚠ **EVERYTHING HERE WAS VERIFIED IN A REAL VT ON 27 AUG 2026.** The previous
 * version targeted the **Universal Input Sheet** with eleven columns led by a
 * `PIN`/`SIN` type code. That target does not accept an import at all:
 * `Transaction ▸ Universal Input Sheet…` opens a bank-side *Payments And
 * Receipts* sheet whose type column takes `1`/`2`/`3` and which has no import
 * command. `docs/Source_Of_Truth.md` §24.3.1 carries the finding.
 *
 * **The real route** is `Transaction ▸ Journal ▸ Import…`, CSV, data format
 * **"Payments list/purchase invoices list"**, which VT documents as:
 *
 * ```
 * A: Bank account name/supplier's name (or code)
 * B: Paid to/invoice details
 * C: Gross amount
 * D: Input VAT
 * E: Net amount (use multiple lines for split analysis)
 * F: Net amount for VAT purposes
 * G: Analysis account name (or code)
 * ```
 *
 * Three consequences shape this file, and each reverses something the old one
 * did:
 *
 * 1. **There is no date column, and no custom format can add one.** The format
 *    designer's defined-ranges list has fourteen entries and none is a date;
 *    the built-in "Trial balance with date" states `Column A: Date (ignored by
 *    VT)`. The journal's single Date field applies to every row in the file.
 *    **So one file per document date** — a mixed-date file posts every
 *    document into one VAT period, which is an accounting error rather than an
 *    inconvenience.
 * 2. **There is no type column.** Purchase versus sales is chosen by the
 *    accountant when they pick the data format, so **one file per direction**
 *    as well — mixing them posts sales as purchases.
 * 3. **VT accepts a split analysis.** Column E says so in VT's own words, and a
 *    two-nominal document was observed posting correctly. The old
 *    `collapseAnalysis()`, which put a document's whole net against its largest
 *    line and warned, is gone. **One row per analysis line.**
 *
 * Because 1 and 2 mean one emit produces many files, the output is a **ZIP**.
 * That is not a new mechanism: `bundle/zip.ts` already builds one for A8's
 * source-document bundle, and `exports.service.ts` already stores whatever
 * bytes, extension and content type the emitter declares.
 */

/**
 * The seven columns, in VT's order. **Not written as a header row** — see
 * {@link VT_CSV_INCLUDE_HEADER}. Kept as a named constant because it is the
 * spec, and because the tests assert the emitted width against it.
 */
export const VT_LIST_COLUMNS = [
  "Bank account name/supplier's name",
  'Paid to/invoice details',
  'Gross amount',
  'Input VAT',
  'Net amount',
  'Net amount for VAT purposes',
  'Analysis account name',
] as const;

/**
 * ⚠ **THIS WAS `true`, AND IT WAS WRONG.** The old reasoning — a labelled
 * column is easier for a human to map — belonged to the Universal Input Sheet,
 * whose import is column-mapped by hand. The journal import is **positional**
 * and reads row 1 as data, so a header row imports as a transaction whose
 * supplier is "Bank account name/supplier's name" and whose amounts are
 * unparseable text.
 */
export const VT_CSV_INCLUDE_HEADER = false;

/** Provenance, in the one free-text column there is. Never a claim that anything was transmitted (D42). */
export const VT_PROVENANCE_TAG = 'Imported from Neo Accounting';

/**
 * Which file a row belongs in, and therefore which VT data format the
 * accountant must choose for it.
 */
export type VtFileKind =
  | 'purchase-invoices'
  | 'purchase-credit-notes'
  | 'sales-invoices'
  | 'sales-credit-notes'
  | 'bank';

const FILE_KIND_BY_TYPE: Readonly<Record<VtType, VtFileKind>> = Object.freeze({
  PIN: 'purchase-invoices',
  PCR: 'purchase-credit-notes',
  SIN: 'sales-invoices',
  SCR: 'sales-credit-notes',
  PAY: 'bank',
  CHQ: 'bank',
  REC: 'bank',
});

/** The VT data format to pick per file. Printed into the how-to so nobody has to guess. */
const VT_DATA_FORMAT_BY_KIND: Readonly<Record<VtFileKind, string>> = Object.freeze({
  'purchase-invoices': 'Payments list/purchase invoices list',
  'purchase-credit-notes': 'Payments list/purchase invoices list',
  'sales-invoices': 'Receipts list/sales invoices list',
  'sales-credit-notes': 'Receipts list/sales invoices list',
  bank: 'Payments list/purchase invoices list',
});

export const HOW_TO_IMPORT_FILENAME = 'HOW-TO-IMPORT.txt';

interface CsvFile {
  readonly kind: VtFileKind;
  /** `YYYY-MM-DD`, the date the accountant types into VT's journal Date box. */
  readonly date: string;
  readonly rows: string[][];
}

/** Free text on its way into a cell: guarded against landmine 1, and the guard's repair reported. */
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
 * Column B — **the whole of D43 rung 1, and A10 made it a strong one.**
 *
 * The old design split the link across `Entry details` (the code) and
 * `Transaction notes` (code, URL, provenance). **The journal import has no
 * notes column**, so both collapse into this one field — and that turned out to
 * be an upgrade rather than a loss:
 *
 * - A 104-character value was observed importing **whole**, token intact. The
 *   ~30-character truncation the old design worked around belongs to VT's
 *   *reference* fields, not to entry details.
 * - VT **replicates this text onto every leg** of the resulting double entry —
 *   the bank line, the VAT line and each analysis line — so the link is
 *   wherever the accountant happens to look.
 *
 * A missing link is still reported: D43 requires one on every exported
 * transaction, and an export that quietly carries none is the failure this
 * surface exists to prevent.
 */
function detailsCell(
  reference: string,
  sourceLink: CanonicalSourceLink | null,
  documentId: string,
  warnings: ExportWarning[],
): string {
  const parts: string[] = [];
  if (reference.length > 0) parts.push(reference);

  if (sourceLink === null) {
    warnings.push({
      documentId,
      code: 'source-link-missing',
      message:
        'This row has no source-document link, so the invoice details column carries no way back to the document. D43 requires one on every exported transaction.',
    });
  } else {
    // Landmine 2: throws on a letterless code rather than emitting one VT will
    // render as a number. The URL goes in too — there is no second field now,
    // and A10 showed the length is affordable.
    parts.push(assertVtEntryDetailsSafe(sourceLink.code), sourceLink.url);
  }

  parts.push(VT_PROVENANCE_TAG);
  return safeText(parts.join(' · '), documentId, 'invoice details', warnings);
}

/**
 * Column G **carries the ledger prefix** — `Cost of sales: Purchases` — where
 * Column A carries the bare name.
 *
 * A10 turned this from a preference into a requirement. VT's format designer
 * type-guesses each cell, and a bare numeric code like `5001` rendered as
 * `5,001.00` — a number, not an account. The prefixed form stays text and
 * auto-matches VT's chart with no mapping at all, provided the ledger name
 * matches VT's own (`Expenses:`, not `Overheads:`).
 */
function analysisAccountCell(account: string, documentId: string, warnings: ExportWarning[]): string {
  if (!account.includes(':')) {
    warnings.push({
      documentId,
      code: 'analysis-account-unprefixed',
      message: `The analysis account "${account}" has no ledger prefix. VT reads a bare numeric code as a number rather than an account — send the "Cost of sales: Purchases" form so it matches VT's chart without manual mapping.`,
    });
  }
  return safeText(account, documentId, 'analysis account', warnings);
}

/**
 * One document becomes **one row per analysis line** (verified, A10).
 *
 * Gross and Input VAT appear on the first line only; continuation lines carry
 * their own net and nothing else. That is VT's documented mechanism — *"Column
 * E: Net amount (use multiple lines for split analysis)"* — and a £240 invoice
 * split £150/£50 across two nominals was observed posting with both nominals
 * correct and the journal balanced.
 *
 * ⚠ **The continuation line must repeat Column A.** Leaving it blank makes VT
 * report an unassigned account and refuse. Repeating it costs an extra **£0.00
 * line** in the supplier account — cosmetic, totals unaffected, and reported
 * below so the accountant is not surprised by it.
 */
function buildDocumentRows(row: CanonicalTransactionDocument): {
  rows: string[][];
  warnings: ExportWarning[];
} {
  const warnings: ExportWarning[] = [];
  const rows: string[][] = [];

  // Passed through byte-for-byte. VT's Converter saves the supplier mapping
  // against this exact string; re-casing or re-trimming it makes every future
  // import a manual mapping session again.
  const primary = safeText(row.primaryAccount, row.documentId, 'supplier or customer name', warnings);
  const details = detailsCell(row.reference, row.sourceLink, row.documentId, warnings);

  row.analysis.forEach((line, index) => {
    const first = index === 0;
    rows.push([
      primary,
      details,
      first ? formatVtAmount(row.grossPence) : '',
      first ? formatVtAmount(row.vatPence) : '',
      formatVtAmount(line.netPence),
      // "Net amount for VAT purposes (eg excluding items outside the scope of
      // VAT)" — VT's box-7 figure. The canonical model records a VAT amount but
      // not whether a zero-VAT line is zero-rated (in scope) or outside scope,
      // and those differ here. Sending the net is right for the overwhelming
      // majority of supplier invoices; telling them apart needs a field the
      // model does not have, which is a roadmap item rather than a per-row
      // guess to make silently.
      formatVtAmount(line.netPence),
      analysisAccountCell(line.analysisAccount, row.documentId, warnings),
    ]);
  });

  if (row.analysis.length > 1) {
    warnings.push({
      documentId: row.documentId,
      code: 'split-analysis-zero-line',
      message: `This document spans ${row.analysis.length} nominals and is exported as ${row.analysis.length} rows, which is how VT imports a split analysis. VT will show an extra £0.00 line against ${row.primaryAccount}; the totals are unaffected.`,
    });
  }

  if (row.instrument === 'CREDIT_NOTE') {
    warnings.push({
      documentId: row.documentId,
      code: 'credit-note-direction-unverified',
      message:
        'Credit notes go to their own file with positive amounts. VT list formats have no credit-note type, so check the direction in Preview Journal before saving and reverse it in VT if it posts the wrong way.',
    });
  }

  return { rows, warnings };
}

/** A bank line. One row, one contra account — a statement line has no split to make. */
function buildBankRows(row: CanonicalBankStatementLine): { rows: string[][]; warnings: ExportWarning[] } {
  const warnings: ExportWarning[] = [];
  const details = detailsCell(row.description, row.sourceLink, row.documentId, warnings);

  return {
    rows: [
      [
        safeText(row.bankAccount, row.documentId, 'bank account name', warnings),
        details,
        formatVtAmount(row.grossPence),
        formatVtAmount(row.vatPence),
        formatVtAmount(row.netPence),
        formatVtAmount(row.netPence),
        analysisAccountCell(row.contraAccount, row.documentId, warnings),
      ],
    ],
    warnings,
  };
}

/** `2026-08-04-purchase-invoices.csv` — the date is in the name because the accountant types it into VT. */
export function vtFileName(date: string, kind: VtFileKind): string {
  return `${date}-${kind}.csv`;
}

/**
 * The how-to that travels with the archive.
 *
 * A10 found that the click path is not the one the published VT research
 * described, and that the accountant must type the date themselves because no
 * column carries it. Both are cheap to get wrong and free to write down.
 */
function buildHowTo(files: readonly CsvFile[]): Buffer {
  const lines: string[] = [
    'Importing this export into VT Transaction+',
    '==========================================',
    '',
    'In VT:  Transaction > Journal > Import...',
    '',
    '  Import via:   CSV file (eg columns separated by commas)',
    '  File:         one of the .csv files in this archive',
    '  Data format:  see the table below - it differs per file',
    '',
    'THE DATE IS NOT IN THE FILE. VT applies ONE date to a whole journal, so',
    'each file holds a single day and the date is in its filename. Type that',
    'date into the journal Date box before importing.',
    '',
    'Use Preview Journal to check the entries before pressing Save.',
    '',
    'Files in this archive',
    '---------------------',
  ];

  for (const file of files) {
    lines.push(
      `  ${vtFileName(file.date, file.kind)}`,
      `      date ${file.date} · ${file.rows.length} row(s) · format: ${VT_DATA_FORMAT_BY_KIND[file.kind]}`,
    );
  }

  lines.push(
    '',
    'The first time you import, VT asks you to assign each supplier and nominal',
    'to a VT account. That mapping is saved in a conversion table and reused by',
    'every later import, so it is a one-off per supplier rather than per export.',
    '',
  );

  return Buffer.from(lines.join('\r\n'), 'utf8');
}

class VtTransactionPlusEmitter implements ExportEmitter {
  readonly target = 'VT_TRANSACTION_PLUS' as const;
  readonly fileExtension = 'zip';
  readonly contentType = 'application/zip';

  emit(rows: readonly CanonicalRow[]): EmittedFile {
    // Rule 4, at the one boundary this module has.
    const parsed = CanonicalRowsSchema.parse(rows);

    const warnings: ExportWarning[] = [];
    // Keyed `date|kind`. Insertion-ordered, then sorted, so the archive lists
    // chronologically rather than in hash order.
    const grouped = new Map<string, CsvFile>();

    for (const row of parsed) {
      const kind =
        row.family === 'TRANSACTION_DOCUMENT'
          ? FILE_KIND_BY_TYPE[vtTypeForDocument(row)]
          : FILE_KIND_BY_TYPE[vtTypeForBankLine(row)];

      const built = row.family === 'TRANSACTION_DOCUMENT' ? buildDocumentRows(row) : buildBankRows(row);
      warnings.push(...built.warnings);

      const key = `${row.date}|${kind}`;
      const file = grouped.get(key) ?? { kind, date: row.date, rows: [] };
      file.rows.push(...built.rows);
      grouped.set(key, file);
    }

    const files = [...grouped.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind),
    );

    const entries = files.map((file) => ({
      name: vtFileName(file.date, file.kind),
      bytes: encodeCsv(
        serialiseCsv(VT_CSV_INCLUDE_HEADER ? [[...VT_LIST_COLUMNS], ...file.rows] : file.rows),
      ),
    }));
    entries.push({ name: HOW_TO_IMPORT_FILENAME, bytes: buildHowTo(files) });

    return {
      bytes: buildZipArchive(entries),
      // CSV rows across every file — what the accountant reconciles against
      // VT's Preview Journal. It exceeds the input row count wherever a
      // document split across nominals, which is the honest direction.
      rowCount: files.reduce((total, file) => total + file.rows.length, 0),
      warnings,
    };
  }
}

export const vtTransactionPlusEmitter: ExportEmitter = new VtTransactionPlusEmitter();
