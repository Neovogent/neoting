import { HttpStatus } from '@nestjs/common';
import type { Prisma, Task as TaskRow } from '@prisma/client';
import type { z } from 'zod';

import type { Task, TaskCadence, TaskStatus } from '@neoting/contracts/model';
import type {
  createTaskBody,
  listTasksQueryParams,
  replaceTaskBody,
  setTaskStatusBody,
} from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { advanceDueDate, isoDateFromUtc, utcMidnight } from './due-date.js';

type ListQuery = z.infer<typeof listTasksQueryParams>;
type CreateBody = z.infer<typeof createTaskBody>;
type EditBody = z.infer<typeof replaceTaskBody>;
type StatusBody = z.infer<typeof setTaskStatusBody>;

/** The row plus the one join the projection needs. */
type TaskWithBusiness = Prisma.TaskGetPayload<{ include: { business: { select: { name: true } } } }>;

/** The `notifications.event` string an assignment writes. One writer, one name. */
export const TASK_ASSIGNED_EVENT = 'task.assigned';

/**
 * The practice's checklist — `/v1/tasks` (review item 54, 7 Sep 2026).
 *
 * `tasks` has been a table since the init migration and **nothing had ever read
 * or written a row**: no operation in the contract named it, no service touched
 * it, and both Tasks tabs ran off React state that evaporated on reload. The
 * amber "no server behind them yet" banner in Mubashir's screenshot was that,
 * stated honestly. This class is the server the banner was waiting for; no
 * migration was needed, because every field the feature wants is already a
 * column.
 *
 * ## Every write here is tier 3 — no proposal, and that is a ruling
 *
 * Item 66 replaced `RELEASE_KINDS`' old question with *whose signature does
 * this carry*, and a ticked checkbox carries nobody's. Nothing in this file
 * touches a document's coding, a figure, a chase, an export, or anything
 * outside the product, and every write is undone by making the opposite one.
 * Governance §10's "no state change outside the ActionProposal path" is about
 * the CLIENT's state; minting a proposal for a checkbox would ask for a
 * signature on something nobody is signing for, and item 66's own finding is
 * that asking twice makes the second one mean less.
 *
 * What would move this to tier 2 is a task that ACTS — a checklist item that
 * publishes, or codes, or texts. There is none, and `aiPrefilledAt` is the
 * boundary: it records that an engine READ something, never that a task drove
 * one.
 *
 * ## Tenancy
 *
 * `tasks.business_id` is `NOT NULL` and the table is on rls.sql's
 * `direct_tables` loop, so `app_can_access_business(business_id)` bounds every
 * row and nothing here adds a second tenancy clause. That column being `NOT
 * NULL` is also why there is no practice-wide task: it would be a row no policy
 * could reach. "All clients" on the board is a FILTER over the set RLS already
 * decided, never a second scope.
 *
 * ## The two invariants the UI cannot enforce, so this file does
 *
 * A `dependsOnTaskId` must name a task on the SAME client (otherwise a
 * dependency is a cross-tenant handle in everything but name), and it may not
 * close a CYCLE (otherwise a chain of blocked tasks can never be read to a
 * conclusion). Both are checked on write. Neither is checked at completion:
 * the dependency is advisory ordering for a human, and the one occasion it
 * matters is the occasion the ordering was wrong.
 */
