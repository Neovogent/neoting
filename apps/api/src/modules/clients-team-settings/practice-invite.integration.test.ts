import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { invitePracticeMemberBody } from '@neoting/contracts/zod';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { ActionProposalsService } from '../approvals/action-proposals.service.js';
import { InvitationAcceptanceService } from '../auth-tenancy/invitation-acceptance.service.js';
import { loadScopeForUser } from '../auth-tenancy/session-scope.js';
import { InMemorySignInThrottle } from '../auth-tenancy/sign-in-throttle.js';
import type { NotificationsService, SendOutcome, SendTeamInviteInput } from '../notifications/index.js';
import { previewPublishBatch } from '../publishing/index.js';
import { buildExecutorRegistry, type PublishGateway } from '../validation-dedupe/index.js';
import { PracticeTeamService } from './practice-team.service.js';

/**
 * **Practice team-member onboarding, against a real database.**
 *
 * The three assertions this feature actually rests on, and none of them can be
 * made against a mock:
 *
 * 1. **A scoped colleague cannot see a client they were not assigned.** That is
 *    a claim about Postgres row-level security, not about a filter in a service,
 *    and the whole per-client access story is worth nothing if it is only true
 *    in TypeScript.
 * 2. **An invited colleague cannot release.** `mayRelease` is `canRelease(role)
 *    && isOwner`, and acceptance writes `isOwner: false` — so the executor must
 *    not run, proven by the absence of its effects.
 * 3. **A non-admin cannot invite.** 403, and no `invites` row.
 *
 * The journey is walked through the REAL services end to end — invite, then
 * accept — rather than by inserting memberships by hand, because the shape of
 * the rows acceptance writes IS the thing under test. A hand-written fixture
 * would be this test agreeing with itself.
 *
 * ⚠ Ids are prefixed **`pti-`** and every table is torn down by EXPLICIT id
 * list, never `startsWith` — Prisma compiles `startsWith` to an unescaped
 * `LIKE 'pti_%'`, whose `_` is a single-character wildcard that would reach into
 * a neighbouring suite's fixtures (the hazard `vitest.config.ts` documents).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const PRACTICE = 'pti-prac';
const BIZ_ASSIGNED = 'pti-biz-assigned';
const BIZ_WITHHELD = 'pti-biz-withheld';
const DOC = 'pti-doc';

const USER_OWNER = 'pti-user-owner';
const USER_STAFF = 'pti-user-staff';
const USER_SYSTEM = 'pti-user-system';

const SEEDED_USERS = [USER_OWNER, USER_STAFF, USER_SYSTEM];
const SEEDED_MEMBERSHIPS = ['pti-mem-owner', 'pti-mem-staff', 'pti-mem-system'];

const INVITED_SCOPED = 'pti-invited-scoped@example.test';
const INVITED_WIDE = 'pti-invited-wide@example.test';
const INVITED_EMAILS = [INVITED_SCOPED, INVITED_WIDE, 'pti-refused@example.test'];

const OWNER_CTX = ScopeContextSchema.parse({ actorId: USER_OWNER, practiceId: PRACTICE });
const STAFF_CTX = ScopeContextSchema.parse({ actorId: USER_STAFF, practiceId: PRACTICE });

let owner: PrismaClient;
let app: PrismaClient;

/** Every invitation this suite sends, with the plaintext token the email carried. */
const outbox: (SendTeamInviteInput & { token: string })[] = [];

const notifications = {
  sendTeamInvite: async (input: SendTeamInviteInput): Promise<SendOutcome> => {
    outbox.push({ ...input, token: new URL(input.inviteLink).searchParams.get('token') ?? '' });
    return { sent: true, kind: 'team-invite', providerMessageId: `msg-${outbox.length}` };
  },
} as unknown as NotificationsService;

function teamService(): PracticeTeamService {
  return new PracticeTeamService(app, notifications, new InMemoryIdempotencyStore(), {
    appOrigin: 'https://app.example.test',
  });
}

