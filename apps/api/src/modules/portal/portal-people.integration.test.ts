import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { DemoEmailSender, InMemoryEmailRateLimiter, NotificationsService } from '../notifications/index.js';
import { PortalOnboardingService } from './portal-onboarding.service.js';
import { PortalPeopleService } from './portal-people.service.js';
import { PortalSessionContextResolver } from './portal-session-context.js';
import { signPortalSessionToken } from './portal-session-token.js';

/**
 * **A client business managing its own people, against a REAL database as
 * `nt_app`** (D45, D49, the product owner's ruling of 2 Sep 2026).
 *
 * Six questions, each of which only Postgres can answer, and each a DIFFERENT
 * kind of boundary — which is the reason this suite exists rather than being
 * folded into the unit tests:
 *
 * 1. **A `USER_ADMIN` invites, and the invitee can then actually sign in.** The
 *    invitation's whole effect is a `contacts` row, and the portal's tokenless
 *    sign-in resolves an address against contacts of exactly one business — so
 *    "can they get in afterwards" is a question about whether the invite wrote
 *    the row that lookup needs. Nothing short of both real services can answer
 *    it.
 * 2. **A `BUSINESS_STANDARD` is refused, and NOTHING IS WRITTEN.** The refusal
 *    alone is not the assertion; a 403 after a create would be a worse bug than
 *    no check at all. The row count is what is checked.
 * 3. **The last owner cannot be removed or demoted.** A business that loses its
 *    only administrator can never add or remove anyone again, and there is no
 *    route back from inside the portal.
 * 4. **A duplicate address is refused.** One email is one person, because the
 *    address IS the sign-in channel and the sender-map key at once.
 * 5. **A removed person cannot open a session** — and, separately, the bearer
 *    they are holding RIGHT NOW stops working. Two different mechanisms, and
 *    both are needed: without the first, a revoked person simply requests a
 *    fresh code and gets a brand-new hour.
 * 6. **One business cannot touch another's people**, proven with a SECOND
 *    BUSINESS IN THE SAME PRACTICE. A second practice would prove nothing —
 *    RLS would hide it anyway, and the test would still pass with the
 *    `businessId` filter deleted. This is the one that pins the application
 *    guarantee this service rests on.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable — a tenancy suite that quietly reports
 * green is worse than none. Ids are disjointly prefixed `ppl_` (`p9_`, `p9u_`
 * and `pcs_` are taken by the other portal suites) and torn down at both ends
 * BY EXPLICIT ID LIST, because this Postgres is shared and holds real data
 * pulled from staging: nothing here may delete by anything broader than its own
 * ids.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const SESSION_SECRET = 'ppl-portal-session-secret';

const PRACTICE = 'ppl_prac';
const BIZ_MINE = 'ppl_biz_mine';
const BIZ_THEIRS = 'ppl_biz_theirs';
const SYS_USER = 'ppl_usr_sys';
const MEMBERSHIP = 'ppl_mem_sys';

/** The owner of the client business — the primary contact intake wrote. */
const CON_OWNER = 'ppl_con_owner';
/** The office manager. The first thing in the product ever to hold `USER_ADMIN`. */
const CON_HR = 'ppl_con_hr';
/** A plain member. Reads the list, changes nothing. */
const CON_STAFF = 'ppl_con_staff';
/** The other client's owner, in the SAME practice. */
const CON_THEIRS = 'ppl_con_theirs';
const SEEDED_CONTACTS = [CON_OWNER, CON_HR, CON_STAFF, CON_THEIRS];

const SESSION_OWNER = 'ppl_otp_owner';
const SESSION_HR = 'ppl_otp_hr';
const SESSION_STAFF = 'ppl_otp_staff';
const SESSION_THEIRS = 'ppl_otp_theirs';
const ALL_SESSIONS = [SESSION_OWNER, SESSION_HR, SESSION_STAFF, SESSION_THEIRS];

const INVITEE_EMAIL = 'ppl-newstarter@americanburger.test';

let owner: PrismaClient;
let app: PrismaClient;

function bearerFor(otpSessionId: string, businessId: string): string {
  return `Bearer ${signPortalSessionToken(
    { otpSessionId, businessId, practiceId: PRACTICE, expiresAtMs: Date.now() + 30 * 60_000 },
    SESSION_SECRET,
  )}`;
}

