import { accountHolderFinding } from './account-holder.js';
import { assessCompleteness, type CompletenessFinding, type CompletenessReport } from './completeness.js';
import { importFingerprintsFor } from './row-identity.js';
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
 *
 * ## ⚠ …and idempotent on the CONTENT too, since 2 Sep 2026
 *
 * The `documentId` key above is necessary and was never sufficient. A real
 * client held **2,288** transactions that were 1,144 rows imported twice, from
 * two `statements` rows covering the identical 2025-08-01 → 2026-07-31 period
 * nine seconds apart. Two uploads of the same period are two DOCUMENTS with two
 * `byte_hash` values, so neither the key above nor exact-hash dedupe fired — and
 * `bank_transactions_account_id_provider_transaction_id_key` is inert for this
 * lane, because D40 has no provider and Postgres treats NULLs as distinct.
 *
 * Every row now carries an `importFingerprint` (`row-identity.ts`) under a real
 * unique index, so the second import of a line adds nothing while two identical
 * purchases on ONE statement stay two rows. Overlapping periods are additionally
 * *reported* — see `overlapFindings` — because a structural defence that nobody
 * can see is how the accountant finds out a year later.
 */

/** Just enough of Prisma for this step — narrow so a test can hand it a fake. */
export interface StatementScopedClient {
  statement: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    /** The period-overlap read — see `overlapFindings`. */
    findMany(args: unknown): Promise<{ id: string; periodStart: Date | null; periodEnd: Date | null; createdAt: Date }[]>;
    create(args: unknown): Promise<{ id: string }>;
    /**
     * The row is created BEFORE its transactions (they carry its id as their
     * `importBatchId`) and its counts are only known AFTER them, so the honest
     * numbers are written back in a second call inside the same transaction.
     */
    update(args: unknown): Promise<unknown>;
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
  /**
   * The account holder extraction read off the page (`documents.customer_name`),
   * for the whose-statement-is-this check (`account-holder.ts`, review item 14).
   * Null/absent means none was read — a spreadsheet, or an older extraction —
   * and the check stays silent rather than guessing.
   */
  readonly accountHolder?: string | null;
  /** Every name the business goes by (`businesses.name`, `trading_name`) — the check's right-hand side. */
  readonly businessNames?: readonly string[];
}

export type StatementIngestOutcome =
  | {
      status: 'ingested';
      statementId: string;
      /** Transactions this import actually ADDED. Never the file's line count. */
      rowCount: number;
      /** Lines the account already held under the same identity, so not re-added. */
      duplicateRowCount: number;
      /** Lines read out of the file, whether or not they were new. */
      parsedRowCount: number;
      report: CompletenessReport;
    }
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

  // Whose statement is this? (review item 14 — 1,491 rows of another business's
  // NatWest statement imported silently). A mismatch FLAGS and the import
  // proceeds (D46); removal is `bank.remove-statement`'s approved path. FIRST
  // in the findings list, because "wrong client" outranks every line-level
  // finding a human would otherwise read first.
  const holderFinding = accountHolderFinding(input.accountHolder, input.businessNames ?? []);
  if (holderFinding !== null) {
    logger.warn(`statement-ingest: ${input.documentId} — ${holderFinding.detail}`);
  }
  const importFindings = (extra: CompletenessFinding[]): CompletenessFinding[] => [
    ...(holderFinding === null ? [] : [holderFinding]),
    ...report.findings,
    ...extra,
  ];

  const accountId = await accountFor(db, input.businessId);

  const periodStart = new Date(`${parsed.statement.periodStart}T00:00:00.000Z`);
  const periodEnd = new Date(`${parsed.statement.periodEnd}T00:00:00.000Z`);

  // BEFORE the statement row is created, or it would find itself.
  const overlaps = await overlapFindings(db, accountId, periodStart, periodEnd);

  const statement = await db.statement.create({
    data: {
      businessId: input.businessId,
      accountId,
      documentId: input.documentId,
      periodStart,
      periodEnd,
      openingBalancePence: parsed.statement.openingBalancePence,
      closingBalancePence: parsed.statement.closingBalancePence,
      // Provisional. The honest number is what the insert below ADDS, and that
      // is not known yet — see the write-back after `createMany`.
      rowCount: 0,
      // ⚠ The FIRST writer of `gapAnalysis` in this repo. `businesses.service.ts`
      // reports `statementGaps: 0` on `GET /businesses` precisely because
      // nothing wrote this column; that count can start reading it now.
      gapAnalysis: {
        assurance: report.assurance,
        provenBy: report.provenBy,
        findings: importFindings([]),
        mapping: parsed.statement.mapping,
      },
    },
    select: { id: true },
  });

  // One content-derived identity per line, ordinal assigned in FILE order —
  // `row-identity.ts` carries the whole argument. Two identical coffees on one
  // statement get ordinals 1 and 2 and both survive; the same file imported
  // again reproduces the same ordinals, so every line collides and none is
  // added.
  const fingerprints = importFingerprintsFor(accountId, 'GBP', parsed.statement.rows);

  const written = await db.bankTransaction.createMany({
    data: parsed.statement.rows.map((row, index) => ({
      businessId: input.businessId,
      accountId,
      bookedAt: new Date(`${row.bookedOn}T00:00:00.000Z`),
      amountPence: row.amountPence,
      currency: 'GBP',
      descriptionRaw: row.description,
      balanceAfterPence: row.balanceAfterPence,
      importFingerprint: fingerprints[index],
      // The provenance stamp: which statement created this line. The column
      // predates this writer and nothing else fills it. It is what makes
      // `bank.remove-statement` able to enumerate a statement's rows PROVABLY
      // — period+account overlap is a guess, and two uploads of the same month
      // would claim each other's lines. A statement whose rows lack the stamp
      // refuses removal by name rather than deleting by guess.
      importBatchId: statement.id,
      // UNMATCHED is the default and is stated anyway: this set IS the chase
      // list's set, so a line arriving in any other state would be a payment
      // silently exempted from ever being chased for its receipt.
      matchState: 'UNMATCHED' as const,
      chaseSuppressed: false,
    })),
    // ⚠ `ON CONFLICT DO NOTHING` against `(account_id, import_fingerprint)`.
    //
    // This is NOT "drop anything that looks like a duplicate" — that would lose
    // a genuine repeat purchase, and losing a real payment out of an accounting
    // ledger is worse than showing two. It skips only rows whose fingerprint is
    // already present, and the ordinal in that fingerprint means two identical
    // purchases have DIFFERENT fingerprints. The only thing it can suppress is
    // the same line, imported twice.
    skipDuplicates: true,
  });

  const duplicateRowCount = parsed.statement.rows.length - written.count;

  // The honest counts, written back now that they exist. `rowCount` is what the
  // contract says it is — "transactions imported from this statement" — so a
  // re-upload of a period already held reports 0 and says why, rather than
  // claiming 1,144 rows it did not add. That claim is exactly what made the
  // doubled client look normal on the Statements tab.
  await db.statement.update({
    where: { id: statement.id },
    data: {
      rowCount: written.count,
      gapAnalysis: {
        assurance: report.assurance,
        provenBy: report.provenBy,
        findings: importFindings([
          ...overlaps,
          ...duplicateFindings(written.count, duplicateRowCount, parsed.statement.rows.length),
        ]),
        mapping: parsed.statement.mapping,
        // The file's own line count, kept beside the import result so the two
        // numbers can never be confused for one another again.
        parsedRowCount: parsed.statement.rows.length,
        importedRowCount: written.count,
        alreadyPresentRowCount: duplicateRowCount,
      },
    },
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
      `${written.count} transaction(s) imported, ${duplicateRowCount} already present ` +
      `of ${parsed.statement.rows.length} read, assurance=${report.assurance}`,
  );
  if (duplicateRowCount > 0) {
    // WARN, not log. A statement whose lines were already held is either a
    // re-upload or an overlapping period, and both are things an operator
    // should be able to see in the logs without reading the database.
    logger.warn(
      `statement-ingest: ${input.documentId} — ${duplicateRowCount} line(s) were already imported ` +
        `for account ${accountId} and were not added again`,
    );
  }
  return {
    status: 'ingested',
    statementId: statement.id,
    rowCount: written.count,
    duplicateRowCount,
    parsedRowCount: parsed.statement.rows.length,
    report,
  };
}