export class TasksService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async list(ctx: ScopeContext, query: ListQuery): Promise<Page<Task>> {
    const filters: Prisma.TaskWhereInput = {
      ...(query.businessId === undefined ? {} : { businessId: query.businessId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.assigneeUserId === undefined ? {} : { ownerUserId: query.assigneeUserId }),
    };
    const request: PageRequest<TaskWithBusiness> = {
      // Soonest due first, undated last. A board is read to find out what is
      // next, and a row with no date is never next — `dateField`'s nullable
      // branch is what pins NULLS LAST in both directions (cursor.ts).
      sort: DUE_AT,
      order: 'asc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      // The fingerprint covers what identifies the LIST, never the caller's
      // position in it — `cursor: undefined` is load-bearing (the
      // portal-documents lesson: folding the cursor in 400s every page 2).
      query: {
        businessId: query.businessId ?? null,
        status: query.status ?? null,
        assigneeUserId: query.assigneeUserId ?? null,
        limit: query.limit,
        cursor: undefined,
      },
    };
    const seek = pageQuery(request);

    return scopedDb(this.prisma, ctx, async (db) => {
      const rows = (await db.task.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.TaskOrderByWithRelationInput[],
        take: seek.take,
        include: { business: { select: { name: true } } },
      })) as TaskWithBusiness[];

      const page = toPage(rows, request);
      const names = await assigneeNames(db, page.data);
      return { data: page.data.map((row) => toTask(row, names)), pageInfo: page.pageInfo };
    });
  }

  async create(ctx: ScopeContext, body: CreateBody, idempotencyKey: string): Promise<Task> {
    const replay = await this.replayed<Task>(ctx, idempotencyKey, { create: body });
    if (replay !== null) return replay;

    const { task, notify } = await scopedDb(this.prisma, ctx, async (db) => {
      // Resolve the business through RLS BEFORE writing, the executors' guard:
      // the WITH CHECK would otherwise fail the insert as a 500, and a 404 here
      // neither confirms nor denies that the id names anything.
      const business = await db.business.findUnique({ where: { id: body.businessId }, select: { id: true } });
      if (business === null) throw notFound();

      await assertAssigneeIsColleague(db, body.assigneeUserId ?? null);
      await assertDependency(db, body.businessId, body.dependsOnTaskId ?? null, null);

      const row = await db.task.create({
        data: {
          businessId: body.businessId,
          ...writableFields(body),
          // Stated rather than left to the column default, because "every task
          // starts open" is a property of the contract (`TaskWriteRequest` has
          // no `status`) and a default is something a migration can move
          // without reading this file.
          status: 'open',
        },
        include: { business: { select: { name: true } } },
      });
      const names = await assigneeNames(db, [row]);
      return { task: toTask(row, names), notify: body.assigneeUserId ?? null };
    });

    await this.notifyAssignment(ctx, task, notify);
    await this.remember(ctx, idempotencyKey, { create: body }, task);
    return task;
  }

  /**
   * Replace the editable fields. Whole-task, so a retry writes the same bytes.
   *
   * `businessId` and `status` are absent from `EditBody` and there is therefore
   * no expression here that could move a task to another client or tick it —
   * {@link writableFields} is the single place a task's `data` is ever built.
   */
  async replace(ctx: ScopeContext, taskId: string, body: EditBody, idempotencyKey: string): Promise<Task> {
    const replay = await this.replayed<Task>(ctx, idempotencyKey, { taskId, body });
    if (replay !== null) return replay;

    const { task, notify } = await scopedDb(this.prisma, ctx, async (db) => {
      const existing = await db.task.findUnique({
        where: { id: taskId },
        select: { id: true, businessId: true, ownerUserId: true },
      });
      if (existing === null) throw notFound();

      await assertAssigneeIsColleague(db, body.assigneeUserId ?? null);
      await assertDependency(db, existing.businessId, body.dependsOnTaskId ?? null, taskId);

      const row = await db.task.update({
        where: { id: taskId },
        data: writableFields(body),
        include: { business: { select: { name: true } } },
      });
      const names = await assigneeNames(db, [row]);
      // ⚠ Only when the assignee actually CHANGES. Re-saving a description
      // must not re-notify, or the bell becomes the thing people mute.
      const changed = (body.assigneeUserId ?? null) !== existing.ownerUserId;
      return { task: toTask(row, names), notify: changed ? (body.assigneeUserId ?? null) : null };
    });

    await this.notifyAssignment(ctx, task, notify);
    await this.remember(ctx, idempotencyKey, { taskId, body }, task);
    return task;
  }

  /**
   * Tick, reopen, or close with a verdict — and generate the next occurrence
   * when a RECURRING task leaves `open`.
   *
   * ## Recurrence without a scheduler, deliberately
   *
   * The completion IS the tick: there is no cron, no worker and no dedupe
   * table, because the only event that can produce a next occurrence is a human
   * pressing a button exactly once. What this shape does NOT do is pile up
   * twelve copies of a monthly task nobody ever completed — which is the right
   * answer for a checklist and the wrong one for a calendar. If rows must
   * appear on the 1st whether or not last month closed, that is a worker and a
   * different feature with a different failure mode.
   *
   * Every transition is allowed in both directions. A checklist a human cannot
   * correct is worse than one they can, and re-opening a completed recurring
   * task does not un-generate its successor — the successor is a real row
   * somebody may already have picked up.
   */
  async setStatus(
    ctx: ScopeContext,
    taskId: string,
    body: StatusBody,
    idempotencyKey: string,
  ): Promise<{ task: Task; nextOccurrence: Task | null }> {
    const replay = await this.replayed<{ task: Task; nextOccurrence: Task | null }>(ctx, idempotencyKey, {
      taskId,
      body,
    });
    if (replay !== null) return replay;

    const response = await scopedDb(this.prisma, ctx, async (db) => {
      const existing = await db.task.findUnique({ where: { id: taskId } });
      if (existing === null) throw notFound();

      const row = await db.task.update({
        where: { id: taskId },
        data: { status: body.status },
        include: { business: { select: { name: true } } },
      });

      const recurring =
        existing.status === 'open' && body.status !== 'open' && isCadence(existing.cadence)
          ? await db.task.create({
              data: {
                businessId: existing.businessId,
                title: existing.title,
                description: existing.description,
                ownerUserId: existing.ownerUserId,
                cadence: existing.cadence,
                dependsOnTaskId: existing.dependsOnTaskId,
                // From the OLD due date, not from today: a monthly task
                // completed four days late is still due on the same day of the
                // next month, and rolling from `now` would walk the whole
                // series later every cycle. Undated in, undated out — there is
                // nothing to advance.
                dueAt: existing.dueAt === null ? null : advanceDueDate(existing.dueAt, existing.cadence),
                status: 'open',
              },
              include: { business: { select: { name: true } } },
            })
          : null;

      const names = await assigneeNames(db, recurring === null ? [row] : [row, recurring]);
      return {
        task: toTask(row, names),
        nextOccurrence: recurring === null ? null : toTask(recurring, names),
      };
    });

    await this.remember(ctx, idempotencyKey, { taskId, body }, response);
    return response;
  }

  /**
   * Delete. Idempotent: a task that is not there — removed already, or out of
   * the caller's reach, which looks identical from here — is a 204.
   *
   * Anything that DEPENDED on it is unblocked rather than deleted with it. A
   * blocker going away should free the work, not take it along.
   */
  async delete(ctx: ScopeContext, taskId: string, idempotencyKey: string): Promise<void> {
    await this.replayed<null>(ctx, idempotencyKey, { delete: taskId });

    await scopedDb(this.prisma, ctx, async (db) => {
      await db.task.updateMany({ where: { dependsOnTaskId: taskId }, data: { dependsOnTaskId: null } });
      await db.task.deleteMany({ where: { id: taskId } });
    });

    await this.remember(ctx, idempotencyKey, { delete: taskId }, null);
  }

  /**
   * One `notifications` row, so the assignee's bell shows it (item 12's read
   * surface, `GET /v1/notifications`). `NotificationItem.event` is a free
   * string by design, so this writer is purely additive — an event the bell
   * does not recognise renders its honest generic line.
   *
   * **Nothing is written when you assign to yourself.** The bell exists to tell
   * you something you did not do.
   *
   * Outside the `scopedDb` transaction that wrote the task, and after it: a
   * notification that fails must not roll back the assignment it describes.
   */
  private async notifyAssignment(ctx: ScopeContext, task: Task, assigneeUserId: string | null): Promise<void> {
    if (assigneeUserId === null || assigneeUserId === ctx.actorId) return;
    await scopedDb(this.prisma, ctx, (db) =>
      db.notification.create({
        data: {
          businessId: task.businessId,
          event: TASK_ASSIGNED_EVENT,
          recipientUserId: assigneeUserId,
          // Enough to navigate and nothing more, the `toNotificationItem`
          // rule. The title is NOT carried: `NotificationItem` has no field
          // for it, so it would be a payload nothing can read.
          payload: { taskId: task.id, assignedByUserId: ctx.actorId },
        },
      }),
    );
  }

  private async replayed<T>(ctx: ScopeContext, idempotencyKey: string, request: unknown): Promise<T | null> {
    const record = await this.idempotency.get(idempotencyKey);
    if (record === null) return null;
    if (record.requestHash !== fingerprint({ actorId: ctx.actorId, request })) {
      throw new AppException(
        'NT-IDM-001',
        HttpStatus.CONFLICT,
        'This Idempotency-Key was already used with a different payload',
        'Use a fresh Idempotency-Key for a different request.',
      );
    }
    return record.response as T;
  }

  private async remember(ctx: ScopeContext, idempotencyKey: string, request: unknown, response: unknown): Promise<void> {
    await this.idempotency.put(idempotencyKey, {
      requestHash: fingerprint({ actorId: ctx.actorId, request }),
      response: response as never,
    });
  }
}

