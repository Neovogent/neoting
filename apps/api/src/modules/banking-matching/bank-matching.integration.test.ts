import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { listBankTransactionsQueryParams } from '@neoting/contracts/zod';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { confirmMatchExecutor } from '../validation-dedupe/proposals/confirm-match.js';
import { ProposalExecutionRefused } from '../validation-dedupe/proposals/proposal-executor.js';
import { BankTransactionsService } from './bank-transactions.service.js';

/**
 * The METH Stage 11 acceptance, against a REAL database:
 *
 * - the feed lists the seeded transactions and the unmatched ones are
 *   unmatched;
 * - confirming a match PERSISTS — read back through the real service under
 *   RLS on a fresh connection, which is what "survives a refresh" means;
 * - a confirmed transaction leaves the UNMATCHED set. That set is the one
 *   chase detection reads (`match_state` + `chase_suppressed` on these same
 *   rows), so this is the assertion that the Bank screen and the chase list
 *   cannot disagree;
 * - the approver's RLS context is the boundary: another practice's staff sees
 *   an empty page and cannot execute against these rows.
 *
 * Ids are cleaned by explicit list, never `startsWith`: Prisma compiles
 * `startsWith` to `LIKE 's11_%'` WITHOUT escaping the `_`, so it would also
 * match another suite's `s110_` fixtures and delete them mid-run.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 's11-prac-a';
const P_B = 's11-prac-b';
const BIZ = 's11-biz-a';
const ACC = 's11-acc-a';
const CONN = 's11-conn-a';
const TXN_UNMATCHED = 's11-txn-currys';
const TXN_SUGGESTED = 's11-txn-amzn';
const TXN_SUPPRESSED = 's11-txn-stripe';
const DOC_CURRYS = 's11-doc-currys';
const DOC_AMZN = 's11-doc-amzn';
const MATCH_SUGGESTED = 's11-mat-amzn';
const USERS = ['s11-user-a', 's11-user-b'];

let owner: PrismaClient;
let app: PrismaClient;

const STAFF_A = ScopeContextSchema.parse({ actorId: 's11-user-a', practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 's11-user-b', practiceId: P_B });

const query = (raw: Record<string, unknown> = {}) => listBankTransactionsQueryParams.parse(raw);

async function cleanup(): Promise<void> {
  await owner.match.deleteMany({ where: { businessId: BIZ } });
  await owner.documentEvent.deleteMany({ where: { documentId: { in: [DOC_CURRYS, DOC_AMZN] } } });
  await owner.document.deleteMany({ where: { id: { in: [DOC_CURRYS, DOC_AMZN] } } });
  await owner.bankTransaction.deleteMany({ where: { accountId: ACC } });
  await owner.bankAccount.deleteMany({ where: { id: ACC } });
  await owner.bankConnection.deleteMany({ where: { id: CONN } });
  await owner.membership.deleteMany({ where: { userId: { in: USERS } } });
  await owner.user.deleteMany({ where: { id: { in: USERS } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'S11 A' }, { id: P_B, name: 'S11 B' }] });
  await owner.business.create({ data: { id: BIZ, practiceId: P_A, name: 'S11 Client' } });
  await owner.user.createMany({
    data: [
      { id: 's11-user-a', email: 's11a@example.test' },
      { id: 's11-user-b', email: 's11b@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 's11-mem-a', userId: 's11-user-a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 's11-mem-b', userId: 's11-user-b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
    ],
  });

  await owner.bankConnection.create({ data: { id: CONN, businessId: BIZ, provider: 'truelayer', consentState: 'ACTIVE' } });
  await owner.bankAccount.create({ data: { id: ACC, businessId: BIZ, connectionId: CONN, displayName: 'S11 — Current' } });

  await owner.bankTransaction.createMany({
    data: [
      // Signed integer pence, exactly as the feed records them.
      { id: TXN_UNMATCHED, businessId: BIZ, accountId: ACC, bookedAt: new Date('2026-08-16T00:00:00Z'), amountPence: -129_900, descriptionRaw: 'CURRYS 0842', matchState: 'UNMATCHED' },
      { id: TXN_SUGGESTED, businessId: BIZ, accountId: ACC, bookedAt: new Date('2026-08-15T00:00:00Z'), amountPence: -15_630, descriptionRaw: 'AMZNMKTPLACE', matchState: 'SUGGESTED' },
      { id: TXN_SUPPRESSED, businessId: BIZ, accountId: ACC, bookedAt: new Date('2026-08-14T00:00:00Z'), amountPence: 284_155, descriptionRaw: 'STRIPE PAYOUT', matchState: 'UNMATCHED', chaseSuppressed: true },
    ],
  });

  for (const id of [DOC_CURRYS, DOC_AMZN]) {
    await owner.document.create({
      data: {
        id,
        practiceId: P_A,
        businessId: BIZ,
        s3Key: `w/${BIZ}/documents/${id}`,
        byteHash: `h-${id}`,
        mimeType: 'application/pdf',
        byteSize: 10,
        channel: 'EMAIL',
        originalFilename: 'receipt.pdf',
        inbox: 'COSTS',
        state: 'READY',
      },
    });
  }

  // The shape the demo actually walks: a suggester already wrote a SUGGESTED
  // row, and confirming promotes it.
  await owner.match.create({
    data: { id: MATCH_SUGGESTED, businessId: BIZ, documentId: DOC_AMZN, transactionId: TXN_SUGGESTED, kind: 'PROBABILISTIC', confidence: 0.78, state: 'SUGGESTED', matchedBy: 'ai' },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('the bank screen against a real database', () => {
  test('the feed lists the workspace, newest booked first, in pence', async () => {
    const service = new BankTransactionsService(app);

    const page = await service.listBankTransactions(STAFF_A, query({ businessId: BIZ }));

    expect(page.data.map((t) => t.id)).toEqual([TXN_UNMATCHED, TXN_SUGGESTED, TXN_SUPPRESSED]);
    expect(page.data[0]?.amountPence).toBe(-129_900);
    // The flag is read off the column both surfaces read, not recomputed here.
    expect(page.data.find((t) => t.id === TXN_SUPPRESSED)?.chaseSuppressed).toBe(true);
  });

  test('another practice sees an empty page — RLS, not a filter', async () => {
    const service = new BankTransactionsService(app);

    // Not a 403 and not a 404: the rows were already invisible, so the filter
    // matches none of them and the answer never confirms the workspace exists.
    const page = await service.listBankTransactions(STAFF_B, query({ businessId: BIZ }));

    expect(page.data).toEqual([]);
  });

  test('confirming persists across a fresh read, and the line leaves the unmatched set', async () => {
    const service = new BankTransactionsService(app);
    const before = await service.listBankTransactions(STAFF_A, query({ businessId: BIZ, matchState: ['UNMATCHED'] }));
    expect(before.data.map((t) => t.id)).toContain(TXN_UNMATCHED);

    await scopedDb(app, STAFF_A, (db) =>
      confirmMatchExecutor.execute(db, {
        proposalId: 's11-prop',
        payload: { transactionId: TXN_UNMATCHED, documentId: DOC_CURRYS, matchKind: 'EXACT', confidence: 0.94 },
        ctx: STAFF_A,
        traceId: 'trace-s11',
      }),
    );

    // Read back through the service, not through `owner` — this is the
    // "survives a refresh" assertion, and it has to go through RLS to be one.
    const after = await service.listBankTransactions(STAFF_A, query({ businessId: BIZ }));
    expect(after.data.find((t) => t.id === TXN_UNMATCHED)?.matchState).toBe('CONFIRMED');

    // The set chase detection reads. A match row written without flipping
    // `match_state` would leave the line here, and the client would be chased
    // by SMS for the receipt that was just filed.
    const unmatched = await service.listBankTransactions(STAFF_A, query({ businessId: BIZ, matchState: ['UNMATCHED'] }));
    expect(unmatched.data.map((t) => t.id)).not.toContain(TXN_UNMATCHED);
    // The suppressed line is still unmatched and still visible — suppression
    // is about chasing, not about hiding a transaction from reconciliation.
    expect(unmatched.data.map((t) => t.id)).toContain(TXN_SUPPRESSED);

    const match = await owner.match.findFirst({ where: { transactionId: TXN_UNMATCHED } });
    expect(match).toMatchObject({ documentId: DOC_CURRYS, state: 'CONFIRMED', kind: 'EXACT', matchedBy: 'human', matchedByUserId: 's11-user-a' });
  });

  test('confirming a suggested pairing promotes the row instead of duplicating it', async () => {
    await scopedDb(app, STAFF_A, (db) =>
      confirmMatchExecutor.execute(db, {
        proposalId: 's11-prop-2',
        payload: { transactionId: TXN_SUGGESTED, documentId: DOC_AMZN, matchKind: 'PROBABILISTIC', confidence: 0.78 },
        ctx: STAFF_A,
        traceId: 'trace-s11',
      }),
    );

    const rows = await owner.match.findMany({ where: { transactionId: TXN_SUGGESTED } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(MATCH_SUGGESTED);
    expect(rows[0]?.state).toBe('CONFIRMED');
  });

  test("another practice's staff cannot confirm against these rows", async () => {
    const err = await scopedDb(app, STAFF_B, (db) =>
      confirmMatchExecutor.execute(db, {
        proposalId: 's11-prop-3',
        payload: { transactionId: TXN_SUPPRESSED, documentId: DOC_CURRYS, matchKind: 'EXACT' },
        ctx: STAFF_B,
        traceId: 'trace-s11',
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ProposalExecutionRefused);
    const txn = await owner.bankTransaction.findUnique({ where: { id: TXN_SUPPRESSED } });
    expect(txn?.matchState).toBe('UNMATCHED');
  });
});
