import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import {
  ingestStatement,
  readStatementFor,
  type StatementScopedClient,
} from './statement-ingest.js';

/**
 * Statement import against a REAL database (D40/D41).
 *
 * The unit tests prove the parser and the completeness gate on their own. This
 * proves the half that only a database can: that an uploaded statement actually
 * becomes `Statement` + `BankTransaction` rows, under RLS, through `scopedDb`.
 *
 * It matters because until this lane existed **nothing in the API had ever
 * created a bank transaction** — `prisma/seed.ts` was the only writer, so every
 * transaction on every screen was demo data, and the one bank input ID has was
 * a mock end to end.
 *
 * Ids are cleaned by explicit list, never `startsWith`: Prisma compiles
 * `startsWith` to `LIKE 'sti_%'` WITHOUT escaping the `_`, which is LIKE's
 * single-character wildcard, so a prefix cleanup deletes another suite's rows.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const PRAC = 'sti-prac';
const BIZ = 'sti-biz';
const USER = 'sti-user';
const MEM = 'sti-mem';
const DOC_GOOD = 'sti-doc-good';
const DOC_BROKEN = 'sti-doc-broken';
const DOC_PDF = 'sti-doc-pdf';
const DOC_SLOW = 'sti-doc-slow';
const DOCS = [DOC_GOOD, DOC_BROKEN, DOC_PDF, DOC_SLOW];

let owner: PrismaClient;
let app: PrismaClient;

const CTX = ScopeContextSchema.parse({ actorId: USER, practiceId: PRAC });

const statementCsv = [
  'Barclays Bank plc',
  'Account: 12345678',
  '',
  'Date,Description,Paid out,Paid in,Balance',
  '01/04/2026,BALANCE BROUGHT FORWARD,,,1000.00',
  '02/04/2026,BIDFOOD LTD,150.00,,850.00',
  '03/04/2026,CARD PAYMENT,,250.00,1100.00',
].join('\n');

/** The same file with £50 unaccounted for between two lines. */
const brokenCsv = [
  'Date,Description,Amount,Balance',
  '02/04/2026,BIDFOOD LTD,-150.00,850.00',
  '03/04/2026,BRITISH GAS,-50.00,750.00',
].join('\n');

async function cleanup(): Promise<void> {
  await owner.bankTransaction.deleteMany({ where: { businessId: BIZ } });
  await owner.statement.deleteMany({ where: { businessId: BIZ } });
  await owner.bankAccount.deleteMany({ where: { businessId: BIZ } });
  await owner.documentEvent.deleteMany({ where: { documentId: { in: DOCS } } });
  await owner.document.deleteMany({ where: { id: { in: DOCS } } });
  await owner.membership.deleteMany({ where: { id: MEM } });
  await owner.user.deleteMany({ where: { id: USER } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: PRAC } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: PRAC, name: 'STI Practice' } });
  await owner.business.create({ data: { id: BIZ, practiceId: PRAC, name: 'STI Client' } });
  await owner.user.create({ data: { id: USER, email: 'sti@example.test' } });
  await owner.membership.create({ data: { id: MEM, userId: USER, practiceId: PRAC, role: 'PRACTICE_ADMIN' } });

  for (const id of DOCS) {
    await owner.document.create({
      data: {
        id,
        practiceId: PRAC,
        businessId: BIZ,
        s3Key: `w/${BIZ}/documents/${id}`,
        byteHash: `h-${id}`,
        mimeType: 'text/csv',
        byteSize: 10,
        channel: 'WEB_UPLOAD',
        originalFilename: 'statement.csv',
        inbox: 'COSTS',
        state: 'READY',
        docType: 'STATEMENT',
      },
    });
  }
});

afterAll(async () => {
  if (!enabled) return;
  await cleanup();
  await owner.$disconnect();
  await app.$disconnect();
});

const log = { log() {}, warn() {} };

const run = (documentId: string, bytes: string, fileName = 'statement.csv') =>
  scopedDb(app, CTX, (db) =>
    ingestStatement(
      db as unknown as StatementScopedClient,
      {
        documentId,
        businessId: BIZ,
        fileName,
        bytes: Buffer.from(bytes, 'utf8'),
        mimeType: fileName.endsWith('.pdf') ? 'application/pdf' : 'text/csv',
        s3Key: null,
      },
      log,
    ),
  );

