import { expect, test } from 'vitest';

import { invitePracticeMemberBody, listPracticeMembersQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import type { NotificationsService, SendOutcome, SendTeamInviteInput } from '../notifications/index.js';
import { PracticeTeamService } from './practice-team.service.js';
import { hashSetupToken } from './setup-link.js';

/**
 * The practice invite as a pure decision. Every assertion is about a REFUSAL or
 * about what was WRITTEN, because an invite endpoint that is only tested on its
 * happy path has been tested for the case nobody worries about.
 *
 * The Prisma double answers `membership.findFirst` — which is what
 * `resolveActor` reads to decide authority — so the D44 gate is genuinely
 * exercised here rather than stubbed past.
 */

const PRACTICE = 'prac_1';
const CTX = ScopeContextSchema.parse({ actorId: 'usr_admin', practiceId: PRACTICE });
const NOW = Date.parse('2026-09-02T09:00:00.000Z');
const SENT: SendOutcome = { sent: true, kind: 'team-invite', providerMessageId: 'msg_1' };

const OWNER = { role: 'PRACTICE_ADMIN' as const, isOwner: true };
const ADMIN_NOT_OWNER = { role: 'PRACTICE_ADMIN' as const, isOwner: false };
const STAFF = { role: 'PRACTICE_STANDARD' as const, isOwner: false };

function inviteRequest(over: Record<string, unknown> = {}) {
  return invitePracticeMemberBody.parse({ email: 'Sam@Ledgerline.test', role: 'PRACTICE_STANDARD', ...over });
}

function harness(
  options: {
    acting?: { role: string; isOwner: boolean } | null;
    businesses?: { id: string }[];
    practice?: { name: string } | null;
    outcome?: SendOutcome;
  } = {},
) {
  const writes: { model: string; data: Record<string, unknown> }[] = [];
  const emails: SendTeamInviteInput[] = [];
  const businesses = options.businesses ?? [{ id: 'biz_a' }, { id: 'biz_b' }];
  const practice = options.practice === undefined ? { name: 'Ledgerline' } : options.practice;
  const acting = options.acting === undefined ? OWNER : options.acting;

  const record = (model: string) => async ({ data }: { data: Record<string, unknown> }) => {
    writes.push({ model, data });
    return { id: `${model}_1`, createdAt: new Date(NOW), acceptedAt: null, businessId: null, ...data };
  };

  const tx = {
    $executeRaw: async () => 0,
    membership: { findFirst: async () => acting },
    business: {
      findMany: async (args?: { where?: { id?: { in?: string[] } } }) => {
        const wanted = args?.where?.id?.in;
        return wanted === undefined ? businesses : businesses.filter((b) => wanted.includes(b.id));
      },
    },
    practice: { findUnique: async () => practice },
    user: { findUnique: async () => ({ firstName: 'Priya', lastName: 'Shah' }), findMany: async () => [] },
    invite: { create: record('invite'), findMany: async () => [] },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;

  const notifications = {
    sendTeamInvite: async (input: SendTeamInviteInput): Promise<SendOutcome> => {
      emails.push(input);
      return options.outcome ?? SENT;
    },
  } as unknown as NotificationsService;

  const service = new PracticeTeamService(
    prisma,
    notifications,
    new InMemoryIdempotencyStore(),
    { appOrigin: 'https://app.example.test' },
    () => NOW,
  );

  return {
    service,
    emails,
    writes,
    invites: () => writes.filter((w) => w.model === 'invite').map((w) => w.data),
  };
}

const refusal = async (run: () => Promise<unknown>): Promise<AppException> => {
  try {
    await run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a refusal');
};

// ---- authority ---------------------------------------------------------------

test('a practice admin who is NOT the owner may invite — the gate is mayManageTeam, not mayRelease', async () => {
  const h = harness({ acting: ADMIN_NOT_OWNER });
  await h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1');
  expect(h.invites()).toHaveLength(1);
});

test('a non-admin gets 403 NT-PRM-001 and NO invite row is written', async () => {
  const h = harness({ acting: STAFF });
  const refused = await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1'));
  expect(refused.code).toBe('NT-PRM-001');
  expect(refused.getStatus()).toBe(403);
  // The whole point: refused BEFORE anything was written or sent.
  expect(h.invites()).toEqual([]);
  expect(h.emails).toEqual([]);
});

test('authority is decided BEFORE the role narrowing — a non-admin sending a refused role still gets 403', async () => {
  const h = harness({ acting: STAFF });
  // A caller who may not invite must not learn which roles this endpoint would
  // have accepted; that is an answer to a question they were not allowed to ask.
  const refused = await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest({ role: 'PRACTICE_ADMIN' }), 'key-1'));
  expect(refused.code).toBe('NT-PRM-001');
});

test('a caller with no practice in scope is refused before any query runs', async () => {
  const h = harness();
  const businessOnly = ScopeContextSchema.parse({ actorId: 'usr_1', businessId: 'biz_a' });
  const refused = await refusal(() => h.service.invitePracticeMember(businessOnly, inviteRequest(), 'key-1'));
  expect(refused.code).toBe('NT-PRM-001');
  expect(h.writes).toEqual([]);
});

// ---- the role narrowing ------------------------------------------------------

test('⚠ PRACTICE_ADMIN is refused BY NAME, with the reason a person can act on', async () => {
  const h = harness();
  const refused = await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest({ role: 'PRACTICE_ADMIN' }), 'key-1'));
  expect(refused.code).toBe('NT-VAL-001');
  expect(refused.getStatus()).toBe(400);
  expect(refused.publicDetail).toContain('practice admin');
  // It says WHY, not just "invalid role" — an invited admin could neither
  // release nor be told coherently why, and there is no ownership transfer.
  expect(refused.publicDetail).toContain('transfer');
  expect(h.invites()).toEqual([]);
});

