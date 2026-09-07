import { HttpStatus } from '@nestjs/common';
import type { Prisma, Team as TeamRow } from '@prisma/client';
import type { z } from 'zod';

import type { Team } from '@neoting/contracts/model';
import type { createTeamBody, listTeamsQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';

type ListQuery = z.infer<typeof listTeamsQueryParams>;
/** `replaceTeam` takes the same body — one shape, deliberately (see the contract). */
type WriteBody = z.infer<typeof createTeamBody>;

type TeamWithMembers = Prisma.TeamGetPayload<{ include: { members: { select: { userId: true } } } }>;

/**
 * The firm's own org chart — `/v1/teams` (review item 54, second half).
 *
 * The Teams sub-tab was the same mock family as Tasks, and unlike Tasks it had
 * no table at all: the cards, the editor and the delete button all wrote React
 * state. Shakib ruled it ships alongside Tasks, so `teams` and `team_members`
 * are new (migration `20260907120000_tasks_and_teams`).
 *
 * ## ⚠ A TEAM GRANTS NOTHING. Read this before adding a field.
 *
 * The objection raised when this was scoped was that a team with its own access
 * setting is a SECOND answer to *"what can this person reach"*, standing beside
 * the one every RLS policy already consults (`Membership.businessId`), and two
 * answers to that question is how a permission bug ships. The design keeps the
 * feature and removes the objection:
 *
 * - There is **no `access_level` column**. {@link accessLevelFor} DERIVES the
 *   label from the members' own memberships — `all-clients` when every member
 *   holds a practice-wide membership, `assigned-clients` otherwise. It is a
 *   read of the real access model, never a second one.
 * - **No policy in the database consults `team_members`**, and
 *   `tenancy-check.sql` §12 asserts that as a structural fact rather than
 *   trusting this comment. If that assertion ever needs relaxing, the design
 *   has changed and this file should not survive the review.
 * - Joining or leaving a team changes nothing about what anybody can see.
 *
 * ## Tenancy
 *
 * `teams` has a practice and no business, so it is not on rls.sql's
 * `direct_tables` loop: its policy is the anchor-pair predicate called with a
 * NULL business, which carries the `app_session_scope() = 'user'` guard a
 * delegated portal session fails. `team_members` reaches its parent, the
 * `chase_messages` shape. Every query here runs inside `scopedDb` and adds no
 * `practiceId` filter of its own — RLS has already decided.
 */
export class TeamsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async list(ctx: ScopeContext, query: ListQuery): Promise<Page<Team>> {
    const request: PageRequest<TeamWithMembers> = {
      // Oldest first, the order a small team reads —
      // `practice-team.service.ts`'s rule, followed rather than re-argued.
      sort: CREATED_AT,
      order: 'asc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      query: { limit: query.limit, cursor: undefined },
    };
    const seek = pageQuery(request);

    return scopedDb(this.prisma, ctx, async (db) => {
      const rows = (await db.team.findMany({
        ...(seek.where === undefined ? {} : { where: seek.where }),
        orderBy: seek.orderBy as Prisma.TeamOrderByWithRelationInput[],
        take: seek.take,
        include: { members: { select: { userId: true } } },
      })) as TeamWithMembers[];

      const page = toPage(rows, request);
      const practiceWide = await practiceWideMembers(db, page.data);
      return { data: page.data.map((row) => toTeam(row, practiceWide)), pageInfo: page.pageInfo };
    });
  }

  async create(ctx: ScopeContext, body: WriteBody, idempotencyKey: string): Promise<Team> {
    const replay = await this.replayed<Team>(ctx, idempotencyKey, { create: body });
    if (replay !== null) return replay;

    const team = await scopedDb(this.prisma, ctx, async (db) => {
      const practiceId = await practiceOf(db);
      const memberUserIds = await colleaguesAmong(db, practiceId, body.memberUserIds ?? []);
      await assertNameFree(db, body.name, null);

      const row = await db.team.create({
        data: {
          practiceId,
          name: body.name,
          members: { create: memberUserIds.map((userId) => ({ userId })) },
        },
        include: { members: { select: { userId: true } } },
      });
      return toTeam(row, await practiceWideMembers(db, [row]));
    });

    await this.remember(ctx, idempotencyKey, { create: body }, team);
    return team;
  }

  /**
   * Rename, and replace the membership WHOLE.
   *
   * `deleteMany` then `create` rather than a diff: the join table has no
   * payload beyond the pair, so a diff would be more code computing the same
   * end state. Both run inside `scopedDb`'s transaction, so a caller never
   * observes the team empty.
   */
  async replace(ctx: ScopeContext, teamId: string, body: WriteBody, idempotencyKey: string): Promise<Team> {
    const replay = await this.replayed<Team>(ctx, idempotencyKey, { teamId, body });
    if (replay !== null) return replay;

    const team = await scopedDb(this.prisma, ctx, async (db) => {
      const existing = await db.team.findUnique({ where: { id: teamId }, select: { id: true, practiceId: true } });
      if (existing === null) throw notFound();

      const memberUserIds = await colleaguesAmong(db, existing.practiceId, body.memberUserIds ?? []);
      await assertNameFree(db, body.name, teamId);

      await db.teamMember.deleteMany({ where: { teamId } });
      const row = await db.team.update({
        where: { id: teamId },
        data: { name: body.name, members: { create: memberUserIds.map((userId) => ({ userId })) } },
        include: { members: { select: { userId: true } } },
      });
      return toTeam(row, await practiceWideMembers(db, [row]));
    });

    await this.remember(ctx, idempotencyKey, { teamId, body }, team);
    return team;
  }

  /**
   * Delete. Idempotent, and **nobody loses any access** — a team never granted
   * any, so this is the one delete in the product with no blast radius to
   * describe. `team_members` goes with it by `ON DELETE CASCADE`.
   */
  async delete(ctx: ScopeContext, teamId: string, idempotencyKey: string): Promise<void> {
    await this.replayed<null>(ctx, idempotencyKey, { delete: teamId });
    await scopedDb(this.prisma, ctx, (db) => db.team.deleteMany({ where: { id: teamId } }));
    await this.remember(ctx, idempotencyKey, { delete: teamId }, null);
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
 * The caller's practice, read through RLS rather than taken from the request.
 *
 * `ctx.practiceId` exists and would be one line — but it is set from the
 * session, and this is a WRITE key: reading it off the businesses RLS already
 * admits means the practice a team is created in is the practice the policies
 * agree the caller is in, not the one a request claimed.
 */
async function practiceOf(db: ScopedClient): Promise<string> {
  const businesses = await db.business.findMany({ select: { practiceId: true }, take: 1 });
  const practiceId = businesses[0]?.practiceId ?? null;
  if (practiceId === null) {
    // A practice with no client workspaces yet. Real on day one of a signup,
    // and a team is not the thing to build first — say so instead of writing a
    // row with an invented parent.
    throw new AppException(
      'NT-TEM-003',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'No practice to put a team in',
      'Add your first client, and then teams can be set up around the work.',
    );
  }
  return practiceId;
}

/**
 * Keep only the ids that are genuinely colleagues in this practice, and refuse
 * if any are not.
 *
 * ⚠ `memberships` carries NO RLS, so the `practiceId` written here is the whole
 * of the bound — the same shape `practice-team.service.ts` uses. Without it,
 * `memberUserIds` is a caller-supplied list of arbitrary user ids that would be
 * stored against this firm's org chart.
 */
async function colleaguesAmong(
  db: ScopedClient,
  practiceId: string,
  requested: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(requested)];
  if (wanted.length === 0) return [];
  const memberships = await db.membership.findMany({
    where: { userId: { in: wanted }, practiceId },
    select: { userId: true },
  });
  const allowed = new Set(memberships.map((m) => m.userId));
  if (allowed.size !== wanted.length) {
    throw new AppException(
      'NT-TEM-002',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Somebody on that list is not in your practice',
      'Teams are made of colleagues at your firm. Pick from the list of people on the Colleagues tab.',
    );
  }
  return wanted;
}

/**
 * Two teams called "VAT" in one firm are a naming accident, not a feature.
 *
 * Checked here rather than left to the `@@unique([practiceId, name])`
 * constraint, so the answer is `NT-TEM-001` with a sentence rather than a
 * Prisma P2002 surfacing as a 500.
 */
async function assertNameFree(db: ScopedClient, name: string, exceptId: string | null): Promise<void> {
  const clash = await db.team.findFirst({
    where: { name, ...(exceptId === null ? {} : { NOT: { id: exceptId } }) },
    select: { id: true },
  });
  if (clash !== null) {
    throw new AppException(
      'NT-TEM-001',
      HttpStatus.CONFLICT,
      'There is already a team with that name',
      `"${name}" is taken. Two teams with one name is a thing nobody can tell apart on a screen.`,
    );
  }
}

/**
 * Which of these teams' members hold a PRACTICE-WIDE membership — the one read
 * `accessLevel` is derived from.
 *
 * One query for the whole page. A practice-wide membership is `practiceId` set
 * and `businessId` null, which is exactly what `listPracticeMembers` reports as
 * an empty `businessIds` — so the Teams tab's label and the Colleagues tab's
 * agree by construction rather than by two implementations happening to match.
 */
async function practiceWideMembers(db: ScopedClient, teams: readonly TeamWithMembers[]): Promise<Set<string>> {
  const ids = [...new Set(teams.flatMap((team) => team.members.map((member) => member.userId)))];
  if (ids.length === 0) return new Set();
  const memberships = await db.membership.findMany({
    where: { userId: { in: ids }, businessId: null, practiceId: { not: null } },
    select: { userId: true },
  });
  return new Set(memberships.map((m) => m.userId));
}

function toTeam(row: TeamWithMembers, practiceWide: ReadonlySet<string>): Team {
  const memberUserIds = row.members.map((member) => member.userId);
  return {
    id: row.id,
    name: row.name,
    accessLevel: accessLevelFor(memberUserIds, practiceWide),
    memberUserIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The DERIVED label, and the reason there is no column behind it.
 *
 * ⚠ An EMPTY team is `assigned-clients`, not `all-clients`. "Every member holds
 * a practice-wide membership" is vacuously true of nobody, and a team of nobody
 * reading as *All clients* on a card is the most misleading answer available.
 */
export function accessLevelFor(
  memberUserIds: readonly string[],
  practiceWide: ReadonlySet<string>,
): Team['accessLevel'] {
  if (memberUserIds.length === 0) return 'assigned-clients';
  return memberUserIds.every((id) => practiceWide.has(id)) ? 'all-clients' : 'assigned-clients';
}

const CREATED_AT = dateField<TeamRow>('createdAt', (row) => row.createdAt, false);

function notFound(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No such team, or it is not yours.');
}
