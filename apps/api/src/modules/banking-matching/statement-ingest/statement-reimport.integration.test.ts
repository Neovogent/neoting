import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { ingestStatement, type StatementScopedClient } from './statement-ingest.js';

/**
 * ⚠ THE MOST SERIOUS DATA DEFECT THIS PRODUCT HAS HAD, held down against a real
 * database.
 *
 * A real client held **2,288** `bank_transactions` that were 1,144 rows imported
 * TWICE — identical `booked_at`, `amount_pence`, `description_raw` and
 * `account_id` — from two `statements` rows covering the same
 * 2025-08-01 → 2026-07-31 period, `row_count` 1144 each, created nine seconds
 * apart. Half of that client's ledger was a duplicate, every figure derived from
 * it was wrong, and nothing in the product noticed.
 *
 * Every defence that should have caught it was inert:
 *
 * - `bank_transactions_account_id_provider_transaction_id_key` — D40 has no
 *   provider, so every row's `provider_transaction_id` was NULL, and Postgres
 *   treats NULLs as DISTINCT. The constraint admitted unlimited copies.
 * - the `documentId` idempotency key in `ingestStatement` — two uploads of one
 *   period are two DOCUMENTS, so it never fired.
 * - exact-byte dedupe — the two source PDFs had different `byte_hash`.
 *
 * The tests below are the two halves of the fix, and they pull in opposite
 * directions on purpose: the second import must add **nothing**, and a genuine
 * repeat purchase must **survive**. Passing one by failing the other is not a
 * fix — losing a real payment out of an accounting ledger is worse than showing
 * two.
 *
 * ## Teardown
 *
 * Ids are cleaned by EXPLICIT LIST, never `startsWith`: Prisma compiles
 * `startsWith` to `LIKE 'x_%'` without escaping the `_`, which is LIKE's
 * single-character wildcard, so a prefix cleanup silently deletes another
 * suite's fixtures. The `stre-` namespace is disjoint from every other suite's,
 * including `sti-` in `statement-ingest.integration.test.ts`, which asserts over
 * every transaction ITS business has.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const PRAC = 'stre-prac';
const BIZ = 'stre-biz';
const USER = 'stre-user';
const MEM = 'stre-mem';
const DOC_FIRST = 'stre-doc-first';
const DOC_SECOND = 'stre-doc-second';
const DOC_EXTENDED = 'stre-doc-extended';
const DOC_REPEATS = 'stre-doc-repeats';
const DOCS = [DOC_FIRST, DOC_SECOND, DOC_EXTENDED, DOC_REPEATS];

let owner: PrismaClient;
let app: PrismaClient;

const CTX = ScopeContextSchema.parse({ actorId: USER, practiceId: PRAC });

/** August, with a running balance so the D41 gate can prove it complete. */
const august = [
  'Date,Description,Amount,Balance',
  '01/08/2026,BALANCE BROUGHT FORWARD,,1000.00',
  '03/08/2026,BIDFOOD LTD,-150.00,850.00',
  '05/08/2026,CARD PAYMENT,250.00,1100.00',
].join('\n');

/**
 * The SAME period, re-exported by the bank in a different format — a different
 * file, a different byte hash, different column headers and a different row for
 * the opening balance. Every transaction in it is one the account already holds.
 * This is the shape of the upload that doubled the real client.
 */
const augustAgain = [
  'Transaction Date,Details,Paid out,Paid in,Running balance',
  '01/08/2026,BALANCE BROUGHT FORWARD,,,1000.00',
  '03/08/2026,BIDFOOD LTD,150.00,,850.00',
  '05/08/2026,CARD PAYMENT,,250.00,1100.00',
].join('\n');

/** August AND September: the shared half must not re-import, September must. */
const augustAndSeptember = [
  'Date,Description,Amount,Balance',
  '01/08/2026,BALANCE BROUGHT FORWARD,,1000.00',
  '03/08/2026,BIDFOOD LTD,-150.00,850.00',
  '05/08/2026,CARD PAYMENT,250.00,1100.00',
  '02/09/2026,BRITISH GAS,-50.00,1050.00',
].join('\n');

/**
 * ⚠ A business really can buy the same coffee twice. Two lines, same date, same
 * amount, same description — because there were two payments. Both must import.
 */