test('the three business-level roles are refused — they belong to a client’s own team list', async () => {
  for (const role of ['BUSINESS_ADMIN', 'USER_ADMIN', 'BUSINESS_STANDARD']) {
    const h = harness();
    const refused = await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest({ role }), `key-${role}`));
    expect(refused.code).toBe('NT-VAL-001');
    expect(h.invites()).toEqual([]);
  }
});

test('the two invitable roles are accepted', async () => {
  for (const role of ['PRACTICE_STANDARD', 'CLIENT_ADMIN']) {
    const h = harness();
    await h.service.invitePracticeMember(CTX, inviteRequest({ role }), `key-${role}`);
    expect(h.invites()[0]).toMatchObject({ role, practiceId: PRACTICE });
  }
});

// ---- the client scope --------------------------------------------------------

test('businessIds are carried onto the invite row, so acceptance can scope the memberships', async () => {
  const h = harness();
  await h.service.invitePracticeMember(CTX, inviteRequest({ businessIds: ['biz_a'] }), 'key-1');
  expect(h.invites()[0]).toMatchObject({ businessIds: ['biz_a'], hideFinancialFields: false });
});

test('a client the INVITER cannot see is 404, never 403 — a 403 would confirm it exists', async () => {
  const h = harness({ businesses: [{ id: 'biz_a' }] });
  const refused = await refusal(() =>
    h.service.invitePracticeMember(CTX, inviteRequest({ businessIds: ['biz_a', 'biz_elsewhere'] }), 'key-1'),
  );
  expect(refused.getStatus()).toBe(404);
  expect(refused.code).toBe('NT-VAL-001');
  // …and it never echoes the id back.
  expect(refused.publicDetail).not.toContain('biz_elsewhere');
  expect(h.invites()).toEqual([]);
});

test('CLIENT_ADMIN with a client list is refused rather than silently widened', async () => {
  const h = harness();
  const refused = await refusal(() =>
    h.service.invitePracticeMember(CTX, inviteRequest({ role: 'CLIENT_ADMIN', businessIds: ['biz_a'] }), 'key-1'),
  );
  expect(refused.code).toBe('NT-VAL-001');
  expect(refused.publicDetail).toContain('every client');
  expect(h.invites()).toEqual([]);
});

// ---- the row, the token and the email ---------------------------------------

