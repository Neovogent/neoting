import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

import type { PortalPeople, PortalPerson } from '@neoting/contracts/model';
import type { invitePortalPersonBody, updatePortalPersonBody } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { appendAuditEvent, assertCan, canonicalHash } from '../approvals/index.js';
import type { NotificationsService } from '../notifications/index.js';
import {
  addressTaken,
  effectivePortalRole,
  isLastOwner,
  isPortalAccessRole,
  type PortalPersonRow,
  portalActorFor,
  splitName,
  toPortalPerson,
} from './portal-people-authority.js';
import { type PortalSessionFacts, systemScopeFor } from './portal-session-context.js';

type InviteRequest = z.infer<typeof invitePortalPersonBody>;
type UpdateRequest = z.infer<typeof updatePortalPersonBody>;

/**
 * **Settings → People, in the client's own portal** — the four operations a
 * client business needs to run its own access list (D45, D49).
 *
 * Until 2 Sep 2026 this screen said *"Managed by your accountant … they cannot
 * be added from this screen."* The product owner ruled that wrong, and the
 * reason is a product one rather than a technical one: the manager, the HR lead
 * or the owner of a client business is the person who knows who handles their
 * paperwork, and making an accounting firm the registrar of a restaurant's
 * kitchen staff put a support ticket between a new starter and their first
 * receipt.
 *
 * ## ⚠ WHO IS ASKING — the blocker this whole feature turned on
 *
 * A portal session identified a **business, not a person**. The signed bearer
 * carries `{otpSessionId, businessId, practiceId, expiresAtMs}` and the server
 * acts as the practice's SYSTEM user, so for every read the portal made, the
 * acting identity was *the workspace*. That is fine for "show me my documents"
 * and useless for "may you remove Tom", which is a question about a human.
 *
 * **The row already knew.** `otp_sessions.contact_id` is written by both
 * own-portal sign-in routes and was simply never read back out. So the acting
 * person is resolved the way every other portal fact is — **from the ROW,
 * re-read on every request** (`portal-session-context.ts` applies six row
 * checks that outrank the token, deliberately), never from the token.
 * `resolveActing` below turns `facts.contactId` into a `contacts` row and
 * `portalActorFor` turns that into the `Actor` shape the authority seam takes.
 *
 * ⚠ **The role is deliberately NOT on the bearer.** A role in the claims would
 * be a seventh fact the row could contradict, for up to an hour, in the
 * direction that matters: an owner demoted at 10:00 would still be holding an
 * owner's bearer at 10:59.
 *
 * ## The authority is `assert-can.ts`'s, not this file's
 *
 * `assertCan(actor, 'business.people.manage')` — `BUSINESS_ADMIN` or
 * `USER_ADMIN`, and nobody else. It lives in `modules/approvals` with the other
 * two `PermittedAction`s because *"a permission model with a role check in
 * every module that offers a guarded act has no single place to read, and the
 * more permissive of two copies always wins on the day it matters."* This
 * service ASKS; it holds no opinion of its own about who may do what.
 *
 * **A `BUSINESS_STANDARD` still READS the list.** Who else can send paperwork
 * on your employer's behalf is not a secret from you, and hiding the section
 * would be the *"pretend the action does not exist"* failure Governance §11.2
 * names. `canManagePeople` on the response is a fact for honest degradation and
 * is **never the gate** — the server refuses the mutation regardless of what a
 * browser believes.
 *
 * ## ⚠ TENANCY: the boundary here is the QUERY, not SQL
 *
 * Same division `portal-documents.service.ts` states in full, and for the same
 * reason: `prisma/sql/rls.sql`'s two delegated branches key on granted DOCUMENT
 * ids, and `contacts` has no branch meaning "this client's whole business". So
 * every read here runs under `systemScopeFor(facts)` — which can see the whole
 * practice — and `where: { businessId: facts.businessId }` is the only thing
 * narrowing it. That is an **application guarantee**, and this file says so
 * rather than overclaiming.
 *
 * What makes it safe to rely on is that the filter cannot be omitted or
 * influenced. It is `facts.businessId`, off the `otp_sessions` row the server
 * wrote; **no operation here takes a `businessId` argument** and the contract
 * declares none, so there is nothing to forget to pass and nothing for a caller
 * to supply; and `whereFor` is the one expression that builds it, used by every
 * query in the class. `portal-people.integration.test.ts` proves it with **a
 * second business in the same practice** — a second practice would prove
 * nothing, because RLS would hide it anyway and the test would still pass with
 * the filter deleted.
 *
 * ## Every change writes to the practice's audit log
 *
 * `appendAuditEvent` with `proposalId: null`. A client managing their own people
 * structurally cannot have a proposal — `createActionProposal` carries
 * `workspaceSession`, which a portal caller does not hold, and no accountant
 * should have to approve whether a restaurant may add a chef. What replaces the
 * human gate is the server-side authority check plus a row in the firm's own
 * chain, so the accountant can see who their client added even though they did
 * not authorise it.
 */

