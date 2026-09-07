import { expect, test } from 'vitest';

import { listTeamsResponse, replaceTeamResponse } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { accessLevelFor, TeamsService } from './teams.service.js';

/**
 * Teams (review item 54, second half). The one thing these tests are really
 * about: **a team grants nothing**, and `accessLevel` is a DERIVED label over
 * `memberships` rather than a stored second answer to "what can this person
 * reach". The complementary assertion lives in SQL — `tenancy-check.sql` §12
 * pins that no policy in the database consults `team_members` at all.
 */

const CTX: ScopeContext = { actorId: 'usr_me', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const NOW = new Date('2026-09-07T09:00:00.000Z');

function teamRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tem_1',
    practiceId: 'prac_1',
    name: 'VAT',
    createdAt: NOW,
    updatedAt: NOW,
    members: [{ userId: 'usr_kate' }, { userId: 'usr_sam' }],
    ...over,
  };
}

interface Calls {
  findMany: { where?: unknown; orderBy?: unknown }[];
  create: { data?: Record<string, unknown> }[];
  update: { where?: unknown; data?: Record<string, unknown> }[];
  memberDeleteMany: { where?: unknown }[];
  deleteMany: { where?: unknown }[];
}

function fixture(
  options: { rows?: ReturnType<typeof teamRow>[]; practiceWide?: string[]; colleagues?: string[]; clash?: boolean } = {},
) {
  const rows = options.rows ?? [teamRow()];
  const practiceWide = options.practiceWide ?? ['usr_kate', 'usr_sam'];
  const colleagues = options.colleagues ?? ['usr_kate', 'usr_sam', 'usr_me'];
  const calls: Calls = { findMany: [], create: [], update: [], memberDeleteMany: [], deleteMany: [] };
  const tx = {
    $executeRaw: async () => 0,
    team: {
      findMany: async (args: Calls['findMany'][number]) => {
        calls.findMany.push(args);
        return rows;
      },
      findUnique: async () => rows[0] ?? null,
      findFirst: async () => (options.clash === true ? { id: 'tem_other' } : null),
      create: async (args: Calls['create'][number]) => {
        calls.create.push(args);
        return teamRow({ ...args.data, members: rows[0]?.members ?? [] });
      },
      update: async (args: Calls['update'][number]) => {
        calls.update.push(args);
        return teamRow({ ...args.data, members: rows[0]?.members ?? [] });
      },
      deleteMany: async (args: Calls['deleteMany'][number]) => {
        calls.deleteMany.push(args);
        return { count: 1 };
      },
    },
    teamMember: {
      deleteMany: async (args: Calls['memberDeleteMany'][number]) => {
        calls.memberDeleteMany.push(args);
        return { count: 2 };
      },
    },
    business: { findMany: async () => [{ practiceId: 'prac_1' }] },
    membership: {
      findMany: async (args: { where: { userId: { in: string[] }; businessId?: null } }) => {
        // Two different reads share this delegate: the colleague check (no
        // businessId clause) and the practice-wide read (businessId: null).
        const pool = 'businessId' in args.where ? practiceWide : colleagues;
        return args.where.userId.in.filter((id) => pool.includes(id)).map((userId) => ({ userId }));
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  return { calls, service: new TeamsService(prisma, new InMemoryIdempotencyStore()) };
}

test('the list parses as the contract and reads oldest first', async () => {
  const { calls, service } = fixture();
  const page = await service.list(CTX, { limit: 50 });

  expect(calls.findMany[0]?.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  expect(listTeamsResponse.safeParse(page).success).toBe(true);
  expect(page.data[0]).toMatchObject({ id: 'tem_1', name: 'VAT', memberUserIds: ['usr_kate', 'usr_sam'] });
});

test('⚠ accessLevel is DERIVED from memberships, not stored', async () => {
  // Everyone practice-wide → "all clients".
  const all = await fixture({ practiceWide: ['usr_kate', 'usr_sam'] }).service.list(CTX, { limit: 50 });
  expect(all.data[0]?.accessLevel).toBe('all-clients');

  // One member scoped to particular clients → the whole team is narrowed. The
  // label describes what the team can collectively reach, and one person on a
  // per-client membership means it is not everything.
  const some = await fixture({ practiceWide: ['usr_kate'] }).service.list(CTX, { limit: 50 });
  expect(some.data[0]?.accessLevel).toBe('assigned-clients');
});

test('⚠ an EMPTY team is assigned-clients, never all-clients', () => {
  // "Every member holds a practice-wide membership" is vacuously true of
  // nobody, and a team of nobody reading as *All clients* on a card is the most
  // misleading answer available. Tested at the pure function, which is where
  // the vacuous-truth trap actually lives.
  expect(accessLevelFor([], new Set())).toBe('assigned-clients');
  expect(accessLevelFor(['a'], new Set(['a']))).toBe('all-clients');
  expect(accessLevelFor(['a', 'b'], new Set(['a']))).toBe('assigned-clients');
});

test('create stores the name and the membership, and nothing resembling an access grant', async () => {
  const { calls, service } = fixture();
  const team = await service.create(CTX, { name: 'VAT', memberUserIds: ['usr_kate', 'usr_sam'] }, 'key-create');

  const data = calls.create[0]?.data ?? {};
  expect(data).toMatchObject({ practiceId: 'prac_1', name: 'VAT' });
  // The structural half: no field on the write resembles an access setting. If
  // a future edit adds one, this fails rather than shipping a second answer to
  // "what can this person reach".
  expect(Object.keys(data).sort()).toEqual(['members', 'name', 'practiceId']);
  expect(replaceTeamResponse.safeParse(team).success).toBe(true);
});

test('replace clears the membership before writing the new one', async () => {
  // Whole-list replace rather than a merge: a merge cannot express removing the
  // last member. Both statements are inside `scopedDb`'s transaction, so a
  // caller never observes the team empty.
  const { calls, service } = fixture();
  await service.replace(CTX, 'tem_1', { name: 'VAT & duties', memberUserIds: ['usr_kate'] }, 'key-rep');

  expect(calls.memberDeleteMany[0]).toEqual({ where: { teamId: 'tem_1' } });
  expect(calls.update[0]?.data).toMatchObject({ name: 'VAT & duties' });
});

test('⚠ a member who is not a colleague at this firm is refused — NT-TEM-002', async () => {
  const { service } = fixture({ colleagues: ['usr_kate'] });
  const error = await service
    .create(CTX, { name: 'VAT', memberUserIds: ['usr_kate', 'usr_stranger'] }, 'key-x')
    .catch((e: AppException) => e);
  expect((error as AppException).code).toBe('NT-TEM-002');
});

test('a duplicate team name is refused with a sentence, not a Prisma P2002 — NT-TEM-001', async () => {
  const { service } = fixture({ clash: true });
  const error = await service.create(CTX, { name: 'VAT', memberUserIds: [] }, 'key-y').catch((e: AppException) => e);
  expect((error as AppException).code).toBe('NT-TEM-001');
});