/** `YYYY-MM-DD` in UTC — the stored instant, said as the date it is. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Statements already held for this account whose period touches this one.
 *
 * ## Why this REPORTS rather than refuses
 *
 * Refusing an overlapping upload would break three legitimate things: a bank
 * that re-issues a corrected statement, a period boundary that overlaps by a
 * day, and the ordinary case of a longer file that extends a shorter one. The
 * fingerprint index already makes the overlap *harmless* — the shared lines
 * cannot be inserted twice — so the remaining job here is to make it VISIBLE.
 *
 * ⚠ That visibility is the half the doubled client did not have. Two statements
 * covering 2025-08-01 → 2026-07-31, nine seconds apart, both claiming 1,144
 * rows, and no surface said the second one was a repeat of the first.
 *
 * Capped at five: a client who has uploaded a year in monthly files has twelve
 * overlaps with a whole-year file, and twelve identical findings is noise. The
 * count in the `alreadyImported` finding carries the magnitude.
 */
async function overlapFindings(
  db: StatementScopedClient,
  accountId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<CompletenessFinding[]> {
  const priors = await db.statement.findMany({
    // Two closed intervals overlap iff each starts on or before the other ends.
    where: { accountId, periodStart: { lte: periodEnd }, periodEnd: { gte: periodStart } },
    select: { id: true, periodStart: true, periodEnd: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });

  return priors.map((prior) => ({
    kind: 'periodOverlap' as const,
    sourceLine: null,
    detail:
      `This file covers ${isoDate(periodStart)} to ${isoDate(periodEnd)}, which overlaps a statement ` +
      `already imported for this account on ${isoDate(prior.createdAt)}` +
      (prior.periodStart === null || prior.periodEnd === null
        ? ''
        : ` covering ${isoDate(prior.periodStart)} to ${isoDate(prior.periodEnd)}`) +
      '. Lines this account already held were not imported a second time.',
  }));
}

/**
 * What the fingerprint index actually did, in words.
 *
 * A skip is only ever a line the account already held under the same identity —
 * never a genuine repeat purchase, which carries a different occurrence ordinal
 * and is inserted normally. Saying so out loud matters: silently adding nothing
 * is indistinguishable from silently adding everything twice, from the outside.
 */
function duplicateFindings(imported: number, duplicates: number, parsed: number): CompletenessFinding[] {
  if (duplicates === 0) return [];
  return [
    {
      kind: 'alreadyImported',
      sourceLine: null,
      detail:
        imported === 0
          ? `Every one of the ${parsed} transactions in this file was already imported for this account, ` +
            'so nothing was added. This looks like the same statement uploaded twice.'
          : `${duplicates} of the ${parsed} transactions in this file were already imported for this account ` +
            `and were not added again; ${imported} new transaction(s) were imported.`,
    },
  ];
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
