import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { createBusinessBody, inviteBusinessMemberBody, listBusinessMembersQueryParams } from '@neoting/contracts/zod';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import type { NotificationsService, SendClientInviteInput, SendOutcome } from '../notifications/index.js';
import { ClientIntakeService } from './client-intake.service.js';
import { readBusinessProfile } from './business-profile.js';
import { hashSetupToken } from './setup-link.js';
import { TeamService } from './team.service.js';

/**
 * A11's acceptance, against a REAL database as `nt_app`:
 *
 * - client intake writes the workspace, its primary contact, **exactly one**
 *   active `VT` integration and the setup invite in ONE transaction that
 *   `businesses_tenant`'s `WITH CHECK` has to admit;
 * - the business-type profile survives the `Json` column and reads back as the
 *   profile A6 consumes;
 * - a context naming a practice the actor does not belong to is refused **by
 *   Postgres**, not by a handler;
 * - another practice's staff get 404 on both team operations — and crucially,
 *   `memberships` is never reached, because that table has no RLS of its own.
 *
 * Id namespace: `a11_`, disjoint from every other suite. Teardown is by
 * explicit id, and the businesses this suite creates carry generated cuids, so
 * their ids are collected as they are made.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'a11_prac_a';
const P_B = 'a11_prac_b';
const USER_A = 'a11_usr_a';
const USER_B = 'a11_usr_b';
const USER_SYS = 'a11_usr_sys';
const USER_TEAM = 'a11_usr_team';
/**
 * Staff on a DIFFERENT client of practice A. A user of their own, deliberately:
 * giving this membership to `USER_B` would have made practice B's admin a
 * member of practice A, and `businesses_tenant`'s practice branch would then
 * legitimately show them everything — a fixture that quietly disproves the
 * isolation the next test is trying to assert.
 */
const USER_ELSEWHERE = 'a11_usr_elsewhere';
const OTHER_CLIENT = 'a11_biz_other';

const STAFF_A = ScopeContextSchema.parse({ actorId: USER_A, practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: USER_B, practiceId: P_B });

let owner: PrismaClient;
let app: PrismaClient;
const createdBusinessIds: string[] = [];
const emails: SendClientInviteInput[] = [];

const notifications = {
  sendClientInvite: async (input: SendClientInviteInput): Promise<SendOutcome> => {
    emails.push(input);
    return { sent: true, kind: 'client-invite', providerMessageId: 'msg_int' };
  },
} as unknown as NotificationsService;

function intake(): ClientIntakeService {
  return new ClientIntakeService(app, notifications, new InMemoryIdempotencyStore(), {
    appOrigin: 'https://app.example.test',
  });
}

function team(): TeamService {
  return new TeamService(app, notifications, new InMemoryIdempotencyStore(), { appOrigin: 'https://app.example.test' });
}

function request(over: Record<string, unknown> = {}) {
  return createBusinessBody.parse({
    name: 'Sparkle Cleaning Ltd',
    primaryContact: { firstName: 'Ana', lastName: 'Rossi', email: 'ana@sparkle.test' },
    contextQuestionnaire: {
      businessActivity: 'Commercial cleaning for offices and schools',
      typicalSuppliers: ['Nisbets'],
      typicalCosts: ['Cleaning materials'],
      hasEmployees: true,
    },
    ...over,
  });
}

