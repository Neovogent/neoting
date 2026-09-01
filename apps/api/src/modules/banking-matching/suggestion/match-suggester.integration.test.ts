import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { BankTransactionsService } from '../bank-transactions.service.js';
import { PrismaMatchSuggester } from './match-suggester.js';

/**
 * The automatic match suggester against real Postgres RLS (Phase 4), plus the
 * read surface it feeds. What only a real database can answer:
 *
 *  - exactly one deterministic candidate → a SUGGESTED `matches` row AND the
 *    `matchState` flip, atomically enough that chase detection stops seeing
 *    the line;
 *  - two candidates → nothing (ambiguity never guesses);
 *  - a second run → nothing (idempotent per document);
 *  - a missing supplier or total → nothing (no amount-coincidence matches);
 *  - `GET /documents/{id}/bank-match` serves the suggestion with the
 *    transaction embedded, and 404s a foreign document;
 *  - the transactions LIST fills `matchedDocumentId` for CONFIRMED only.
 *
 * Namespace `p4ms_`, torn down by explicit id list.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'p4ms_prac';
const P2 = 'p4ms_prac_other';
const BIZ = 'p4ms_biz';
const SYSTEM_USER = 'p4ms_sys';
const SYSTEM_MEMBERSHIP = 'p4ms_mem_sys';
const STAFF_USER = 'p4ms_staff';
const STAFF_MEMBERSHIP = 'p4ms_mem_staff';
const OTHER_USER = 'p4ms_staff_other';
const OTHER_MEMBERSHIP = 'p4ms_mem_other';
const ACCOUNT = 'p4ms_acct';
const DOC = 'p4ms_doc';
const DOC_AMBIG = 'p4ms_doc_ambig';
const TXN = 'p4ms_txn';
const TXN_TWIN_A = 'p4ms_txn_twin_a';
const TXN_TWIN_B = 'p4ms_txn_twin_b';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF = ScopeContextSchema.parse({ actorId: STAFF_USER, practiceId: P });
const OTHER = ScopeContextSchema.parse({ actorId: OTHER_USER, practiceId: P2 });

async function cleanup(): Promise<void> {
  await owner.match.deleteMany({ where: { businessId: BIZ } });
  await owner.bankTransaction.deleteMany({ where: { id: { in: [TXN, TXN_TWIN_A, TXN_TWIN_B] } } });
  await owner.bankAccount.deleteMany({ where: { id: ACCOUNT } });
  await owner.document.deleteMany({ where: { id: { in: [DOC, DOC_AMBIG] } } });
  await owner.membership.deleteMany({ where: { id: { in: [SYSTEM_MEMBERSHIP, STAFF_MEMBERSHIP, OTHER_MEMBERSHIP] } } });
  await owner.user.deleteMany({ where: { id: { in: [SYSTEM_USER, STAFF_USER, OTHER_USER] } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: { in: [P, P2] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'P4MS' } });
  await owner.practice.create({ data: { id: P2, name: 'P4MS Other' } });
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'Suggest Ltd' } });
  await owner.user.create({ data: { id: SYSTEM_USER, kind: 'SYSTEM' } });
  await owner.user.create({ data: { id: STAFF_USER, email: 'p4ms@example.test' } });
  await owner.user.create({ data: { id: OTHER_USER, email: 'p4ms-other@example.test' } });
  await owner.membership.create({
    data: { id: SYSTEM_MEMBERSHIP, userId: SYSTEM_USER, practiceId: P, role: 'PRACTICE_STANDARD' },
  });
  await owner.membership.create({
    data: { id: STAFF_MEMBERSHIP, userId: STAFF_USER, practiceId: P, role: 'PRACTICE_STANDARD' },
  });
  await owner.membership.create({
    data: { id: OTHER_MEMBERSHIP, userId: OTHER_USER, practiceId: P2, role: 'PRACTICE_STANDARD' },
  });
  await owner.bankAccount.create({ data: { id: ACCOUNT, businessId: BIZ, displayName: 'Current' } });
  await owner.document.create({
    data: {
      id: DOC,
      practiceId: P,
      businessId: BIZ,
      inbox: 'COSTS',
      state: 'READY',
      channel: 'EMAIL',
      s3Key: 'w/p4ms/doc',
      byteHash: 'p4ms-hash-1',
      byteSize: 10,
      mimeType: 'image/jpeg',
      originalFilename: 'currys.jpg',
      submitterLabel: 'test',
    },
  });
  await owner.document.create({
    data: {
      id: DOC_AMBIG,
      practiceId: P,
      businessId: BIZ,
      inbox: 'COSTS',
      state: 'READY',
      channel: 'EMAIL',
      s3Key: 'w/p4ms/doc2',
      byteHash: 'p4ms-hash-2',
      byteSize: 10,
      mimeType: 'image/jpeg',
      originalFilename: 'linen.jpg',
      submitterLabel: 'test',
    },
  });
});

beforeEach(async () => {
  if (!enabled) return;
  await owner.match.deleteMany({ where: { businessId: BIZ } });
  await owner.bankTransaction.deleteMany({ where: { id: { in: [TXN, TXN_TWIN_A, TXN_TWIN_B] } } });
  await owner.bankTransaction.create({
    data: {
      id: TXN,
      businessId: BIZ,
      accountId: ACCOUNT,
      bookedAt: new Date('2026-08-09T12:00:00.000Z'),
      amountPence: -129_900,
      descriptionRaw: 'CURRYS 1234 LONDON',
      merchantName: 'Currys',
      matchState: 'UNMATCHED',
    },
  });
  // The London Linen twins: identical amounts, four days apart — the direct
  // debit that recurs. A £156 invoice fits both, and must suggest neither.
  for (const [id, day] of [
    [TXN_TWIN_A, '2026-08-12'],
    [TXN_TWIN_B, '2026-08-16'],
  ] as const) {
    await owner.bankTransaction.create({
      data: {
        id,
        businessId: BIZ,
        accountId: ACCOUNT,
        bookedAt: new Date(`${day}T12:00:00.000Z`),
        amountPence: -15_600,
        descriptionRaw: 'LONDON LINEN DD',
        merchantName: 'London Linen Co',
        matchState: 'UNMATCHED',
      },
    });
  }
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

const CURRYS_INPUT = {
  documentId: DOC,
  businessId: BIZ,
  practiceId: P,
  supplierName: 'Currys',
  totalPence: 129_900,
  documentDate: new Date('2026-08-09T00:00:00.000Z'),
  traceId: 'p4ms-trace',
};

describe.skipIf(!enabled)('the automatic match suggester, against real Postgres', () => {
  test('exactly one candidate → a SUGGESTED row, the matchState flip, and the read surface serves it', async () => {
    const suggester = new PrismaMatchSuggester(app);
    const result = await suggester.run(CURRYS_INPUT);
    expect(result.suggested?.transactionId).toBe(TXN);

    const txn = await owner.bankTransaction.findUnique({ where: { id: TXN }, select: { matchState: true } });
    expect(txn?.matchState).toBe('SUGGESTED');
    const match = await owner.match.findFirst({ where: { documentId: DOC } });
    expect(match?.state).toBe('SUGGESTED');
    expect(match?.kind).toBe('EXACT');
    expect(match?.matchedBy).toBe('auto-suggester');

    // The read surface, through RLS as the practice's own staff.
    const service = new BankTransactionsService(app);
    const read = await service.getDocumentBankMatch(STAFF, DOC);
    expect(read.match?.state).toBe('SUGGESTED');
    expect(read.match?.transaction.id).toBe(TXN);
    // A suggestion fills no matchedDocumentId — it is a question, not evidence.
    expect(read.match?.transaction.matchedDocumentId).toBeNull();

    // A foreign practice asking for the same document gets a 404, never data.
    await expect(service.getDocumentBankMatch(OTHER, DOC)).rejects.toMatchObject({ code: 'NT-VAL-001' });
  });

  test('a second run suggests nothing — idempotent per document', async () => {
    const suggester = new PrismaMatchSuggester(app);
    await suggester.run(CURRYS_INPUT);
    const second = await suggester.run(CURRYS_INPUT);
    expect(second.suggested).toBeNull();
    expect(await owner.match.count({ where: { documentId: DOC } })).toBe(1);
  });

  test('two equally-fitting lines suggest NEITHER — ambiguity never guesses', async () => {
    const suggester = new PrismaMatchSuggester(app);
    const result = await suggester.run({
      documentId: DOC_AMBIG,
      businessId: BIZ,
      practiceId: P,
      supplierName: 'London Linen Co',
      totalPence: 15_600,
      documentDate: new Date('2026-08-13T00:00:00.000Z'),
      traceId: 'p4ms-trace',
    });
    expect(result.suggested).toBeNull();
    expect(await owner.match.count({ where: { businessId: BIZ } })).toBe(0);
    const twins = await owner.bankTransaction.findMany({
      where: { id: { in: [TXN_TWIN_A, TXN_TWIN_B] } },
      select: { matchState: true },
    });
    expect(twins.every((t) => t.matchState === 'UNMATCHED')).toBe(true);
  });

  test('a document missing its supplier or total suggests nothing — no amount coincidences', async () => {
    const suggester = new PrismaMatchSuggester(app);
    expect((await suggester.run({ ...CURRYS_INPUT, supplierName: null })).suggested).toBeNull();
    expect((await suggester.run({ ...CURRYS_INPUT, totalPence: null })).suggested).toBeNull();
    expect(await owner.match.count({ where: { businessId: BIZ } })).toBe(0);
  });

  test('the transactions LIST fills matchedDocumentId for a CONFIRMED match only', async () => {
    const suggester = new PrismaMatchSuggester(app);
    await suggester.run(CURRYS_INPUT);

    const service = new BankTransactionsService(app);
    const suggestedPage = await service.listBankTransactions(STAFF, { businessId: BIZ, limit: 10 } as never);
    const suggestedRow = suggestedPage.data.find((t) => t.id === TXN);
    expect(suggestedRow?.matchState).toBe('SUGGESTED');
    expect(suggestedRow?.matchedDocumentId).toBeNull();

    // Promote the suggestion the way the confirm executor does: state flip on
    // both rows (the executor's own semantics, exercised end to end in
    // bank-matching.integration.test.ts — here the DB shape is the question).
    await owner.match.updateMany({ where: { documentId: DOC }, data: { state: 'CONFIRMED' } });
    await owner.bankTransaction.update({ where: { id: TXN }, data: { matchState: 'CONFIRMED' } });

    const confirmedPage = await service.listBankTransactions(STAFF, { businessId: BIZ, limit: 10 } as never);
    const confirmedRow = confirmedPage.data.find((t) => t.id === TXN);
    expect(confirmedRow?.matchedDocumentId).toBe(DOC);
  });
});