const resolver = (): PortalSessionContextResolver =>
  new PortalSessionContextResolver(app, { portalSessionSecret: SESSION_SECRET });

/** Facts through the REAL resolver, so these tests exercise the session a request would. */
const factsFor = (otpSessionId: string, businessId: string) =>
  resolver().resolveOnboarding(bearerFor(otpSessionId, businessId));

let mailer: DemoEmailSender;

function service(): PortalPeopleService {
  mailer = new DemoEmailSender();
  const notifications = new NotificationsService(mailer, new InMemoryEmailRateLimiter());
  return new PortalPeopleService(app, notifications, new InMemoryIdempotencyStore(), {
    appOrigin: 'https://app.ppl.test',
  });
}

/**
 * The invited client's own sign-in service, over the SAME database.
 *
 * Built per call with its own outbox so "was a code sent" is a question about
 * this assertion rather than about everything the test did before it.
 */
function signIn(): { onboarding: PortalOnboardingService; outbox: DemoEmailSender } {
  const outbox = new DemoEmailSender();
  const onboarding = new PortalOnboardingService(
    app,
    { portalSessionSecret: SESSION_SECRET, otpMode: 'demo', portalLinkSecret: 'ppl-link-secret' },
    new NotificationsService(outbox, new InMemoryEmailRateLimiter()),
  );
  return { onboarding, outbox };
}

/** `lastTo` takes a branded `EmailAddress`; the outbox itself is plain to read. */
function mailFor(sender: DemoEmailSender, address: string): { subject: string; body: string } | undefined {
  const entries = sender.readOutbox().filter((e) => String(e.to) === address);
  const last = entries[entries.length - 1];
  return last === undefined ? undefined : { subject: last.subject, body: last.body };
}

