import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { TaxEstimateService } from './tax-estimate.service.js';

/**
 * The tax estimate (D52) against real Postgres RLS. What only a real database
 * can answer: the document predicate (states, inbox, the STATEMENT exclusion
 * with a NULL docType, the trash, the date window), the bank evidence read
 * off real `match_state` values, the statement coverage, the add-on gate, and
 * that another practice cannot see the estimate at all.
 *
 * Namespace `te_`, torn down by explicit id list.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'te_prac';
const P2 = 'te_prac_other';
const BIZ = 'te_biz';
const BIZ_OFF = 'te_biz_off';
const STAFF_USER = 'te_staff';
const OTHER_USER = 'te_other';
const MEMBERSHIPS = ['te_mem_staff', 'te_mem_other'];
const ACCOUNT = 'te_acct';
const DOCS = ['te_doc_sale', 'te_doc_cost', 'te_doc_statement', 'te_doc_trash', 'te_doc_usd', 'te_doc_late'];
const TXNS = ['te_txn_1', 'te_txn_2', 'te_txn_3', 'te_txn_hmrc'];
const STATEMENT = 'te_stmt';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF = ScopeContextSchema.parse({ actorId: STAFF_USER, practiceId: P });
const OTHER = ScopeContextSchema.parse({ actorId: OTHER_USER, practiceId: P2 });
const Q3 = { kind: 'VAT' as const, periodStart: '2026-07-01', periodEnd: '2026-09-30' };

async function cleanup(): Promise<void> {
  await owner.statement.deleteMany({ where: { id: STATEMENT } });
  await owner.bankTransaction.deleteMany({ where: { id: { in: TXNS } } });
  await owner.bankAccount.deleteMany({ where: { id: ACCOUNT } });
  await owner.document.deleteMany({ where: { id: { in: DOCS } } });
  await owner.membership.deleteMany({ where: { id: { in: MEMBERSHIPS } } });
  await owner.user.deleteMany({ where: { id: { in: [STAFF_USER, OTHER_USER] } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ, BIZ_OFF] } } });
  await owner.practice.deleteMany({ where: { id: { in: [P, P2] } } });
}

function document(id: string, data: Record<string, unknown>) {
  return owner.document.create({
    data: {
      id,
      practiceId: P,
      businessId: BIZ,
      channel: 'EMAIL',
      s3Key: `w/te/${id}`,
      byteHash: `te-${id}`,
      byteSize: 10,
      mimeType: 'application/pdf',
      originalFilename: `${id}.pdf`,
      submitterLabel: 'test',
      documentDate: new Date('2026-08-10T00:00:00.000Z'),
      ...data,
    },
  });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;
  await cleanup();

  await owner.practice.create({ data: { id: P, name: 'TE' } });
  await owner.practice.create({ data: { id: P2, name: 'TE Other' } });
  const paid = { subscriptionStatus: 'ACTIVE' as const, vatRegistered: true, legalStructure: 'LIMITED_COMPANY' };
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'Estimate Ltd', taxEstimateAddon: true, ...paid } });
  await owner.business.create({ data: { id: BIZ_OFF, practiceId: P, name: 'No Add-on Ltd', taxEstimateAddon: false, ...paid } });
  await owner.user.create({ data: { id: STAFF_USER, email: 'te@example.test' } });
  await owner.user.create({ data: { id: OTHER_USER, email: 'te-other@example.test' } });
  await owner.membership.create({ data: { id: MEMBERSHIPS[0] as string, userId: STAFF_USER, practiceId: P, role: 'PRACTICE_STANDARD' } });
  await owner.membership.create({ data: { id: MEMBERSHIPS[1] as string, userId: OTHER_USER, practiceId: P2, role: 'PRACTICE_STANDARD' } });

  await document('te_doc_sale', { inbox: 'SALES', state: 'READY', totalPence: 12_000, taxPence: 2_000, customerName: 'Café Ltd' });
  // docType NULL and TO_REVIEW: counted, and not "reviewed".
  await document('te_doc_cost', {
    inbox: 'COSTS',
    state: 'TO_REVIEW',
    totalPence: 6_000,
    taxPence: 1_000,
    categoryCode: 'SOFTWARE_AND_SUBSCRIPTIONS',
  });
  // Never counted: a bank statement, the trash, a later date. Counted as skipped: another currency.
  await document('te_doc_statement', { inbox: 'COSTS', state: 'READY', docType: 'STATEMENT', totalPence: 99_999, taxPence: 0 });
  await document('te_doc_trash', { inbox: 'COSTS', state: 'READY', totalPence: 99_999, taxPence: 9_999, deletedAt: new Date() });
  await document('te_doc_late', {
    inbox: 'COSTS',
    state: 'READY',
    totalPence: 99_999,
    taxPence: 9_999,
    documentDate: new Date('2026-10-01T00:00:00Z'),
  });
  await document('te_doc_usd', { inbox: 'COSTS', state: 'READY', totalPence: 5_000, taxPence: 0, currency: 'USD' });

  await owner.bankAccount.create({ data: { id: ACCOUNT, businessId: BIZ, displayName: 'Current' } });
  const txn = (id: string, amountPence: number, matchState: 'UNMATCHED' | 'SUGGESTED' | 'CONFIRMED', descriptionRaw: string) =>
    owner.bankTransaction.create({
      data: {
        id,
        businessId: BIZ,
        accountId: ACCOUNT,
        bookedAt: new Date('2026-08-12T12:00:00Z'),
        amountPence,
        matchState,
        descriptionRaw,
      },
    });
  await txn('te_txn_1', -6_000, 'SUGGESTED', 'SOFTWARE CO');
  await txn('te_txn_2', -1_200, 'UNMATCHED', 'UNKNOWN SHOP');
  await txn('te_txn_3', 12_000, 'CONFIRMED', 'CAFE LTD');
  await txn('te_txn_hmrc', -5_000, 'UNMATCHED', 'FASTER PAYMENT - HMRC VAT');
  await owner.statement.create({
    data: { id: STATEMENT, businessId: BIZ, periodStart: new Date('2026-07-01T00:00:00Z'), periodEnd: new Date('2026-09-30T00:00:00Z') },
  });
});

afterAll(async () => {
  if (!enabled) return;
  await cleanup();
  await owner.$disconnect();
  await app.$disconnect();
});

describe.skipIf(!enabled)('the tax estimate against real RLS', () => {
  test('a UK VAT estimate from the period’s documents and bank evidence', async () => {
    const view = await new TaxEstimateService(app).forPractice(STAFF, BIZ, Q3);
    expect(view.active).toBe(true);
    const e = view.estimate!;
    const box = (code: string) => e.figures.find((f) => f.code === code)?.amountPence;
    expect(box('1')).toBe(2_000);
    expect(box('4')).toBe(1_000);
    expect(e.lines.map((l) => l.documentId).sort()).toEqual(['te_doc_cost', 'te_doc_sale']);
    // The HMRC payment is left out; the £12 unexplained payment could hide £2 of VAT.
    expect(e.result).toEqual({ amountPence: 1_000, lowPence: 800, highPence: 1_000 });
    expect(e.completeness).toMatchObject({ statementCoveragePercent: 100, evidencedPercent: 93, reviewedPercent: 66, scorePercent: 93 });
    expect(e.notes.some((n) => n.includes('not in GBP'))).toBe(true);
  });

  test('without the add-on the answer is the offer, not an estimate', async () => {
    expect(await new TaxEstimateService(app).forPractice(STAFF, BIZ_OFF, Q3)).toEqual({ active: false, estimate: null });
  });

  test('another practice cannot see the client at all', async () => {
    await expect(new TaxEstimateService(app).forPractice(OTHER, BIZ, Q3)).rejects.toMatchObject({ code: 'NT-VAL-001' });
  });

  test('company tax for the same client, same data', async () => {
    const view = await new TaxEstimateService(app).forPractice(STAFF, BIZ, { ...Q3, kind: 'COMPANY_TAX' });
    // Profit £100 − £50 = £50 → 19%.
    expect(view.estimate?.result.amountPence).toBe(950);
  });
});
