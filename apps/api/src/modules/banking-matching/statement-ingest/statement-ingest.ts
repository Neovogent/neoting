import { assessCompleteness, type CompletenessReport } from './completeness.js';
import { formatFor } from './sheet-reader.js';
import { parseStatement, parseStatementGrid, type ParsedStatement, type ParseResult } from './statement-parser.js';
import { isOcrMedia, type DocumentOcr, type OcrFailure } from '../../../common/ocr/document-ocr.js';
import { closeStatementRequestChases } from '../../chase/index.js';

/**
 * An uploaded bank statement becomes `Statement` + `BankTransaction` rows.
 *
 * ## What this closes
 *
 * Until this file existed **nothing in the API ever created a bank transaction**
 * — `prisma/seed.ts` was the only writer, so every transaction on every screen
 * was demo data. Meanwhile the practice app's "Upload statement" button took a
 * file NAME, never the bytes, and pushed a row into local React state that
 * vanished on reload. D40 makes manual upload the only bank input in ID, so the
 * one input the release has was, end to end, a mock.
 *
 * ## Where it runs
 *
 * After extraction, in the ingest job, for a document the extractor classified
 * `STATEMENT`. Extraction already reads the bytes and decides the type; this
 * step reads the same stored object and turns the grid into rows.
 *
 * ## Idempotent, because the queue is at-least-once
 *
 * Keyed on `documentId`: a statement already ingested for this document is
 * left exactly as it is. A redelivery must not double a client's bank feed,
 * and "did this job already run" is answered from the database rather than
 * from a processed-set that a restart would forget.
 */

