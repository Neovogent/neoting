/**
 * The deterministic classification for a spreadsheet (finding 6, 4 Sep 2026).
 *
 * A CSV or an XLSX is not a photograph of a document — it IS the data, already
 * in cells, and in Initial Delivery it means exactly one thing: a manually
 * uploaded bank statement (D40). Sending it to the model would be wrong twice
 * over: `BedrockExtractor` honestly refuses `text/csv` with `NT-EXT-003`
 * ("images and PDFs only"), so the document lands FAILED and the statement lane
 * — which keys on `docType === 'STATEMENT'` — never fires; and even a model
 * that read it would be a probabilistic opinion about a grid the statement
 * parser reads exactly, which is the confidence-over-proof inversion D41
 * forbids.
 *
 * So the pipeline routes a spreadsheet here instead of to the configured
 * extractor. The classification is the whole of the work: every header field is
 * null (a statement covers a period, has no supplier and no single total —
 * the demo STATEMENT profile records the same reasoning), so
 * `resolveProcessedState` lands it TO_REVIEW, and `PrismaStatementStep` then
 * reads the grid deterministically with the D41 completeness gates.
 *
 * `kind`/`modelVersion` name this branch honestly on `extractions` — the audit
 * columns answer "which reader produced this value", and the answer here is
 * "no model at all".
 */

import type { DocumentExtractor, ExtractionOutcome } from './document-extractor.js';

/** The two stored MIME types the sniff produces for a spreadsheet (`formats.ts`). */
const SPREADSHEET_MIMES: ReadonlySet<string> = new Set([
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** Should this document skip the model and be classified STATEMENT deterministically? */
export function isSpreadsheetMime(mimeType: string | null): boolean {
  return mimeType !== null && SPREADSHEET_MIMES.has(mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '');
}

export const SPREADSHEET_EXTRACTOR_KIND = 'deterministic-spreadsheet';

export const spreadsheetStatementExtractor: DocumentExtractor = {
  kind: SPREADSHEET_EXTRACTOR_KIND,
  modelVersion: 'spreadsheet-statement-1',
  extract(): Promise<ExtractionOutcome> {
    return Promise.resolve({
      ok: true,
      document: {
        docType: 'STATEMENT',
        // Null, not '': a statement has no supplier and no single total, and a
        // null is what `resolveProcessedState` honestly reads as "left for a
        // human" — the document lands TO_REVIEW while the statement lane
        // imports its rows.
        supplierName: null,
        customerName: null,
        documentDate: null,
        dueDate: null,
        currency: null,
        totalPence: null,
        taxPence: null,
        reference: null,
        vatNumber: null,
        categoryCode: null,
        fields: {},
        lineItems: [],
        validatorResults: {},
        validatorFailed: false,
        // Deterministic: the classification is a fact about the MIME type, not
        // a model's opinion about pixels.
        overallConfidence: 1,
        suggestions: [],
      },
    });
  },
};
