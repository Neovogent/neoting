import { z } from 'zod';

import type { Export as ExportRow } from '@prisma/client';

import type { Export, ExportWarning, FileAccess } from '@neoting/contracts/model';

/**
 * Prisma `exports` row → the contract `Export` shape, plus the small record
 * that has to live inside `exports.filters` because the table has no column for
 * it.
 *
 * Pure: no clock, no database, no config. One place a row becomes a wire
 * object, so `POST /exports` and `GET /exports` cannot disagree about what an
 * `Export` is.
 *
 * ## ⚠ Why two facts live in `filters` rather than in columns
 *
 * The contract's `Export` carries `documentCount` and `warnings`; `exports` in
 * `prisma/schema.prisma` carries neither, and it carries **one** `s3_key` while
 * an export produces **two** artefacts (the import file and the D43 bundle).
 * `prisma/` is LAW (G7) and A9 does not open a contract-change issue for it, so
 * the three go into the one nullable `Json` column the table already has.
 *
 * That is a compromise and it is written down rather than hidden:
 *
 * - `documentIds` genuinely IS a filter — it is the request's own narrowing —
 *   so it is the part of this record that belongs there on the column's own
 *   terms.
 * - `documentCount` and `warnings` are produced facts. They are kept because
 *   losing them would make the export history unable to answer *"which rows in
 *   January's file had no paperwork behind them"*, which is precisely the
 *   question §24.3.4 says an export must be able to answer.
 * - `bundleS3Key` is kept so the ZIP is reachable from the row at all. `s3_key`
 *   holds the import file.
 *
 * The proper fix is three columns on `exports`; it is on this module's TODO as a
 * contract-change candidate rather than being taken here.
 *
 * ## The record is PARSED on the way out
 *
 * `filters` is `Json?` — untyped as far as TypeScript is concerned, and a row
 * written by a future lane, an older build, or a hand-edit is a real input. A
 * row whose `filters` does not parse degrades to "no extra facts recorded"
 * rather than felling a page of export history: the columns are still true, and
 * a list that 500s tells the accountant less than a list with one thin row.
 */

const ExportWarningSchema = z.object({
  documentId: z.string().nullable().optional(),
  code: z.string(),
  message: z.string(),
});

export const ExportFiltersRecordSchema = z.object({
  /** The request's `documentIds`, or null when the whole period was exported. */
  documentIds: z.array(z.string()).nullable().default(null),
  /** How many source documents actually made it into the bundle. */
  documentCount: z.number().int().min(0).nullable().default(null),
  /** The object key of the D43 bundle. `exports.s3_key` holds the import file. */
  bundleS3Key: z.string().nullable().default(null),
  /** What did not travel. Never invented, never trimmed. */
  warnings: z.array(ExportWarningSchema).default([]),
});

export type ExportFiltersRecord = z.infer<typeof ExportFiltersRecordSchema>;

const EMPTY_RECORD: ExportFiltersRecord = {
  documentIds: null,
  documentCount: null,
  bundleS3Key: null,
  warnings: [],
};

export function readExportFilters(filters: unknown): ExportFiltersRecord {
  const parsed = ExportFiltersRecordSchema.safeParse(filters);
  return parsed.success ? parsed.data : EMPTY_RECORD;
}

/**
 * **`file` and `bundle` are the caller's argument to supply, and history
 * supplies neither.**
 *
 * `FileAccess.expiresAt` is "minutes away, not hours" — that is the contract's
 * own wording — so a row created last Tuesday has no live URL to report and
 * inventing one that 403s at the storage host would be worse than the honest
 * `null`. `POST /exports` passes the two it has just signed; `GET /exports`
 * passes neither. Re-downloading an old export is a new `POST` over the same
 * period, which reuses the same capability codes (`document-link.service.ts`)
 * and therefore produces a file the accountant's saved VT conversion table
 * still matches.
 */
export function toExport(
  row: ExportRow,
  signed: { readonly file: FileAccess | null; readonly bundle: FileAccess | null } = { file: null, bundle: null },
): Export {
  const record = readExportFilters(row.filters);

  return {
    id: row.id,
    businessId: row.businessId,
    // `target` is nullable in prisma (rows written before the column existed
    // have no answer, and expand-contract forbids inventing one) while the
    // contract requires it. Every row this module writes sets it; a legacy row
    // that did not is reported as the generic CSV it would have been, because
    // that is the only target the ID enum admits besides VT and a missing key
    // would fail the consumer's own parse.
    target: row.target ?? 'GENERIC_CSV',
    periodStart: row.periodStart === null ? null : calendarDateOf(row.periodStart),
    periodEnd: row.periodEnd === null ? null : calendarDateOf(row.periodEnd),
    rowCount: row.rowCount,
    documentCount: record.documentCount,
    state: row.state,
    file: signed.file,
    bundle: signed.bundle,
    warnings: record.warnings as ExportWarning[],
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  };
}

/**
 * A stored period boundary → `YYYY-MM-DD`, read in **UTC**.
 *
 * The period is a calendar range widened into `timestamptz` by the column type.
 * Reading it back in a local zone during BST turns `01/01/2026` into
 * `31/12/2025` on the screen that asks *"have we already exported January?"* —
 * rule 8, and the one place on this surface where getting it wrong produces a
 * double-imported month.
 */
function calendarDateOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` → the instant that calendar day starts, in UTC.
 *
 * The inverse of `calendarDateOf`, and the only place this module turns a
 * contract date into a `Date`. It is explicit `T00:00:00.000Z` rather than
 * `new Date('2026-01-01')` — those happen to agree today, but the bare form is
 * implementation-defined for date-only strings in older engines and this value
 * decides which documents are in a month.
 */
export function startOfUtcDay(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

/**
 * The instant the day AFTER `calendarDate` starts, in UTC.
 *
 * The period is inclusive at both ends (the contract says so twice), and
 * `document_date` is a `timestamptz` that may carry a time. `lt` the next
 * midnight is therefore the only filter that includes every document dated on
 * the last day of the period; `lte` the last day's midnight silently drops
 * them, which is a short file that looks complete.
 */
export function startOfNextUtcDay(calendarDate: string): Date {
  const start = startOfUtcDay(calendarDate);
  return new Date(start.getTime() + 86_400_000);
}
