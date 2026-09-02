import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema, systemContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { ActionProposalsService } from '../approvals/action-proposals.service.js';
import { PortalContextService } from '../portal/portal-context.service.js';
import type { PortalSessionFacts } from '../portal/portal-session-context.js';
import type { PublishGateway } from '../validation-dedupe/proposals/publish-batch.js';
import { buildExecutorRegistry } from '../validation-dedupe/proposals/registry.js';
import { verifyPortalLink } from './portal-link.js';
import { DemoSmsSender } from './sms-sender.js';
import { closeStatementRequestChases, statementPeriodOf } from './statement-request.js';

/**
 * The statement-request chase (engine (c), Phase 5), end to end against real
 * Postgres through the REAL engine:
 *
 *   create (the engine composes the month + a working link, resolves the
 *   PRIMARY contact) → approve → the chase is SENT under STATEMENT_PERIOD_GAP
 *   with its month tagged on itemRefs → the portal context serves the request
 *   with `received: false` → a statement covering the month arrives → the
 *   close flips the chase to CLOSED_RECEIVED and the portal reads
 *   `received: true` — the same predicate on both sides.
 *
 * Namespace `p5sr_`, torn down by explicit id list.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'p5sr_prac';
const BIZ = 'p5sr_biz';
const OWNER_USER = 'p5sr_owner';
const OWNER_MEMBERSHIP = 'p5sr_mem_owner';
const SYSTEM_USER = 'p5sr_sys';
const SYSTEM_MEMBERSHIP = 'p5sr_mem_sys';
const CONTACT = 'p5sr_contact';
const DOC = 'p5sr_stmt_doc';
const PORTAL_SECRET = 'p5sr-portal-secret-000000000000000';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF = ScopeContextSchema.parse({ actorId: OWNER_USER, practiceId: P });

const STUB_PUBLISHING: PublishGateway = {
  ledger: { publishBill: async () => ({ ok: true, externalRef: 'STUB', attachmentSent: false }) },
  previewPublishBatch: () => ({ ok: true, preview: { itemCount: 0, grossPence: 0, vatPence: 0, currency: null } }),
};

function service(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ smsSender: new DemoSmsSender(), publishing: STUB_PUBLISHING }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    STUB_PUBLISHING,
    new InMemoryIdempotencyStore(),
    { portalLinkSecret: PORTAL_SECRET, appOrigin: 'https://app.test' },
  );
}

function factsFor(chaseId: string | null): PortalSessionFacts {
  return {
    otpSessionId: 'p5sr_session',
    businessId: BIZ,
    practiceId: P,
    systemUserId: SYSTEM_USER,
    actorId: SYSTEM_USER,
    // A chase session names no person on purpose — the link is forwardable.
    contactId: null,
    chaseId,
    grantedItemIds: [],
    expiresAt: new Date(Date.now() + 60_000),
  };
}

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { businessId: BIZ } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: P }, { businessId: BIZ }] } });
  await owner.notification.deleteMany({ where: { businessId: BIZ } });
  await owner.smsLog.deleteMany({ where: { businessId: BIZ } });
  await owner.chaseMessage.deleteMany({ where: { chase: { businessId: BIZ } } });
  await owner.chase.deleteMany({ where: { businessId: BIZ } });
  await owner.statement.deleteMany({ where: { businessId: BIZ } });
  await owner.bankAccount.deleteMany({ where: { businessId: BIZ } });
  await owner.document.deleteMany({ where: { id: DOC } });
  await owner.contact.deleteMany({ where: { id: CONTACT } });
  await owner.membership.deleteMany({ where: { id: { in: [OWNER_MEMBERSHIP, SYSTEM_MEMBERSHIP] } } });
  await owner.user.deleteMany({ where: { id: { in: [OWNER_USER, SYSTEM_USER] } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: P } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'P5SR' } });
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'Statement Ltd' } });
  await owner.user.create({ data: { id: OWNER_USER, email: 'p5sr@example.test' } });
  await owner.user.create({ data: { id: SYSTEM_USER, kind: 'SYSTEM' } });
  // chase.send is a RELEASE (D44): the approver must be the firm's super admin.
  await owner.membership.create({
    data: { id: OWNER_MEMBERSHIP, userId: OWNER_USER, practiceId: P, role: 'PRACTICE_ADMIN', isOwner: true },
  });
  await owner.membership.create({
    data: { id: SYSTEM_MEMBERSHIP, userId: SYSTEM_USER, practiceId: P, role: 'PRACTICE_STANDARD' },
  });
  // The PRIMARY contact the compose seam resolves when the caller names none.
  await owner.contact.create({
    data: { id: CONTACT, businessId: BIZ, mobileE164: '+447700900301', email: 'books@statement.test', isPrimary: true },
  });
  await owner.document.create({
    data: {
      id: DOC,
      practiceId: P,
      businessId: BIZ,
      inbox: 'COSTS',
      state: 'READY',
      channel: 'EMAIL',
      docType: 'STATEMENT',
      s3Key: 'w/p5sr/stmt',
      byteHash: 'p5sr-hash',
      byteSize: 10,
      mimeType: 'text/csv',
      originalFilename: 'july.csv',
      submitterLabel: 'test',
    },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('the statement-request chase, end to end', () => {
  test('create composes the month + link + PRIMARY contact → approve → engine (c) chase → portal serves it → a statement closes it', async () => {
    const svc = service();
    const created = await svc.create(
      STAFF,
      {
        kind: 'chase.send',
        businessId: BIZ,
        payload: { messages: [{ statementPeriod: '2026-07', body: 'caller draft — discarded' }] },
      },
      'p5sr-key-create',
    );

    const composed = (created.payload as { messages: Record<string, unknown>[] }).messages[0] ?? {};
    const body = String(composed['body']);
    expect(body).toContain("we're missing your bank statement for July 2026");
    expect(body).toContain('https://app.test/p/');
    // The recipient came from the PRIMARY contact — never typed (D45).
    expect(composed['recipientContactId']).toBe(CONTACT);
    expect(composed['recipientEmail']).toBe('books@statement.test');
    expect(composed['recipientE164']).toBe('+447700900301');
    expect(composed['businessId']).toBe(BIZ);

    const review = await svc.review(STAFF, created.id, 'p5sr-key-review');
    await svc.approve(STAFF, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p5sr-key-approve');

    const chase = await owner.chase.findFirst({ where: { businessId: BIZ, actionProposalId: created.id } });
    expect(chase?.state).toBe('SENT');
    expect(chase?.id).toBe(composed['chaseId']);
    expect(chase?.detectionEngine).toBe('STATEMENT_PERIOD_GAP');
    expect(statementPeriodOf((chase?.itemRefs as string[]) ?? [])).toBe('2026-07');

    // The reviewed link names the chase the approval created.
    const token = body.split('/p/')[1] ?? '';
    expect(verifyPortalLink(token, PORTAL_SECRET)).toEqual({ ok: true, chaseId: chase?.id });

    // The portal context — chase session — serves the request, not yet received.
    const portal = new PortalContextService(app);
    const before = await portal.getContext(factsFor(chase?.id ?? ''));
    expect(before.items).toEqual([]);
    expect(before.statementRequests).toEqual([{ period: '2026-07', received: false }]);

    // The own-portal session lists the same ask.
    const own = await portal.getContext(factsFor(null));
    expect(own.statementRequests).toEqual([{ period: '2026-07', received: false }]);
    expect(own.summary?.awaitingYou).toBe(1);

    // A July statement arrives: the close runs inside the ingest transaction —
    // simulated here by the row plus the close under the SAME system scope.
    const account = await owner.bankAccount.create({ data: { businessId: BIZ, displayName: 'Current' } });
    await owner.statement.create({
      data: {
        businessId: BIZ,
        accountId: account.id,
        documentId: DOC,
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        periodEnd: new Date('2026-07-31T00:00:00.000Z'),
        rowCount: 12,
      },
    });
    const closed = await scopedDb(app, systemContext(P, SYSTEM_USER), (db) =>
      closeStatementRequestChases(db, {
        businessId: BIZ,
        documentId: DOC,
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        periodEnd: new Date('2026-07-31T00:00:00.000Z'),
      }),
    );
    expect(closed).toEqual([chase?.id]);

    const after = await owner.chase.findUnique({ where: { id: chase?.id ?? '' } });
    expect(after?.state).toBe('CLOSED_RECEIVED');
    expect(after?.closedReason).toBe('matched-inbound-statement');
    expect(after?.closedByDocumentId).toBe(DOC);
    const event = await owner.chaseMessage.findFirst({ where: { chaseId: chase?.id ?? '', channel: 'event' } });
    expect(event?.body).toContain('2026-07');
    expect(await owner.notification.count({ where: { businessId: BIZ, event: 'chase.closed' } })).toBe(1);

    // The portal now reads received — the SAME predicate the close ran.
    const settled = await portal.getContext(factsFor(chase?.id ?? ''));
    expect(settled.statementRequests).toEqual([{ period: '2026-07', received: true }]);

    // Idempotent: a second close finds nothing open and writes nothing new.
    const again = await scopedDb(app, systemContext(P, SYSTEM_USER), (db) =>
      closeStatementRequestChases(db, {
        businessId: BIZ,
        documentId: DOC,
        periodStart: new Date('2026-07-01T00:00:00.000Z'),
        periodEnd: new Date('2026-07-31T00:00:00.000Z'),
      }),
    );
    expect(again).toEqual([]);
    expect(await owner.notification.count({ where: { businessId: BIZ, event: 'chase.closed' } })).toBe(1);
  });

  test('a message with both transactions and a period refuses at creation — exactly one ask per message', async () => {
    const svc = service();
    await expect(
      svc.create(
        STAFF,
        {
          kind: 'chase.send',
          businessId: BIZ,
          payload: { messages: [{ statementPeriod: '2026-07', transactionIds: ['p5sr_txn_x'], body: 'x' }] },
        },
        'p5sr-key-both',
      ),
    ).rejects.toMatchObject({ code: 'NT-PRP-006' });
  });

  test('an August statement does not close a July request — coverage is the month asked for', async () => {
    const svc = service();
    const created = await svc.create(
      STAFF,
      {
        kind: 'chase.send',
        businessId: BIZ,
        payload: { messages: [{ statementPeriod: '2026-06', body: 'x' }] },
      },
      'p5sr-key-june',
    );
    const review = await svc.review(STAFF, created.id, 'p5sr-key-june-review');
    await svc.approve(STAFF, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p5sr-key-june-approve');

    const closed = await scopedDb(app, systemContext(P, SYSTEM_USER), (db) =>
      closeStatementRequestChases(db, {
        businessId: BIZ,
        documentId: DOC,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-31T00:00:00.000Z'),
      }),
    );
    expect(closed).toEqual([]);
    const chase = await owner.chase.findFirst({ where: { businessId: BIZ, actionProposalId: created.id } });
    expect(chase?.state).toBe('SENT');
  });
});
