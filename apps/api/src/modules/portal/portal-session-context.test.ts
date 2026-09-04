import { expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { AppException } from '../../common/problem/problem.js';
import {
  delegatedScopeFor,
  type PortalSessionFacts,
  PortalSessionContextResolver,
  systemScopeFor,
} from './portal-session-context.js';
import { PORTAL_SESSION_TTL_MS, signPortalSessionToken } from './portal-session-token.js';

const SECRET = 'test-portal-session-secret';
const NOW = 1_755_500_000_000;
const EXPIRES = new Date(NOW + PORTAL_SESSION_TTL_MS);

interface OtpRow {
  readonly id: string;
  readonly businessId: string;
  readonly userId: string | null;
  /** WHO is holding this session. Null on a chase row, deliberately — the link is forwardable. */
  readonly contactId: string | null;
  readonly scope: string;
  readonly chaseId: string | null;
  readonly grantedItemIds: string[];
  readonly verifiedAt: Date | null;
  readonly expiresAt: Date;
  /**
   * The joined `contacts` row, which the resolver reads for the SIXTH row check.
   *
   * ⚠ It is joined rather than looked up separately so the revocation check
   * cannot race the session read, and it is on this double because the resolver
   * selects it — a double that omits a selected relation is not a stand-in for
   * the query, it is a different query.
   */
  readonly contact: { readonly id: string; readonly deactivatedAt: Date | null } | null;
}

function row(over: Partial<OtpRow> = {}): OtpRow {
  return {
    id: 'otp_1',
    businessId: 'biz_burger',
    userId: null,
    contactId: null,
    scope: 'DELEGATED_UPLOAD',
    chaseId: 'chase_1',
    grantedItemIds: [],
    verifiedAt: new Date(NOW - 1000),
    expiresAt: EXPIRES,
    contact: null,
    ...over,
  };
}

function fakePrisma(stored: OtpRow | null, systemActor: string | null = 'usr_system_1'): PrismaClient {
  const tx = {
    $executeRaw: async (): Promise<number> => 0,
    otpSession: { findUnique: async ({ where }: { where: { id: string } }) => (stored !== null && stored.id === where.id ? stored : null) },
  };
  return {
    membership: { findFirst: async () => (systemActor === null ? null : { userId: systemActor }) },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
}

function bearer(over: Partial<{ otpSessionId: string; businessId: string; practiceId: string; expiresAtMs: number }> = {}): string {
  return `Bearer ${signPortalSessionToken(
    { otpSessionId: 'otp_1', businessId: 'biz_burger', practiceId: 'prac_1', expiresAtMs: NOW + PORTAL_SESSION_TTL_MS, ...over },
    SECRET,
  )}`;
}

function resolver(stored: OtpRow | null, systemActor: string | null = 'usr_system_1'): PortalSessionContextResolver {
  return new PortalSessionContextResolver(fakePrisma(stored, systemActor), { portalSessionSecret: SECRET });
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

test('a live bearer resolves to the session facts, taking the tenant from the ROW', async () => {
  const facts = await resolver(row({ grantedItemIds: ['doc_a'] })).resolveForUpload(bearer(), NOW);
  expect(facts).toEqual({
    otpSessionId: 'otp_1',
    businessId: 'biz_burger',
    practiceId: 'prac_1',
    systemUserId: 'usr_system_1',
    // No contact user on the row, so the delegated actor is the practice SYSTEM
    // actor — the same actor every WhatsApp/email document already carries.
    actorId: 'usr_system_1',
    // A chase row names no person on purpose: the link is forwardable and a
    // guess in an audit column is worse than an absence.
    contactId: null,
    chaseId: 'chase_1',
    grantedItemIds: ['doc_a'],
    expiresAt: EXPIRES,
  });
});

test('the row decides who the session acts as — a stored contact user wins over the SYSTEM fallback', async () => {
  const facts = await resolver(row({ userId: 'usr_client' })).resolveForUpload(bearer(), NOW);
  expect(facts.actorId).toBe('usr_client');
  expect(facts.systemUserId).toBe('usr_system_1');
});

test('missing, malformed and forged bearers are one 401 NT-OTP-002 with one detail — no oracle', async () => {
  const service = resolver(row());
  for (const header of [undefined, 'Bearer nonsense', 'Basic abc', `Bearer ${signPortalSessionToken({ otpSessionId: 'otp_1', businessId: 'biz_burger', practiceId: 'prac_1', expiresAtMs: NOW + 1000 }, 'another-secret')}`]) {
    const error = await grab(() => service.resolveForUpload(header, NOW));
    expect(error.code).toBe('NT-OTP-002');
    expect(error.getStatus()).toBe(401);
    expect(error.publicDetail).toBe('missing or invalid portal session');
  }
});

test('an expired bearer says so — it was genuinely ours, and "tap the link again" is safe to say', async () => {
  const error = await grab(() => resolver(row()).resolveForUpload(bearer({ expiresAtMs: NOW }), NOW));
  expect(error.code).toBe('NT-OTP-002');
  expect(error.publicDetail).toBe('This portal session has expired. Open the link in your email again.');
});

test('the ROW outranks the token: expired, unverified, unknown scope or a different business are all refused', async () => {
  // Expired on the row but not yet on the token — a session shortened after the
  // bearer was minted must lose to the row.
  const expired = await grab(() => resolver(row({ expiresAt: new Date(NOW) })).resolveForUpload(bearer(), NOW));
  expect(expired.publicDetail).toBe('This portal session has expired. Open the link in your email again.');

  // `ITEM_MESSAGE` is neither of the two kinds these doors take, and a row for
  // another tenant is refused however well-formed the bearer is.
  for (const stored of [
    row({ verifiedAt: null }),
    row({ scope: 'ITEM_MESSAGE' }),
    row({ businessId: 'biz_someone_else' }),
  ]) {
    const error = await grab(() => resolver(stored).resolveForUpload(bearer(), NOW));
    expect(error.code).toBe('NT-OTP-002');
    expect(error.publicDetail).toBe('missing or invalid portal session');
  }
});

/**
 * ⚠ THE REGRESSION THIS FILE NOW EXISTS TO HOLD DOWN.
 *
 * All three portal doors — the context read, the upload intent and the
 * completion — resolved with `DELEGATED_UPLOAD` only. So a client who signed in
 * to their own portal, with a code they had just typed correctly, was answered
 * `NT-OTP-002 — missing or invalid portal session` by the very endpoint written
 * for them, and the business-context branch behind it was unreachable code.
 */
test('BOTH kinds of session pass the context and upload doors', async () => {
  const chase = row();
  const own = row({ scope: 'ONBOARDING', chaseId: null });

  for (const stored of [chase, own]) {
    expect((await resolver(stored).resolveForContext(bearer(), NOW)).businessId).toBe('biz_burger');
    expect((await resolver(stored).resolveForUpload(bearer(), NOW)).businessId).toBe('biz_burger');
  }

  // And the two remain distinguishable to the service that reads them: the
  // context branches on `chaseId`, which is null only for the client's own.
  expect((await resolver(chase).resolveForContext(bearer(), NOW)).chaseId).not.toBeNull();
  expect((await resolver(own).resolveForContext(bearer(), NOW)).chaseId).toBeNull();
});

test('the BILLING door stays narrow — it takes only the client own session', async () => {
  // Widening the two shared doors must not widen this one: it is the door a
  // subscription is paid through.
  const wrongKind = await grab(() => resolver(row()).resolveOnboarding(bearer(), NOW));
  expect(wrongKind.code).toBe('NT-OTP-002');
});

test('a bearer whose session row is gone is refused like any other', async () => {
  const error = await grab(() => resolver(null).resolveForUpload(bearer(), NOW));
  expect(error.code).toBe('NT-OTP-002');
});

const FACTS: PortalSessionFacts = {
  otpSessionId: 'otp_1',
  businessId: 'biz_burger',
  practiceId: 'prac_1',
  systemUserId: 'usr_system_1',
  actorId: 'usr_system_1',
  contactId: null,
  chaseId: 'chase_1',
  grantedItemIds: [],
  expiresAt: EXPIRES,
};

test('a session with nothing granted yet has NO delegated context — a typed result, not a Zod throw from a query', () => {
  expect(delegatedScopeFor(FACTS)).toEqual({ ok: false, reason: 'no-granted-items' });
});

test('the delegated context grants exactly the documents held, plus the one being intended, and carries no practice', () => {
  const result = delegatedScopeFor({ ...FACTS, grantedItemIds: ['doc_a'] }, ['doc_b', 'doc_a']);
  expect(result).toEqual({
    ok: true,
    context: {
      actorId: 'usr_system_1',
      businessId: 'biz_burger',
      sessionScope: 'delegated_upload',
      // De-duplicated: a re-intended upload must not push the same id twice.
      grantedItemIds: ['doc_a', 'doc_b'],
    },
  });
});

test('the system context reads the practice, in USER scope — the only way to see the chase', () => {
  // `chases` has no delegated RLS branch (`app_can_access_business` begins
  // `app_session_scope() = 'user'`), so chase reads run here. The caller must
  // still constrain them to `facts.chaseId`: this context can see the practice.
  expect(systemScopeFor(FACTS)).toEqual({
    actorId: 'usr_system_1',
    practiceId: 'prac_1',
    sessionScope: 'user',
    grantedItemIds: [],
  });
});

/**
 * ⚠ The two scopes are two DOORS, not one door with a flag.
 *
 * `resolve` and `resolveOnboarding` differ by exactly which `otp_sessions.scope`
 * they will accept, and each refuses the other's. That is the whole safety of
 * contract-change #205: an onboarding session has no chase and an empty grant,
 * so answering the upload question with one would hand it document powers it
 * was never granted — and answering the billing question with a chase session
 * would let a forwarded chase link buy a subscription.
 *
 * Both refusals are the SAME uniform `NT-OTP-002`, so a holder learns "not a
 * session for this", never which check said so.
 */
test('resolveOnboarding takes an ONBOARDING row and refuses a chase one', async () => {
  const facts = await resolver(row({ scope: 'ONBOARDING', chaseId: null })).resolveOnboarding(bearer(), NOW);
  expect(facts.businessId).toBe('biz_burger');
  // No chase, and nothing it could ever write a document against.
  expect(facts.chaseId).toBeNull();
  expect(delegatedScopeFor(facts)).toEqual({ ok: false, reason: 'no-granted-items' });
  // What it CAN do is name its own business, under a context that sees the
  // whole practice — which is why the caller has to constrain the query.
  expect(systemScopeFor(facts).practiceId).toBe('prac_1');

  const wrongKind = await grab(() => resolver(row()).resolveOnboarding(bearer(), NOW));
  expect(wrongKind.code).toBe('NT-OTP-002');
  expect(wrongKind.publicDetail).toBe('missing or invalid portal session');
});

test('an ONBOARDING row still fails every other check a session has to pass', async () => {
  const onboarding = (over: Partial<OtpRow>) => row({ scope: 'ONBOARDING', chaseId: null, ...over });

  for (const stored of [onboarding({ verifiedAt: null }), onboarding({ businessId: 'biz_someone_else' })]) {
    const error = await grab(() => resolver(stored).resolveOnboarding(bearer(), NOW));
    expect(error.code).toBe('NT-OTP-002');
    expect(error.publicDetail).toBe('missing or invalid portal session');
  }

  const expired = await grab(() => resolver(onboarding({ expiresAt: new Date(NOW) })).resolveOnboarding(bearer(), NOW));
  expect(expired.publicDetail).toBe('This portal session has expired. Open the link in your email again.');
});

/**
 * ⚠ THE SIXTH ROW CHECK — what makes "remove" mean removed.
 *
 * A business revoking somebody's access must stop them NOW, not at the end of
 * the hour their bearer happens to have left: *"they stop being able to send
 * documents immediately"* is what the People screen promises, and a bearer is a
 * bearer — nothing else in this product can withdraw one. Portal sessions are
 * not rows that can be deleted per person (`link_token_hash` is unique per LINK,
 * not per grant), so revocation is expressed on the CONTACT and honoured here.
 *
 * It is checked in the resolver rather than per endpoint for the reason every
 * other check on this list is: this is the one door, and a rule enforced at four
 * call sites is a rule three of them will eventually miss.
 */
test('a REVOKED person\'s live bearer stops working, on every door', async () => {
  const revoked = row({
    scope: 'ONBOARDING',
    chaseId: null,
    contactId: 'con_gone',
    contact: { id: 'con_gone', deactivatedAt: new Date(NOW - 60_000) },
  });

  for (const door of ['resolveForContext', 'resolveForUpload', 'resolveOnboarding'] as const) {
    const error = await grab(() => resolver(revoked)[door](bearer(), NOW));
    // The uniform detail. Somebody whose access was withdrawn learns that their
    // session is not valid, which is true — not that they were removed, which is
    // their employer's to tell them.
    expect(error.code).toBe('NT-OTP-002');
    expect(error.publicDetail).toBe('missing or invalid portal session');
  }

  // The row itself is untouched and still live: the CONTACT is what refuses it.
  expect(revoked.expiresAt.getTime()).toBeGreaterThan(NOW);
});

test('a LIVE person passes, and their contactId reaches the facts', async () => {
  // The answer to "who is doing this", which the session could not previously
  // give — and which everything on the People surface is derived from.
  const facts = await resolver(
    row({ scope: 'ONBOARDING', chaseId: null, contactId: 'con_boss', contact: { id: 'con_boss', deactivatedAt: null } }),
  ).resolveOnboarding(bearer(), NOW);
  expect(facts.contactId).toBe('con_boss');
});

test('a session with NO contact is unaffected — a chase link has nobody to revoke', async () => {
  // Refusing it here would break the forwardable-link journey for a rule that
  // has nothing to say about it.
  const facts = await resolver(row()).resolveForUpload(bearer(), NOW);
  expect(facts.contactId).toBeNull();
});
