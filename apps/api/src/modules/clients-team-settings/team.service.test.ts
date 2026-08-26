import { expect, test } from 'vitest';

import { inviteBusinessMemberBody, listBusinessMembersQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import type { NotificationsService, SendClientInviteInput, SendOutcome } from '../notifications/index.js';
import type { MembershipRow } from './projections.js';
import { hashSetupToken } from './setup-link.js';
import { TeamService } from './team.service.js';

const PRACTICE = 'prac_1';
const BUSINESS = 'biz_1';
const CTX = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: PRACTICE });
const NOW = Date.parse('2026-08-26T09:00:00.000Z');
const SENT: SendOutcome = { sent: true, kind: 'client-invite', providerMessageId: 'msg_1' };

function membership(over: Partial<MembershipRow> = {}): MembershipRow {
  return {
    id: 'mem_1',
    userId: 'usr_2',
    practiceId: null,
    businessId: BUSINESS,
    role: 'BUSINESS_ADMIN',
    permissions: [],
    hideFinancialFields: false,
    isOwner: false,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    user: { id: 'usr_2', email: 'ana@sparkle.test', firstName: 'Ana', lastName: 'Rossi' },
    ...over,
  } as MembershipRow;
}

function inviteRequest(over: Record<string, unknown> = {}) {
  return inviteBusinessMemberBody.parse({ email: 'Sam@Sparkle.test', role: 'BUSINESS_STANDARD', ...over });
}

function harness(
  options: {
    business?: { id: string; practiceId: string | null; name?: string } | null;
    members?: MembershipRow[];
    existingContact?: boolean;
    outcome?: SendOutcome;
  } = {},
) {
  const memberQueries: { where?: unknown; orderBy?: unknown; take?: number }[] = [];
  const writes: { model: string; data: Record<string, unknown> }[] = [];
  const emails: SendClientInviteInput[] = [];
  const business = options.business === undefined ? { id: BUSINESS, practiceId: PRACTICE, name: 'Sparkle' } : options.business;

  const record = (model: string) => async ({ data }: { data: Record<string, unknown> }) => {
    writes.push({ model, data });
    return { id: `${model}_1`, createdAt: new Date(NOW), acceptedAt: null, practiceId: null, ...data };
  };

  const tx = {
    $executeRaw: async () => 0,
    business: {
      findUnique: async () =>
        business === null ? null : { ...business, practice: business.practiceId === null ? null : { name: 'Mercer & Co' } },
    },
    membership: {
      findMany: async (args: { where?: unknown; orderBy?: unknown; take?: number }) => {
        memberQueries.push(args);
        return options.members ?? [membership()];
      },
    },
    contact: {
      findFirst: async () => (options.existingContact === true ? { id: 'con_1' } : null),
      create: record('contact'),
    },
    invite: { create: record('invite') },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;

  const notifications = {
    sendClientInvite: async (input: SendClientInviteInput): Promise<SendOutcome> => {
      emails.push(input);
      return options.outcome ?? SENT;
    },
  } as unknown as NotificationsService;

  const service = new TeamService(prisma, notifications, new InMemoryIdempotencyStore(), {
    appOrigin: 'https://app.example.test',
  }, () => NOW);

  const of = (model: string) => writes.filter((write) => write.model === model).map((write) => write.data);
  return { service, memberQueries, writes, emails, of };
}

async function refusal(promise: Promise<unknown>): Promise<AppException> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: AppException) => error,
  );
}

const QUERY = listBusinessMembersQueryParams.parse({});

test('the member list is the practice-wide staff plus this client\'s own people — and no other client\'s', async () => {
  const { service, memberQueries } = harness();

  await service.listMembers(CTX, BUSINESS, QUERY);

  const where = memberQueries[0]?.where as { AND: unknown[] };
  expect(where.AND).toContainEqual({ OR: [{ businessId: BUSINESS }, { practiceId: PRACTICE, businessId: null }] });
  // `{ practiceId }` alone would match a colleague's membership on a DIFFERENT
  // client of the same practice, and list every client's staff on every client.
  expect(JSON.stringify(where)).toContain('"businessId":null');
});

test('SYSTEM actors are filtered out in the query, not after it', async () => {
  const { service, memberQueries } = harness();

  await service.listMembers(CTX, BUSINESS, QUERY);

  expect((memberQueries[0]?.where as { AND: unknown[] }).AND).toContainEqual({ user: { kind: 'HUMAN' } });
});

test('a standalone business has no practice branch — nobody is admitted by a null practice', async () => {
  const { service, memberQueries } = harness({ business: { id: BUSINESS, practiceId: null } });

  await service.listMembers(CTX, BUSINESS, QUERY);

  expect((memberQueries[0]?.where as { AND: unknown[] }).AND).toContainEqual({ OR: [{ businessId: BUSINESS }] });
});

