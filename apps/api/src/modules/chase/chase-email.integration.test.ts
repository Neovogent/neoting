import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { ActionProposalsService } from '../approvals/action-proposals.service.js';
import { DemoEmailSender, InMemoryEmailRateLimiter, parseEmailAddress } from '../notifications/index.js';
import type { PublishGateway } from '../validation-dedupe/proposals/publish-batch.js';
import { buildExecutorRegistry } from '../validation-dedupe/proposals/registry.js';
import { detectUnmatchedChases } from './detection.js';
import { CHASE_EMAIL_SUBJECT, type ChaseEmailTransport, EmailChaseSender } from './email-chase-sender.js';
import { verifyPortalLink } from './portal-link.js';
import { composeChaseSms } from './sms-copy.js';

/**
 * The A13 acceptance, end to end through the REAL Review → Approve engine
 * against a real database as `nt_app`:
 *
 *   detection (engine (a), over-ask suppressed) composes the verbatim body → a
 *   `chase.send` proposal is created → review shows that body byte-for-byte →
 *   approve → the chase is SENT and **the email that left carries the reviewed
 *   bytes, unchanged**, addressed to the contact the chase names.
 *
 * ⚠ **Nothing here can reach a network.** The transport is `DemoEmailSender`,
 * handed to `EmailChaseSender` directly, so the lazy factory that would build
 * an SES client in production never runs and `SesEmailSender` is never
 * constructed. `EMAIL_SENDER` is not read at all.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

// A disjoint id namespace, and every row torn down by EXPLICIT id — never
// `startsWith`, which Prisma compiles to an unescaped LIKE and which has eaten
// another suite's fixtures (apps/api/CLAUDE.md, the file-serial note).
const P = 'a13_prac';
const BIZ = 'a13_biz';
const USER = 'a13_user';
const MEMBERSHIP = 'a13_mem';
const CONTACT = 'a13_contact';
const CONTACT_NO_EMAIL = 'a13_contact_nomail';
const ACCOUNT = 'a13_acct';
const TXN_CURRYS = 'a13_txn_currys';
const TXN_BIDFOOD = 'a13_txn_bidfood';
const TXN_SUPPRESSED = 'a13_txn_chg';
const PORTAL_SECRET = 'a13-portal-secret-0000000000000000';

let owner: PrismaClient;
let app: PrismaClient;
let email: DemoEmailSender;

const STAFF = ScopeContextSchema.parse({ actorId: USER, practiceId: P });

const STUB_PUBLISHING: PublishGateway = {
  ledger: { publishBill: async () => ({ ok: true, externalRef: 'STUB', attachmentSent: false }) },
  previewPublishBatch: () => ({ ok: true, preview: { itemCount: 0, grossPence: 0, vatPence: 0, currency: null } }),
};

// chase.send composition config — the SAME secret the assertions verify with,
// because the engine (not the caller) signs the reviewed link since the
// compose seam landed.
const TEST_CHASE_COMPOSE = { portalLinkSecret: PORTAL_SECRET, appOrigin: 'https://app.test' };

function transport(): ChaseEmailTransport {
  return { sender: email, limiter: new InMemoryEmailRateLimiter(), parseAddress: parseEmailAddress };
}

function service(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({
      // The ONE substitution this stage makes: the same seam, the email
      // transport behind it. The executor is byte-identical either way.
      smsSender: new EmailChaseSender(async () => transport()),
      publishing: STUB_PUBLISHING,
    }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    STUB_PUBLISHING,
    new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
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
  await owner.bankTransaction.deleteMany({ where: { id: { in: [TXN_CURRYS, TXN_BIDFOOD, TXN_SUPPRESSED] } } });
  await owner.bankAccount.deleteMany({ where: { id: ACCOUNT } });
  await owner.contact.deleteMany({ where: { id: { in: [CONTACT, CONTACT_NO_EMAIL] } } });
  await owner.membership.deleteMany({ where: { id: MEMBERSHIP } });
  await owner.user.deleteMany({ where: { id: USER } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: P } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;
  email = new DemoEmailSender();

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'A13' } });
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'Wright Cleaning' } });
  await owner.user.create({ data: { id: USER, email: 'a13@example.test' } });
  // ⚠ `isOwner` matters since stage A12: `chase.send` is a RELEASE (D44 — "a
  // text or email to someone else's client" is one of the two irreversible
  // outward acts), so the approve path refuses `NT-PRM-001` for a
  // `PRACTICE_ADMIN` who is not the firm's super admin. Without this flag every
  // approval below fails the gate rather than the executor, and the failure
  // reads as a chase bug rather than as the gate doing its job.
  await owner.membership.create({
    data: { id: MEMBERSHIP, userId: USER, practiceId: P, role: 'PRACTICE_ADMIN', isOwner: true },
  });
  await owner.contact.create({
    data: { id: CONTACT, businessId: BIZ, mobileE164: '+447700900101', email: 'sam@wrightcleaning.test', isPrimary: true },
  });
  await owner.contact.create({
    data: { id: CONTACT_NO_EMAIL, businessId: BIZ, mobileE164: '+447700900102', email: null },
  });
  await owner.bankAccount.create({ data: { id: ACCOUNT, businessId: BIZ, displayName: 'Current' } });
  for (const [id, amountPence, descriptionRaw, merchantName] of [
    [TXN_CURRYS, -129_900, 'CURRYS 1234 LONDON', 'Currys'],
    [TXN_BIDFOOD, -42_150, 'BIDFOOD UK', 'Bidfood'],
    // A bank-originated charge: no paperwork can exist, so nobody is ever asked.
    [TXN_SUPPRESSED, -1_250, 'CHG MONTHLY', null],
  ] as const) {
    await owner.bankTransaction.create({
      data: {
        id,
        businessId: BIZ,
        accountId: ACCOUNT,
        bookedAt: new Date('2026-08-09T12:00:00.000Z'),
        amountPence,
        descriptionRaw,
        merchantName,
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

describe.skipIf(!enabled)('chase by email, end to end through the engine', () => {
  test('create (engine composes) → review (verbatim body) → approve → the EMAIL carries the reviewed bytes', async () => {
    // The caller's draft body — DISCARDED by the compose seam, exactly as a
    // caller-sent publish preview is. What review shows and what sends is the
    // engine's own composition, whose portal link actually verifies.
    const callerDraft = 'a body the caller typed, with a dead link: /p/';

    const svc = service();
    const created = await svc.create(
      STAFF,
      {
        kind: 'chase.send',
        businessId: BIZ,
        payload: {
          messages: [
            { recipientE164: '+447700900101', recipientContactId: CONTACT, body: callerDraft, transactionIds: [TXN_CURRYS] },
          ],
        },
      },
      'a13-key-create',
    );

    // The stored payload is the ENGINE's composition: server body over the
    // chased transaction, the minted chase id, the contact's email for review.
    const composed = (created.payload as { messages: Record<string, unknown>[] }).messages[0] ?? {};
    expect(composed['body']).not.toBe(callerDraft);
    expect(typeof composed['chaseId']).toBe('string');
    expect(composed['recipientEmail']).toBe('sam@wrightcleaning.test');
    expect(composed['body']).toBe(
      composeChaseSms({
        businessName: 'Wright Cleaning',
        portalLink: `https://app.test/p/${String(composed['body']).split('/p/')[1] ?? ''}`,
        items: [
          {
            transactionId: TXN_CURRYS,
            amountPence: -129_900,
            bookedAt: new Date('2026-08-09T12:00:00.000Z'),
            supplierLabel: 'Currys',
          },
        ],
      }),
    );

    // Review renders the body byte-for-byte — the flagship guarantee, unchanged
    // by the transport underneath it — and names the ADDRESS the message goes
    // to (the A13 leftover, closed by the compose seam).
    const review = await svc.review(STAFF, created.id, 'a13-key-review');
    const summary = review.renderedSummary as unknown as {
      sections: { heading: string; entries: { label: string; value: string }[] }[];
    };
    expect(summary.sections[0]?.heading).toContain('sam@wrightcleaning.test');
    const shownBody = summary.sections[0]?.entries.find((e) => e.label.startsWith('Message,'))?.value;
    expect(shownBody).toBe(composed['body']);

    const executed = await svc.approve(
      STAFF,
      created.id,
      { renderedSummaryHash: review.renderedSummaryHash },
      'a13-key-approve',
    );
    expect(executed.state).toBe('EXECUTED');

    // ⚠ THE ASSERTION THIS STAGE EXISTS FOR: the bytes shown at review are the
    // bytes that left the building. Not "contains", not "matches after
    // normalisation" — identical, and identical to the stored audit row too.
    const [sent] = email.readOutbox();
    expect(sent?.body).toBe(shownBody);
    expect(sent?.to).toBe('sam@wrightcleaning.test');
    expect(sent?.kind).toBe('document-request');
    expect(sent?.subject).toBe(CHASE_EMAIL_SUBJECT);

    const chase = await owner.chase.findFirst({ where: { businessId: BIZ, actionProposalId: created.id } });
    expect(chase?.state).toBe('SENT');
    // The executor ADOPTED the composed chase id — the reviewed link names the
    // chase that now exists, which is the whole point of the compose seam.
    expect(chase?.id).toBe(composed['chaseId']);
    const message = await owner.chaseMessage.findFirst({ where: { chaseId: chase?.id ?? '' } });
    expect(message?.body).toBe(shownBody);
    expect(message?.channel).toBe('email');
    expect(message?.providerMessageId).toBe(sent?.providerMessageId);
    expect(message?.sentAt).not.toBeNull();

    // No sms_log row: an email send never invents a phone number for the SMS
    // outbox, so that screen keeps telling the truth about what it shows.
    expect(await owner.smsLog.count({ where: { businessId: BIZ } })).toBe(0);

    // The portal link the client received is the reviewed one, it VERIFIES,
    // and it names the chase the approval created.
    const url = (sent?.body ?? '').split('Upload securely: ')[1]?.trim() ?? '';
    expect(url.startsWith('https://app.test/p/')).toBe(true);
    const tokenInBody = url.slice('https://app.test/p/'.length);
    expect(verifyPortalLink(tokenInBody, PORTAL_SECRET)).toEqual({ ok: true, chaseId: chase?.id });
  });

  test('detection will not ask again for the line that chase already covers', async () => {
    // The over-ask gate, against the chase the previous test really created.
    // Bidfood is still outstanding; Currys is not, and the CHG line never was.
    const found = await scopedDb(app, STAFF, (db) => detectUnmatchedChases(db, BIZ));
    expect(found.map((f) => f.transactionId)).toEqual([TXN_BIDFOOD]);
  });

  test('a chase whose contact has no email refuses the approval, and no email leaves', async () => {
    const sentBefore = email.readOutbox().length;
    const chasesBefore = await owner.chase.count({ where: { businessId: BIZ } });

    const svc = service();
    const created = await svc.create(
      STAFF,
      {
        kind: 'chase.send',
        businessId: BIZ,
        payload: {
          messages: [
            {
              recipientE164: '+447700900102',
              recipientContactId: CONTACT_NO_EMAIL,
              body: 'Wright Cleaning Accounts: we’re missing the receipt for Bidfood £421.50 on 9 Aug. Upload securely: https://p.test/p/t',
              transactionIds: [TXN_BIDFOOD],
            },
          ],
        },
      },
      'a13-key-create-nomail',
    );
    const review = await svc.review(STAFF, created.id, 'a13-key-review-nomail');

    let code = 'no-throw';
    try {
      await svc.approve(STAFF, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'a13-key-approve-nomail');
    } catch (e) {
      code = e instanceof AppException ? e.code : `unexpected:${String(e)}`;
    }
    expect(code).toBe('NT-PRP-006');

    // The whole atom rolled back: no chase, no message row, and — the point —
    // no email. A client is never sent a request the workspace then forgets.
    expect(email.readOutbox()).toHaveLength(sentBefore);
    expect(await owner.chase.count({ where: { businessId: BIZ } })).toBe(chasesBefore);
    const proposal = await owner.actionProposal.findUnique({ where: { id: created.id } });
    expect(proposal?.executedAt).toBeNull();
  });
});
