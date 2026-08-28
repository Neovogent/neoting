import type { Grid } from './sheet-reader.js';

/**
 * How a NON-SPREADSHEET statement becomes a grid.
 *
 * ## Why this is a seam and not a function
 *
 * CSV and XLSX are already exact grids — every value is a value, in a column,
 * and reading them deterministically is lossless. A PDF or a photograph is not:
 * the table has to be recovered, and D20 commits that job to **Textract**.
 *
 * A hand-rolled PDF text extractor stood here first and it was the wrong call.
 * It worked only on born-digital PDFs (a scanned statement has no text objects
 * at all), and on a real 29-page bank statement it dropped 80 of 1,250
 * transactions and failed to find the balance column — which under D41 means it
 * could never prove completeness, only report `reduced`. Textract's TABLES
 * feature is built for exactly this shape and reads scans as well.
 *
 * ## What does NOT change
 *
 * The completeness gate. D41's proof is arithmetic over whatever grid arrives —
 * balance continuity to the penny — so a better reader improves the input and
 * leaves `completeness.ts` untouched. The reader is replaceable; the proof is
 * not.
 */

export type TableReadFailure =
  /** The file is not a shape this reader takes. */
  | { reason: 'unsupportedMedia'; detail: string }
  /** Read, and it contains no table. A cover letter, or a photo of nothing. */
  | { reason: 'noTableFound' }
  /** The service refused or was unreachable. Retryable — NOT a bad document. */
  | { reason: 'readerUnavailable'; detail: string }
  /**
   * No reader is configured at all (`STATEMENT_READER=none`).
   *
   * ⚠ Deliberately SEPARATE from `readerUnavailable`, because the two need
   * opposite messages. Unavailable is a moment and retrying fixes it; not
   * configured is permanent for this environment, and telling someone their
   * statement "will be read again shortly" would be a promise nothing keeps.
   */
  | { reason: 'readerNotConfigured' };

export type TableReadResult = { ok: true; grid: Grid } | { ok: false; failure: TableReadFailure };

export interface StatementTableInput {
  readonly bytes: Buffer;
  /** Sniffed, never the client's declared type. */
  readonly mimeType: string;
  /**
   * Where the object already lives, for the multi-page path.
   *
   * ⚠ Textract's SYNCHRONOUS `AnalyzeDocument` takes raw bytes but accepts only
   * a SINGLE-PAGE PDF. A real bank statement is 20-40 pages, which needs the
   * asynchronous `StartDocumentAnalysis`, and that one reads **only from S3** —
   * it cannot be handed bytes. So the reader needs the key as well as the
   * bytes, and a caller that cannot supply one is limited to single pages.
   */
  readonly s3Key: string | null;
}

export interface StatementTableReader {
  read(input: StatementTableInput): Promise<TableReadResult>;
}

/** Images Textract accepts directly, plus PDF. Everything else is refused by name. */
export const TEXTRACT_MEDIA = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
]);

export function isTextractMedia(mimeType: string): boolean {
  return TEXTRACT_MEDIA.has(mimeType.toLowerCase());
}