test('the invite is practice-level, records the inviter, and stores only the token HASH', async () => {
  const h = harness();
  await h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1');
  const invite = h.invites()[0];

  expect(invite).toMatchObject({ practiceId: PRACTICE, invitedByUserId: 'usr_admin' });
  // `business_id` stays NULL — the branch `invites_tenant` admits on practice_id,
  // and what distinguishes a colleague invitation from a client one.
  expect(invite?.['businessId']).toBeUndefined();
  // The address is lower-cased, because `users.email` is unique on literal bytes.
  expect(invite?.['email']).toBe('sam@ledgerline.test');

  // The plaintext token exists in the email and NOWHERE else.
  const link = h.emails[0]?.inviteLink ?? '';
  const token = new URL(link).searchParams.get('token') ?? '';
  expect(token).not.toBe('');
  expect(invite?.['tokenHash']).toBe(hashSetupToken(token));
  expect(JSON.stringify(invite)).not.toContain(token);
});

test('the email names the practice and the inviter, and lands on /invite', async () => {
  const h = harness();
  await h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1');
  expect(h.emails[0]).toMatchObject({ practiceName: 'Ledgerline', inviterName: 'Priya Shah' });
  expect(h.emails[0]?.inviteLink.startsWith('https://app.example.test/invite?token=')).toBe(true);
});

test('a rate-limited email KEEPS the row and answers 429 — the decision was made, the mail was not sent', async () => {
  const h = harness({ outcome: { sent: false, kind: 'team-invite', reason: 'rate-limited', retryAfterSeconds: 1800 } });
  const refused = await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1'));
  expect(refused.code).toBe('NT-RATE-001');
  expect(refused.getStatus()).toBe(429);
  expect(refused.publicDetail).toContain('1800');
  // The row survives: it is the durable record of a decision that was made.
  expect(h.invites()).toHaveLength(1);
});

test('⚠ a rate-limited retry on the SAME key raises the same 429 — it does NOT mint a second live token', async () => {
  const h = harness({ outcome: { sent: false, kind: 'team-invite', reason: 'rate-limited', retryAfterSeconds: 1800 } });

  const first = await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1'));
  const retry = await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1'));

  // The retry gets the ending the key already had, word for word.
  expect(retry.code).toBe(first.code);
  expect(retry.getStatus()).toBe(first.getStatus());
  expect(retry.publicDetail).toBe(first.publicDetail);

  // The bug this pins: the 429 threw BEFORE the key was remembered, so a retry
  // missed the replay cache and wrote a second `invites` row with a second
  // live token — one address holding two outstanding invitations.
  expect(h.invites()).toHaveLength(1);
  // …and it did not try the email again either, which is what the ceiling asked for.
  expect(h.emails).toHaveLength(1);
});

test('the rate-limited replay is per KEY, not a lockout — a fresh key is a fresh decision', async () => {
  const h = harness({ outcome: { sent: false, kind: 'team-invite', reason: 'rate-limited', retryAfterSeconds: 1800 } });
  await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1'));
  const refused = await refusal(() => h.service.invitePracticeMember(CTX, inviteRequest(), 'key-2'));
  expect(refused.code).toBe('NT-RATE-001');
  // The operator's own retry still reaches the send path; only the replay is short-circuited.
  expect(h.emails).toHaveLength(2);
});

// ---- idempotency -------------------------------------------------------------

test('a replayed key does no work twice; the same key with a different body is 409', async () => {
  const h = harness();
  const first = await h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1');
  const replay = await h.service.invitePracticeMember(CTX, inviteRequest(), 'key-1');
  expect(replay).toEqual(first);
  expect(h.invites()).toHaveLength(1);
  expect(h.emails).toHaveLength(1);

  const conflict = await refusal(() =>
    h.service.invitePracticeMember(CTX, inviteRequest({ email: 'other@ledgerline.test' }), 'key-1'),
  );
  expect(conflict.code).toBe('NT-IDM-001');
});

// ---- the list ----------------------------------------------------------------

test('the member list refuses a caller with no practice in scope', async () => {
  const h = harness();
  const query = listPracticeMembersQueryParams.parse({ limit: 25 });
  const businessOnly = ScopeContextSchema.parse({ actorId: 'usr_1', businessId: 'biz_a' });
  const refused = await refusal(() => h.service.listPracticeMembers(businessOnly, query));
  expect(refused.code).toBe('NT-PRM-001');
  expect(refused.getStatus()).toBe(403);
});