async function cleanup(): Promise<void> {
  // Businesses this suite created carry generated ids, so they are removed by
  // the collected list plus their practice anchor — never by a prefix match on
  // a column another suite also writes. `contacts`, `integrations` and `invites`
  // cascade from the business.
  await owner.business.deleteMany({ where: { id: { in: [...createdBusinessIds, OTHER_CLIENT] } } });
  await owner.business.deleteMany({ where: { practiceId: { in: [P_A, P_B] } } });
  await owner.membership.deleteMany({ where: { userId: { in: [USER_A, USER_B, USER_SYS, USER_TEAM, USER_ELSEWHERE] } } });
  await owner.user.deleteMany({ where: { id: { in: [USER_A, USER_B, USER_SYS, USER_TEAM, USER_ELSEWHERE] } } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'Mercer & Co' }, { id: P_B, name: 'Other Firm' }] });
  await owner.user.createMany({
    data: [
      { id: USER_A, email: 'a11a@example.test' },
      { id: USER_B, email: 'a11b@example.test' },
      { id: USER_TEAM, email: 'a11team@example.test' },
      { id: USER_ELSEWHERE, email: 'a11elsewhere@example.test' },
      { id: USER_SYS, kind: 'SYSTEM' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'a11_mem_a', userId: USER_A, practiceId: P_A, role: 'PRACTICE_ADMIN', isOwner: true },
      { id: 'a11_mem_b', userId: USER_B, practiceId: P_B, role: 'PRACTICE_ADMIN' },
      { id: 'a11_mem_sys', userId: USER_SYS, practiceId: P_A, role: 'PRACTICE_STANDARD' },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

test.runIf(enabled)('intake writes the workspace, the contact, ONE VT integration and the invite — under RLS', async () => {
  const business = await intake().createClient(STAFF_A, request(), 'a11-key-1');
  createdBusinessIds.push(business.id);

  expect(business.practiceId).toBe(P_A);

  // Read back as the OWNER: the assertion is about what landed, and reading it
  // through the same policies that wrote it could hide a row that did not.
  const integrations = await owner.integration.findMany({ where: { businessId: business.id } });
  expect(integrations).toHaveLength(1);
  expect(integrations[0]?.kind).toBe('VT');
  expect(integrations[0]?.isActive).toBe(true);
  // No connection was made, so nothing may claim one was.
  expect(integrations[0]?.orgRef).toBeNull();
  expect(integrations[0]?.tokenRef).toBeNull();
  expect(integrations[0]?.health).toBeNull();

  const contacts = await owner.contact.findMany({ where: { businessId: business.id } });
  expect(contacts).toHaveLength(1);
  expect(contacts[0]?.email).toBe('ana@sparkle.test');
  expect(contacts[0]?.isPrimary).toBe(true);

  const invites = await owner.invite.findMany({ where: { businessId: business.id } });
  expect(invites).toHaveLength(1);
  const token = new URL(emails.at(-1)?.inviteLink ?? '').searchParams.get('setupToken') ?? '';
  expect(invites[0]?.tokenHash).toBe(hashSetupToken(token));
});

test.runIf(enabled)('the business-type profile survives the Json column and reads back for A6', async () => {
  const business = await intake().createClient(STAFF_A, request({ name: 'Profile Round Trip Ltd' }), 'a11-key-2');
  createdBusinessIds.push(business.id);

  const row = await owner.business.findUnique({ where: { id: business.id }, select: { contextQuestionnaire: true } });

  expect(readBusinessProfile(row?.contextQuestionnaire)).toEqual({
    businessActivity: 'Commercial cleaning for offices and schools',
    typicalSuppliers: ['Nisbets'],
    typicalCosts: ['Cleaning materials'],
    hasEmployees: true,
  });
  // And through the module's own read, which is the call A6 makes.
  expect(await intake().getClientProfile(STAFF_A, business.id)).not.toBeNull();
});

test.runIf(enabled)('a context naming a practice the actor does not belong to is refused by POSTGRES', async () => {
  // Not by a handler check — `businesses_tenant`'s WITH CHECK is what refuses
  // it, so the guarantee survives any future code path that forgets to look.
  const forged = ScopeContextSchema.parse({ actorId: USER_A, practiceId: P_B });

  await expect(intake().createClient(forged, request({ name: 'Forged Ltd' }), 'a11-key-3')).rejects.toThrow(
    /row-level security/i,
  );

  expect(await owner.business.count({ where: { practiceId: P_B } })).toBe(0);
});

test.runIf(enabled)('another practice cannot read the profile of a client it cannot see — 404, never 403', async () => {
  const business = await intake().createClient(STAFF_A, request({ name: 'Invisible Ltd' }), 'a11-key-4');
  createdBusinessIds.push(business.id);

  const error: AppException = await intake()
    .getClientProfile(STAFF_B, business.id)
    .then(
      () => {
        throw new Error('expected a refusal');
      },
      (thrown: AppException) => thrown,
    );

  expect(error.getStatus()).toBe(404);
});

test.runIf(enabled)('the team list is this client\'s people and the practice staff — no SYSTEM, no other client', async () => {
  const business = await intake().createClient(STAFF_A, request({ name: 'Team List Ltd' }), 'a11-key-5');
  createdBusinessIds.push(business.id);

  // One person on THIS client, and one on a different client of the same
  // practice — the row that a `{ practiceId }`-only filter would wrongly admit.
  await owner.business.create({ data: { id: OTHER_CLIENT, practiceId: P_A, name: 'Another Client' } });
  await owner.membership.createMany({
    data: [
      { id: 'a11_mem_team', userId: USER_TEAM, businessId: business.id, role: 'BUSINESS_ADMIN' },
      { id: 'a11_mem_elsewhere', userId: USER_ELSEWHERE, practiceId: P_A, businessId: OTHER_CLIENT, role: 'BUSINESS_STANDARD' },
    ],
  });

  const page = await team().listMembers(STAFF_A, business.id, listBusinessMembersQueryParams.parse({}));
  const ids = page.data.map((member) => member.membershipId);

  expect(ids).toContain('a11_mem_team'); // the client's own person
  expect(ids).toContain('a11_mem_a'); // practice-wide staff
  expect(ids).not.toContain('a11_mem_sys'); // the SYSTEM actor is never listed
  expect(ids).not.toContain('a11_mem_elsewhere'); // another client's staff
  expect(ids).not.toContain('a11_mem_b'); // another practice entirely
});

test.runIf(enabled)('another practice listing or inviting into a client it cannot see gets 404', async () => {
  const business = await intake().createClient(STAFF_A, request({ name: 'Not Yours Ltd' }), 'a11-key-6');
  createdBusinessIds.push(business.id);

  const service = team();
  const listed = await service
    .listMembers(STAFF_B, business.id, listBusinessMembersQueryParams.parse({}))
    .then(() => null, (thrown: AppException) => thrown);
  const invited = await service
    .inviteMember(STAFF_B, business.id, inviteBusinessMemberBody.parse({ email: 'x@y.test', role: 'BUSINESS_STANDARD' }), 'a11-key-7')
    .then(() => null, (thrown: AppException) => thrown);

  expect(listed?.getStatus()).toBe(404);
  expect(invited?.getStatus()).toBe(404);
  // Nothing was written into someone else's workspace on the way to that 404.
  expect(await owner.invite.count({ where: { businessId: business.id, email: 'x@y.test' } })).toBe(0);
});

test.runIf(enabled)('an invite lands under RLS with only the token hash, and makes the invitee a permitted sender', async () => {
  const business = await intake().createClient(STAFF_A, request({ name: 'Invite Ltd' }), 'a11-key-8');
  createdBusinessIds.push(business.id);

  const invite = await team().inviteMember(
    STAFF_A,
    business.id,
    inviteBusinessMemberBody.parse({ email: 'Sam@Sparkle.test', role: 'BUSINESS_STANDARD' }),
    'a11-key-9',
  );

  const row = await owner.invite.findUnique({ where: { id: invite.id } });
  const token = new URL(emails.at(-1)?.inviteLink ?? '').searchParams.get('setupToken') ?? '';
  expect(row?.tokenHash).toBe(hashSetupToken(token));
  expect(row?.email).toBe('sam@sparkle.test');

  // D45: the address is now a contact, which is what `ingestion-routing`'s
  // sender map keys on — without it their forwarded email lands Unrouted.
  const contact = await owner.contact.findFirst({ where: { businessId: business.id, email: 'sam@sparkle.test' } });
  expect(contact).not.toBeNull();
  expect(contact?.receivesChases).toBe(false);
});
