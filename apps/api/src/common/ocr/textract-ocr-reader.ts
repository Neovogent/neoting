import {
  AnalyzeDocumentCommand,
  GetDocumentAnalysisCommand,
  StartDocumentAnalysisCommand,
  TextractClient,
  type Block,
} from '@aws-sdk/client-textract';

import {
  isOcrMedia,
  ocrToText,
  type DocumentOcrReader,
  type Grid,
  type OcrInput,
  type OcrPage,
  type OcrResult,
} from './document-ocr.js';

/**
 * Textract to text and tables, in ONE read (D20's OCR rung).
 *
 * ## Two paths, and the split is Textract's, not ours
 *
 * - **Synchronous `AnalyzeDocument`** takes raw bytes and reads images and a
 *   **single-page** PDF. That is the receipt-shaped case.
 * - **Asynchronous `StartDocumentAnalysis`** is the only way to read a
 *   multi-page PDF, and it reads **from S3 only** — it cannot be handed bytes.
 *   A real bank statement is 20-40 pages, so this is the path that matters, and
 *   it is why the reader needs the object key rather than just the file.
 *
 * A multi-page PDF with no key is refused rather than truncated to page one:
 * silently reading 44 of 1,250 transactions and reporting them as the statement
 * is precisely the failure D41 exists to prevent.
 *
 * ## Every failure is classified, because they mean different things
 *
 * A document Textract cannot read is a document problem — the accountant is
 * told, and can send a better copy. A throttle or an expired credential is OUR
 * problem, and must surface as retryable rather than as "your document is
 * unreadable", which would be a lie that costs the client a re-scan.
 *
 * ⚠ **This call is slow — 40-60 seconds for a 29-page PDF — so it must never
 * run inside a database transaction.** `scopedDb` opens a Prisma interactive
 * transaction with a 10-second timeout; the first real statement through this
 * reader died on the query AFTER the read returned, with Textract having
 * succeeded. See `banking-matching/CLAUDE.md`.
 */

/** Textract's own ceiling for the synchronous path. */
const SYNC_MAX_BYTES = 10 * 1024 * 1024;

/** How long to wait for an async job before giving up and letting the queue retry. */
const ASYNC_TIMEOUT_MS = 5 * 60 * 1000;
const ASYNC_POLL_MS = 3000;

export interface TextractOcrReaderOptions {
  readonly client: TextractClient;
  /** The bucket the documents live in — the async path reads from it directly. */
  readonly bucket: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly logger?: { log(m: string): void; warn(m: string): void };
}

export class TextractOcrReader implements DocumentOcrReader {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly logger: { log(m: string): void; warn(m: string): void };

  constructor(private readonly options: TextractOcrReaderOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? { log() {}, warn() {} };
  }

  async read(input: OcrInput): Promise<OcrResult> {
    if (!isOcrMedia(input.mimeType)) {
      return { ok: false, failure: { reason: 'unsupportedMedia', detail: input.mimeType } };
    }

    try {
      const blocks =
        input.mimeType.toLowerCase() === 'application/pdf'
          ? await this.readPdf(input)
          : await this.readSync(input.bytes);
      if (blocks === null) {
        return {
          ok: false,
          failure: {
            reason: 'unsupportedMedia',
            detail: 'a multi-page PDF has to be read from storage, and this one has no stored object',
          },
        };
      }
      const pages = blocksToPages(blocks);
      const grid = pages.flatMap((page) => page.grid);
      const hasText = pages.some((page) => page.lines.length > 0);
      if (grid.length === 0 && !hasText) return { ok: false, failure: { reason: 'nothingFound' } };
      return { ok: true, ocr: { pages, grid, text: ocrToText(pages) } };
    } catch (error) {
      // ⚠ NOT a document failure. A throttle, an expired credential or a socket
      // reset says nothing about the document, and telling a client their file
      // is unreadable would send them to re-scan a perfectly good one.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`textract: read failed — ${detail}`);
      return { ok: false, failure: { reason: 'readerUnavailable', detail } };
    }
  }

  /** Images, and any PDF small enough that one synchronous call can hold it. */
  private async readSync(bytes: Buffer): Promise<Block[]> {
    const response = await this.options.client.send(
      new AnalyzeDocumentCommand({ Document: { Bytes: bytes }, FeatureTypes: ['TABLES'] }),
    );
    return response.Blocks ?? [];
  }

  /**
   * A PDF. Single-page and small enough goes synchronously; anything else has
   * to go through S3, because that is the only multi-page door Textract has.
   */
  private async readPdf(input: OcrInput): Promise<Block[] | null> {
    if (input.s3Key === null) {
      // One page MIGHT fit the sync path, but we cannot count pages without a
      // parser, so we cannot know. Refusing beats reading page one of forty and
      // calling it the document.
      return input.bytes.length <= SYNC_MAX_BYTES ? this.readSync(input.bytes) : null;
    }
    return this.readAsync(input.s3Key);
  }