/** Just enough of Prisma for this step — narrow so a test can hand it a fake. */
export interface StatementScopedClient {
  statement: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<{ id: string }>;
  };
  bankAccount: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<{ id: string }>;
  };
  bankTransaction: {
    createMany(args: unknown): Promise<{ count: number }>;
  };
  document: {
    update(args: unknown): Promise<unknown>;
  };
  // The statement-request close (chase seam, Phase 5) runs inside this step's
  // transaction, so its three tables join the narrow client. A fake that
  // answers `findMany: []` opts out of the close entirely.
  chase: {
    findMany(args: unknown): Promise<{ id: string; itemRefs: unknown }[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  chaseMessage: { create(args: unknown): Promise<unknown> };
  notification: { create(args: unknown): Promise<unknown> };
}

export interface StatementIngestInput {
  readonly documentId: string;
  readonly businessId: string;
  /** The statement's own file name — the reader picks CSV or XLSX from it. */
  readonly fileName: string;
  readonly bytes: Buffer;
  /** Sniffed at ingest, never the client's declared type. */
  readonly mimeType: string;
  /** Where the object lives, for Textract's multi-page path. */
  readonly s3Key: string | null;
}

export type StatementIngestOutcome =
  | { status: 'ingested'; statementId: string; rowCount: number; report: CompletenessReport }
  | { status: 'alreadyIngested'; statementId: string }
  | { status: 'refused'; reason: string };

export interface StatementIngestLogger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * The account a statement's lines hang off.
 *
 * ID has **no bank connection** (D40), so there is no provider account to look
 * up and nothing to reconcile against. A business therefore gets one implicit
 * account, created on first upload, and every statement lands on it.
 *
 * ⚠ It carries **no `connectionId`** and must not grow one here: a populated
 * connection would be a claim that a feed was authorised, which is precisely
 * what this release does not do.
 */
async function accountFor(db: StatementScopedClient, businessId: string): Promise<string> {
  const existing = await db.bankAccount.findFirst({ where: { businessId }, select: { id: true } });
  if (existing !== null) return existing.id;
  const created = await db.bankAccount.create({
    data: { businessId, displayName: 'Uploaded statements', currency: 'GBP' },
    select: { id: true },
  });
  return created.id;
}

/**
 * Turn the file into a statement. **Call this OUTSIDE any transaction.**
 *
 * ⚠ THIS IS THE SLOW HALF, AND SEPARATING IT IS NOT TIDINESS. It was inline in
 * `ingestStatement`, which runs inside `scopedDb` — a Prisma *interactive*
 * transaction with a 10-second timeout. A CSV parses in milliseconds so it
 * never mattered; Textract's asynchronous path takes 40–60 seconds on a real
 * statement, and the first 29-page PDF ever put through it died with
 *
 *     Transaction already closed: … timeout … was 10000 ms, however 56824 ms
 *     passed since the start of the transaction
 *
 * on the *next* query after the read returned. Textract had succeeded; the
 * database connection it came back to had not. Holding a transaction open
 * across a minute-long network call also pins a connection from the pool for
 * that whole minute, so a handful of concurrent statements would have starved
 * every other query in the process.
 *
 * So the shape is: read here, then persist in a transaction that opens after
 * the bytes are already a grid and closes in milliseconds.
 */
export async function readStatementFor(
  input: StatementIngestInput,
  /**
   * What the OCR rung already read (D20) — see `readStatement` below.
   *
   * Optional ONLY so a spreadsheet can be ingested with no OCR at all: a CSV is
   * already an exact grid and demanding an OCR pass for one would be absurd. A
   * PDF arriving with no read is refused and says so, rather than being quietly
   * skipped.
   */
  ocr?: DocumentOcr,
): Promise<ParseResult> {
  return readStatement(input, ocr);
}

/** Whether this document's rows are already in the database. Its own tiny query. */
export async function statementAlreadyIngested(
  db: StatementScopedClient,
  documentId: string,
): Promise<string | null> {
  const already = await db.statement.findFirst({ where: { documentId }, select: { id: true } });
  return already?.id ?? null;
}

export async function ingestStatement(
  db: StatementScopedClient,
  input: StatementIngestInput,
  logger: StatementIngestLogger,
  /**
   * The read, already done — see `readStatementFor` for why it is not done here.
   *
   * Omitted, this reads the file itself, which is correct for a SPREADSHEET and
   * is what the offline tests do. ⚠ Never omit it for a PDF or an image on a
   * path that runs inside a transaction.
   */
  parsedInput?: ParseResult,
  ocr?: DocumentOcr,
): Promise<StatementIngestOutcome> {
  // Idempotency first, before any persistence work.
  const alreadyId = await statementAlreadyIngested(db, input.documentId);
  if (alreadyId !== null) {
    logger.log(`statement-ingest: document ${input.documentId} already ingested as ${alreadyId}`);
    return { status: 'alreadyIngested', statementId: alreadyId };
  }

  const parsed = parsedInput ?? (await readStatement(input, ocr));
  if (!parsed.ok) {
    const reason = refusalText(parsed.failure);
    logger.warn(`statement-ingest: refused ${input.documentId} — ${reason}`);
    return { status: 'refused', reason };
  }

  const report = assessCompleteness(parsed.statement);
  const accountId = await accountFor(db, input.businessId);

  const statement = await db.statement.create({
    data: {
      businessId: input.businessId,
      accountId,
      documentId: input.documentId,
      periodStart: new Date(`${parsed.statement.periodStart}T00:00:00.000Z`),
      periodEnd: new Date(`${parsed.statement.periodEnd}T00:00:00.000Z`),
      openingBalancePence: parsed.statement.openingBalancePence,
      closingBalancePence: parsed.statement.closingBalancePence,
      rowCount: report.rowCount,
      // ⚠ The FIRST writer of `gapAnalysis` in this repo. `businesses.service.ts`
      // reports `statementGaps: 0` on `GET /businesses` precisely because
      // nothing wrote this column; that count can start reading it now.
      gapAnalysis: {
        assurance: report.assurance,
        provenBy: report.provenBy,
        findings: report.findings,
        mapping: parsed.statement.mapping,
      },
    },
    select: { id: true },
  });

  const written = await db.bankTransaction.createMany({
    data: parsed.statement.rows.map((row) => ({
      businessId: input.businessId,
      accountId,
      bookedAt: new Date(`${row.bookedOn}T00:00:00.000Z`),
      amountPence: row.amountPence,
      currency: 'GBP',
      descriptionRaw: row.description,
      balanceAfterPence: row.balanceAfterPence,
      // UNMATCHED is the default and is stated anyway: this set IS the chase
      // list's set, so a line arriving in any other state would be a payment
      // silently exempted from ever being chased for its receipt.
      matchState: 'UNMATCHED' as const,
      chaseSuppressed: false,
    })),
  });

  // The statement document's own link, so the Bank screen can open the file a
  // line came from (D43's principle, applied inside the product rather than at
  // the export boundary).
  await db.document.update({
    where: { id: input.documentId },
    data: { updatedAt: new Date() },
  });

  // Close every open statement-request chase this statement covers (engine
  // (c), Phase 5) — inside the SAME transaction, so a statement that imports
  // also settles the ask that requested it, atomically. The chase seam owns
  // the tag format and the close semantics; a failure here fails the ingest
  // transaction as a whole, which is right — the statement and its settlement
  // are one fact.
  const closedChases = await closeStatementRequestChases(db, {
    businessId: input.businessId,
    documentId: input.documentId,
    periodStart: new Date(`${parsed.statement.periodStart}T00:00:00.000Z`),
    periodEnd: new Date(`${parsed.statement.periodEnd}T00:00:00.000Z`),
  });
  if (closedChases.length > 0) {
    logger.log(`statement-ingest: ${input.documentId} closed ${closedChases.length} statement-request chase(s)`);
  }

  logger.log(
    `statement-ingest: ${input.documentId} → statement ${statement.id}, ` +
      `${written.count} transaction(s), assurance=${report.assurance}`,
  );
  return { status: 'ingested', statementId: statement.id, rowCount: written.count, report };
}

/**
 * Spreadsheet or OCR — decided by what the file actually is.
 *
 * CSV and XLSX are exact grids already and stay deterministic; sending them
 * through OCR would add loss to something lossless. A PDF or an image is a
 * table to be recovered, which is Textract's job under D20 — and the grid it
 * returns goes through the SAME parser, so the column rules, the money rules and
 * the D41 completeness gate cannot drift between the two.
 */
async function readStatement(
  input: StatementIngestInput,
  ocr: DocumentOcr | undefined,
): Promise<ParseResult> {
  // A spreadsheet IS a grid. It needs no OCR and never did — reading a CSV
  // through an OCR service would be paying to make an exact thing approximate.
  if (formatFor(input.fileName) !== null) return parseStatement(input.bytes, input.fileName);

  if (!isOcrMedia(input.mimeType)) {
    return { ok: false, failure: { reason: 'unsupportedFormat', fileName: input.fileName } };
  }

  // ⚠ THIS LANE NO LONGER CALLS TEXTRACT ITSELF, AND THAT IS THE POINT.
  //
  // It used to, which meant a PDF statement was read twice: once by the model
  // (the whole file, at vision-token prices) to classify it, and again here to
  // get its rows. One document, two reads, two bills — and two answers that
  // could disagree about what it said.
  //
  // The OCR rung now runs once, in the extraction step, and hands its result
  // forward on the completion. `undefined` here means that read did not happen
  // — no reader configured, or it failed — and the honest answer is a refusal
  // naming what would work, never an empty statement.
  if (ocr === undefined) {
    return { ok: false, failure: { reason: 'tableRead', failure: { reason: 'readerNotConfigured' } } };
  }
  if (ocr.grid.length === 0) {
    return { ok: false, failure: { reason: 'tableRead', failure: { reason: 'nothingFound' } } };
  }
  return parseStatementGrid(ocr.grid);
}

/** Why the OCR rung did not produce a table, in words the accountant can act on. */
function ocrRefusalText(failure: OcrFailure): string {
  switch (failure.reason) {
    case 'nothingFound':
      return 'No transaction table was found in this document. If it is a photograph, make sure the whole table is in frame and in focus.';
    case 'unsupportedMedia':
      return `This file could not be read as a statement (${failure.detail}).`;
    case 'readerUnavailable':
      // ⚠ Deliberately NOT phrased as a problem with their document. It is
      // ours, and telling a client their statement is unreadable would send
      // them to re-scan a perfectly good file.
      return 'The document reader could not be reached, so this statement has not been imported yet. Nothing is lost — it will be read again shortly.';
    case 'readerNotConfigured':
      // Permanent for this environment, so it must NOT promise a retry. Naming
      // the two formats that need no reader is the one action the person
      // holding the file can actually take.
      return 'This file needs to be read by the document reader, which is not switched on here. A statement uploaded as CSV or XLSX imports without it.';
  }
}

/**
 * A refusal an accountant can act on.
 *
 * Every branch names the file's problem and what to do about it. "Could not
 * parse statement" is the message this deliberately does not produce — it tells
 * the person holding the file nothing they can use.
 */
function refusalText(failure: Extract<ReturnType<typeof parseStatement>, { ok: false }>['failure']): string {
  switch (failure.reason) {
    case 'unsupportedFormat':
      return `${failure.fileName} is not a format this reads. Bank statements can be uploaded as PDF, CSV, XLSX, or a photograph.`;
    case 'tableRead':
      return ocrRefusalText(failure.failure);
    case 'unreadable':
      switch (failure.detail) {
        case 'notAZipFile':
          return 'This file is named .xlsx but is not a spreadsheet — it may have been renamed.';
        case 'notAWorkbook':
          return 'This spreadsheet has no readable worksheet.';
        default:
          return 'This file is empty.';
      }
    case 'noHeaderRow':
      return 'No transaction table was found. A statement needs a header row naming a date column and either an amount column or paid-in/paid-out columns.';
    case 'noDateColumn':
      return 'No date column was found in the transaction table.';
    case 'noAmountColumn':
      return 'No amount column was found. Expected one of: Amount, Paid in / Paid out, Debit / Credit.';
    case 'noRows':
      return 'A transaction table was found but it has no readable rows.';
  }
}

export type { ParsedStatement, CompletenessReport };
