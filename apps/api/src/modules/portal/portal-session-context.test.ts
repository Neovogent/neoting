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
  readonly scope: string;
  readonly chaseId: string | null;
  readonly grantedItemIds: string[];
  readonly verifiedAt: Date | null;
  readonly expiresAt: Date;
}

function row(over: Partial<OtpRow> = {}): OtpRow {
  return {
    id: 'otp_1',
    businessId: 'biz_burger',
    userId: null,
    scope: 'DELEGATED_UPLOAD',
    chaseId: 'chase_1',
    grantedItemIds: [],
    verifiedAt: new Date(NOW - 1000),
    expiresAt: EXPIRES,
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
  const facts = await resolver(row({ grantedItemIds: ['doc_a'] })).resolve(bearer(), NOW);
  expect(facts).toEqual({
    otpSessionId: 'otp_1',
    businessId: 'biz_burger',
    practiceId: 'prac_1',
    systemUserId: 'usr_system_1',
    // No contact user on the row, so the delegated actor is the practice SYSTEM
    // actor — the same actor every WhatsApp/email document already carries.
    actorId: 'usr_system_1',
    chaseId: 'chase_1',
    grantedItemIds: ['doc_a'],
    expiresAt: EXPIRES,
  });
});

test('the row decides who the session acts as — a stored contact user wins over the SYSTEM fallback', async () => {
  const facts = await resolver(row({ userId: 'usr_client' })).resolve(bearer(), NOW);
  expect(facts.actorId).toBe('usr_client');
  expect(facts.systemUserId).toBe('usr_system_1');
});

test('missing, malformed and forged bearers are one 401 NT-OTP-002 with one detail — no oracle', async () => {
  const service = resolver(row());
  for (const header of [undefined, 'Bearer nonsense', 'Basic abc', `Bearer ${signPortalSessionToken({ otpSessionId: 'otp_1', businessId: 'biz_burger', practiceId: 'prac_1', expiresAtMs: NOW + 1000 }, 'another-secret')}`]) {
    const error = await grab(() => service.resolve(header, NOW));
    expect(error.code).toBe('NT-OTP-002');
    expect(error.getStatus()).toBe(401);
    expect(error.publicDetail).toBe('missing or invalid portal session');
  }
});

test('an expired bearer says so — it was genuinely ours, and "tap the link again" is safe to say', async () => {
  const error = await grab(() => resolver(row()).resolve(bearer({ expiresAtMs: NOW }), NOW));
  expect(error.code).toBe('NT-OTP-002');
  expect(error.publicDetail).toBe('This portal session has expired. Open the link from your text message again.');
});

test('the ROW outranks the token: expired, unverified, wrong scope or a different business are all refused', async () => {
  // Expired on the row but not yet on the token — a session shortened after the
  // bearer was minted must lose to the row.
  const expired = await grab(() => resolver(row({ expiresAt: new Date(NOW) })).resolve(bearer(), NOW));
  expect(expired.publicDetail).toBe('This portal session has expired. Open the link from your text message again.');

  for (const stored of [row({ verifiedAt: null }), row({ scope: 'ONBOARDING' }), row({ businessId: 'biz_someone_else' })]) {
    const error = await grab(() => resolver(stored).resolve(bearer(), NOW));
    expect(error.code).toBe('NT-OTP-002');
    expect(error.publicDetail).toBe('missing or invalid portal session');
  }
});

test('a bearer whose session row is gone is refused like any other', async () => {
  const error = await grab(() => resolver(null).resolve(bearer(), NOW));
  expect(error.code).toBe('NT-OTP-002');
});

const FACTS: PortalSessionFacts = {
  otpSessionId: 'otp_1',
  businessId: 'biz_burger',
  practiceId: 'prac_1',
  systemUserId: 'usr_system_1',
  actorId: 'usr_system_1',
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
