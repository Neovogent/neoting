import { HttpStatus } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import type { AppException } from '../../common/problem/problem.js';
import { ChasesService } from './chases.service.js';

/**
 * The chase read surface against a REAL database as `nt_app` — the assertion that
 * matters is RLS: a practice reads its own chases, messages and outbox and sees
 * NOTHING of another practice's, because the `chases_tenant` / `sms_log_tenant`
 * policies remove the rows before the query runs, not because the service filters
 * them. A `getChase` for a foreign chase is a 404 (never a 403 that would confirm
 * it exists).
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable — a tenancy suite that quietly reports
 * green is worse than none.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'pc8_prac_a';
const P_B = 'pc8_prac_b';
const BIZ_A = 'pc8_biz_a';
const BIZ_B = 'pc8_biz_b';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF_A = ScopeContextSchema.parse({ actorId: 'pc8_user_a', practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 'pc8_user_b', practiceId: P_B });

function service(): ChasesService {
  return new ChasesService(app);
}

async function cleanup(): Promise<void> {
  await owner.smsLog.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.chaseMessage.deleteMany({ where: { chase: { businessId: { in: [BIZ_A, BIZ_B] } } } });
  await owner.chase.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.bankTransaction.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.bankAccount.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'pc8_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'pc8_' } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ_A, BIZ_B] } } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'PC8 A' }, { id: P_B, name: 'PC8 B' }] });
  await owner.business.createMany({
    data: [
      { id: BIZ_A, practiceId: P_A, name: 'American Burger' },
      { id: BIZ_B, practiceId: P_B, name: "Someone Else's Client" },
    ],
  });
  await owner.user.createMany({
    data: [
      { id: 'pc8_user_a', email: 'pc8a@example.test' },
      { id: 'pc8_user_b', email: 'pc8b@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'pc8_mem_a', userId: 'pc8_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'pc8_mem_b', userId: 'pc8_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
    ],
  });

  // Business A: a bank account, an unmatched transaction, a SENT chase over it,
  // one message, and an outbox row — the shape the chase.send executor writes.
  const acctA = await owner.bankAccount.create({ data: { id: 'pc8_acct_a', businessId: BIZ_A, displayName: 'Current' } });
  await owner.bankTransaction.create({
    data: {
      id: 'pc8_txn_currys',
      businessId: BIZ_A,
      accountId: acctA.id,
      bookedAt: new Date('2026-08-09T12:00:00.000Z'),
      amountPence: -129_900,
      descriptionRaw: 'CURRYS 1234 LONDON',
      merchantName: 'Currys',
      matchState: 'UNMATCHED',
    },
  });
  const chaseA = await owner.chase.create({
    data: {
      id: 'pc8_chase_a',
      businessId: BIZ_A,
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: 'pc8_txn_currys',
      itemRefs: ['pc8_txn_currys'],
      state: 'SENT',
      firstSentAt: new Date(),
      lastSentAt: new Date(),
      actionProposalId: 'pc8_prop_a',
    },
  });
  await owner.chaseMessage.create({
    data: {
      chaseId: chaseA.id,
      channel: 'sms',
      body: "American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: tok.sig",
      recipientE164: '+447700900001',
      sentAt: new Date(),
    },
  });
  await owner.smsLog.create({
    data: {
      id: 'pc8_sms_a',
      businessId: BIZ_A,
      toE164: '+447700900001',
      body: "American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: tok.sig",
      chaseId: chaseA.id,
    },
  });

  // Business B (a different practice): its own chase + outbox row, which A must
  // never see.
  const acctB = await owner.bankAccount.create({ data: { id: 'pc8_acct_b', businessId: BIZ_B, displayName: 'Current' } });
  await owner.bankTransaction.create({
    data: {
      id: 'pc8_txn_b',
      businessId: BIZ_B,
      accountId: acctB.id,
      bookedAt: new Date('2026-08-05T12:00:00.000Z'),
      amountPence: -60_000,
      descriptionRaw: 'GOOGLE ADS',
      merchantName: 'Google',
      matchState: 'UNMATCHED',
    },
  });
  await owner.chase.create({
    data: {
      id: 'pc8_chase_b',
      businessId: BIZ_B,
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: 'pc8_txn_b',
      itemRefs: ['pc8_txn_b'],
      state: 'SENT',
    },
  });
  await owner.smsLog.create({
    data: { id: 'pc8_sms_b', businessId: BIZ_B, toE164: '+447700900002', body: 'B only', chaseId: 'pc8_chase_b' },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('chase read surface under RLS', () => {
  test('a practice lists its own chase in full, with items and messages', async () => {
    const page = await service().listChases(STAFF_A, { limit: 50 } as never);
    expect(page.data.map((c) => c.id)).toEqual(['pc8_chase_a']);
    expect(page.data[0]?.itemCount).toBe(1);

    const detail = await service().getChase(STAFF_A, 'pc8_chase_a');
    expect(detail.items.map((i) => i.transactionId)).toEqual(['pc8_txn_currys']);
    expect(detail.items[0]?.amountPence).toBe(-129_900); // integer pence, unchanged
    expect(detail.items[0]?.merchantName).toBe('Currys');
    expect(detail.messages[0]?.body).toContain("we're missing the receipt for Currys");
  });

  test('the outbox lists only this practice\'s SMS, with the portal link extracted', async () => {
    const page = await service().listSmsOutbox(STAFF_A, { limit: 50 } as never);
    expect(page.data.map((m) => m.id)).toEqual(['pc8_sms_a']);
    expect(page.data[0]?.portalUrl).toBe('tok.sig'); // tappable phone-screen affordance
  });

  test('RLS hides another practice entirely — list is empty, detail is 404', async () => {
    // B's staff see none of A's chases or outbox…
    expect((await service().listChases(STAFF_B, { businessId: BIZ_A, limit: 50 } as never)).data).toHaveLength(0);
    expect((await service().listSmsOutbox(STAFF_B, { businessId: BIZ_A, limit: 50 } as never)).data).toHaveLength(0);

    // …and A's chase is a 404 for B, never a 403 that would confirm it exists.
    let err: AppException | undefined;
    try {
      await service().getChase(STAFF_B, 'pc8_chase_a');
    } catch (e) {
      err = e as AppException;
    }
    expect(err?.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(err?.code).toBe('NT-VAL-001');

    // B still sees its OWN chase — the boundary hides across, not down.
    expect((await service().listChases(STAFF_B, { limit: 50 } as never)).data.map((c) => c.id)).toEqual(['pc8_chase_b']);
  });
});