test('a client RLS cannot see is a 404 — and the membership table is NEVER queried', async () => {
  // The negative half is the one that matters: `memberships` carries no RLS, so
  // a refactor that queried it before checking the business would read another
  // practice's team and the 404 would still look right.
  const { service, memberQueries } = harness({ business: null });

  const error = await refusal(service.listMembers(CTX, 'biz_elsewhere', QUERY));

  expect(error.getStatus()).toBe(404);
  expect(memberQueries).toHaveLength(0);
});

test('members project onto the contract shape, and `scope` says how they reach the client', async () => {
  const { service } = harness({
    members: [
      membership({ id: 'mem_biz' }),
      membership({ id: 'mem_prac', businessId: null, practiceId: PRACTICE, role: 'PRACTICE_ADMIN', isOwner: true }),
    ],
  });

  const page = await service.listMembers(CTX, BUSINESS, QUERY);

  expect(page.data.map((member) => [member.membershipId, member.scope, member.role])).toEqual([
    ['mem_biz', 'business', 'BUSINESS_ADMIN'],
    ['mem_prac', 'practice', 'PRACTICE_ADMIN'],
  ]);
  // D44 is visible on the surface without being enforced by it: the screen can
  // show who may release; the check lives on the approve path (A12).
  expect(page.data[1]?.isOwner).toBe(true);
});

test('a practice-level role is refused with NT-VAL-001, and no invite is written', async () => {
  const { service, writes } = harness();

  const error = await refusal(service.inviteMember(CTX, BUSINESS, inviteRequest({ role: 'PRACTICE_ADMIN' }), 'key-1'));

  expect(error.getStatus()).toBe(400);
  expect(error.code).toBe('NT-VAL-001');
  expect(writes).toHaveLength(0);
});

test('an invite records the identity decision: the invite row AND the permitted sender (D45)', async () => {
  const { service, emails, of } = harness();

  const invite = await service.inviteMember(CTX, BUSINESS, inviteRequest(), 'key-1');

  const token = new URL(emails[0]?.inviteLink ?? '').searchParams.get('setupToken') ?? '';
  expect(of('invite')[0]?.['tokenHash']).toBe(hashSetupToken(token));
  expect(of('invite')[0]?.['email']).toBe('sam@sparkle.test');
  expect(of('contact')[0]).toMatchObject({ email: 'sam@sparkle.test', isPrimary: false, receivesChases: false });
  // The token is never in the response. An invite readable from an API response
  // is an invite anyone with read access can accept.
  expect(JSON.stringify(invite)).not.toContain(token);
  expect(Object.keys(invite)).not.toContain('token');
});

test('re-inviting someone does not accumulate duplicate contacts', async () => {
  // There is no unique index on (business, email) — `prisma/` is LAW — so a
  // second contact row would be a second sender-map entry for one person.
  const { service, of } = harness({ existingContact: true });

  await service.inviteMember(CTX, BUSINESS, inviteRequest(), 'key-1');

  expect(of('contact')).toHaveLength(0);
  expect(of('invite')).toHaveLength(1);
});

test('a rate-limited invite email is a 429 the accountant can act on, and the invite row is kept', async () => {
  const { service, of } = harness({
    outcome: { sent: false, kind: 'client-invite', reason: 'rate-limited', retryAfterSeconds: 90 },
  });

  const error = await refusal(service.inviteMember(CTX, BUSINESS, inviteRequest(), 'key-1'));

  expect(error.getStatus()).toBe(429);
  expect(error.code).toBe('NT-RATE-001');
  expect(error.publicDetail).toContain('90 seconds');
  expect(of('invite')).toHaveLength(1);
});

test('an invite for a client RLS cannot see is a 404 with nothing written', async () => {
  const { service, writes } = harness({ business: null });

  const error = await refusal(service.inviteMember(CTX, 'biz_elsewhere', inviteRequest(), 'key-1'));

  expect(error.getStatus()).toBe(404);
  expect(writes).toHaveLength(0);
});

test('one Idempotency-Key reused on a different client is a miss, not the other client\'s invite', async () => {
  const { service, of } = harness();

  await service.inviteMember(CTX, BUSINESS, inviteRequest(), 'shared-key');
  await service.inviteMember(CTX, 'biz_2', inviteRequest(), 'shared-key');

  // Two invites, because the replay namespace is per business. A flat map would
  // have handed the second caller the first client's invite.
  expect(of('invite')).toHaveLength(2);
});

test('the same key on the same client replays the original invite and writes nothing twice', async () => {
  const { service, of } = harness();

  const first = await service.inviteMember(CTX, BUSINESS, inviteRequest(), 'key-1');
  const second = await service.inviteMember(CTX, BUSINESS, inviteRequest(), 'key-1');

  expect(second).toEqual(first);
  expect(of('invite')).toHaveLength(1);
});