/**
 * How many people one response serves.
 *
 * Governance §5.1 forbids an unbounded load, and a client's own staff list is
 * bounded by the business rather than by a growing record set — so this is a
 * ceiling that should never be reached rather than a page size. It is said out
 * loud on `truncated` rather than silently stopping, because a list that
 * quietly omits somebody who has access is worse than a long list.
 */
export const PORTAL_PEOPLE_LIMIT = 200;

/** The `contacts` columns the authority module reads. One place, so a query cannot under-select. */
const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
  portalRole: true,
  isPrimary: true,
  canSendDocuments: true,
  canSeeTotals: true,
  deactivatedAt: true,
  createdAt: true,
} as const;

/** What the invite mail needs, resolved inside the same transaction that writes the row. */
export interface PortalPeopleConfig {
  /** The portal's own front door. The invitation carries NO token — see `composeBusinessPeopleInvite`. */
  readonly appOrigin: string;
}

const NOT_PERMITTED_DETAIL =
  'Only an owner or a user administrator at your business can add or remove people. Ask one of them.';

/** The contract's 400. One code for the whole save gate, distinguished by its detail. */
function invalid(detail: string): AppException {
  return new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Invalid request', detail);
}

/**
 * Nobody with that id on this workspace.
 *
 * ⚠ **404, never 403** — a 403 would confirm the person exists somewhere else.
 * The absence is produced by the `businessId` filter rather than by a check
 * against the row's own business, so there is no second place for the two to
 * disagree.
 */
function notFound(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No such person on this business.');
}

