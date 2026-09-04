import { HttpStatus, Logger } from '@nestjs/common';
import type { z } from 'zod';

import type { Invite, PracticeMember } from '@neoting/contracts/model';
import type { invitePracticeMemberBody, listPracticeMembersQueryParams } from '@neoting/contracts/zod';
import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { assertCan, resolveActor } from '../approvals/index.js';
import type { NotificationsService } from '../notifications/index.js';
import { type PracticeMemberRow, toInvite, toPracticeMember } from './projections.js';
import { buildInviteLink, hashSetupToken, mintSetupToken, setupLinkExpiry } from './setup-link.js';
import { BUSINESS_LEVEL_ROLES, isPracticeLevelRole } from './team-authority.js';

type ListQuery = z.infer<typeof listPracticeMembersQueryParams>;
type InviteRequest = z.infer<typeof invitePracticeMemberBody>;

/**
 * What an `Idempotency-Key` remembers on this surface — **both endings, not
 * only the happy one.**
 *
 * A rate-limited invitation is an OUTCOME rather than a gap: the row commits,
 * the email is refused, and the method throws. Recording only the success left
 * that ending outside the cache, so a retry carrying the same key missed the
 * replay and created a second `invites` row with a second live token. One
 * address, two outstanding invitations, either of which admits its holder to
 * the practice.
 *
 * ⚠ **A replayed rate-limited key re-raises the same 429; it does not re-send.**
 * It cannot: only `sha256(token)` is stored, so the plaintext that would go in
 * the email no longer exists anywhere. `openapi.yaml`'s 429 description says *"a
 * retry re-sends rather than re-decides"* — true of a retry the operator makes
 * (a fresh key), and not achievable for a replay without re-minting the token on
 * the existing row. That, and the fact that nothing stops a fresh key writing a
 * second outstanding invitation for one address, are contract questions (G7),
 * flagged rather than decided here.
 */
type InviteReplay =
  | { readonly outcome: 'sent'; readonly invite: Invite }
  | { readonly outcome: 'rate-limited'; readonly retryAfterSeconds: number };

/**
 * **The practice's OWN team** — `GET`/`POST /v1/practice-members`.
 *
 * Before this existed a firm could only ever have the one person `POST
 * /v1/practices` created: there was no operation anywhere in the contract that
 * granted a second human access to a practice. The Team screen's "Invite
 * colleague" button opened a local record editor whose save evaporated on
 * reload, and the chat surface's invite card rendered *"Invitation sent to
 * {email}"* over an `onApprove` that did nothing.
 *
 * ## Why this is not `team.service.ts`
 *
 * That class is deliberately not extended, and the reason is its own tenancy
 * argument. `TeamService`'s header says the boundary on its surface is *"the
 * `businesses` lookup at the top of every method"* — `businesses_tenant` decides
 * whether the caller can see that client, and every membership filter is derived
 * from the row RLS handed back. **This surface has no business to look up.** Its
 * subject is the practice itself, so the same code with a different first query
 * would be the same comment guarding a different thing, which is how a tenancy
 * argument silently stops being true.
 *
 * ## ⚠ THE BOUNDARY HERE IS `ctx.practiceId`, AND NOTHING ELSE
 *
 * `memberships` and `users` carry **no RLS** — they are the tables the policies
 * themselves read, and a policed one would recurse (`prisma/CLAUDE.md`,
 * `common/db/CLAUDE.md`). So on the member list the database is not the
 * boundary and pretending otherwise would be the most dangerous kind of
 * comment. The boundary is the `practiceId` filter below, and it is legitimate
 * for exactly one reason: `ctx.practiceId` comes from the **verified session**,
 * resolved by `session-scope.ts` from the caller's own membership rows — a
 * caller cannot name a practice, only be one. `approvals/assert-can.ts` states
 * the identical thing about its own membership read; this is the same exemption
 * with the same warrant.
 *
 * What IS policed, and is therefore left to RLS rather than filtered by hand:
 * `businesses` (which clients exist, and which the caller may scope a colleague
 * to) and `invites` (`invites_tenant` already admits a practice-level row —
 * `business_id IS NULL AND practice_id = app_practice_id()` — which is precisely
 * the shape a colleague invitation has, so this feature needed no policy).
 *
 * ## D44, and where the role rule lives
 *
 * Inviting is gated by `assertCan(actor, 'team.invite')`, imported from
 * `modules/approvals`' seam. **There is deliberately no second role test in this
 * file.** A permission model with a copy in every module that offers a guarded
 * act has no single place to read, and the more permissive of two copies wins on
 * the day it matters. What the seam decides is written there: the release ROLE
 * without the `isOwner` narrowing, because inviting is reversible and internal
 * and requiring ownership would make team management a bus factor of one.
 */
