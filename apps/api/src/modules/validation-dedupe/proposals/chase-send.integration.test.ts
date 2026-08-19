import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { AppException } from '../../../common/problem/problem.js';
import { composeChaseSms, DemoSmsSender, signPortalLink, verifyPortalLink } from '../../chase/index.js';
import { ActionProposalsService } from '../../approvals/action-proposals.service.js';
import { buildExecutorRegistry } from './registry.js';

/**
 * The METH Stage 8 acceptance, end to end through the REAL Review → Approve
 * engine against a real database as `nt_app`:
 *
 *   detection composes the verbatim SMS → a `chase.send` proposal is created →
 *   review shows that SMS byte-for-byte → approve → the chase is SENT, the
 *   outbox carries the message with the SAME body, and the portal link in it
 *   verifies. The chase.send executor runs inside the engine's approve
 *   transaction (the #81 seam), driven by the registry the engine builds.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'p8_prac';
const BIZ = 'p8_biz';
const PORTAL_SECRET = 'p8-portal-secret-000000000000000000';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF = ScopeContextSchema.parse({ actorId: 'p8_user', practiceId: P });

function service(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ smsSender: new DemoSmsSender() }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    new InMemoryIdempotencyStore(),
  );
}

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { businessId: BIZ } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: P }, { businessId: BIZ }] } });
  await owner.smsLog.deleteMany({ where: { businessId: BIZ } });
  await owner.chaseMessage.deleteMany({ where: { chase: { businessId: BIZ } } });
  await owner.chase.deleteMany({ where: { businessId: BIZ } });
  await owner.bankTransaction.deleteMany({ where: { businessId: BIZ } });
  await owner.bankAccount.deleteMany({ where: { businessId: BIZ } });
  await owner.contact.deleteMany({ where: { businessId: BIZ } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p8_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p8_' } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: P } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'P8' } });
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'American Burger' } });
  await owner.user.create({ data: { id: 'p8_user', email: 'p8@example.test' } });
  await owner.membership.create({ data: { id: 'p8_mem', userId: 'p8_user', practiceId: P, role: 'PRACTICE_ADMIN' } });
  await owner.contact.create({ data: { id: 'p8_contact', businessId: BIZ, mobileE164: '+447700900001', isPrimary: true } });
  const account = await owner.bankAccount.create({ data: { id: 'p8_acct', businessId: BIZ, displayName: 'Current' } });
  await owner.bankTransaction.create({
    data: {
      id: 'p8_txn_currys',
      businessId: BIZ,
      accountId: account.id,
      bookedAt: new Date('2026-08-09T12:00:00.000Z'),
      amountPence: -129_900,
      descriptionRaw: 'CURRYS 1234 LONDON',
      merchantName: 'Currys',
      matchState: 'UNMATCHED',
    },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('chase.send end to end through the engine', () => {
  test('create → review (verbatim SMS) → approve → chase SENT + outbox with a working portal link', async () => {
    // Composition — exactly the copy detection would produce, with a real portal
    // link signed over a pre-minted chase identity (the token Stage 9 verifies).
    const link = signPortalLink({ chaseId: 'p8_link_chase', expSeconds: 86_400 }, PORTAL_SECRET);
    const body = composeChaseSms({
      businessName: 'American Burger',
      portalLink: link,
      items: [{ transactionId: 'p8_txn_currys', amountPence: -129_900, bookedAt: new Date('2026-08-09T12:00:00.000Z'), supplierLabel: 'Currys' }],
    });
    expect(body).toContain("we're missing the receipt for Currys £1,299 on 9 Aug");

    const svc = service();
    const created = await svc.create(
      STAFF,
      {
        kind: 'chase.send',
        businessId: BIZ,
        payload: {
          messages: [
            { recipientE164: '+447700900001', recipientContactId: 'p8_contact', body, transactionIds: ['p8_txn_currys'] },
          ],
        },
      },
      'p8-key-create',
    );
    expect(created.state).toBe('CREATED');

    // Review renders the SMS byte-for-byte — the flagship guarantee.
    const review = await svc.review(STAFF, created.id, 'p8-key-review');
    const summary = review.renderedSummary as {
      title: string;
      sections: { entries: { label: string; value: string }[] }[];
    };
    expect(summary.title).toBe('Send 1 chase SMS message');
    const shownBody = summary.sections[0]?.entries.find((e) => e.label.startsWith('SMS'))?.value;
    expect(shownBody).toBe(body);

    const executed = await svc.approve(STAFF, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p8-key-approve');
    expect(executed.state).toBe('EXECUTED');
    expect(executed.outcome).toMatchObject({ alreadyApplied: false });

    // The chase landed SENT, engine (a), stamped with the proposal, its item the
    // chased transaction.
    const chase = await owner.chase.findFirst({ where: { businessId: BIZ, actionProposalId: created.id } });
    expect(chase?.state).toBe('SENT');
    expect(chase?.detectionEngine).toBe('UNMATCHED_TRANSACTION');
    expect(chase?.itemRefs).toEqual(['p8_txn_currys']);
    expect(chase?.recipientContactId).toBe('p8_contact');
    expect(chase?.firstSentAt).not.toBeNull();

    // The outbox: the chase_messages body and the sms_log body are the reviewed
    // body, verbatim — nothing rewrote the text on the way to "sent".
    const message = await owner.chaseMessage.findFirst({ where: { chaseId: chase?.id ?? '' } });
    expect(message?.body).toBe(body);
    expect(message?.providerMessageId).toMatch(/^demo-sms-/);
    expect(message?.sentAt).not.toBeNull();

    const smsLog = await owner.smsLog.findFirst({ where: { chaseId: chase?.id ?? '' } });
    expect(smsLog?.body).toBe(body);
    expect(smsLog?.toE164).toBe('+447700900001');

    // The portal link inside the SMS verifies — Stage 9 will do exactly this.
    const tokenInBody = body.split('Upload securely: ')[1] ?? '';
    expect(verifyPortalLink(tokenInBody, PORTAL_SECRET)).toEqual({ ok: true, chaseId: 'p8_link_chase' });
  });

  test('re-approving the executed proposal is refused and sends nothing — exactly-once holds', async () => {
    // A fresh service (fresh idempotency cache) re-approving an already-EXECUTED
    // proposal is refused by the engine's exactly-once guard (NT-PRP-005), so no
    // second chase and no second SMS ever appear — the guarantee that a client
    // is never double-chased.
    const svc = service();
    const chasesBefore = await owner.chase.count({ where: { businessId: BIZ } });
    const smsBefore = await owner.smsLog.count({ where: { businessId: BIZ } });
    const proposal = await owner.actionProposal.findFirst({ where: { businessId: BIZ, kind: 'chase.send' } });
    const review = { renderedSummaryHash: proposal?.renderedSummaryHash ?? '' };

    let code = 'no-throw';
    try {
      await svc.approve(STAFF, proposal?.id ?? '', review, 'p8-key-approve-again');
    } catch (e) {
      code = e instanceof AppException ? e.code : `unexpected:${String(e)}`;
    }
    expect(code).toBe('NT-PRP-005');
    expect(await owner.chase.count({ where: { businessId: BIZ } })).toBe(chasesBefore);
    expect(await owner.smsLog.count({ where: { businessId: BIZ } })).toBe(smsBefore);
  });
});
