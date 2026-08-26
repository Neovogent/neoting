import { HttpStatus, Logger } from '@nestjs/common';
import type { z } from 'zod';

import type { BusinessMember, Invite } from '@neoting/contracts/model';
import type { inviteBusinessMemberBody, listBusinessMembersQueryParams } from '@neoting/contracts/zod';
import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import type { NotificationsService } from '../notifications/index.js';
import { type MembershipRow, toBusinessMember, toInvite } from './projections.js';
import { buildSetupLink, hashSetupToken, mintSetupToken, setupLinkExpiry } from './setup-link.js';
import { isBusinessLevelRole } from './team-authority.js';

type ListQuery = z.infer<typeof listBusinessMembersQueryParams>;
type InviteRequest = z.infer<typeof inviteBusinessMemberBody>;

/**
 * Oldest first, then id. The contract declares no `sort` parameter for this
 * list, so the order is a constant rather than a lookup table; joined-order puts
 * the people who were there first at the top, which is how a small team reads.
 * `created_at` is `NOT NULL`, so `nullable: false` — Prisma throws on the
 * `{ sort, nulls }` shape for a required column (`common/pagination/cursor.ts`).
 */
const JOINED = dateField<MembershipRow>('createdAt', (row) => row.createdAt, false);

/** Only the joined user's identity fields are read. No password hash, no TOTP reference, ever. */
const USER_FIELDS = { id: true, email: true, firstName: true, lastName: true } as const;