const twoIdenticalCoffees = [
  'Date,Description,Amount,Balance',
  '01/10/2026,BALANCE BROUGHT FORWARD,,500.00',
  '02/10/2026,PRET A MANGER 1187,-3.20,496.80',
  '02/10/2026,PRET A MANGER 1187,-3.20,493.60',
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
  await owner.practice.create({ data: { id: PRAC, name: 'STRE Practice' } });
  await owner.business.create({ data: { id: BIZ, practiceId: PRAC, name: 'STRE Client' } });
  await owner.user.create({ data: { id: USER, email: 'stre@example.test' } });
  await owner.membership.create({ data: { id: MEM, userId: USER, practiceId: PRAC, role: 'PRACTICE_ADMIN' } });

  for (const id of DOCS) {
    await owner.document.create({
      data: {
        id,
        practiceId: PRAC,
        businessId: BIZ,
        s3Key: `w/${BIZ}/documents/${id}`,
        // Different bytes per document, exactly like the two real PDFs — so
        // upstream hash dedupe cannot be what makes these tests pass.
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

const run = (documentId: string, bytes: string) =>
  scopedDb(app, CTX, (db) =>
    ingestStatement(
      db as unknown as StatementScopedClient,
      {
        documentId,
        businessId: BIZ,
        fileName: 'statement.csv',
        bytes: Buffer.from(bytes, 'utf8'),
        mimeType: 'text/csv',
        s3Key: null,
      },
      log,
    ),
  );

const countAll = () => owner.bankTransaction.count({ where: { businessId: BIZ } });

describe.skipIf(!enabled)('re-uploading a statement, against a real database', () => {
  test('the first import lands the file', async () => {
    const outcome = await run(DOC_FIRST, august);
    expect(outcome.status).toBe('ingested');
    if (outcome.status !== 'ingested') return;
    // The brought-forward line is the opening balance, not a transaction.
    expect(outcome.rowCount).toBe(2);
    expect(outcome.duplicateRowCount).toBe(0);
    expect(await countAll()).toBe(2);
  });

  test('⚠ the SAME period uploaded as a different file adds NOTHING', async () => {
    // The defect, reproduced exactly: a second document, a different byte hash,
    // a different export format, the same transactions. Before the fingerprint
    // index this doubled the account and reported 1,144 rows imported.
    const before = await countAll();
    const outcome = await run(DOC_SECOND, augustAgain);

    expect(outcome.status).toBe('ingested');
    if (outcome.status !== 'ingested') return;
    expect(outcome.rowCount).toBe(0);
    expect(outcome.duplicateRowCount).toBe(2);
    expect(outcome.parsedRowCount).toBe(2);
    expect(await countAll()).toBe(before);

    // …and specifically no second copy of any one line.
    expect(await owner.bankTransaction.count({ where: { businessId: BIZ, descriptionRaw: 'BIDFOOD LTD' } })).toBe(1);
  });

  test('the second statement row says 0 rows and says WHY', async () => {
    // ⚠ A structural defence nobody can see is how this gets rediscovered in a
    // year. The real client's two statement rows BOTH claimed 1,144 imported,
    // which is what made the doubling look normal on the Statements tab.
    const statement = await owner.statement.findFirst({ where: { documentId: DOC_SECOND } });
    expect(statement?.rowCount).toBe(0);

    const analysis = statement?.gapAnalysis as {
      parsedRowCount?: number;
      importedRowCount?: number;
      alreadyPresentRowCount?: number;
      findings?: { kind: string; detail: string }[];
    } | null;
    expect(analysis?.parsedRowCount).toBe(2);
    expect(analysis?.importedRowCount).toBe(0);
    expect(analysis?.alreadyPresentRowCount).toBe(2);

    const kinds = (analysis?.findings ?? []).map((f) => f.kind);
    expect(kinds).toContain('alreadyImported');
    expect(kinds).toContain('periodOverlap');
    expect((analysis?.findings ?? []).find((f) => f.kind === 'alreadyImported')?.detail).toContain(
      'uploaded twice',
    );
  });

  test('an OVERLAPPING statement imports only the part that is new', async () => {
    const before = await countAll();
    const outcome = await run(DOC_EXTENDED, augustAndSeptember);

    expect(outcome.status).toBe('ingested');
    if (outcome.status !== 'ingested') return;
    expect(outcome.rowCount).toBe(1);
    expect(outcome.duplicateRowCount).toBe(2);
    expect(await countAll()).toBe(before + 1);
    expect(await owner.bankTransaction.count({ where: { businessId: BIZ, descriptionRaw: 'BRITISH GAS' } })).toBe(1);
    // The August half is still exactly one copy each.
    expect(await owner.bankTransaction.count({ where: { businessId: BIZ, descriptionRaw: 'BIDFOOD LTD' } })).toBe(1);
  });

  test('⚠ two genuinely identical transactions on ONE statement BOTH survive', async () => {
    // The counterweight to every assertion above. A business really can buy the
    // same coffee twice, and a defence that collapsed these would silently
    // delete a real payment from an accounting ledger.
    const before = await countAll();
    const outcome = await run(DOC_REPEATS, twoIdenticalCoffees);

    expect(outcome.status).toBe('ingested');
    if (outcome.status !== 'ingested') return;
    expect(outcome.rowCount).toBe(2);
    expect(outcome.duplicateRowCount).toBe(0);
    expect(await countAll()).toBe(before + 2);

    const coffees = await owner.bankTransaction.findMany({
      where: { businessId: BIZ, descriptionRaw: 'PRET A MANGER 1187' },
    });
    expect(coffees).toHaveLength(2);
    expect(coffees.every((c) => c.amountPence === -320)).toBe(true);
    // Two rows, two DIFFERENT identities — the occurrence ordinal is what makes
    // that true, and it is the reason the re-import test above can be strict.
    expect(new Set(coffees.map((c) => c.importFingerprint)).size).toBe(2);
  });

  test('…and re-uploading THAT statement still adds nothing', async () => {
    // Both properties held at once: the genuine repeat survived, AND the file
    // is still idempotent. This is the queue's redelivery path — the same
    // document arriving twice — which short-circuits on `documentId` before any
    // parsing happens and so must not spend a Textract charge either.
    const before = await countAll();
    const again = await run(DOC_REPEATS, twoIdenticalCoffees);
    expect(again.status).toBe('alreadyIngested');
    expect(await countAll()).toBe(before);
  });

  test('every imported row carries an identity and its source statement', async () => {
    const rows = await owner.bankTransaction.findMany({ where: { businessId: BIZ } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.importFingerprint !== null)).toBe(true);
    // `import_batch_id` has existed and been unused since `init`. Writing the
    // statement id is what makes "which rows came from that file" answerable.
    expect(rows.every((r) => r.importBatchId !== null)).toBe(true);
    // Distinct across the whole account — which is the invariant the unique
    // index enforces, asserted here so a dropped index fails a test rather than
    // a client's books.
    expect(new Set(rows.map((r) => r.importFingerprint)).size).toBe(rows.length);
  });
});
