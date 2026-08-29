import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { scopedDb } from '../../common/db/scoped-db.js';
import type { AppException } from '../../common/problem/problem.js';
import { signPortalLink } from '../chase/index.js';
import { PortalContextService } from './portal-context.service.js';
import { delegatedScopeFor, PortalSessionContextResolver, systemScopeFor } from './portal-session-context.js';
import { PortalSessionService } from './portal-session.service.js';

/**
 * The portal journey against a REAL database as `nt_app` (METH Stage 9
 * acceptance): a signed SMS link plus `000000` becomes a session, and that
 * session sees ITS chase's items and its client's name — and nothing else.
 *
 * Three things only a real database can answer, and they are why this file
 * exists:
 *
 * 1. **The chase read genuinely needs the practice SYSTEM context.** `chases`
 *    has no delegated RLS branch, so a delegated context sees nothing of it.
 *    Asserted here against the real policies rather than described in prose.
 * 2. **The delegated policies really do bound the documents.** A session granted
 *    one document id cannot read another document in its OWN business — the
 *    negative test the acceptance demands.
 * 3. **The chase boundary is the session row, not SQL.** The system context can
 *    see the whole practice, so the service's `where id = facts.chaseId` is what
 *    narrows it; a session pointed at another practice's chase gets nothing.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable — a tenancy suite that quietly reports
 * green is worse than none. Ids are disjointly prefixed `p9_` and torn down at
 * both ends, because the suite shares one local Postgres and runs file-serially.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const LINK_SECRET = 'p9-portal-link-secret';
const SESSION_SECRET = 'p9-portal-session-secret';

const P_A = 'p9_prac_a';
const P_B = 'p9_prac_b';
const BIZ_A = 'p9_biz_a';
const BIZ_B = 'p9_biz_b';
const CHASE_A = 'p9_chase_a';
const CHASE_B = 'p9_chase_b';
const DOC_GRANTED = 'p9_doc_granted';
const DOC_UNGRANTED = 'p9_doc_ungranted';

let owner: PrismaClient;
let app: PrismaClient;

const config = { portalLinkSecret: LINK_SECRET, portalSessionSecret: SESSION_SECRET, otpMode: 'demo' } as const;

/** The whole journey, exactly as the three endpoints run it: link + OTP → bearer → facts. */
async function openSession(chaseId = CHASE_A): Promise<Awaited<ReturnType<PortalSessionContextResolver['resolveForUpload']>>> {
  const issued = await new PortalSessionService(app, config).createSession({
    linkToken: signPortalLink({ chaseId }, LINK_SECRET),
    otp: '000000',
  });
  return new PortalSessionContextResolver(app, { portalSessionSecret: SESSION_SECRET }).resolveForUpload(`Bearer ${issued.token}`);
}