const grab = async (run: () => Promise<unknown>): Promise<AppException> => {
  try {
    await run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
};

/** Every contacts row this suite may have created, including ones it invited. */
async function invitedContactIds(): Promise<string[]> {
  const rows = await owner.contact.findMany({
    where: { businessId: { in: [BIZ_MINE, BIZ_THEIRS] } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Teardown by EXPLICIT ID LIST, never by prefix scan or by a bare `deleteMany`.
 * This database holds production data pulled from staging.
 *
 * ⚠ The invited contacts have SERVER-GENERATED cuids, so their ids cannot be
 * written down in advance. They are collected by the one narrow query above —
 * scoped to this suite's two business ids, which ARE known — and deleted by the
 * list it returns. That is still an explicit list; it is simply computed.
 *
 * ⚠ **`audit_events` needs the trigger dropped for the length of one delete.**
 * `audit_events_no_update` refuses every UPDATE and DELETE — *"audit_events is
 * append-only (Governance §12.3)"* — even for the migration role this suite
 * connects as, which is the guarantee working rather than an obstacle. It also
 * has a REAL foreign key to `businesses`, so the rows cannot simply be left:
 * they would block the teardown two lines down. The house pattern (four other
 * integration suites) is to disable, delete this suite's own business's rows,
 * and re-enable — and the `finally` is not decoration, because a throw between
 * the two statements would leave the append-only guarantee OFF for every other
 * suite in the run and for the developer's own database afterwards.
 */
async function cleanup(): Promise<void> {
  await owner.otpSession.deleteMany({ where: { id: { in: ALL_SESSIONS } } });
  await owner.contact.deleteMany({ where: { id: { in: [...SEEDED_CONTACTS, ...(await invitedContactIds())] } } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  try {
    await owner.auditEvent.deleteMany({ where: { businessId: { in: [BIZ_MINE, BIZ_THEIRS] } } });
  } finally {
    await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  }
  await owner.membership.deleteMany({ where: { id: { in: [MEMBERSHIP] } } });
  await owner.user.deleteMany({ where: { id: { in: [SYS_USER] } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ_MINE, BIZ_THEIRS] } } });
  await owner.practice.deleteMany({ where: { id: { in: [PRACTICE] } } });
}

/** Put the workspace back the way `beforeAll` left it, between tests that mutate. */
async function resetPeople(): Promise<void> {
  await owner.contact.deleteMany({
    where: { businessId: { in: [BIZ_MINE, BIZ_THEIRS] }, id: { notIn: SEEDED_CONTACTS } },
  });
  await owner.contact.update({
    where: { id: CON_OWNER },
    data: { portalRole: 'BUSINESS_ADMIN', deactivatedAt: null },
  });
  await owner.contact.update({ where: { id: CON_HR }, data: { portalRole: 'USER_ADMIN', deactivatedAt: null } });
  await owner.contact.update({
    where: { id: CON_STAFF },
    data: { portalRole: 'BUSINESS_STANDARD', deactivatedAt: null },
  });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: PRACTICE, name: 'PPL Practice' } });
  // ⚠ TWO businesses in ONE practice. The practice SYSTEM context can see both,
  // so this is the pair that makes the tenancy assertion mean anything.
  await owner.business.createMany({
    data: [
      { id: BIZ_MINE, practiceId: PRACTICE, name: 'American Burger' },
      { id: BIZ_THEIRS, practiceId: PRACTICE, name: 'The Other Client' },
    ],
  });
  await owner.user.create({ data: { id: SYS_USER, email: 'ppl-system@example.test', kind: 'SYSTEM' } });
  await owner.membership.create({
    data: { id: MEMBERSHIP, userId: SYS_USER, practiceId: PRACTICE, role: 'PRACTICE_STANDARD' },
  });

  await owner.contact.createMany({
    data: [
      {
        id: CON_OWNER,
        businessId: BIZ_MINE,
        firstName: 'Ade',
        lastName: 'Bello',
        email: 'ppl-owner@americanburger.test',
        role: 'Owner',
        portalRole: 'BUSINESS_ADMIN',
        isPrimary: true,
      },
      {
        id: CON_HR,
        businessId: BIZ_MINE,
        firstName: 'Priya',
        lastName: 'Shah',
        email: 'ppl-hr@americanburger.test',
        role: 'Office Manager',
        portalRole: 'USER_ADMIN',
      },
      {
        id: CON_STAFF,
        businessId: BIZ_MINE,
        firstName: 'Tom',
        lastName: 'Whyte',
        email: 'ppl-staff@americanburger.test',
        role: 'Head Chef',
        portalRole: 'BUSINESS_STANDARD',
      },
      {
        id: CON_THEIRS,
        businessId: BIZ_THEIRS,
        firstName: 'Sam',
        lastName: 'Reed',
        email: 'ppl-theirs@other.test',
        portalRole: 'BUSINESS_ADMIN',
        isPrimary: true,
      },
    ],
  });

  const live = { verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000) };
  await owner.otpSession.createMany({
    data: [
      {
        id: SESSION_OWNER,
        businessId: BIZ_MINE,
        practiceId: PRACTICE,
        contactId: CON_OWNER,
        scope: 'ONBOARDING',
        grantedItemIds: [],
        linkTokenHash: 'ppl-link-owner',
        ...live,
      },
      {
        id: SESSION_HR,
        businessId: BIZ_MINE,
        practiceId: PRACTICE,
        contactId: CON_HR,
        scope: 'ONBOARDING',
        grantedItemIds: [],
        linkTokenHash: 'ppl-link-hr',
        ...live,
      },
      {
        id: SESSION_STAFF,
        businessId: BIZ_MINE,
        practiceId: PRACTICE,
        contactId: CON_STAFF,
        scope: 'ONBOARDING',
        grantedItemIds: [],
        linkTokenHash: 'ppl-link-staff',
        ...live,
      },
      {
        id: SESSION_THEIRS,
        businessId: BIZ_THEIRS,
        practiceId: PRACTICE,
        contactId: CON_THEIRS,
        scope: 'ONBOARDING',
        grantedItemIds: [],
        linkTokenHash: 'ppl-link-theirs',
        ...live,
      },
    ],
  });
});

afterAll(async () => {
  if (!enabled) return;
  await cleanup();
  await owner.$disconnect();
  await app.$disconnect();
});