export class PortalPeopleService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationsService,
    private readonly idempotency: IdempotencyStore,
    private readonly config: PortalPeopleConfig,
  ) {}

  /**
   * The list, and what the SERVER would let this session do to it.
   *
   * Oldest first — the people who were there first read at the top, which is how
   * a small team reads a list of itself.
   */
  async listPeople(facts: PortalSessionFacts): Promise<PortalPeople> {
    return scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      const rows = await this.#peopleIn(db, facts);
      const acting = rows.find((r) => r.id === facts.contactId) ?? null;
      return {
        people: rows.slice(0, PORTAL_PEOPLE_LIMIT).map((row) => toPortalPerson(row, facts.contactId)),
        // The fact, not the gate. A browser that lied about it would still be
        // refused by all three mutations.
        canManagePeople: mayManage(acting),
        truncated: rows.length > PORTAL_PEOPLE_LIMIT,
      };
    });
  }

  /**
   * Add one of this business's own people.
   *
   * **This is an IDENTITY decision, which is exactly why it belongs to the
   * business.** The invitation writes a `contacts` row, and that row is what the
   * ingest router matches a sender against (D45) — so the person invited here
   * can immediately forward an invoice from their own mailbox and have it land
   * in the right workspace instead of Unrouted. It is also the row the portal's
   * tokenless sign-in resolves an address against, which is what makes the
   * invitee able to actually sign in afterwards.
   *
   * ⚠ **The save gate refuses in the order the screen states it** — name, then
   * address, then a valid address, then a duplicate, then the role. The order is
   * part of the design rather than an implementation detail: a person filling in
   * a form should be told about the first thing that is wrong, not the last, and
   * a screen and a server that disagree about which that is will contradict each
   * other on every slow connection. The first three are the contract's zod, at
   * the controller; the last two are here, because only the workspace's own rows
   * can answer them.
   */
  async invitePerson(
    facts: PortalSessionFacts,
    request: InviteRequest,
    idempotencyKey?: string,
  ): Promise<PortalPerson> {
    const replay = await this.#replayed<PortalPerson>(facts, idempotencyKey, request);
    if (replay !== null) return replay;

    if (!isPortalAccessRole(request.access)) {
      // A client granting themselves a PRACTICE role would be a client
      // promoting themselves into their accountant's firm.
      throw invalid('That is not a role you can give someone at your business.');
    }
    const name = request.name.trim();
    if (name === '') throw invalid('Enter their name.');
    const email = request.email.trim().toLowerCase();

    const { person, businessName, inviterName } = await scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      const rows = await this.#peopleIn(db, facts);
      const acting = this.#assertMayManage(rows, facts);

      // ⚠ ONE EMAIL IS ONE PERSON, because the address IS the sign-in channel:
      // two people sharing one would be sent each other's six-digit codes and
      // would collide on every send. It is also the sender-map key (D45), so a
      // second row carrying it would put one identity on two rows and make "who
      // sent this" ambiguous for the ingest router. Deactivated rows still
      // count — reviving somebody is a different act from inviting a second
      // person under their address.
      //
      // Safe to report, and this is the one refusal on this surface that is:
      // the caller is looking at the list that contains that person. Nothing
      // here reports whether an address exists ANYWHERE ELSE in the product.
      if (addressTaken(rows, email)) {
        throw invalid('Someone on this business already uses that email address.');
      }

      const business = await db.business.findFirst({
        where: { id: facts.businessId },
        select: { name: true },
      });
      if (business === null) throw notFound();

      const split = splitName(name);
      const created = await db.contact.create({
        data: {
          businessId: facts.businessId,
          email,
          firstName: split.firstName,
          lastName: split.lastName,
          // The FREE-TEXT job title, never the authority. A site's Foreman must
          // not be flattened into "Staff".
          role: request.jobTitle ?? null,
          // The AUTHORITY, written explicitly. A new row never relies on the
          // `portalRole ?? isPrimary` derivation — that exists for rows written
          // before the column did.
          portalRole: request.access,
          canSendDocuments: request.canSendDocuments,
          // ⚠ The CONTRACT's default (`false`), applied here, and it deliberately
          // disagrees with the COLUMN's (`true`). The column defaults true
          // because every contact that predates it already saw totals and a
          // migration must not silently remove a permission; a NEW invitation is
          // the opposite case — *"staff photographing receipts should not see
          // the company's figures"* — so a body that omits the field gets the
          // safer answer rather than the compatible one. Written explicitly so
          // the create never falls through to the column default.
          canSeeTotals: request.canSeeTotals ?? false,
          // `is_primary` is who the chases go to, and it is not this person.
          // Exactly one primary contact per business is what makes the
          // no-backfill derivation work, so a second one would quietly give an
          // existing workspace two owners.
          isPrimary: false,
          // A new starter is a permitted SENDER, not automatically somebody the
          // firm chases — the same reading `POST /businesses/{id}/members`
          // takes. Over-chasing is how the product loses a client's trust in
          // week one (§4 Stage 8.2).
          receivesChases: false,
        },
        select: PERSON_SELECT,
      });

      await this.#audit(db, facts, acting, 'business.person.invited', {
        personId: created.id,
        access: request.access,
        canSendDocuments: request.canSendDocuments,
        canSeeTotals: request.canSeeTotals,
      });

      return {
        person: created,
        businessName: business.name,
        inviterName: displayName(acting),
      };
    });

    // ⚠ OUTSIDE the transaction, deliberately. An external call must never hold
    // a tenant transaction open, and the row is the invitation — the mail is how
    // the person is told about it. A send that fails leaves somebody with access
    // who has not been told, which is recoverable by re-inviting; a transaction
    // rolled back by a mail server leaves a screen claiming a person was added
    // when they were not.
    const outcome = await this.notifications.sendBusinessPeopleInvite(
      {
        to: person.email ?? email,
        businessName,
        inviterName,
        // No token. The address is the credential channel: they type it at the
        // portal, a six-digit code is emailed, and they are in. A setup token
        // would add a seven-day expiry to a relationship that has none and put
        // them on the CLIENT-onboarding journey, which is the owner's.
        portalLink: portalFrontDoor(this.config.appOrigin),
      },
      // No `ip`: this send is authorised by a bearer rather than typed by a
      // stranger, so the per-address ceiling is the one that matters and an IP
      // key here would be the ALB's for every client at once.
      {},
    );
    const response = toPortalPerson(person, facts.contactId);
    if (!outcome.sent) {
      // ⚠ REMEMBERED BEFORE THE THROW, which is the ordering `practice-team`
      // paid for: recording only success lets a retried key run the whole
      // mutation again, and here that would write a SECOND contacts row for the
      // same person — two sender-map entries for one identity, which is exactly
      // what the duplicate-address refusal exists to prevent.
      await this.#remember(facts, idempotencyKey, request, response);
      // Told plainly. The caller is the business's own admin looking at their
      // own list, so silence would be the worst answer — they would re-invite,
      // and the row already exists. The contract declares this 429 on the
      // operation and says the person WAS added.
      throw new AppException(
        'NT-RATE-001',
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many requests',
        'They were added, but we could not email them just yet. Ask them to sign in with this email address, or try again shortly.',
      );
    }

    await this.#remember(facts, idempotencyKey, request, response);
    return response;
  }

  /**
   * Rename, retitle, re-authorise. Every field is optional; an omitted one is
   * left alone, and a body that changes nothing is a no-op that still answers
   * the person's current state.
   *
   * `email` is deliberately **not** changeable. The address is the sign-in
   * channel and the sender-map key at once, so changing it is removing one
   * person and inviting another; doing that under the word "update" would
   * silently transfer whatever the first person had already sent.
   */
  async updatePerson(
    facts: PortalSessionFacts,
    personId: string,
    request: UpdateRequest,
    idempotencyKey?: string,
  ): Promise<PortalPerson> {
    const replay = await this.#replayed<PortalPerson>(facts, idempotencyKey, { personId, request });
    if (replay !== null) return replay;

    if (request.access !== undefined && !isPortalAccessRole(request.access)) {
      throw invalid('That is not a role you can give someone at your business.');
    }

    const response = await scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      const rows = await this.#peopleIn(db, facts);
      const acting = this.#assertMayManage(rows, facts);

      const target = rows.find((r) => r.id === personId);
      if (target === undefined) throw notFound();

      // ⚠ LAST-OWNER PROTECTION. Without it a business could quietly leave
      // itself with nobody who can ever add or remove anyone again, and there is
      // no route back from inside the portal — it would be a support call, which
      // is the failure this whole feature was ruled in to remove. The fix is
      // named in the refusal, because "you cannot do that" without "here is what
      // to do instead" is a dead end on a phone.
      const demoting = request.access !== undefined && request.access !== 'BUSINESS_ADMIN';
      if (demoting && isLastOwner(rows, personId)) {
        throw invalid('This is your only owner — make someone else an owner first.');
      }

      const name = request.name === undefined ? null : splitName(request.name.trim());
      if (request.name !== undefined && request.name.trim() === '') throw invalid('Enter their name.');

      const updated = await db.contact.update({
        where: { id: target.id },
        data: {
          ...(name === null ? {} : { firstName: name.firstName, lastName: name.lastName }),
          ...(request.jobTitle === undefined ? {} : { role: request.jobTitle }),
          ...(request.access === undefined ? {} : { portalRole: request.access }),
          ...(request.canSendDocuments === undefined ? {} : { canSendDocuments: request.canSendDocuments }),
          ...(request.canSeeTotals === undefined ? {} : { canSeeTotals: request.canSeeTotals }),
        },
        select: PERSON_SELECT,
      });

      await this.#audit(db, facts, acting, 'business.person.updated', {
        personId: target.id,
        // What CHANGED, never the whole row: an audit payload is storable and
        // small, and the row itself is readable from the list.
        ...(request.access === undefined ? {} : { access: request.access }),
        ...(request.canSendDocuments === undefined ? {} : { canSendDocuments: request.canSendDocuments }),
        ...(request.canSeeTotals === undefined ? {} : { canSeeTotals: request.canSeeTotals }),
        ...(request.name === undefined ? {} : { renamed: true }),
        ...(request.jobTitle === undefined ? {} : { retitled: true }),
      });

      return toPortalPerson(updated, facts.contactId);
    });

    await this.#remember(facts, idempotencyKey, { personId, request }, response);
    return response;
  }

  /**
   * Remove someone's access.
   *
   * **A revocation, not a deletion**, and the screen says so in as many words:
   * *"They stop being able to send documents immediately. Anything they already
   * sent stays with your accountant."* The `contacts` row is DEACTIVATED, never
   * destroyed — documents that person already submitted carry their provenance,
   * and a hard delete would either orphan that trail or rewrite it, both of
   * which make a client's own file less honest than it was.
   *
   * What deactivation actually withdraws, the same instant, in three readers:
   *
   * - **the sender map** — a forwarded email from that address stops resolving
   *   to this workspace and lands Unrouted (`sender-map.ts`);
   * - **new sessions** — the tokenless sign-in no longer finds them, and answers
   *   its usual uniform `202` while sending nothing (`resolveByAddress`);
   * - **the session they are holding right now** — the resolver re-reads the
   *   contact on every request, so a bearer minted a minute ago stops working
   *   rather than lasting out its hour (`portal-session-context.ts`).
   *
   * All three are needed. Without the second, a revoked person simply requests a
   * fresh code and gets a brand-new hour.
   */
  async removePerson(facts: PortalSessionFacts, personId: string, idempotencyKey?: string): Promise<PortalPerson> {
    const replay = await this.#replayed<PortalPerson>(facts, idempotencyKey, { personId });
    if (replay !== null) return replay;

    const response = await scopedDb(this.prisma, systemScopeFor(facts), async (db) => {
      const rows = await this.#peopleIn(db, facts);
      const acting = this.#assertMayManage(rows, facts);

      const target = rows.find((r) => r.id === personId);
      if (target === undefined) throw notFound();

      // Nobody may remove themselves. A person revoking their own authority from
      // a phone has no way back in, and asking another admin costs one message.
      if (target.id === facts.contactId) {
        throw invalid('You cannot remove your own access. Ask another owner or user administrator to do it.');
      }
      if (isLastOwner(rows, personId)) {
        throw invalid('This is your only owner — make someone else an owner first.');
      }

      const updated = await db.contact.update({
        where: { id: target.id },
        // Idempotent by shape: removing somebody already removed re-stamps the
        // instant rather than failing, and the screen renders the same answer.
        data: { deactivatedAt: target.deactivatedAt ?? new Date() },
        select: PERSON_SELECT,
      });

      await this.#audit(db, facts, acting, 'business.person.removed', { personId: target.id });

      return toPortalPerson(updated, facts.contactId);
    });

    await this.#remember(facts, idempotencyKey, { personId }, response);
    return response;
  }

  /**
   * Everybody on this business, live and revoked.
   *
   * ⚠ Revoked people are INCLUDED. Removal is a state a client should be able to
   * see and understand — a name that simply vanished is how somebody concludes
   * the product lost it — and `isLastOwner` must count over the same set the
   * refusals are computed from, or a revoked owner could be used to release the
   * protection on the last live one.
   */
  async #peopleIn(db: ScopedClient, facts: PortalSessionFacts): Promise<PortalPersonRow[]> {
    return db.contact.findMany({
      where: whereFor(facts),
      select: PERSON_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      // One over the ceiling, so `truncated` can be answered without a count.
      take: PORTAL_PEOPLE_LIMIT + 1,
    });
  }

  /**
   * The acting person, and the refusal.
   *
   * ⚠ The acting row is found **in the list that was just read for this
   * business**, not by an id lookup. A `contact_id` naming somebody on another
   * business therefore resolves to nothing and fails closed, rather than
   * resolving to a real person whose authority would then be applied to a
   * workspace they do not belong to.
   */
  #assertMayManage(rows: readonly PortalPersonRow[], facts: PortalSessionFacts): PortalPersonRow | null {
    const acting = rows.find((r) => r.id === facts.contactId) ?? null;
    // `portalActorFor(null)` yields `role: null`, which every branch of
    // `assertCan` refuses — a chase session, whose `contact_id` is deliberately
    // NULL, manages nobody.
    assertCan(portalActorFor(acting), 'business.people.manage');
    return acting;
  }

  /**
   * The replay half of `Idempotency-Key`, which the contract declares a `409` for
   * on all three mutations.
   *
   * ⚠ **The store key is namespaced by SESSION, not by business.**
   * `Idempotency-Key` is a client-generated UUID over a process-wide flat map,
   * so two sessions reusing one key must MISS rather than be handed each
   * other's response — and the response here names a person on a workspace. The
   * session id is in the fingerprint as well as the key, so a collision on one
   * cannot be resolved by the other.
   */
  async #replayed<T>(facts: PortalSessionFacts, key: string | undefined, request: unknown): Promise<T | null> {
    if (key === undefined) return null;
    const record = await this.idempotency.get(storeKey(facts, key));
    if (record === null) return null;
    if (record.requestHash !== fingerprint({ otpSessionId: facts.otpSessionId, request })) {
      throw new AppException(
        'NT-IDM-001',
        HttpStatus.CONFLICT,
        'This Idempotency-Key was already used with a different payload',
      );
    }
    return record.response as T;
  }

  async #remember(
    facts: PortalSessionFacts,
    key: string | undefined,
    request: unknown,
    response: unknown,
  ): Promise<void> {
    if (key === undefined) return;
    await this.idempotency.put(storeKey(facts, key), {
      requestHash: fingerprint({ otpSessionId: facts.otpSessionId, request }),
      response,
    });
  }

  /** One audit row per change, in the practice's own chain. */
  async #audit(
    db: ScopedClient,
    facts: PortalSessionFacts,
    acting: PortalPersonRow | null,
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const outcome = {
      ...detail,
      // WHO, as the practice can read it: a contacts id, because a portal person
      // usually has no `users` row at all (SoT §3.3's phone-only contacts are
      // real). Never the address — an audit payload is storable and an address
      // is personal data the chain does not need to carry.
      byContactId: acting?.id ?? null,
      byAccess: acting === null ? null : effectivePortalRole(acting),
      otpSessionId: facts.otpSessionId,
    };
    await appendAuditEvent(db, {
      businessId: facts.businessId,
      event,
      // No proposal, and structurally there cannot be one: the Review → Approve
      // spine carries `workspaceSession`, which a portal caller does not hold.
      proposalId: null,
      payloadHash: canonicalHash(outcome),
      renderedSummaryHash: null,
      traceId: null,
      outcome,
    });
  }
}

