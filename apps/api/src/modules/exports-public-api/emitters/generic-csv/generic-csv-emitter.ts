import type { ExportWarning } from '@neoting/contracts/model';

import { CanonicalRowsSchema, type CanonicalRow } from '../../canonical/canonical-row.js';
import { serialiseCsv } from '../csv/csv.js';
import { encodeCsv } from '../csv/encoding.js';
import type { EmittedFile, ExportEmitter } from '../export-emitter.js';

/**
 * The generic CSV emitter — the canonical model, written out as it is.
 *
 * **Why this exists in a stage whose job was the VT emitter.** `ExportTarget`
 * has two values in both the contract and Prisma, and the comment on both says
 * why: *an enum value with no emitter behind it is a 500 waiting for whoever
 * passes it.* `GENERIC_CSV` is admitted by the contract today, so it needs an
 * emitter today. It is also the cheapest possible proof that the canonical
 * model is not VT in disguise — the two emitters disagree about **sign**,
 * **date format**, **account presentation** and **row count**, and neither had
 * to change the model to disagree.
 *
 * It is **not** Xero and it is **not** Sage; D42 puts both out of this release
 * and neither is built here.
 *
 * Two deliberate differences from VT, each of which is a target's opinion
 * rather than a truth:
 *
 * - **Amounts keep the canonical sign** (debit positive, credit negative),
 *   where VT wants magnitudes because it derives direction from `Type`.
 * - **One row per analysis line.** Nothing here forces one nominal per row, so
 *   nothing collapses and there is nothing to warn about. That is the whole of
 *   why the canonical model keeps the lines instead of pre-flattening them.
 */

const GENERIC_CSV_COLUMNS = [
  'Date',
  'Family',
  'Type',
  'Account',
  'Reference',
  'Analysis account',
  'Net',
  'VAT',
  'Gross',
  'Source code',
  'Source URL',
] as const;

/** Signed, and still never a float: pounds by integer division, pence by remainder. */
function formatSignedAmount(signedPence: number): string {
  const sign = signedPence < 0 ? '-' : '';
  const absolute = Math.abs(signedPence);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

class GenericCsvEmitter implements ExportEmitter {
  readonly target = 'GENERIC_CSV' as const;
  readonly fileExtension = 'csv';
  readonly contentType = 'text/csv';

  emit(rows: readonly CanonicalRow[]): EmittedFile {
    const parsed = CanonicalRowsSchema.parse(rows);
    const warnings: ExportWarning[] = [];
    const cells: string[][] = [[...GENERIC_CSV_COLUMNS]];

    for (const row of parsed) {
      // ⚠ A8 fills `sourceLink`; it lands in the last two columns unchanged.
      const code = row.sourceLink?.code ?? '';
      const url = row.sourceLink?.url ?? '';

      if (row.family === 'BANK_STATEMENT_LINE') {
        cells.push([
          row.date,
          'BANK_STATEMENT_LINE',
          `${row.movement}/${row.instrument}`,
          row.bankAccount,
          row.description,
          row.contraAccount,
          formatSignedAmount(row.netPence),
          formatSignedAmount(row.vatPence),
          formatSignedAmount(row.grossPence),
          code,
          url,
        ]);
        continue;
      }

      for (const line of row.analysis) {
        cells.push([
          row.date,
          'TRANSACTION_DOCUMENT',
          `${row.party}/${row.instrument}`,
          row.primaryAccount,
          line.description ?? row.reference,
          line.analysisAccount,
          formatSignedAmount(line.netPence),
          formatSignedAmount(line.vatPence),
          formatSignedAmount(line.netPence + line.vatPence),
          code,
          url,
        ]);
      }
    }

    return {
      bytes: encodeCsv(serialiseCsv(cells)),
      // Excludes the header. Differs from the input count wherever a document
      // carried several nominals — which is the point.
      rowCount: cells.length - 1,
      warnings,
    };
  }
}

export const genericCsvEmitter: ExportEmitter = new GenericCsvEmitter();