describe.skipIf(!enabled)('a business manages its own people', () => {
  // ---- 1 · the invitation, and the sign-in it has to make possible ----------

  test('a USER_ADMIN invites, and the invitee can then actually sign in', async () => {
    await resetPeople();
    const people = service();
    const facts = await factsFor(SESSION_HR, BIZ_MINE);

    const invited = await people.invitePerson(facts, {
      name: 'Mary Anne Clarke',
      email: INVITEE_EMAIL,
      jobTitle: 'Foreman',
      access: 'BUSINESS_STANDARD',
      canSendDocuments: true,
      canSeeTotals: false,
    });

    expect(invited.name).toBe('Mary Anne Clarke');
    // The FREE TEXT survives intact. A site's Foreman is not flattened into
    // "Staff" — that is the whole reason `jobTitle` and `access` are separate.
    expect(invited.jobTitle).toBe('Foreman');
    expect(invited.access).toBe('BUSINESS_STANDARD');
    expect(invited.isActive).toBe(true);

    // The mail names the EMPLOYER, never the practice, and carries no token.
    const sent = mailFor(mailer, INVITEE_EMAIL);
    expect(sent?.subject).toContain('American Burger');
    expect(sent?.subject).not.toContain('PPL Practice');
    expect(sent?.body).toContain('https://app.ppl.test/portal');
    // ⚠ A portal person has no password, and the copy says so RATHER than
    // staying silent about it. `composeTeamInvite`'s central instruction —
    // *"open the link below to choose a password"* — would send a new starter
    // looking for a screen that does not exist, so what must be absent is the
    // instruction, not the word.
    expect(sent?.body).toContain('no password to choose');
    expect(sent?.body).not.toMatch(/choose a password/i);
    expect(sent?.body).not.toMatch(/authenticator/i);

    // ⚠ THE ASSERTION THAT MAKES THE INVITE MEAN ANYTHING, through the REAL
    // public sign-in path. The portal resolves an address against contacts of
    // exactly ONE business; if the invite had not written the row that lookup
    // needs, `requestSignInCode` would answer its uniform 202 and send nothing,
    // and the person would be unable to get in with no way of finding out why.
    const { onboarding, outbox } = signIn();
    await onboarding.requestSignInCode({ email: INVITEE_EMAIL });
    const code = mailFor(outbox, INVITEE_EMAIL);
    expect(code).toBeDefined();
    expect(code?.subject).toMatch(/sign-in code/i);

    // And the row is the one the ingest sender map keys on (D45), lower-cased,
    // so a document they forward from their own mailbox lands in this workspace
    // rather than Unrouted.
    const row = await owner.contact.findFirstOrThrow({ where: { businessId: BIZ_MINE, email: INVITEE_EMAIL } });
    expect(row.deactivatedAt).toBeNull();
    expect(row.isPrimary).toBe(false);
  });

  // ---- 2 · the refusal, and the absence of a write --------------------------

  test('a BUSINESS_STANDARD is refused server-side, and NOTHING is written', async () => {
    await resetPeople();
    const people = service();
    const facts = await factsFor(SESSION_STAFF, BIZ_MINE);
    const before = await owner.contact.count({ where: { businessId: BIZ_MINE } });

    const refused = await grab(() =>
      people.invitePerson(facts, {
        name: 'Somebody Else',
        email: 'ppl-should-not-exist@americanburger.test',
        access: 'BUSINESS_ADMIN',
        canSendDocuments: true,
      }),
    );
    expect(refused.code).toBe('NT-PRM-001');
    expect(refused.getStatus()).toBe(403);

    // ⚠ The refusal alone is not the assertion. A 403 returned after the row was
    // written would be a worse bug than no check at all.
    expect(await owner.contact.count({ where: { businessId: BIZ_MINE } })).toBe(before);
    expect(mailFor(mailer, 'ppl-should-not-exist@americanburger.test')).toBeUndefined();

    // The same refusal on the other two mutations, and the same absence.
    expect((await grab(() => people.updatePerson(facts, CON_STAFF, { canSeeTotals: true }))).code).toBe('NT-PRM-001');
    expect((await grab(() => people.removePerson(facts, CON_HR))).code).toBe('NT-PRM-001');
    const untouched = await owner.contact.findUniqueOrThrow({ where: { id: CON_HR } });
    expect(untouched.deactivatedAt).toBeNull();
  });

  test('a BUSINESS_STANDARD still READS the list — the section is not hidden', async () => {
    await resetPeople();
    const list = await service().listPeople(await factsFor(SESSION_STAFF, BIZ_MINE));
    // Governance §11.2: honest degradation, never "pretend the action does not
    // exist". They see everyone, and they see that they cannot change it.
    expect(list.people).toHaveLength(3);
    expect(list.canManagePeople).toBe(false);
    expect(list.people.find((p) => p.id === CON_STAFF)?.isYou).toBe(true);
  });

  test('an owner and a user administrator both get canManagePeople', async () => {
    await resetPeople();
    const people = service();
    expect((await people.listPeople(await factsFor(SESSION_OWNER, BIZ_MINE))).canManagePeople).toBe(true);
    expect((await people.listPeople(await factsFor(SESSION_HR, BIZ_MINE))).canManagePeople).toBe(true);
  });

  // ---- 3 · last-owner protection -------------------------------------------

  test('the last owner cannot be removed, and cannot be demoted', async () => {
    await resetPeople();
    const people = service();
    const facts = await factsFor(SESSION_HR, BIZ_MINE);

    const removal = await grab(() => people.removePerson(facts, CON_OWNER));
    expect(removal.code).toBe('NT-VAL-001');
    expect(removal.publicDetail).toContain('only owner');

    const demotion = await grab(() => people.updatePerson(facts, CON_OWNER, { access: 'BUSINESS_STANDARD' }));
    expect(demotion.code).toBe('NT-VAL-001');

    const still = await owner.contact.findUniqueOrThrow({ where: { id: CON_OWNER } });
    expect(still.deactivatedAt).toBeNull();
    expect(still.portalRole).toBe('BUSINESS_ADMIN');
  });

  test('promoting a second owner RELEASES the protection — the rule is escapable', async () => {
    // A protection with no way out is an outage. Making somebody else an owner
    // is the named fix, so it has to actually work.
    await resetPeople();
    const people = service();
    const facts = await factsFor(SESSION_HR, BIZ_MINE);

    await people.updatePerson(facts, CON_HR, { access: 'BUSINESS_ADMIN' });
    const removed = await people.removePerson(await factsFor(SESSION_HR, BIZ_MINE), CON_OWNER);
    expect(removed.isActive).toBe(false);
  });

  test('nobody may remove themselves, even an owner with a colleague to fall back on', async () => {
    await resetPeople();
    const people = service();
    await people.updatePerson(await factsFor(SESSION_OWNER, BIZ_MINE), CON_HR, { access: 'BUSINESS_ADMIN' });

    const facts = await factsFor(SESSION_OWNER, BIZ_MINE);
    const refused = await grab(() => people.removePerson(facts, CON_OWNER));
    expect(refused.code).toBe('NT-VAL-001');
    expect(refused.publicDetail).toContain('your own access');
  });

  // ---- 4 · one email is one person -----------------------------------------

  test('a duplicate address is refused, case-insensitively', async () => {
    await resetPeople();
    const people = service();
    const facts = await factsFor(SESSION_OWNER, BIZ_MINE);
    const before = await owner.contact.count({ where: { businessId: BIZ_MINE } });

    const refused = await grab(() =>
      people.invitePerson(facts, {
        name: 'Impostor',
        email: 'PPL-STAFF@AmericanBurger.TEST',
        access: 'BUSINESS_STANDARD',
        canSendDocuments: true,
      }),
    );
    expect(refused.code).toBe('NT-VAL-001');
    expect(refused.getStatus()).toBe(400);
    expect(await owner.contact.count({ where: { businessId: BIZ_MINE } })).toBe(before);
  });

  test('a REVOKED person still holds their address', async () => {
    // Reviving somebody is a different act from inviting a second person under
    // their address. Two rows on one address would make "who sent this"
    // ambiguous for the ingest router (D45).
    await resetPeople();
    const people = service();
    await people.removePerson(await factsFor(SESSION_OWNER, BIZ_MINE), CON_STAFF);

    const facts = await factsFor(SESSION_OWNER, BIZ_MINE);
    const refused = await grab(() =>
      people.invitePerson(facts, {
        name: 'Tom Again',
        email: 'ppl-staff@americanburger.test',
        access: 'BUSINESS_STANDARD',
        canSendDocuments: true,
      }),
    );
    expect(refused.code).toBe('NT-VAL-001');
  });

  // ---- 5 · removal is revocation, and it bites immediately ------------------

  test('a removed person cannot open a NEW session, and the answer stays uniform', async () => {
    await resetPeople();
    await service().removePerson(await factsFor(SESSION_OWNER, BIZ_MINE), CON_STAFF);

    const { onboarding, outbox } = signIn();
    // The call SUCCEEDS — it always does, and that is the contract: telling the
    // outcomes apart would answer "is this address registered on this
    // workspace" for anyone who types one.
    await onboarding.requestSignInCode({ email: 'ppl-staff@americanburger.test' });
    // What changed is that no code left the building. The caller cannot see
    // this; the revoked person simply never receives one.
    expect(mailFor(outbox, 'ppl-staff@americanburger.test')).toBeUndefined();

    // And a LIVE colleague on the same workspace still gets theirs, so the
    // absence above is about the revocation rather than about the fixture.
    await onboarding.requestSignInCode({ email: 'ppl-hr@americanburger.test' });
    expect(mailFor(outbox, 'ppl-hr@americanburger.test')).toBeDefined();
  });

  test('the bearer they are holding RIGHT NOW stops working, rather than lasting its hour', async () => {
    // ⚠ The sixth row check in `portal-session-context.ts`, and the only
    // assertion here that a unit test structurally cannot make: the session row
    // is unchanged and still live, and the CONTACT is what refuses it.
    await resetPeople();
    const live = await factsFor(SESSION_STAFF, BIZ_MINE);
    expect(live.contactId).toBe(CON_STAFF);

    await service().removePerson(await factsFor(SESSION_OWNER, BIZ_MINE), CON_STAFF);

    const refused = await grab(() => factsFor(SESSION_STAFF, BIZ_MINE));
    expect(refused.code).toBe('NT-OTP-002');
    const row = await owner.otpSession.findUniqueOrThrow({ where: { id: SESSION_STAFF } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('removal DEACTIVATES and never deletes — the provenance survives', async () => {
    await resetPeople();
    const removed = await service().removePerson(await factsFor(SESSION_OWNER, BIZ_MINE), CON_STAFF);
    expect(removed.isActive).toBe(false);
    const row = await owner.contact.findUnique({ where: { id: CON_STAFF } });
    expect(row).not.toBeNull();
    expect(row?.deactivatedAt).not.toBeNull();
    // And they are still on the list, as inactive, rather than vanishing.
    const list = await service().listPeople(await factsFor(SESSION_OWNER, BIZ_MINE));
    expect(list.people.find((p) => p.id === CON_STAFF)?.isActive).toBe(false);
  });

  // ---- 6 · the tenancy this service rests on -------------------------------

  test('one business cannot SEE another\'s people — a second business in the SAME practice', async () => {
    await resetPeople();
    const people = service();
    const mine = await people.listPeople(await factsFor(SESSION_OWNER, BIZ_MINE));
    const theirs = await people.listPeople(await factsFor(SESSION_THEIRS, BIZ_THEIRS));

    expect(mine.people.map((p) => p.id).sort()).toEqual([CON_HR, CON_OWNER, CON_STAFF].sort());
    expect(theirs.people.map((p) => p.id)).toEqual([CON_THEIRS]);
    // Both directions, so the filter is proven DERIVED from the session rather
    // than constant.
    expect(mine.people.some((p) => p.id === CON_THEIRS)).toBe(false);
    expect(theirs.people.some((p) => p.id === CON_OWNER)).toBe(false);
  });

  test('one business cannot CHANGE another\'s people — 404, never 403', async () => {
    await resetPeople();
    const people = service();
    // The other client's owner, holding a perfectly valid session of their own,
    // pointing at somebody on our workspace.
    const theirs = await factsFor(SESSION_THEIRS, BIZ_THEIRS);

    const update = await grab(() => people.updatePerson(theirs, CON_STAFF, { canSeeTotals: true }));
    expect(update.getStatus()).toBe(404);
    // ⚠ 404 and not 403: a 403 would confirm that person exists.
    expect(update.code).toBe('NT-VAL-001');

    const removal = await grab(() => people.removePerson(theirs, CON_STAFF));
    expect(removal.getStatus()).toBe(404);

    const untouched = await owner.contact.findUniqueOrThrow({ where: { id: CON_STAFF } });
    expect(untouched.canSeeTotals).toBe(true);
    expect(untouched.deactivatedAt).toBeNull();
  });

  // ---- the audit trail the accountant reads --------------------------------

  test('every change writes to the practice audit log, and the chain links', async () => {
    await resetPeople();
    // The chain is append-only and a previous run's rows may still be here, so
    // the assertion is about what THIS run added.
    const existing = new Set(
      (await owner.auditEvent.findMany({ where: { businessId: BIZ_MINE }, select: { id: true } })).map((r) => r.id),
    );
    const people = service();

    await people.invitePerson(await factsFor(SESSION_HR, BIZ_MINE), {
      name: 'Audit Subject',
      email: 'ppl-audit@americanburger.test',
      access: 'BUSINESS_STANDARD',
      canSendDocuments: true,
    });
    await people.updatePerson(await factsFor(SESSION_HR, BIZ_MINE), CON_STAFF, { canSeeTotals: false });
    await people.removePerson(await factsFor(SESSION_HR, BIZ_MINE), CON_STAFF);

    const rows = (
      await owner.auditEvent.findMany({ where: { businessId: BIZ_MINE }, orderBy: { seq: 'asc' } })
    ).filter((r) => !existing.has(r.id));
    expect(rows.map((r) => r.event)).toEqual([
      'business.person.invited',
      'business.person.updated',
      'business.person.removed',
    ]);
    // No proposal, and structurally there cannot be one — the Review → Approve
    // spine carries `workspaceSession`, which a portal caller does not hold.
    expect(rows.every((r) => r.proposalId === null)).toBe(true);
    // The acting person is recorded, so the accountant can see WHO their client
    // added even though they did not authorise it.
    for (const row of rows) {
      expect((row.outcome as Record<string, unknown>)['byContactId']).toBe(CON_HR);
      expect((row.outcome as Record<string, unknown>)['byAccess']).toBe('USER_ADMIN');
    }
  });

  // ---- replay --------------------------------------------------------------

  test('a replayed Idempotency-Key returns the same person and writes no second row', async () => {
    await resetPeople();
    const people = service();
    const key = 'ppl-replay-key';
    const request = {
      name: 'Replay Subject',
      email: 'ppl-replay@americanburger.test',
      access: 'BUSINESS_STANDARD' as const,
      canSendDocuments: true,
    };

    const first = await people.invitePerson(await factsFor(SESSION_OWNER, BIZ_MINE), request, key);
    const second = await people.invitePerson(await factsFor(SESSION_OWNER, BIZ_MINE), request, key);
    expect(second).toEqual(first);
    // ⚠ A second row would be a second sender-map entry for one identity, which
    // is exactly what the duplicate-address refusal exists to prevent.
    expect(await owner.contact.count({ where: { businessId: BIZ_MINE, email: request.email } })).toBe(1);
  });

  // ---- the derivation that makes this work with no backfill -----------------

  test('a business whose contacts predate the column still has exactly one owner', async () => {
    // The migration writes NO data. Every workspace that already exists derives
    // its owner from `is_primary`, which intake wrote exactly one of.
    await resetPeople();
    await owner.contact.updateMany({
      where: { id: { in: [CON_OWNER, CON_HR, CON_STAFF] } },
      data: { portalRole: null },
    });

    const list = await service().listPeople(await factsFor(SESSION_OWNER, BIZ_MINE));
    expect(list.people.filter((p) => p.access === 'BUSINESS_ADMIN').map((p) => p.id)).toEqual([CON_OWNER]);
    expect(list.canManagePeople).toBe(true);

    // And the plain members derive as BUSINESS_STANDARD, so they are refused.
    const staff = await service().listPeople(await factsFor(SESSION_STAFF, BIZ_MINE));
    expect(staff.canManagePeople).toBe(false);
  });
});