async function cleanup(): Promise<void> {
  await owner.otpSession.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.documentEvent.deleteMany({ where: { documentId: { in: [DOC_GRANTED, DOC_UNGRANTED] } } });
  await owner.document.deleteMany({ where: { id: { in: [DOC_GRANTED, DOC_UNGRANTED] } } });
  await owner.chase.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.bankTransaction.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.bankAccount.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p9_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p9_' } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ_A, BIZ_B] } } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'P9 A' }, { id: P_B, name: 'P9 B' }] });
  await owner.business.createMany({
    data: [
      { id: BIZ_A, practiceId: P_A, name: 'American Burger' },
      { id: BIZ_B, practiceId: P_B, name: "Someone Else's Client" },
    ],
  });
  // A SYSTEM actor per practice: the portal's chase reads run as one, and
  // `createSession` finds the chase's practice by sweeping them.
  await owner.user.createMany({
    data: [
      { id: 'p9_usr_sys_a', email: 'p9-system-a@example.test', kind: 'SYSTEM' },
      { id: 'p9_usr_sys_b', email: 'p9-system-b@example.test', kind: 'SYSTEM' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'p9_mem_a', userId: 'p9_usr_sys_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'p9_mem_b', userId: 'p9_usr_sys_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
    ],
  });

  // American Burger: two unmatched lines and the grouped chase over both — one
  // text, many receipts (SoT §8.2), which is what the portal list must show.
  await owner.bankAccount.create({ data: { id: 'p9_acct_a', businessId: BIZ_A, displayName: 'Current' } });
  await owner.bankTransaction.createMany({
    data: [
      {
        id: 'p9_txn_currys',
        businessId: BIZ_A,
        accountId: 'p9_acct_a',
        bookedAt: new Date('2026-08-09T12:00:00.000Z'),
        amountPence: -129_900,
        descriptionRaw: 'CURRYS 1234 LONDON',
        merchantName: 'Currys',
      },
      {
        id: 'p9_txn_google',
        businessId: BIZ_A,
        accountId: 'p9_acct_a',
        bookedAt: new Date('2026-08-05T09:00:00.000Z'),
        amountPence: -60_000,
        descriptionRaw: 'GOOGLE ADS',
        merchantName: 'Google',
      },
    ],
  });
  await owner.chase.create({
    data: {
      id: CHASE_A,
      businessId: BIZ_A,
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: 'p9_txn_currys',
      itemRefs: ['p9_txn_currys', 'p9_txn_google'],
      state: 'SENT',
    },
  });

  // Another practice's chase, which this session must never reach.
  await owner.bankAccount.create({ data: { id: 'p9_acct_b', businessId: BIZ_B, displayName: 'Current' } });
  await owner.bankTransaction.create({
    data: {
      id: 'p9_txn_b',
      businessId: BIZ_B,
      accountId: 'p9_acct_b',
      bookedAt: new Date('2026-08-07T09:00:00.000Z'),
      amountPence: -42_000,
      descriptionRaw: 'THEIRS',
    },
  });
  await owner.chase.create({
    data: { id: CHASE_B, businessId: BIZ_B, detectionEngine: 'UNMATCHED_TRANSACTION', transactionId: 'p9_txn_b', itemRefs: ['p9_txn_b'], state: 'SENT' },
  });

  // Two documents in the SAME business — one the session will be granted, one it
  // never is. The delegated policies must tell them apart.
  await owner.document.createMany({
    data: [DOC_GRANTED, DOC_UNGRANTED].map((id) => ({
      id,
      businessId: BIZ_A,
      practiceId: P_A,
      s3Key: `w/${BIZ_A}/documents/${id}`,
      originalFilename: `${id}.jpg`,
      mimeType: 'image/jpeg',
      byteSize: 1024,
      byteHash: id,
      channel: 'SMS_PORTAL' as const,
      inbox: 'COSTS' as const,
    })),
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('the OTP portal against real RLS', () => {
  test('an SMS link plus 000000 opens a session that sees ITS chase: the client\'s name and both chased items', async () => {
    const facts = await openSession();
    expect(facts.chaseId).toBe(CHASE_A);
    expect(facts.businessId).toBe(BIZ_A);
    // Nothing is granted until the first upload — the session may see the chase,
    // not any document.
    expect(facts.grantedItemIds).toEqual([]);

    const context = await new PortalContextService(app).getContext(facts);
    expect(context.businessName).toBe('American Burger');
    expect(context.items.map((item) => item.transactionId)).toEqual(['p9_txn_currys', 'p9_txn_google']);
    expect(context.items.map((item) => item.amountPence)).toEqual([-129_900, -60_000]); // signed integer pence, untouched
    expect(context.items.map((item) => item.merchantName)).toEqual(['Currys', 'Google']);
    expect(context.items.every((item) => item.received)).toBe(false);
    expect(context.expiresAt).toBe(facts.expiresAt.toISOString());

    // And the session was recorded as the delegated grant it is (SoT Stage 8.3:
    // requested-from is kept apart from uploaded-by).
    const row = await owner.otpSession.findUnique({ where: { id: facts.otpSessionId } });
    expect(row?.scope).toBe('DELEGATED_UPLOAD');
    expect(row?.chaseId).toBe(CHASE_A);
    expect(row?.contactId).toBeNull();
  });

  test('the chase is INVISIBLE under the delegated context — which is why the read runs under the practice SYSTEM one', async () => {
    const facts = await openSession();
    // Give the session a grant so a delegated context can exist at all
    // (`ScopeContextSchema` refuses an empty one), then look for the chase with it.
    const delegated = delegatedScopeFor(facts, [DOC_GRANTED]);
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) return;

    const underDelegated = await scopedDb(app, delegated.context, (db) => db.chase.findUnique({ where: { id: CHASE_A } }));
    expect(underDelegated).toBeNull(); // `chases` has no delegated policy branch

    const underSystem = await scopedDb(app, systemScopeFor(facts), (db) => db.chase.findUnique({ where: { id: CHASE_A } }));
    expect(underSystem?.id).toBe(CHASE_A);
  });

  test('a portal session CANNOT read a document it was not granted — the document boundary is SQL, not the handler', async () => {
    const facts = await openSession();
    const delegated = delegatedScopeFor(facts, [DOC_GRANTED]);
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) return;

    const [granted, ungranted] = await scopedDb(app, delegated.context, async (db) => [
      await db.document.findUnique({ where: { id: DOC_GRANTED } }),
      // Same business, same practice, one id away — and `documents_delegated_upload`
      // keys on `id = ANY(app_granted_item_ids())`, so it is not there.
      await db.document.findUnique({ where: { id: DOC_UNGRANTED } }),
    ]);
    expect(granted?.id).toBe(DOC_GRANTED);
    expect(ungranted).toBeNull();

    // A list is the same answer: exactly the grant, never the business.
    const all = await scopedDb(app, delegated.context, (db) => db.document.findMany({ where: { businessId: BIZ_A } }));
    expect(all.map((doc) => doc.id)).toEqual([DOC_GRANTED]);
  });

  test('the chase boundary is the SESSION ROW: facts pointed at another practice\'s chase see nothing', async () => {
    const facts = await openSession();
    // The system context can see the whole of practice A, so if the service did
    // not constrain to `facts.chaseId` this is where the leak would appear.
    // Practice B's chase is outside it anyway, and B's business is not this
    // session's — both refusals land as the same 401.
    let error: AppException | undefined;
    try {
      await new PortalContextService(app).getContext({ ...facts, chaseId: CHASE_B });
    } catch (thrown) {
      error = thrown as AppException;
    }
    expect(error?.code).toBe('NT-OTP-002');
    expect(error?.getStatus()).toBe(401);
  });

  test('re-tapping the same link re-verifies the SAME otp_sessions row — link_token_hash is unique, and the grant survives', async () => {
    const service = new PortalSessionService(app, config);
    const linkToken = signPortalLink({ chaseId: CHASE_A }, LINK_SECRET);
    const first = await service.createSession({ linkToken, otp: '000000' });
    const resolver = new PortalSessionContextResolver(app, { portalSessionSecret: SESSION_SECRET });
    const facts = await resolver.resolveForUpload(`Bearer ${first.token}`);
    await service.grantItems(facts, [DOC_GRANTED]);

    const second = await service.createSession({ linkToken, otp: '000000' });
    const again = await resolver.resolveForUpload(`Bearer ${second.token}`);
    expect(again.otpSessionId).toBe(facts.otpSessionId);
    // A document already uploaded in this session stays readable to it.
    expect(again.grantedItemIds).toEqual([DOC_GRANTED]);
  });
});