export class PracticeTeamService {
  private readonly logger = new Logger(PracticeTeamService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationsService,
    private readonly idempotency: IdempotencyStore,
    private readonly config: { readonly appOrigin: string },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Everyone at the firm, plus every invitation still outstanding.
   *
   * **The page is over `users`, not over `memberships`, and that is what makes
   * the cursor honest.** A colleague scoped to three clients holds three
   * membership rows; a keyset over rows would page the same person three times
   * and split their `businessIds` across page boundaries. One row per person is
   * the only unit a cursor can seek to, so the seek runs on `users.created_at`
   * and the memberships arrive as an include.
   *
   * ⚠ The consequence, stated rather than discovered: the SORT key is the user
   * row's `created_at` while the reported `createdAt` is the earliest membership.
   * They agree for everyone this product creates — acceptance writes the user and
   * the membership in one transaction — and can differ only for a row assembled
   * by hand.
   *
   * **SYSTEM users are excluded**, the same rule and the same reason as
   * `listBusinessMembers`: a worker's actor is a real `users` row with a real
   * membership (issue #17) so machine writes go through the same predicate as
   * human ones, and showing it would invite someone to try to invite,
   * seat-count or deactivate it. **Deactivated users are excluded too**, which
   * the client-workspace list does not do — offboarding ends authority at the
   * next request (`loadScopeForUser`), so a deactivated colleague listed with no
   * "inactive" column to wear would read as somebody who can still sign in.
   */
  async listPracticeMembers(
    ctx: ScopeContext,
    query: ListQuery,
  ): Promise<Page<PracticeMember> & { readonly pendingInvites: readonly Invite[] }> {
    const practiceId = requirePractice(ctx);

    const request: PageRequest<MemberPageRow> = {
      sort: JOINED,
      order: 'asc',
      limit: query.limit,
      cursor: query.cursor,
      // The fingerprint identifies the LIST, never the caller's position in it
      // (`modules/documents/CLAUDE.md`).
      query: { practiceId, ...query, cursor: undefined },
    };
    const seek = pageQuery(request);

    const { rows, pendingInvites } = await scopedDb(this.prisma, ctx, async (db) => {
      // Which clients this practice has, decided by RLS rather than by a
      // `practiceId` filter written here. It is what the second membership
      // branch below is scoped to, so the branch cannot reach a business the
      // caller could not already see.
      const businesses = await db.business.findMany({ select: { id: true } });
      const businessIds = businesses.map((business) => business.id);
      const memberOfThisFirm = firmMembership(practiceId, businessIds);

      const rows = await db.user.findMany({
        where: {
          AND: [
            ...(seek.where === undefined ? [] : [seek.where as Prisma.UserWhereInput]),
            { kind: 'HUMAN', deactivatedAt: null },
            { memberships: { some: memberOfThisFirm } },
          ],
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          // The SORT key, and only that — `PracticeMember.createdAt` is the
          // earliest membership's, read from the include below.
          createdAt: true,
          memberships: {
            where: memberOfThisFirm,
            select: { businessId: true, role: true, isOwner: true, hideFinancialFields: true, createdAt: true },
            // Oldest first: `toPracticeMember` folds `role`,
            // `hideFinancialFields` and `createdAt` off the earliest row.
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: seek.orderBy as Prisma.UserOrderByWithRelationInput[],
        take: seek.take,
      });

      // Outstanding only: an accepted invitation is a member (they are in the
      // list above) and an expired one is not something to wait for. `invites`
      // IS policed, so the practice filter here is a narrowing of what RLS
      // already allows rather than the boundary itself.
      const pendingInvites = await db.invite.findMany({
        where: { practiceId, businessId: null, acceptedAt: null, expiresAt: { gt: new Date(this.now()) } },
        orderBy: { createdAt: 'desc' },
        take: PENDING_INVITE_CAP,
      });

      return { rows, pendingInvites };
    });

    const page = toPage(rows, request);
    return {
      data: page.data.map(toPracticeMember),
      pendingInvites: pendingInvites.map(toInvite),
      pageInfo: page.pageInfo,
    };
  }

  /**
   * Invite a colleague into the practice.
   *
   * The order of the gates is the interesting part, and it is deliberate:
   * **authority, then the role narrowing, then the client scope.** A caller who
   * may not invite learns nothing about which roles this endpoint accepts or
   * which clients exist — those are answers to a question they were not allowed
   * to ask, the same ordering `assert-can.ts` argues for on the approve path.
   *
   * **The token is never returned.** It exists in the email and in
   * `invites.token_hash`, and nowhere else.
   */
  async invitePracticeMember(ctx: ScopeContext, request: InviteRequest, idempotencyKey?: string): Promise<Invite> {
    const practiceId = requirePractice(ctx);

    const replay = await this.replayed(practiceId, idempotencyKey, request);
    // A replayed key reproduces the ENDING it had, both of them. See
    // `InviteReplay` — replaying only the success is what let a rate-limited
    // retry mint a second invitation.
    if (replay !== null) {
      if (replay.outcome === 'sent') return replay.invite;
      throw rateLimited(replay.retryAfterSeconds);
    }

    const email = request.email.toLowerCase();
    const setupToken = mintSetupToken();
    const expiresAt = setupLinkExpiry(this.now());
    const businessIds = request.businessIds ?? [];

    const { invite, practiceName, inviterName } = await scopedDb(this.prisma, ctx, async (db) => {
      // 1 · AUTHORITY. `resolveActor` reads the caller's practice-wide
      // membership inside this same transaction; `assertCan` is approvals' seam
      // and the only place the role rule is written.
      assertCan(await resolveActor(db, ctx), 'team.invite');

      // 2 · THE ROLE NARROWING. The request schema takes the whole
      // `WorkspaceRole` enum because there is exactly one copy of it in the
      // contract, so this is where the refusal has to live.
      assertInvitableRole(request.role);
      assertScopeMatchesRole(request.role, businessIds);

      // 3 · THE CLIENT SCOPE. Read through RLS, so a business the inviter
      // cannot see simply is not found — 404, never 403, because a 403 would
      // confirm the client exists (convention 1).
      if (businessIds.length > 0) {
        const visible = await db.business.findMany({ where: { id: { in: businessIds } }, select: { id: true } });
        if (visible.length !== new Set(businessIds).size) throw noSuchClient();
      }

      const practice = await db.practice.findUnique({ where: { id: practiceId }, select: { name: true } });
      // The practice the verified session named is gone between sign-in and
      // now. A 404 rather than a 500: nothing is broken, the tenant stopped
      // existing.
      if (practice === null) throw noSuchClient();

      const invite = await db.invite.create({
        data: {
          practiceId,
          // Practice-level: `business_id` stays NULL, which is the branch
          // `invites_tenant` admits on `practice_id` and what distinguishes a
          // colleague invitation from a client one on the same table.
          email,
          role: request.role,
          // ⚠ `request.firstName` / `request.lastName` are ACCEPTED BY THE
          // CONTRACT AND WRITTEN NOWHERE — `invites` has no column for either,
          // and acceptance asks the invitee for their own name as a REQUIRED
          // field (`invitation-acceptance.service.ts`), so even a stored one
          // would be overwritten by the person it describes. `apps/web` stopped
          // collecting and sending them (2 Sep 2026); removing them from
          // `PracticeMemberInviteRequest` is a contract change (G7) and is the
          // half still owed. Named here rather than discarded silently — that
          // is the same anti-pattern `hide_financial_fields` was fixed for.
          tokenHash: hashSetupToken(setupToken),
          expiresAt,
          businessIds,
          hideFinancialFields: request.hideFinancialFields ?? false,
          invitedByUserId: ctx.actorId,
        },
      });

      // `users` carries no RLS, so this read is bounded by `ctx.actorId` — the
      // verified session's own subject, and the only id involved.
      const inviter = await db.user.findUnique({
        where: { id: ctx.actorId },
        select: { firstName: true, lastName: true },
      });

      return { invite, practiceName: practice.name, inviterName: displayName(inviter) };
    });

    const outcome = await this.notifications.sendTeamInvite({
      to: request.email,
      practiceName,
      inviterName,
      inviteLink: buildInviteLink(this.config.appOrigin, setupToken),
      expiresAt,
    });
    if (!outcome.sent) {
      // Told plainly, and the contract declares the status. The caller is a
      // trusted authenticated admin looking at their own team list, and
      // "nothing happened, silently" is the worst possible answer
      // (`notifications.service.ts` argues the general case).
      //
      // The row is KEPT. It is the durable record of a decision that was made,
      // and an invitation with no email behind it expires harmlessly in seven
      // days. Same stance as `team.service.ts` on the client-invite path.
      this.logger.warn(`team invite email refused by the rate limit · practiceId=${practiceId} inviteId=${invite.id}`);
      // ⚠ REMEMBERED BEFORE THE THROW, and the ordering is the fix rather than
      // tidiness. Recording only the success left this branch outside the
      // replay cache, so a retry carrying the SAME `Idempotency-Key` missed it
      // and wrote a SECOND `invites` row with a SECOND live token — one address
      // holding two outstanding invitations, either of which opens the
      // practice. The key now reproduces the ending it had.
      await this.remember(practiceId, idempotencyKey, request, {
        outcome: 'rate-limited',
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
      throw rateLimited(outcome.retryAfterSeconds);
    }

    const response = toInvite(invite);
    await this.remember(practiceId, idempotencyKey, request, { outcome: 'sent', invite: response });
    return response;
  }

  /**
   * The replay namespace is per PRACTICE — `Idempotency-Key` is a
   * client-generated UUID over one shared map, and two firms reusing one key
   * must miss rather than be handed each other's invitation. The same
   * namespacing `team.service.ts` does per business.
   */
  private storeKey(practiceId: string, idempotencyKey: string): string {
    return `practice-members:${practiceId}:${idempotencyKey}`;
  }

  private async replayed(practiceId: string, idempotencyKey: string | undefined, request: unknown): Promise<InviteReplay | null> {
    if (idempotencyKey === undefined) return null;
    const record = await this.idempotency.get(this.storeKey(practiceId, idempotencyKey));
    if (record === null) return null;
    if (record.requestHash !== fingerprint(request)) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as InviteReplay;
  }

  private async remember(
    practiceId: string,
    idempotencyKey: string | undefined,
    request: unknown,
    response: InviteReplay,
  ): Promise<void> {
    if (idempotencyKey === undefined) return;
    await this.idempotency.put(this.storeKey(practiceId, idempotencyKey), {
      requestHash: fingerprint(request),
      response,
    });
  }
}

/**
 * Oldest first, then id. The contract declares no `sort` parameter for this
 * list, so the order is a constant; joined-order puts the people who were there
 * first at the top, which is how a small team reads. `users.created_at` is `NOT
 * NULL`, so `nullable: false` — Prisma throws on the `{ sort, nulls }` shape for
 * a required column (`common/pagination/cursor.ts`).
 */
const JOINED = dateField<MemberPageRow>('createdAt', (row) => row.createdAt, false);

/**
 * A person on the page: the fold's input plus the SORT key.
 *
 * Two `createdAt`s, and they are not the same fact — `users.created_at` is what
 * the cursor seeks on (one row per person, which is the only unit a keyset can
 * resume from), and the one the contract reports is the earliest membership's.
 * They agree for everyone this product creates.
 */
type MemberPageRow = PracticeMemberRow & { readonly createdAt: Date };

/**
 * How many outstanding invitations one response carries.
 *
 * `pendingInvites` is deliberately unpaginated — a practice with more than this
 * many unaccepted invitations has a problem a second page would not solve — so
 * the cap exists to bound the response, not to page it. It is generous enough
 * that no honest firm reaches it.
 */
const PENDING_INVITE_CAP = 200;

/**
 * Who counts as a member of the FIRM, as one Prisma predicate.
 *
 * Two branches, and the second is the one that needed thinking about:
 *
 * - **practice-WIDE** (`practiceId` set, `businessId` null) — the shape signup
 *   writes and the shape a `CLIENT_ADMIN` or an unscoped `PRACTICE_STANDARD`
 *   accepts into.
 * - **business-SCOPED with a practice-level role** (`practiceId` **null**,
 *   `businessId` one of this practice's clients). ⚠ `practiceId: null` is not a
 *   detail: `app_can_access_business`'s third branch grants a user access to
 *   EVERY business of any practice they hold a `practice_id` on, so a scoped
 *   colleague whose rows also carried `practice_id` would see every client the
 *   scope was supposed to withhold. Acceptance writes them null for exactly that
 *   reason, and this predicate has to match what acceptance writes.
 *
 * The role condition on the second branch is what keeps the CLIENT's own people
 * off the firm's team list — `mem_dee` in the seed is a `BUSINESS_ADMIN` on one
 * business with no practice, and she works for the client, not the practice. It
 * is written as "not a business-level role" against the existing constant rather
 * than as a second list of practice-level roles, so the two cannot drift.
 */
function firmMembership(practiceId: string, businessIds: readonly string[]): Prisma.MembershipWhereInput {
  return {
    OR: [
      { practiceId, businessId: null },
      ...(businessIds.length === 0
        ? []
        : [{ practiceId: null, businessId: { in: [...businessIds] }, NOT: { role: { in: [...BUSINESS_LEVEL_ROLES] } } }]),
    ],
  };
}

/**
 * The practice the verified session acts for.
 *
 * A caller with none is not a practice colleague at all — a client-workspace
 * login, or a colleague whose memberships are all business-scoped (see
 * `firmMembership`: those carry no `practice_id`, so their session context
 * carries none either). `403`, not `404`: this is a permission answer about a
 * surface whose existence is public, and the detail says which.
 */
function requirePractice(ctx: ScopeContext): string {
  if (ctx.practiceId !== undefined) return ctx.practiceId;
  throw new AppException(
    'NT-PRM-001',
    HttpStatus.FORBIDDEN,
    'Not permitted',
    'This account does not act for a practice, so it has no practice team to read.',
  );
}

/** The contract's own refusal set. `PRACTICE_ADMIN` is named because a silent "invalid role" would read as a bug. */
function assertInvitableRole(role: InviteRequest['role']): void {
  if (isPracticeLevelRole(role)) return;
  throw new AppException(
    'NT-VAL-001',
    HttpStatus.BAD_REQUEST,
    'Validation failed',
    role === 'PRACTICE_ADMIN'
      ? 'A colleague cannot be invited as a practice admin. Release authority belongs to the person who created the practice, and there is no way to transfer it yet.'
      : 'Only a practice-level role can be granted here.',
    [{ field: 'role', message: 'Must be PRACTICE_STANDARD or CLIENT_ADMIN.' }],
  );
}

/**
 * A `CLIENT_ADMIN` is practice-wide by definition, so `businessIds` is refused
 * rather than ignored: accepting a client picker's answer and discarding it
 * would describe a grant that did not happen.
 */
function assertScopeMatchesRole(role: InviteRequest['role'], businessIds: readonly string[]): void {
  if (role !== 'CLIENT_ADMIN' || businessIds.length === 0) return;
  throw new AppException(
    'NT-VAL-001',
    HttpStatus.BAD_REQUEST,
    'Validation failed',
    'A client admin reaches every client, so they cannot be scoped to a list of them.',
    [{ field: 'businessIds', message: 'Must be empty for CLIENT_ADMIN.' }],
  );
}

/**
 * The 429 the contract declares — built in one place because it is raised
 * twice: once when the ceiling refuses the send, and once when a replayed key
 * reproduces that ending. Two spellings of one refusal is how a retry starts
 * being told something different from the first attempt.
 */
function rateLimited(retryAfterSeconds: number): AppException {
  return new AppException(
    'NT-RATE-001',
    HttpStatus.TOO_MANY_REQUESTS,
    'Too many invitations',
    `The invitation was recorded but the email was rate limited. Try again in ${retryAfterSeconds} seconds.`,
  );
}

/** NT-NOT-001 does not exist in the contract's enum; NT-VAL-001 is the house fallback for an uncoded 4xx. */
function noSuchClient(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No client with that id.');
}

/**
 * The inviter's name for the invitation email, or null.
 *
 * Null when there is no name to print — a blank rather than "someone at", which
 * `composeTeamInvite` handles by dropping the clause. A half-name is still a
 * name a colleague will recognise, so a missing surname is not a reason to say
 * nothing.
 */
function displayName(user: { firstName: string | null; lastName: string | null } | null): string | null {
  if (user === null) return null;
  const name = [user.firstName, user.lastName].filter((part) => part !== null && part.trim() !== '').join(' ').trim();
  return name === '' ? null : name;
}
