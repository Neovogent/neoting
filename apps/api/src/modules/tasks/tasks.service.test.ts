import { expect, test } from 'vitest';

import { listTasksResponse, replaceTaskResponse } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { TASK_ASSIGNED_EVENT, TasksService } from './tasks.service.js';

/**
 * Tasks (review item 54), through a recording fake Prisma. What these pin, in
 * order of what it would cost to lose:
 *
 * 1. **Completing a recurring task creates the next one** — the whole of the
 *    recurrence feature, and the reason no worker was built. Asserted on the
 *    `data` that REACHES the database, because a service that returned a
 *    plausible `nextOccurrence` without writing one would pass any assertion
 *    made on the response.
 * 2. **A dependency cannot cross clients or close a cycle.** Neither can be
 *    enforced by a UI, and a cycle makes a chain of blocked tasks unreadable
 *    to a conclusion.
 * 3. **Assignment writes a notification — and self-assignment does not.** The
 *    bell exists to tell you something you did not do.
 * 4. **Nothing here mints an ActionProposal.** Item 66 tier 3, asserted
 *    structurally rather than trusted to a comment.
 */

const CTX: ScopeContext = { actorId: 'usr_me', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const NOW = new Date('2026-09-07T09:00:00.000Z');

function taskRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tsk_1',
    businessId: 'biz_1',
    title: 'Reconcile the bank',
    description: null,
    ownerUserId: 'usr_kate',
    dueAt: new Date(Date.UTC(2026, 8, 30)),
    status: 'open',
    cadence: null,
    dependsOnTaskId: null,
    aiPrefilledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    business: { name: 'Zeplow Inc.' },
    ...over,
  };
}

interface Calls {
  findMany: { where?: unknown; orderBy?: unknown }[];
  create: { data?: Record<string, unknown> }[];
  update: { where?: unknown; data?: Record<string, unknown> }[];
  updateMany: { where?: unknown; data?: Record<string, unknown> }[];
  deleteMany: { where?: unknown }[];
  notifications: { data?: Record<string, unknown> }[];
}

/**
 * `byId` is what makes the dependency walk testable: `findUnique` answers from
 * it, so a chain (and a cycle) is expressed as data rather than as a mock
 * sequence nobody can read.
 */