/**
 * The fields a human may change by typing, in the one place they are spelled.
 *
 * ⚠ `businessId` and `status` are ABSENT and must stay absent. This function is
 * the whole reason neither write path can move a task to another client or tick
 * it sideways: there is no branch to audit, because there is only one
 * expression that ever builds a task's `data`.
 *
 * `?? null` throughout rather than a conditional spread: these are PUT bodies,
 * so an omitted field means "cleared", not "unchanged" — that is what makes a
 * replace idempotent.
 */
function writableFields(body: CreateBody | EditBody): WritableTaskFields {
  return {
    title: body.title,
    description: body.description ?? null,
    ownerUserId: body.assigneeUserId ?? null,
    dueAt: body.dueDate === undefined || body.dueDate === null ? null : utcMidnight(body.dueDate),
    cadence: body.cadence ?? null,
    dependsOnTaskId: body.dependsOnTaskId ?? null,
  };
}

/**
 * ⚠ Spelled out rather than `Omit<Prisma.TaskUncheckedUpdateInput, …>`, because
 * that type's fields are `string | StringFieldUpdateOperationsInput` — an
 * *update* shape, which a `create` will not take. Plain values satisfy both
 * calls, and writing them here is what lets one function serve create and
 * replace and stay the single place a task's `data` is built.
 */
