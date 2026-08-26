import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import type { Env } from '../../config/env.js';
import { canonicalStringify as approvalsCanonicalStringify, sha256Hex as approvalsSha256Hex } from '../approvals/canonical-hash.js';
import { AuthService } from './auth.service.js';
import { PracticeSignupService, TERMS_VERSION_IN_FORCE, type PracticeSignupInput } from './practice-signup.service.js';
import { verifySessionCookieHeader } from './session-cookie.js';
import { loadScopeForUser } from './session-scope.js';
import { RecordingSignupMailer } from './signup-mailer.js';
import { TERMS_ACCEPTED_EVENT } from './signup-audit.js';

/**
 * Practice signup against the REAL database (launch stage A1).
 *
 * The unit suite proves the decisions; this proves the two claims only Postgres
 * can settle:
 *
 * 1. **The unscoped provisioning write actually works as `nt_app`** — the
 *    RLS-constrained application role, with no context set and no bypass of any
 *    kind. If `practices`, `users` or `memberships` ever gained a policy, this
 *    goes red rather than the endpoint quietly writing nothing in production.
 * 2. **What it wrote is a working tenant**: the new owner's membership resolves
 *    to a `ScopeContext`, and that context sees its own practice's data and none
 *    of a stranger's. A membership row that satisfies the schema but not the
 *    policies is exactly the "valid login with no visible workspace" failure
 *    this module's notes already record hitting once.
 *
 * Same doctrine as the rest of the suite: skipped when no database is
 * configured, RED when one is configured and unreachable. Namespace `a1sig_`,
 * disjoint from `s1a_` (session auth), `p122_` (approvals) and the others.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const SECRET = 'integration-signup-secret';
const env = { SESSION_SECRET: SECRET, OTP_MODE: 'demo', NODE_ENV: 'test' } as Env;

const EMAIL_DOMAIN = '@a1sig.test';
const PRACTICE_PREFIX = 'A1SIG ';
const P_OTHER = 'a1sig_prac_other';
const B_OTHER = 'a1sig_biz_other';

let owner: PrismaClient;
let app: PrismaClient;

function input(overrides: Partial<PracticeSignupInput> = {}): PracticeSignupInput {
  return {
    practiceName: `${PRACTICE_PREFIX}Ledgerline LLP`,
    firstName: 'Priya',
    lastName: 'Raman',
    email: `owner${EMAIL_DOMAIN}`,
    password: 'a-perfectly-good-passphrase',
    acceptedTermsVersion: TERMS_VERSION_IN_FORCE,
    ...overrides,
  };
}

let keys = 0;
function meta() {
  keys += 1;
  return { idempotencyKey: `a1sig000-0000-4000-8000-${String(keys).padStart(12, '0')}`, traceId: `a1sig-trace-${keys}` };
}

function signupService(mailer = new RecordingSignupMailer()): { service: PracticeSignupService; mailer: RecordingSignupMailer } {
  // ⚠ `app`, not `owner`. The point of this suite is that provisioning succeeds
  // as the RLS-constrained application role.
  return { service: new PracticeSignupService(app, env, mailer, new InMemoryIdempotencyStore()), mailer };
}

describe.skipIf(DATABASE_URL === undefined || OWNER_URL === undefined)('practice signup against the real database', () => {
  beforeAll(async () => {
    if (DATABASE_URL === undefined || OWNER_URL === undefined) return; // skipIf already skips; this narrows the types
    owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
    app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    await owner.$queryRaw`SELECT 1`; // configured-but-unreachable must go RED, not quietly green

    await cleanup();
    await owner.practice.create({ data: { id: P_OTHER, name: `${PRACTICE_PREFIX}Stranger LLP` } });
    await owner.business.create({ data: { id: B_OTHER, practiceId: P_OTHER, name: 'A1SIG Stranger Ltd' } });
  });

  afterAll(async () => {
    if (owner !== undefined) await cleanup();
    await owner?.$disconnect();
    await app?.$disconnect();
  });

  test('signup provisions practice + owner + membership as nt_app, with no scope context and no bypass', async () => {
    const { service } = signupService();
    await service.signUp(input(), meta());

    const user = await owner.user.findUnique({ where: { email: `owner${EMAIL_DOMAIN}` } });
    expect(user).not.toBeNull();
    expect(user!.emailVerified).toBe(false);
    expect(user!.passwordHash).not.toBeNull();
    expect(user!.kind).toBe('HUMAN');

    const membership = await owner.membership.findFirst({ where: { userId: user!.id } });
    expect(membership).not.toBeNull();
    expect(membership!.role).toBe('PRACTICE_ADMIN');
    // D44: the first user is the firm's super admin, the release authority.
    expect(membership!.isOwner).toBe(true);
    // Practice-WIDE — a business-scoped row would narrow the owner to one client.
    expect(membership!.businessId).toBeNull();
    expect(membership!.practiceId).not.toBeNull();

    const practice = await owner.practice.findUnique({ where: { id: membership!.practiceId! } });
    expect(practice!.name).toBe(`${PRACTICE_PREFIX}Ledgerline LLP`);
  });

  test('what it wrote is a WORKING tenant: the owner resolves a scope that sees its own practice and not a stranger', async () => {
    const user = await owner.user.findUniqueOrThrow({ where: { email: `owner${EMAIL_DOMAIN}` } });
    const membership = await owner.membership.findFirstOrThrow({ where: { userId: user.id } });
    // A client of their own, created after the fact — the thing the practice exists to hold.
    await owner.business.create({ data: { id: 'a1sig_biz_mine', practiceId: membership.practiceId!, name: 'A1SIG Cleaning Ltd' } });

    const context = await loadScopeForUser(app, user.id);
    expect(context).not.toBeNull();
    expect(context!.practiceId).toBe(membership.practiceId);

    // Every query AFTER provisioning is scoped. This is the one that proves the
    // membership row satisfies the policies, not merely the schema.
    const visible = await scopedDb(app, context!, async (db) => db.business.findMany({ select: { id: true } }));
    expect(visible.map((b) => b.id)).toEqual(['a1sig_biz_mine']);
    expect(visible.map((b) => b.id)).not.toContain(B_OTHER);
  });

  test('REFUSAL: the account is unusable until verified, and then it is usable', async () => {
    const auth = new AuthService(app, env);
    const credentials = { email: `owner${EMAIL_DOMAIN}`, password: 'a-perfectly-good-passphrase', totp: '000000' };

    await expect(auth.login(credentials)).rejects.toMatchObject({ code: 'NT-AUTH-003' });

    // Proving control of the address is the only thing that lifts it. (The
    // endpoint that does this needs a contract operation that does not exist
    // yet — see email-verification.ts. Here the database stands in for it.)
    const user = await owner.user.findUniqueOrThrow({ where: { email: `owner${EMAIL_DOMAIN}` } });
    await owner.user.update({ where: { id: user.id }, data: { emailVerified: true } });

    const session = await auth.login(credentials);
    expect(verifySessionCookieHeader(`nt_session=${session.token}`, SECRET)).toEqual({ ok: true, userId: user.id });
  });

  test('REFUSAL: a second signup on the same address writes nothing at all', async () => {
    const before = await owner.practice.count({ where: { name: { startsWith: PRACTICE_PREFIX } } });
    const { service, mailer } = signupService();

    // Resolves, silently — the caller must not learn the address is taken.
    await expect(service.signUp(input({ practiceName: `${PRACTICE_PREFIX}Impostor LLP` }), meta())).resolves.toBeUndefined();

    expect(await owner.practice.count({ where: { name: { startsWith: PRACTICE_PREFIX } } })).toBe(before);
    expect(await owner.practice.count({ where: { name: `${PRACTICE_PREFIX}Impostor LLP` } })).toBe(0);
    expect(await owner.user.count({ where: { email: { endsWith: EMAIL_DOMAIN } } })).toBe(1);
    expect(mailer.sentVerifications()).toEqual([]);
    expect(mailer.sentDuplicateNotices()).toHaveLength(1);
  });

  test('terms acceptance is one append-only audit row, and its hash chain agrees with approvals/', async () => {
    const user = await owner.user.findUniqueOrThrow({ where: { email: `owner${EMAIL_DOMAIN}` } });
    const membership = await owner.membership.findFirstOrThrow({ where: { userId: user.id } });

    const rows = await owner.auditEvent.findMany({ where: { event: TERMS_ACCEPTED_EVENT }, orderBy: { seq: 'asc' } });
    const mine = rows.filter((r) => (r.outcome as Record<string, unknown>)['practiceId'] === membership.practiceId);
    expect(mine).toHaveLength(1);
    const row = mine[0]!;

    expect(row.businessId).toBeNull();
    expect(row.proposalId).toBeNull();
    expect((row.outcome as Record<string, unknown>)['acceptedTermsVersion']).toBe(TERMS_VERSION_IN_FORCE);
    // The mailbox is not in the stream — audit_events can never be erased, and
    // `users.email` is the record that can.
    expect(JSON.stringify(row.outcome)).not.toContain(EMAIL_DOMAIN);

    // ⚠ THE DRIFT PIN. `signup-audit.ts` copies the chain formula from
    // `approvals/audit-writer.ts` because the two write into the SAME
    // `business_id IS NULL` chain and approvals has no public seam to import
    // (see that file's header). Recomputing here with APPROVALS' canonical
    // hash — an integration test may cross the module boundary; that exemption
    // is exactly what it is for — is what stops the copy drifting into a chain
    // nobody can verify. When approvals grows an index.ts, delete the copy and
    // this test keeps its meaning unchanged.
    const payloadHash = approvalsSha256Hex(
      approvalsCanonicalStringify({
        practiceId: membership.practiceId,
        userId: user.id,
        email: `owner${EMAIL_DOMAIN}`,
        acceptedTermsVersion: TERMS_VERSION_IN_FORCE,
      }),
    );
    expect(row.payloadHash).toBe(payloadHash);

    const recomputed = approvalsSha256Hex(
      (row.previousHash ?? '') +
        approvalsCanonicalStringify({
          businessId: null,
          seq: row.seq.toString(),
          event: TERMS_ACCEPTED_EVENT,
          proposalId: null,
          payloadHash,
          renderedSummaryHash: null,
          outcome: row.outcome,
        }),
    );
    expect(row.hash).toBe(recomputed);
  });

  test('the audit row is append-only in the DATABASE, not merely in the service', async () => {
    const rows = await owner.auditEvent.findMany({ where: { event: TERMS_ACCEPTED_EVENT }, take: 1 });
    expect(rows).toHaveLength(1);
    // The trigger fires for every role, including the schema owner.
    await expect(
      owner.$executeRawUnsafe(`UPDATE audit_events SET event = 'tampered' WHERE id = '${rows[0]!.id}'`),
    ).rejects.toThrow(/append-only/);
  });
});

async function cleanup(): Promise<void> {
  // audit_events is append-only BY TRIGGER, on purpose — the trigger fires for
  // every role, so test cleanup has to lift it for the one statement that
  // resets the fixture world (the pattern action-proposals.integration.test.ts
  // established). Test database only; the guarantee is re-proven on every run
  // by the last test above.
  const practices = await owner.practice.findMany({ where: { name: { startsWith: PRACTICE_PREFIX } }, select: { id: true } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  for (const practice of practices) {
    await owner.auditEvent.deleteMany({
      where: { event: TERMS_ACCEPTED_EVENT, outcome: { path: ['practiceId'], equals: practice.id } },
    });
  }
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');

  await owner.membership.deleteMany({ where: { user: { email: { endsWith: EMAIL_DOMAIN } } } });
  await owner.user.deleteMany({ where: { email: { endsWith: EMAIL_DOMAIN } } });
  await owner.business.deleteMany({ where: { id: { in: [B_OTHER, 'a1sig_biz_mine'] } } });
  await owner.practice.deleteMany({ where: { name: { startsWith: PRACTICE_PREFIX } } });
}