/** The one expression that narrows the practice-wide context to this client. */
function whereFor(facts: PortalSessionFacts): { businessId: string } {
  return { businessId: facts.businessId };
}

/** `portal-people:<session>:<key>` — the third portal surface to namespace this way, for the same reason. */
function storeKey(facts: PortalSessionFacts, key: string): string {
  return `portal-people:${facts.otpSessionId}:${key}`;
}

/** Whether a resolved acting row may manage — the same rule `assertCan` enforces, read as a fact. */
function mayManage(acting: PortalPersonRow | null): boolean {
  if (acting === null) return false;
  const role = effectivePortalRole(acting);
  return role === 'BUSINESS_ADMIN' || role === 'USER_ADMIN';
}

/** `"Tom Whyte"`, or null when the business recorded no name for the inviter. */
function displayName(row: PortalPersonRow | null): string | null {
  if (row === null) return null;
  const name = [row.firstName, row.lastName].filter((part) => part !== null && part !== '').join(' ');
  return name === '' ? null : name;
}

/**
 * The portal's front door, carrying no token.
 *
 * ⚠ That absence is the design — see `composeBusinessPeopleInvite`. The origin
 * is trimmed of a trailing slash so the link is not `https://app.test//portal`,
 * which some mail clients decline to linkify.
 */
export function portalFrontDoor(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/portal`;
}

/** Exported for the controller's 403, so the two cannot drift. */
export const PORTAL_PEOPLE_FORBIDDEN_DETAIL = NOT_PERMITTED_DETAIL;