interface WritableTaskFields {
  readonly title: string;
  readonly description: string | null;
  readonly ownerUserId: string | null;
  readonly dueAt: Date | null;
  readonly cadence: string | null;
  readonly dependsOnTaskId: string | null;
}

/**
 * The two dependency invariants, both enforced here because a UI cannot.
 *
 * Same business: RLS would already stop a task on ANOTHER PRACTICE's client
 * being named, but not one on a sibling client of the same firm — and a
 * dependency across two clients' checklists is a handle with no meaning that
 * would render as "Waiting on: {a task the board is not showing}".
 *
 * No cycle: walked rather than depth-capped, because the chain is a linked list
 * (one `dependsOnTaskId` per row) and walking it is O(chain). The `seen` set is
 * belt-and-braces — a cycle already in the data from before this check existed
 * would otherwise spin here forever.
 */
async function assertDependency(
  db: ScopedClient,
  businessId: string,
  dependsOnTaskId: string | null,
  selfId: string | null,
): Promise<void> {
  if (dependsOnTaskId === null) return;
  if (dependsOnTaskId === selfId) throw cycle();

  const blocker = await db.task.findUnique({
    where: { id: dependsOnTaskId },
    select: { id: true, businessId: true, dependsOnTaskId: true },
  });
  if (blocker === null || blocker.businessId !== businessId) {
    throw new AppException(
      'NT-TSK-001',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'That task cannot be a blocker',
      'A task can only wait on another task for the same client.',
    );
  }
  if (selfId === null) return;

  const seen = new Set<string>([dependsOnTaskId]);
  let next = blocker.dependsOnTaskId;
  while (next !== null) {
    if (next === selfId) throw cycle();
    if (seen.has(next)) return;
    seen.add(next);
    const step = await db.task.findUnique({ where: { id: next }, select: { dependsOnTaskId: true } });
    if (step === null) return;
    next = step.dependsOnTaskId;
  }
}