function fixture(options: { rows?: ReturnType<typeof taskRow>[]; byId?: Record<string, unknown> } = {}) {
  const rows = options.rows ?? [taskRow()];
  const byId = options.byId ?? { tsk_1: rows[0] };
  const calls: Calls = { findMany: [], create: [], update: [], updateMany: [], deleteMany: [], notifications: [] };
  let nextId = 0;
  const tx = {
    $executeRaw: async () => 0,
    task: {
      findMany: async (args: Calls['findMany'][number]) => {
        calls.findMany.push(args);
        return rows;
      },
      findUnique: async (args: { where: { id: string } }) => byId[args.where.id] ?? null,
      create: async (args: Calls['create'][number]) => {
        calls.create.push(args);
        nextId += 1;
        return taskRow({ ...args.data, id: `tsk_new_${nextId}` });
      },
      update: async (args: Calls['update'][number]) => {
        calls.update.push(args);
        return taskRow({ ...(byId[(args.where as { id: string }).id] as object), ...args.data });
      },
      updateMany: async (args: Calls['updateMany'][number]) => {
        calls.updateMany.push(args);
        return { count: 1 };
      },
      deleteMany: async (args: Calls['deleteMany'][number]) => {
        calls.deleteMany.push(args);
        return { count: 1 };
      },
    },
    business: {
      findUnique: async () => ({ id: 'biz_1' }),
      findMany: async () => [{ practiceId: 'prac_1' }],
    },
    membership: { findFirst: async () => ({ id: 'mem_1' }) },
    user: {
      findMany: async () => [{ id: 'usr_kate', firstName: 'Kate', lastName: 'Okafor', email: 'kate@firm.test' }],
    },
    notification: {
      create: async (args: Calls['notifications'][number]) => {
        calls.notifications.push(args);
        return { id: 'ntf_1' };
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  return { calls, service: new TasksService(prisma, new InMemoryIdempotencyStore()) };
}

test('the list parses as the contract, sorts soonest-due first and puts undated last', async () => {
  const { calls, service } = fixture();
  const page = await service.list(CTX, { limit: 50 });

  // NULLS LAST in both directions is `dateField`'s nullable branch. A board is
  // read to find what is next, and a row with no date is never next.
  expect(calls.findMany[0]?.orderBy).toEqual([{ dueAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]);
  expect(listTasksResponse.safeParse(page).success).toBe(true);
  expect(page.data[0]).toMatchObject({ id: 'tsk_1', dueDate: '2026-09-30', businessName: 'Zeplow Inc.' });
  // Projected server-side so a board does not have to hold the member list.
  expect(page.data[0]?.assigneeName).toBe('Kate Okafor');
});

test('the three filters narrow; omitting them spans every workspace RLS allows', async () => {
  const { calls, service } = fixture();
  await service.list(CTX, { limit: 50, businessId: 'biz_1', status: 'open', assigneeUserId: 'usr_kate' });
  await service.list(CTX, { limit: 50 });

  const where = JSON.stringify(calls.findMany[0]?.where);
  expect(where).toContain('"businessId":"biz_1"');
  expect(where).toContain('"status":"open"');
  // The contract calls it `assigneeUserId`; the column is `ownerUserId`.
  expect(where).toContain('"ownerUserId":"usr_kate"');
  expect(calls.findMany[1]?.where).toEqual({});
});

test('create writes status open and a UTC-midnight due date', async () => {
  const { calls, service } = fixture();
  const task = await service.create(
    CTX,
    { businessId: 'biz_1', title: 'Chase the VAT paperwork', dueDate: '2026-10-31' },
    'key-create',
  );

  expect(calls.create[0]?.data).toMatchObject({ businessId: 'biz_1', status: 'open' });
  expect((calls.create[0]?.data?.['dueAt'] as Date).toISOString()).toBe('2026-10-31T00:00:00.000Z');
  expect(replaceTaskResponse.safeParse(task).success).toBe(true);
});

test('⚠ completing a RECURRING task writes the next occurrence, rolled from the OLD due date', async () => {
  const recurring = taskRow({ cadence: 'monthly', dueAt: new Date(Date.UTC(2026, 8, 30)) });
  const { calls, service } = fixture({ rows: [recurring], byId: { tsk_1: recurring } });

  const { task, nextOccurrence } = await service.setStatus(CTX, 'tsk_1', { status: 'complete' }, 'key-tick');

  expect(task.status).toBe('complete');
  // The row that actually reached the database — not the mapped response.
  expect(calls.create[0]?.data).toMatchObject({
    businessId: 'biz_1',
    title: 'Reconcile the bank',
    ownerUserId: 'usr_kate',
    cadence: 'monthly',
    status: 'open',
  });
  // From 30 Sep, not from "today": a task completed four days late is still due
  // on the same day next month, and rolling from `now` walks the series later
  // every cycle.
  expect((calls.create[0]?.data?.['dueAt'] as Date).toISOString()).toBe('2026-10-30T00:00:00.000Z');
  expect(nextOccurrence?.status).toBe('open');
});

test('a ONE-OFF task generates nothing, and neither does reopening a recurring one', async () => {
  const oneOff = taskRow({ cadence: null });
  const first = fixture({ rows: [oneOff], byId: { tsk_1: oneOff } });
  expect((await first.service.setStatus(CTX, 'tsk_1', { status: 'complete' }, 'k1')).nextOccurrence).toBeNull();
  expect(first.calls.create).toHaveLength(0);

  // Already complete → open is a REOPEN. Only a transition OUT of `open` on a
  // recurring task generates, or every correction would mint another row.
  const done = taskRow({ cadence: 'monthly', status: 'complete' });
  const second = fixture({ rows: [done], byId: { tsk_1: done } });
  expect((await second.service.setStatus(CTX, 'tsk_1', { status: 'open' }, 'k2')).nextOccurrence).toBeNull();
  expect(second.calls.create).toHaveLength(0);
});

test('⚠ a blocker on ANOTHER client is refused — NT-TSK-001', async () => {
  const { service } = fixture({ byId: { tsk_other: taskRow({ id: 'tsk_other', businessId: 'biz_2' }) } });

  const error = await service
    .create(CTX, { businessId: 'biz_1', title: 'Blocked', dependsOnTaskId: 'tsk_other' }, 'key-x')
    .catch((e: AppException) => e);

  expect((error as AppException).code).toBe('NT-TSK-001');
});

test('⚠ a dependency that would close a CYCLE is refused — NT-TSK-002', async () => {
  // tsk_2 already waits on tsk_1. Pointing tsk_1 at tsk_2 closes the loop.
  const one = taskRow({ id: 'tsk_1' });
  const two = taskRow({ id: 'tsk_2', dependsOnTaskId: 'tsk_1' });
  const { service } = fixture({ byId: { tsk_1: one, tsk_2: two } });

  const error = await service
    .replace(CTX, 'tsk_1', { title: 'Reconcile the bank', dependsOnTaskId: 'tsk_2' }, 'key-cycle')
    .catch((e: AppException) => e);

  expect((error as AppException).code).toBe('NT-TSK-002');

  // And the shortest cycle of all: a task waiting on itself.
  const selfError = await service
    .replace(CTX, 'tsk_1', { title: 'Reconcile the bank', dependsOnTaskId: 'tsk_1' }, 'key-self')
    .catch((e: AppException) => e);
  expect((selfError as AppException).code).toBe('NT-TSK-002');
});

test('assigning to a colleague writes one task.assigned notification for THEM', async () => {
  const { calls, service } = fixture();
  await service.create(CTX, { businessId: 'biz_1', title: 'Code the receipts', assigneeUserId: 'usr_kate' }, 'key-a');

  expect(calls.notifications).toHaveLength(1);
  expect(calls.notifications[0]?.data).toMatchObject({
    businessId: 'biz_1',
    event: TASK_ASSIGNED_EVENT,
    recipientUserId: 'usr_kate',
  });
});

test('⚠ assigning to YOURSELF writes nothing — the bell is for what you did not do', async () => {
  const { calls, service } = fixture();
  await service.create(CTX, { businessId: 'biz_1', title: 'My own job', assigneeUserId: CTX.actorId }, 'key-b');
  expect(calls.notifications).toHaveLength(0);
});

test('re-saving a task without changing the assignee does NOT re-notify', async () => {
  // Otherwise the bell becomes the thing people mute, and then item 12's whole
  // surface is worth nothing.
  const { calls, service } = fixture();
  await service.replace(CTX, 'tsk_1', { title: 'Reconcile the bank, carefully', assigneeUserId: 'usr_kate' }, 'key-c');
  expect(calls.notifications).toHaveLength(0);
});

test('deleting a task UNBLOCKS its dependents rather than deleting them', async () => {
  const { calls, service } = fixture();
  await service.delete(CTX, 'tsk_1', 'key-del');

  expect(calls.updateMany[0]).toEqual({ where: { dependsOnTaskId: 'tsk_1' }, data: { dependsOnTaskId: null } });
  expect(calls.deleteMany[0]).toEqual({ where: { id: 'tsk_1' } });
});

test('a status or cadence from outside the enum reads as open / none, never a crash', async () => {
  // Both columns are free `String?` in Prisma and predate this contract, so a
  // hand-run SQL fix can put anything there. A board that 500s on one row is
  // worse than one that shows it as open.
  const rogue = taskRow({ status: 'archived', cadence: 'fortnightly' });
  const { service } = fixture({ rows: [rogue] });
  const page = await service.list(CTX, { limit: 50 });

  expect(page.data[0]?.status).toBe('open');
  expect(page.data[0]?.cadence).toBeNull();
  expect(listTasksResponse.safeParse(page).success).toBe(true);
});

test('⚠ no write path here mints an ActionProposal (item 66 tier 3)', async () => {
  // Structural, not a comment: the fake exposes no `actionProposal` delegate at
  // all, so any attempt to create one throws rather than passing silently.
  const { service } = fixture();
  await service.create(CTX, { businessId: 'biz_1', title: 'A task' }, 'k-1');
  await service.replace(CTX, 'tsk_1', { title: 'A task, renamed' }, 'k-2');
  await service.setStatus(CTX, 'tsk_1', { status: 'complete' }, 'k-3');
  await service.delete(CTX, 'tsk_1', 'k-4');
  // Reaching here at all is the assertion; this keeps it honest for a reader.
  expect(true).toBe(true);
});