/**
 * **Team management for one client workspace** —
 * `GET`/`POST /v1/businesses/{businessId}/members`.
 *
 * ## The tenancy shape, which is not the usual one
 *
 * `memberships` and `users` carry **no RLS** (verified empirically; see
 * `prisma/CLAUDE.md` and `auth-tenancy/session-scope.ts`). They cannot: they are
 * the tables the policies themselves read to decide what a caller may see, and a
 * policy that queried a policed table would recurse.
 *
 * So on this surface the database is **not** the boundary, and pretending
 * otherwise would be the most dangerous kind of comment. The boundary is the
 * `businesses` lookup at the top of every method: `businesses_tenant` decides
 * whether the caller can see that client at all, and every membership filter
 * below is derived from the row RLS handed back. Both queries run in **one**
 * `scopedDb` transaction, so there is no window in which the second could run
 * under different GUCs than the first.
 *
 * **404, never 403** — a client outside the caller's scope is invisible to the
 * lookup, so it returns null and this raises 404. There is no ownership check
 * that could raise 403, because a 403 confirms the record exists.
 *
 * ## D44
 *
 * Everyone listed here **composes and edits**; only a `PRACTICE_ADMIN`
 * **releases** (`team-authority.ts`). This surface reports `role`, `scope` and
 * `isOwner` so a screen can show who is who honestly, and enforces nothing about
 * release itself — that check belongs on the approve path (A12), where the
 * irreversible acts actually happen, and not on the screen that lists people.
 */
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationsService,
    private readonly idempotency: IdempotencyStore,
    private readonly config: { readonly appOrigin: string },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The client's own people and the practice staff who can reach them.
   *
   * **SYSTEM users are never listed** — the contract is explicit, and the reason
   * is that a worker's actor is a real `users` row with a real membership (issue
   * #17) so machine writes go through the same predicate as human ones. Showing
   * it would invite someone to try to invite, seat-count or deactivate it.
   */
  async listMembers(ctx: ScopeContext, businessId: string, query: ListQuery): Promise<Page<BusinessMember>> {
    const request: PageRequest<MembershipRow> = {
      sort: JOINED,
      order: 'asc',
      limit: query.limit,
      cursor: query.cursor,
      // The fingerprint identifies the LIST, not the caller's position in it —
      // `{ ...query, cursor: undefined }`, never `query` (modules/documents/CLAUDE.md).
      query: { businessId, ...query, cursor: undefined },
    };
    const seek = pageQuery(request);

    const rows = await scopedDb(this.prisma, ctx, async (db) => {
      const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true, practiceId: true } });
      if (business === null) throw notFound();

      return db.membership.findMany({
        where: {
          AND: [
            ...(seek.where === undefined ? [] : [seek.where as Prisma.MembershipWhereInput]),
            { OR: reachesBusiness(business.id, business.practiceId) },
            // The SYSTEM exclusion, as a filter on the joined user's kind rather
            // than on a name convention — `UserKind` is the schema's own answer
            // to "is this a person".
            { user: { kind: 'HUMAN' } },
          ],
        },
        include: { user: { select: USER_FIELDS } },
        orderBy: seek.orderBy as Prisma.MembershipOrderByWithRelationInput[],
        take: seek.take,
      });
    });

    const page = toPage(rows, request);
    return { data: page.data.map(toBusinessMember), pageInfo: page.pageInfo };
  }

  /**
   * Invite someone into a client workspace (D45).
   *
   * An invite is an **identity decision, not an access convenience**: the
   * contract makes this the mechanism by which a client's own team members
   * become permitted senders, so the same call that creates the invitation also
   * records the address as a `contacts` row — which is what
   * `ingestion-routing`'s sender map keys on. Without it the invited person
   * could accept, log in, and still have every email they forwarded land in
   * Unrouted.
   *
   * **The token is never returned.** It exists in the email and in
   * `invites.token_hash`, and nowhere else.
   */
  async inviteMember(
    ctx: ScopeContext,
    businessId: string,
    request: InviteRequest,
    idempotencyKey?: string,
  ): Promise<Invite> {
    const replay = await this.replayed<Invite>(businessId, idempotencyKey, request);
    if (replay !== null) return replay;

    // The contract's own refusal: "Only the three business-level roles are
    // accepted here … a practice-level role sent here is refused with
    // NT-VAL-001." The request schema takes the whole `WorkspaceRole` enum
    // because there is exactly one copy of it in the contract, so the narrowing
    // has to happen here rather than in a second, drift-prone schema.
    if (!isBusinessLevelRole(request.role)) {
      throw new AppException(
        'NT-VAL-001',
        HttpStatus.BAD_REQUEST,
        'Validation failed',
        'Only a client-workspace role can be granted here.',
        [{ field: 'role', message: 'Must be BUSINESS_ADMIN, USER_ADMIN or BUSINESS_STANDARD.' }],
      );
    }

    const email = request.email.toLowerCase();
    const setupToken = mintSetupToken();
    const expiresAt = setupLinkExpiry(this.now());

    const { invite, businessName, practiceName } = await scopedDb(this.prisma, ctx, async (db) => {
      const business = await db.business.findUnique({
        where: { id: businessId },
        select: { id: true, name: true, practice: { select: { name: true } } },
      });
      if (business === null) throw notFound();

      const invite = await db.invite.create({
        data: { businessId: business.id, email, role: request.role, tokenHash: hashSetupToken(setupToken), expiresAt },
      });

      // D45, create-if-absent. There is no unique index on (business, email) —
      // `prisma/` is LAW — so re-inviting someone must not silently accumulate
      // duplicate contacts, each of which would be a separate sender-map entry
      // for the same person.
      const existing = await db.contact.findFirst({ where: { businessId: business.id, email }, select: { id: true } });
      if (existing === null) {
        await db.contact.create({
          data: {
            businessId: business.id,
            email,
            firstName: request.firstName ?? null,
            lastName: request.lastName ?? null,
            isPrimary: false,
            // A team member is a permitted SENDER, not automatically the person
            // the chase goes to. Over-chasing is how the product loses a
            // client's trust in week one (§4 Stage 8.2).
            receivesChases: false,
          },
        });
      }

      return { invite, businessName: business.name, practiceName: business.practice?.name ?? business.name };
    });

    const outcome = await this.notifications.sendClientInvite({
      to: request.email,
      practiceName,
      businessName,
      inviteLink: buildSetupLink(this.config.appOrigin, setupToken),
      expiresAt,
    });
    if (!outcome.sent) {
      // Told plainly, and the contract declares the status. The accountant is a
      // trusted authenticated user looking at their own client's team list, and
      // "nothing happened, silently" is the worst possible answer
      // (`notifications.service.ts` argues the general case).
      //
      // The row is KEPT. It is the durable record of a decision that was made;
      // a retry re-sends rather than re-deciding, and an invite with no email
      // behind it expires harmlessly in seven days.
      this.logger.warn(`invite email refused by the rate limit · businessId=${businessId} inviteId=${invite.id}`);
      throw new AppException(
        'NT-RATE-001',
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many invitations',
        `The invitation was recorded but the email was rate limited. Try again in ${outcome.retryAfterSeconds} seconds.`,
      );
    }

    const response = toInvite(invite);
    await this.remember(businessId, idempotencyKey, request, response);
    return response;
  }

  /**
   * The replay namespace is per business — `Idempotency-Key` is a
   * client-generated UUID over one shared map, and two workspaces reusing one
   * key must miss rather than be handed each other's invite (the same
   * namespacing the portal's delegated completion does).
   */
  private storeKey(businessId: string, idempotencyKey: string): string {
    return `business-members:${businessId}:${idempotencyKey}`;
  }

  private async replayed<T>(businessId: string, idempotencyKey: string | undefined, request: unknown): Promise<T | null> {
    if (idempotencyKey === undefined) return null;
    const record = await this.idempotency.get(this.storeKey(businessId, idempotencyKey));
    if (record === null) return null;
    if (record.requestHash !== fingerprint(request)) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as T;
  }

  private async remember(
    businessId: string,
    idempotencyKey: string | undefined,
    request: unknown,
    response: unknown,
  ): Promise<void> {
    if (idempotencyKey === undefined) return;
    await this.idempotency.put(this.storeKey(businessId, idempotencyKey), {
      requestHash: fingerprint(request),
      response,
    });
  }
}

/**
 * Who reaches this client: someone with a membership ON it, or practice staff
 * with a practice-WIDE membership above it.
 *
 * A practice membership that also names a *different* business is that other
 * client's row and is deliberately not matched — `{ practiceId, businessId:
 * null }`, not `{ practiceId }`. The distinction is the same one
 * `pickActingMembership` makes when it prefers a practice-wide membership, and
 * getting it wrong would list every client's staff on every client.
 */
function reachesBusiness(businessId: string, practiceId: string | null): Prisma.MembershipWhereInput[] {
  const branches: Prisma.MembershipWhereInput[] = [{ businessId }];
  // A standalone business has no practice above it (SoT §3.2), and `{
  // practiceId: null, businessId: null }` would match a membership belonging to
  // nobody rather than nobody at all.
  if (practiceId !== null) branches.push({ practiceId, businessId: null });
  return branches;
}

/** NT-NOT-001 does not exist in the contract's enum; NT-VAL-001 is the house fallback for an uncoded 4xx. */
function notFound(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No client with that id.');
}