/**
 * The assignee must be a colleague the caller can already see.
 *
 * ⚠ `users` and `memberships` carry NO RLS (`prisma/CLAUDE.md`), so this read
 * is bounded by `ctx.practiceId` written into the query, not by a policy. That
 * is the same shape `practice-team.service.ts` uses and the reason the check
 * exists at all: without it, `ownerUserId` is a caller-supplied string that
 * would be stored and echoed back as this firm's colleague.
 */
async function assertAssigneeIsColleague(db: ScopedClient, assigneeUserId: string | null): Promise<void> {
  if (assigneeUserId === null) return;
  // RLS decides which businesses are in reach; the practice is read off them
  // rather than trusted from the request.
  const businesses = await db.business.findMany({ select: { practiceId: true } });
  const practiceIds = [...new Set(businesses.map((b) => b.practiceId).filter((id): id is string => id !== null))];
  const membership =
    practiceIds.length === 0
      ? null
      : await db.membership.findFirst({
          where: { userId: assigneeUserId, practiceId: { in: practiceIds } },
          select: { id: true },
        });
  if (membership === null) {
    throw new AppException(
      'NT-TSK-003',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'That person is not in your practice',
      'Pick a colleague from the list — a task can only be assigned to someone at your firm.',
    );
  }
}

/**
 * Display names for the assignees on a page of rows, in one query.
 *
 * The ids come out of RLS-bounded task rows, never off the request, which is
 * what makes reading the unpoliced `users` table here safe. Returns a map so a
 * board of 50 tasks assigned to 4 people costs one query, not 50.
 */
async function assigneeNames(
  db: ScopedClient,
  rows: readonly Pick<TaskRow, 'ownerUserId'>[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.ownerUserId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const out = new Map<string, string>();
  for (const user of users) {
    const name = [user.firstName, user.lastName].filter((part) => part !== null && part !== '').join(' ');
    // The email is the fallback, never the raw id — an id means nothing to a
    // reader, and a row rendering `cm3x9…` is worse than one rendering nothing.
    const label = name !== '' ? name : (user.email ?? '');
    if (label !== '') out.set(user.id, label);
  }
  return out;
}

function toTask(row: TaskWithBusiness, names: Map<string, string>): Task {
  return {
    id: row.id,
    businessId: row.businessId,
    businessName: row.business.name,
    title: row.title,
    description: row.description,
    assigneeUserId: row.ownerUserId,
    assigneeName: row.ownerUserId === null ? null : (names.get(row.ownerUserId) ?? null),
    // Date-only out, as it went in. `isoDateFromUtc` reads the UTC components
    // rather than the local ones, so a due date does not move a day west of
    // Greenwich — the trap `UkDateField` documents.
    dueDate: row.dueAt === null ? null : isoDateFromUtc(row.dueAt),
    // Read DEFENSIVELY: both columns are free `String?` in Prisma and the
    // contract types them as enums, so a value from outside this service (a
    // hand-run SQL fix, a row from before this surface existed) must not take
    // the board down. An unrecognised status reads as `open` — the state that
    // keeps a row visible — and an unrecognised cadence as none.
    status: isStatus(row.status) ? row.status : 'open',
    cadence: isCadence(row.cadence) ? row.cadence : null,
    dependsOnTaskId: row.dependsOnTaskId,
    aiPrefilledAt: row.aiPrefilledAt === null ? null : row.aiPrefilledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const TASK_STATUSES: readonly string[] = ['open', 'complete', 'complete-with-issues', 'not-applicable'];
const TASK_CADENCES: readonly string[] = ['monthly', 'quarterly'];

function isStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value);
}

export function isCadence(value: string | null): value is TaskCadence {
  return value !== null && TASK_CADENCES.includes(value);
}

/** `due_at` is nullable, so this is the NULLS LAST branch (cursor.ts). */
const DUE_AT = dateField<TaskWithBusiness>('dueAt', (row) => row.dueAt, true);

function cycle(): AppException {
  return new AppException(
    'NT-TSK-002',
    HttpStatus.UNPROCESSABLE_ENTITY,
    'That would make a loop',
    'These tasks would end up waiting on each other, so neither could ever start.',
  );
}

/**
 * Absent and unreachable answer identically — 404, never 403, id never echoed.
 * `NT-VAL-001` is the house fallback for an otherwise-uncoded 4xx.
 */
function notFound(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No such task, or it is not yours.');
}