describe.skipIf(!enabled)('statement import, against a real database', () => {
  test('a reader SLOWER than the transaction timeout still imports', async () => {
    // ⚠ THE REGRESSION THIS FILE EXISTS TO HOLD DOWN, and it was live.
    //
    // `ingestStatement` used to do the read itself, inside `scopedDb` — a
    // Prisma INTERACTIVE transaction whose timeout is 10 seconds. A CSV parses
    // in milliseconds so it never showed. Textract's asynchronous path takes
    // 40-60 seconds on a real statement, and the first 29-page PDF through it
    // died on the query AFTER the read came back:
    //
    //   Transaction already closed: … timeout … was 10000 ms, however 56824 ms
    //   passed since the start of the transaction
    //
    // Textract had SUCCEEDED. The database connection it returned to had not,
    // and the statement-step swallowed the throw, so the only symptom was a
    // statement that silently did not import. The reader below sleeps past the
    // same ceiling; if the read ever moves back inside the transaction, this
    // test fails exactly the way staging did.
    const SLOW_MS = 11_000;
    const ocr = {
      pages: [],
      text: '',
      grid: [
        ['Date', 'Description', 'Paid out', 'Paid in', 'Balance'],
        ['01/04/2026', 'BALANCE BROUGHT FORWARD', '', '', '1000.00'],
        ['02/04/2026', 'SLOW READER LTD', '150.00', '', '850.00'],
      ],
    };

    const input = {
      documentId: DOC_SLOW,
      businessId: BIZ,
      fileName: 'slow.pdf',
      bytes: Buffer.from('%PDF-1.7', 'latin1'),
      mimeType: 'application/pdf',
      s3Key: 'w/biz/documents/slow',
    };

    // The read, and the time it takes, happen OUTSIDE any transaction — the
    // shape the step uses. The sleep stands in for Textract, which is exactly
    // this slow on a real statement.
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    const parsed = await readStatementFor(input, ocr);
    expect(parsed.ok).toBe(true);

    const outcome = await scopedDb(app, CTX, (db) =>
      ingestStatement(db as unknown as StatementScopedClient, input, log, parsed),
    );

    expect(outcome.status).toBe('ingested');
    if (outcome.status !== 'ingested') return;
    expect(outcome.rowCount).toBe(1);
    expect(
      await owner.bankTransaction.count({ where: { businessId: BIZ, descriptionRaw: 'SLOW READER LTD' } }),
    ).toBe(1);

    // Cleaned here rather than in `afterAll`: the sibling tests assert over
    // EVERY transaction this business has, so a row left behind by this one
    // fails them instead of this one.
    await owner.bankTransaction.deleteMany({ where: { businessId: BIZ, descriptionRaw: 'SLOW READER LTD' } });
    await owner.statement.deleteMany({ where: { documentId: DOC_SLOW } });
  }, 40_000);

  test('a statement becomes real bank transactions', async () => {
    const outcome = await run(DOC_GOOD, statementCsv);
    expect(outcome.status).toBe('ingested');
    if (outcome.status !== 'ingested') return;
    // The brought-forward line is the opening balance, not a transaction.
    expect(outcome.rowCount).toBe(2);
    expect(outcome.report.assurance).toBe('complete');

    const rows = await owner.bankTransaction.findMany({
      where: { businessId: BIZ },
      orderBy: { bookedAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    // Signed integer pence, money OUT negative. Getting this backwards files
    // every payment as income and inverts the client's books.
    expect(rows[0]?.amountPence).toBe(-15_000);
    expect(rows[1]?.amountPence).toBe(25_000);
    expect(rows[0]?.descriptionRaw).toBe('BIDFOOD LTD');
    // The set the chase list reads: a line that arrived any other way would be
    // a payment silently exempted from ever being chased for its receipt.
    expect(rows.every((r) => r.matchState === 'UNMATCHED')).toBe(true);
    expect(rows.every((r) => r.chaseSuppressed === false)).toBe(true);
  });

  test('the statement row records the period, the balances and the assurance', async () => {
    const statement = await owner.statement.findFirst({ where: { documentId: DOC_GOOD } });
    expect(statement).not.toBeNull();
    expect(statement?.openingBalancePence).toBe(100_000);
    expect(statement?.closingBalancePence).toBe(110_000);
    expect(statement?.rowCount).toBe(2);
    expect(statement?.periodStart?.toISOString().slice(0, 10)).toBe('2026-04-02');
    // The FIRST writer of gapAnalysis in this repo — `GET /businesses` counts
    // statement gaps off exactly this.
    expect((statement?.gapAnalysis as { assurance?: string } | null)?.assurance).toBe('complete');
  });

  test('an implicit bank account is created once and reused', async () => {
    // ID has no bank connection (D40), so there is no provider account to look
    // up. The account must carry no connectionId — a populated one would claim
    // a feed was authorised.
    const accounts = await owner.bankAccount.findMany({ where: { businessId: BIZ } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.connectionId).toBeNull();
  });

  test('a redelivery does NOT double the client bank feed', async () => {
    // The queue is at-least-once, so this is the property that matters most.
    const before = await owner.bankTransaction.count({ where: { businessId: BIZ } });
    const again = await run(DOC_GOOD, statementCsv);
    expect(again.status).toBe('alreadyIngested');
    expect(await owner.bankTransaction.count({ where: { businessId: BIZ } })).toBe(before);
  });

  test('a broken balance chain still imports, and is recorded as incomplete', async () => {
    // The rows are real and the accountant needs them; what must not happen is
    // the file being reported as trustworthy. 850 − 50 is 800, not 750.
    const outcome = await run(DOC_BROKEN, brokenCsv);
    expect(outcome.status).toBe('ingested');
    if (outcome.status !== 'ingested') return;
    expect(outcome.report.assurance).toBe('incomplete');
    expect(outcome.report.findings.some((f) => f.kind === 'balanceBreak')).toBe(true);

    const statement = await owner.statement.findFirst({ where: { documentId: DOC_BROKEN } });
    expect((statement?.gapAnalysis as { assurance?: string } | null)?.assurance).toBe('incomplete');
  });

  test('a PDF with NO reader configured is refused with a reason, and writes nothing', async () => {
    // A PDF is Textract's job (D20). With `STATEMENT_READER=none` there is no
    // reader, and the refusal must say so PERMANENTLY — importing zero rows
    // would report an unread statement as an empty one, and promising a retry
    // that no configuration will ever perform is the same lie one step later.
    const before = await owner.bankTransaction.count({ where: { businessId: BIZ } });
    const outcome = await run(DOC_PDF, '%PDF-1.7', 'statement.pdf');
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toContain('not switched on');
    expect(outcome.reason).not.toContain('shortly');
    expect(await owner.statement.count({ where: { documentId: DOC_PDF } })).toBe(0);
    expect(await owner.bankTransaction.count({ where: { businessId: BIZ } })).toBe(before);
  });
});