  private async readAsync(s3Key: string): Promise<Block[]> {
    const started = await this.options.client.send(
      new StartDocumentAnalysisCommand({
        DocumentLocation: { S3Object: { Bucket: this.options.bucket, Name: s3Key } },
        FeatureTypes: ['TABLES'],
      }),
    );
    const jobId = started.JobId;
    if (jobId === undefined) throw new Error('Textract accepted the job and returned no id');

    const deadline = this.now() + ASYNC_TIMEOUT_MS;
    const blocks: Block[] = [];

    for (;;) {
      const page = await this.options.client.send(new GetDocumentAnalysisCommand({ JobId: jobId }));
      if (page.JobStatus === 'FAILED') {
        // ⚠ `??` is not enough: Textract may answer FAILED with an EMPTY
        // StatusMessage, and `new Error('')` produces a log line that reads
        // "threw and was skipped — " with nothing after it. An undiagnosable
        // failure is worse than a wrong one, so an empty message falls back too.
        const detail = page.StatusMessage ?? '';
        throw new Error(detail === '' ? 'Textract reported the job FAILED with no reason' : detail);
      }
      if (page.JobStatus === 'SUCCEEDED') {
        blocks.push(...(page.Blocks ?? []));
        // ⚠ PAGINATED, and a statement is long enough to be paginated. Stopping
        // at the first response reads the first slice of a file and reports it
        // as the whole — the silent-truncation failure D41 exists to catch.
        let next = page.NextToken;
        while (next !== undefined) {
          const more = await this.options.client.send(
            new GetDocumentAnalysisCommand({ JobId: jobId, NextToken: next }),
          );
          blocks.push(...(more.Blocks ?? []));
          next = more.NextToken;
        }
        return blocks;
      }
      if (this.now() > deadline) throw new Error('Textract job did not finish in time');
      await this.sleep(ASYNC_POLL_MS);
    }
  }
}

/**
 * Textract blocks to one entry per page, each carrying its text lines and its
 * table rows.
 *
 * Textract returns a flat block list joined by relationships: a `TABLE` owns
 * `CELL`s through a CHILD relationship, and each cell owns the `WORD` and
 * `SELECTION_ELEMENT` blocks that make up its text. Cells carry explicit row
 * and column indices, which is the whole reason this is better than recovering
 * a table from text positions: the grid is stated rather than inferred, so an
 * EMPTY cell is a real empty cell rather than a gap that shifts everything
 * after it one column left.
 *
 * Pages come back in PAGE order regardless of the order Textract listed them —
 * a document read out of order fails D41's date-monotonicity check and reports
 * a good statement as broken.
 */
export function blocksToPages(blocks: Block[]): OcrPage[] {
  const byId = new Map<string, Block>();
  for (const block of blocks) if (block.Id !== undefined) byId.set(block.Id, block);

  const textOf = (cell: Block): string => {
    const ids = (cell.Relationships ?? [])
      .filter((rel) => rel.Type === 'CHILD')
      .flatMap((rel) => rel.Ids ?? []);
    return ids
      .map((id) => byId.get(id))
      .filter((child): child is Block => child !== undefined)
      .map((child) =>
        child.BlockType === 'SELECTION_ELEMENT'
          ? child.SelectionStatus === 'SELECTED'
            ? 'X'
            : ''
          : (child.Text ?? ''),
      )
      .join(' ')
      .trim();
  };

  const gridsByPage = new Map<number, Grid>();
  const linesByPage = new Map<number, string[]>();

  // ⚠ A single-page SYNCHRONOUS read carries no `Page` on its blocks — the
  // field is only populated for multi-page documents. Defaulting to 1 is what
  // keeps a receipt from vanishing into page 0.
  const pageOf = (block: Block): number => block.Page ?? 1;

  for (const block of blocks) {
    if (block.BlockType !== 'LINE') continue;
    const page = pageOf(block);
    const lines = linesByPage.get(page) ?? [];
    lines.push(block.Text ?? '');
    linesByPage.set(page, lines);
  }

  const tables = blocks
    .filter((block) => block.BlockType === 'TABLE')
    .sort((a, b) => pageOf(a) - pageOf(b));

  for (const table of tables) {
    const cellIds = (table.Relationships ?? [])
      .filter((rel) => rel.Type === 'CHILD')
      .flatMap((rel) => rel.Ids ?? []);
    const rows = new Map<number, Map<number, string>>();
    let widest = 0;

    for (const id of cellIds) {
      const cell = byId.get(id);
      if (cell === undefined || cell.BlockType !== 'CELL') continue;
      const rowIndex = cell.RowIndex ?? 0;
      const columnIndex = cell.ColumnIndex ?? 0;
      if (rowIndex === 0 || columnIndex === 0) continue;
      widest = Math.max(widest, columnIndex);
      const row = rows.get(rowIndex) ?? new Map<number, string>();
      row.set(columnIndex, textOf(cell));
      rows.set(rowIndex, row);
    }

    const page = pageOf(table);
    const grid = gridsByPage.get(page) ?? [];
    for (const rowIndex of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(rowIndex);
      if (row === undefined) continue;
      const cells: string[] = [];
      for (let column = 1; column <= widest; column += 1) cells.push(row.get(column) ?? '');
      grid.push(cells);
    }
    gridsByPage.set(page, grid);
  }

  const pageNumbers = [...new Set([...gridsByPage.keys(), ...linesByPage.keys()])].sort(
    (a, b) => a - b,
  );
  return pageNumbers.map((pageNumber) => ({
    pageNumber,
    grid: gridsByPage.get(pageNumber) ?? [],
    lines: linesByPage.get(pageNumber) ?? [],
  }));
}
