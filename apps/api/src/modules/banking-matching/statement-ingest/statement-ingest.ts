import { assessCompleteness, type CompletenessReport } from './completeness.js';
import { parseStatement, type ParsedStatement } from './statement-parser.js';

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
}

export interface StatementIngestInput {
  readonly documentId: string;
  readonly businessId: string;
  /** The statement's own file name — the reader picks CSV or XLSX from it. */
  readonly fileName: string;
  readonly bytes: Buffer;
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

export async function ingestStatement(
  db: StatementScopedClient,
  input: StatementIngestInput,
  logger: StatementIngestLogger,
): Promise<StatementIngestOutcome> {
  // Idempotency first, before any parsing work.
  const already = await db.statement.findFirst({
    where: { documentId: input.documentId },
    select: { id: true },
  });
  if (already !== null) {
    logger.log(`statement-ingest: document ${input.documentId} already ingested as ${already.id}`);
    return { status: 'alreadyIngested', statementId: already.id };
  }

  const parsed = parseStatement(input.bytes, input.fileName);
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

  logger.log(
    `statement-ingest: ${input.documentId} → statement ${statement.id}, ` +
      `${written.count} transaction(s), assurance=${report.assurance}`,
  );
  return { status: 'ingested', statementId: statement.id, rowCount: written.count, report };
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
      return `${failure.fileName} is not a format this reads. Bank statements can be uploaded as .pdf, .csv or .xlsx.`;
    case 'unreadable':
      switch (failure.detail) {
        case 'notAZipFile':
          return 'This file is named .xlsx but is not a spreadsheet — it may have been renamed.';
        case 'notAWorkbook':
          return 'This spreadsheet has no readable worksheet.';
        case 'notAPdf':
          return 'This file is named .pdf but is not one.';
        case 'encrypted':
          return 'This PDF is password-protected, so its transactions cannot be read. Export it again without a password, or upload the CSV or XLSX your bank offers.';
        case 'noTextFound':
          return 'This PDF has no readable text — it looks like a scan or a photograph of a statement. Download the statement from your bank as a PDF, CSV or XLSX rather than scanning a printout.';
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
