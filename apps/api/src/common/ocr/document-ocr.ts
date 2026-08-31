/**
 * The OCR rung (D20), shared.
 *
 * ## Why this is in `common/` and not in a module
 *
 * TWO lanes need the same read of the same bytes. `modules/extraction` wants
 * the document's text so a model can classify and code it; `banking-matching`
 * wants its tables so a statement can become transactions. Before this existed
 * they each read the file separately — Claude was handed the whole PDF, and
 * then Textract was handed the same PDF again — so a 29-page bank statement was
 * paid for twice, once at vision-token prices and once per page.
 *
 * A module may not import another module's internals (lint-enforced), and
 * neither of those two lanes owns OCR on behalf of the other, so the seam lives
 * here beside `common/db` and `common/ai-budget.ts`.
 *
 * ## What a reader promises
 *
 * Text AND tables, per page, from ONE call. Both consumers read the same
 * result, so they can never disagree about what the document says — which is
 * the second reason to share it, and the one that outlives the cost argument.
 */

/** Table cells, row-major, in reading order. Same shape a CSV parses to. */
export type Grid = string[][];

export interface OcrPage {
  /** 1-based, as Textract numbers them. */
  readonly pageNumber: number;
  /** The page's table rows. Empty when the page carries no table. */
  readonly grid: Grid;
  /** Every line of text on the page, in reading order. */
  readonly lines: readonly string[];
}

/**
 * Where one word sits on its page, normalised 0–1 — Textract's own
 * `Geometry.BoundingBox` convention (`Left/Top/Width/Height`), carried through
 * unscaled so the contract's `ExtractedField.boundingBox` (also 0–1) needs no
 * arithmetic between here and the screen.
 */
export interface OcrWordBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One word the reader saw, with the page it was on and where. */
export interface OcrWord {
  readonly text: string;
  /** 1-based, as Textract numbers them (and defaults them — see `blocksToPages`). */
  readonly pageNumber: number;
  readonly box: OcrWordBox;
}

export interface DocumentOcr {
  readonly pages: readonly OcrPage[];
  /**
   * Every table row across every page, stacked in page order.
   *
   * ⚠ This is the STATEMENT grid, and page order is load-bearing: a statement
   * read out of order fails the D41 date-monotonicity check and reports a
   * perfectly good file as broken.
   */
  readonly grid: Grid;
  /** The whole document as plain text, pages in order and marked. */
  readonly text: string;
  /**
   * Every WORD the reader saw, in reading order, with its normalised box —
   * what lets an extracted value be pointed at ON the image (the contract's
   * `ExtractedField.boundingBox`).
   *
   * Additive and OPTIONAL: readers that predate it, and tests that build a
   * `DocumentOcr` by hand, simply omit it, and every consumer of `pages`,
   * `grid` and `text` is untouched. Absent or empty means "no geometry" and
   * every field's box is honestly null — never a guess.
   */
  readonly words?: readonly OcrWord[];
}

export type OcrFailure =
  /** Not a shape this reader takes. */
  | { reason: 'unsupportedMedia'; detail: string }
  /** Read, and there is nothing on it. A blank page, or a photo of nothing. */
  | { reason: 'nothingFound' }
  /** The service refused or was unreachable. Retryable — NOT a bad document. */
  | { reason: 'readerUnavailable'; detail: string }
  /**
   * No reader is configured at all (`STATEMENT_READER=none`).
   *
   * ⚠ Deliberately SEPARATE from `readerUnavailable`, because the two need
   * opposite messages. Unavailable is a moment and retrying fixes it; not
   * configured is permanent for this environment, and telling someone their
   * document "will be read again shortly" would be a promise nothing keeps.
   */
  | { reason: 'readerNotConfigured' };

export type OcrResult = { ok: true; ocr: DocumentOcr } | { ok: false; failure: OcrFailure };

export interface OcrInput {
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

export interface DocumentOcrReader {
  read(input: OcrInput): Promise<OcrResult>;
}

/** What Textract accepts directly. Everything else is refused by name. */
export const OCR_MEDIA = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff']);

export function isOcrMedia(mimeType: string): boolean {
  return OCR_MEDIA.has(mimeType.toLowerCase());
}

/** The whole document as one string, for a model that is reading rather than seeing. */
export function ocrToText(pages: readonly OcrPage[]): string {
  return pages
    .map((page) => `--- page ${page.pageNumber} ---\n${page.lines.join('\n')}`)
    .join('\n\n');
}