function acceptanceService(): InvitationAcceptanceService {
  return new InvitationAcceptanceService(app, new InMemorySignInThrottle());
}

/** D42: releasing for export reaches no ledger. The adapter is a tripwire. */
const PUBLISHING: PublishGateway = {
  ledger: {
    publishBill: async () => {
      throw new Error('D42: releasing a document for export must never reach a ledger');
    },
  },
  previewPublishBatch,
};

function proposals(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ publishing: PUBLISHING }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    PUBLISHING,
    new InMemoryIdempotencyStore(),
    { portalLinkSecret: 'test-portal-link-secret', appOrigin: 'https://app.example.test' },
  );
}

const problem = async (p: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> => {
  try {
    await p;
    return { code: 'no-throw', status: 0 };
  } catch (e) {
    if (!(e instanceof AppException)) return { code: `unexpected:${String(e)}`, status: 0 };
    return { code: e.code, status: e.getStatus(), ...(e.publicDetail === undefined ? {} : { detail: e.publicDetail }) };
  }
};

async function cleanup(): Promise<void> {
  const accepted = await owner.user.findMany({ where: { email: { in: INVITED_EMAILS } }, select: { id: true } });
  const userIds = [...SEEDED_USERS, ...accepted.map((u) => u.id)];

  // audit_events is append-only BY TRIGGER; the fixture reset is the one
  // statement allowed to lift it, on a test database only.
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { businessId: { in: [BIZ_ASSIGNED, BIZ_WITHHELD] } } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');

  await owner.publish.deleteMany({ where: { businessId: { in: [BIZ_ASSIGNED, BIZ_WITHHELD] } } });
  await owner.actionProposal.deleteMany({ where: { practiceId: PRACTICE } });
  await owner.documentEvent.deleteMany({ where: { documentId: DOC } });
  await owner.document.deleteMany({ where: { id: DOC } });
  await owner.invite.deleteMany({ where: { practiceId: PRACTICE } });
  await owner.membership.deleteMany({ where: { OR: [{ id: { in: SEEDED_MEMBERSHIPS } }, { userId: { in: userIds } }] } });
  await owner.user.deleteMany({ where: { id: { in: userIds } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ_ASSIGNED, BIZ_WITHHELD] } } });
  await owner.practice.deleteMany({ where: { id: PRACTICE } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: PRACTICE, name: 'PTI Practice' } });
  await owner.business.createMany({
    data: [
      { id: BIZ_ASSIGNED, practiceId: PRACTICE, name: 'PTI Assigned Client' },
      { id: BIZ_WITHHELD, practiceId: PRACTICE, name: 'PTI Withheld Client' },
    ],
  });
  await owner.user.createMany({
    data: [
      { id: USER_OWNER, email: 'pti-owner@example.test' },
      { id: USER_STAFF, email: 'pti-staff@example.test' },
      // The practice's machine actor. Without it the sanctioned sweep has
      // nothing to search under and every acceptance refuses — which is the
      // `no-practice-actor` case, and exactly what an unprovisioned tenant
      // looks like from outside.
      { id: USER_SYSTEM, kind: 'SYSTEM', firstName: 'Neoting', lastName: 'automation' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'pti-mem-owner', userId: USER_OWNER, practiceId: PRACTICE, role: 'PRACTICE_ADMIN', isOwner: true },
      { id: 'pti-mem-staff', userId: USER_STAFF, practiceId: PRACTICE, role: 'PRACTICE_STANDARD' },
      { id: 'pti-mem-system', userId: USER_SYSTEM, practiceId: PRACTICE, role: 'PRACTICE_STANDARD' },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

/** Invite, read the token out of the email, accept. The whole journey, for real. */
async function onboard(request: Record<string, unknown>, key: string): Promise<string> {
  const body = invitePracticeMemberBody.parse(request);
  await teamService().invitePracticeMember(OWNER_CTX, body, key);
  const token = outbox.at(-1)?.token ?? '';
  expect(token).not.toBe('');

  const accepted = await acceptanceService().accept({
    token,
    password: 'a-long-enough-passphrase',
    firstName: 'Sam',
    lastName: 'Patel',
  });
  expect(accepted).toEqual({ email: String(request['email']).toLowerCase() });

  const user = await owner.user.findUnique({ where: { email: accepted.email }, select: { id: true } });
  expect(user).not.toBeNull();
  return user?.id ?? '';
}

describe.skipIf(!enabled)('practice team-member onboarding, against a real database', () => {
  test('⚠ ASSERTION 1 — a scoped colleague sees the client they were assigned and NOT the one they were not', async () => {
    const userId = await onboard(
      { email: INVITED_SCOPED, role: 'PRACTICE_STANDARD', businessIds: [BIZ_ASSIGNED] },
      'pti-key-scoped',
    );

    // The rows acceptance actually wrote. `practiceId` MUST be null: with one
    // set, `app_can_access_business`'s practice branch grants every client of
    // the firm and the assertion below would pass for the wrong reason.
    const rows = await owner.membership.findMany({ where: { userId }, select: { practiceId: true, businessId: true, isOwner: true } });
    expect(rows).toEqual([{ practiceId: null, businessId: BIZ_ASSIGNED, isOwner: false }]);

    // The context a real sign-in would produce, not one written by hand.
    const ctx = await loadScopeForUser(app, userId);
    expect(ctx).not.toBeNull();

    // POSTGRES answers this, not a filter in a service.
    const visible = await scopedDb(app, ctx!, (db) => db.business.findMany({ select: { id: true } }));
    const ids = visible.map((b) => b.id);
    expect(ids).toContain(BIZ_ASSIGNED);
    expect(ids).not.toContain(BIZ_WITHHELD);

    // …and asking for the withheld client BY ID is invisible, not merely absent
    // from a list.
    const direct = await scopedDb(app, ctx!, (db) => db.business.findUnique({ where: { id: BIZ_WITHHELD } }));
    expect(direct).toBeNull();
  });

  test('an unscoped colleague joins practice-wide and sees every client — the same code path, the other branch', async () => {
    const userId = await onboard({ email: INVITED_WIDE, role: 'CLIENT_ADMIN' }, 'pti-key-wide');

    const rows = await owner.membership.findMany({ where: { userId }, select: { practiceId: true, businessId: true, role: true } });
    expect(rows).toEqual([{ practiceId: PRACTICE, businessId: null, role: 'CLIENT_ADMIN' }]);

    const ctx = await loadScopeForUser(app, userId);
    const visible = await scopedDb(app, ctx!, (db) => db.business.findMany({ select: { id: true } }));
    expect(visible.map((b) => b.id).sort()).toEqual([BIZ_ASSIGNED, BIZ_WITHHELD].sort());
  });

  test('⚠ ASSERTION 2 — an invited colleague approving a publish.batch is refused, and the executor never runs', async () => {
    const userId = await onboard(
      { email: 'pti-releaser@example.test', role: 'CLIENT_ADMIN' },
      'pti-key-releaser',
    );
    INVITED_EMAILS.push('pti-releaser@example.test');
    const invitedCtx = (await loadScopeForUser(app, userId))!;

    await owner.document.create({
      data: {
        id: DOC,
        practiceId: PRACTICE,
        businessId: BIZ_ASSIGNED,
        s3Key: `w/${BIZ_ASSIGNED}/documents/${DOC}`,
        byteHash: `h-${DOC}`,
        mimeType: 'image/jpeg',
        byteSize: 4096,
        channel: 'WEB_UPLOAD',
        originalFilename: `${DOC}.jpg`,
        inbox: 'COSTS',
        state: 'READY',
        docType: 'INVOICE',
        currency: 'GBP',
        documentDate: new Date('2026-08-01T00:00:00.000Z'),
        supplierName: 'Bidfood Ltd',
        categoryCode: 'COST_OF_SALES',
        totalPence: 97_620,
        taxPence: 16_270,
      },
    });
    await owner.integration.create({
      data: { businessId: BIZ_ASSIGNED, kind: 'VT', isActive: true },
    });

    const svc = proposals();
    // Composing and reviewing are theirs — D44's first half is not gated.
    const created = await svc.create(
      invitedCtx,
      { kind: 'publish.batch', businessId: BIZ_ASSIGNED, payload: { documentIds: [DOC] } },
      'pti-key-create',
    );
    const review = await svc.review(invitedCtx, created.id, 'pti-key-review');

    const refused = await problem(
      svc.approve(invitedCtx, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'pti-key-approve'),
    );
    expect(refused.code).toBe('NT-PRM-001');
    expect(refused.status).toBe(403);
    expect(refused.detail).toContain('super admin');

    // NO EFFECT AT ALL. Every surface the executor would have touched:
    expect((await owner.document.findUnique({ where: { id: DOC } }))?.state).toBe('READY');
    expect(await owner.publish.count({ where: { documentId: DOC } })).toBe(0);
    expect(await owner.auditEvent.count({ where: { proposalId: created.id } })).toBe(0);
    // …and the proposal is not consumed, so the person who MAY release still can.
    const row = await owner.actionProposal.findUnique({ where: { id: created.id } });
    expect(row?.state).toBe('REVIEWED');
    expect(row?.executedAt).toBeNull();

    // The owner approves the very same proposal and it releases.
    const executed = await svc.approve(OWNER_CTX, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'pti-key-owner');
    expect(executed.state).toBe('EXECUTED');
    expect((await owner.document.findUnique({ where: { id: DOC } }))?.state).toBe('PUBLISHED');
  });

  test('⚠ ASSERTION 3 — a non-admin calling POST /practice-members is refused 403, and no invites row is written', async () => {
    const before = await owner.invite.count({ where: { practiceId: PRACTICE } });
    const sentBefore = outbox.length;

    const body = invitePracticeMemberBody.parse({ email: 'pti-refused@example.test', role: 'PRACTICE_STANDARD' });
    const refused = await problem(teamService().invitePracticeMember(STAFF_CTX, body, 'pti-key-refused'));

    expect(refused.code).toBe('NT-PRM-001');
    expect(refused.status).toBe(403);
    expect(refused.detail).toContain('practice admin');

    // The absence is the assertion: nothing written, nothing sent.
    expect(await owner.invite.count({ where: { practiceId: PRACTICE } })).toBe(before);
    expect(await owner.invite.count({ where: { email: 'pti-refused@example.test' } })).toBe(0);
    expect(outbox.length).toBe(sentBefore);
  });

  test('the team list is scoped by the SESSION, and another practice sees none of it', async () => {
    const page = await teamService().listPracticeMembers(OWNER_CTX, { limit: 50 });
    const emails = page.data.map((member) => member.email);
    expect(emails).toContain('pti-owner@example.test');
    expect(emails).toContain(INVITED_WIDE);
    // The scoped colleague is a member of the FIRM even though every membership
    // they hold names a business — the second branch of `firmMembership`.
    expect(emails).toContain(INVITED_SCOPED);
    // ⚠ The SYSTEM actor is never listed. It is a real user row with a real
    // membership; showing it invites someone to try to invite or deactivate it.
    expect(emails).not.toContain(null);
    expect(page.data.some((member) => member.userId === USER_SYSTEM)).toBe(false);

    // The owner is the only person with the flag, and acceptance never sets it.
    expect(page.data.filter((member) => member.isOwner)).toHaveLength(1);
    // The scoped colleague reports the client they were assigned; a practice-wide
    // member reports an empty list, which means ALL and not NONE.
    expect(page.data.find((m) => m.email === INVITED_SCOPED)?.businessIds).toEqual([BIZ_ASSIGNED]);
    expect(page.data.find((m) => m.email === INVITED_WIDE)?.businessIds).toEqual([]);
  });
});
