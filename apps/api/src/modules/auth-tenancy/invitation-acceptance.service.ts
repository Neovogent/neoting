import { HttpStatus, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { InvitationAcceptanceResult, InvitationPreview, WorkspaceRole } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import { type PracticeSystemActor, systemActorsByPractice } from '../../common/db/resolve-system-actor.js';
import { systemContext } from '../../common/db/scope-context.js';
import { type ScopedClient, scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { hashSetupToken } from '../clients-team-settings/index.js';
import { hashPassword } from './password.js';
import { appendPracticeAuditEvent, canonicalStringify, sha256Hex } from './signup-audit.js';
import { RateLimitedException, type SignInThrottle } from './sign-in-throttle.js';

/**
 * `POST /v1/auth/invitation-preview` and `POST /v1/auth/invitation-acceptance` —
 * how a colleague who was invited actually becomes a user.
 *
 * `POST /v1/practice-members` writes the invitation and emails the link; this is
 * the door that link opens. **It is the deliberate mirror of
 * `practice-signup.service.ts`'s `provisionPractice`** — read that method and
 * its unscoped-write justification before changing anything here — and it
 * differs from it in exactly one way that matters: a signup has no tenant to be
 * scoped to, and this does. The practice already exists, so nothing here runs
 * unscoped. It runs under the practice's own SYSTEM context, which is the
 * worker pattern, not an exemption.
 *
 * ## ⚠ IT ISSUES NO SESSION, AND MUST NEVER GROW ONE
 *
 * No cookie, no bearer, nothing. The account it creates has no second factor,
 * and `OTP_MODE=totp` — what staging runs — **fails closed** for an account with
 * no enrolment. A session minted here would therefore be either a session that
 * cannot be used, or a door around the second factor for anyone holding an
 * invitation link. The invitee's next call is `POST /v1/auth/totp-enrolment`
 * with the password they have just chosen; that endpoint is authenticated by
 * password alone precisely because its purpose is that the caller has no factor
 * yet. This is the door the refusal points at, not a way round it.
 *
 * ## Why the address is created ALREADY VERIFIED
 *
 * `emailVerified: true`, and it is a claim about delivery rather than a
 * shortcut. The token existed in one place only — an email this server sent to
 * that address — so presenting it proves control of the mailbox, which is
 * exactly what `POST /v1/auth/email-verification` proves for a self-signup.
 * Sending a second verification mail would ask the invitee to prove twice what
 * they have already proved once, and an unverified account cannot enrol
 * (`NT-AUTH-006`), so the flow would simply dead-end.
 *
 * ## What it refuses, and why they are all one answer
 *
 * `NT-AUTH-004` covers: a token that resolves to nothing, an invitation that is
 * a CLIENT invitation rather than a practice one, one already accepted, and an
 * address that already has an account. `NT-AUTH-005` is expiry alone. Same split
 * and same reasoning as `email-verification.service.ts`: an expiry is a fact
 * about a credential its holder already had and "ask for another" is the only
 * action available to them, while everything else collapses so a guesser learns
 * nothing — including, on the already-registered branch, an answer to *"is this
 * address registered here"*.
 */

/** What `preview` gives the screen so it can name what is being accepted. */
export type InvitationPreviewOutcome = InvitationPreview;

export interface InvitationAcceptanceInput {
  readonly token: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
}

/** The invitation, and the practice context that could see it. */
interface ResolvedInvitation {
  readonly actor: PracticeSystemActor;
  readonly id: string;
  readonly email: string;
  readonly role: WorkspaceRole;
  readonly businessIds: readonly string[];
  readonly hideFinancialFields: boolean;
  readonly expiresAt: Date;
  readonly invitedByUserId: string | null;
}

/** Why a token did not resolve. Never told to the caller — logged, so an operator is not blind. */
type RefusalReason =
  | 'unknown-token'
  | 'expired'
  | 'already-accepted'
  | 'not-a-practice-invite'
  | 'no-practice-actor'
  | 'address-taken'
  | 'no-clients-left';

/** The event name for the acceptance row. Stable — a later access review greps for it. */
export const MEMBER_JOINED_EVENT = 'practice.member-joined';

export class InvitationAcceptanceService {
  private readonly logger = new Logger(InvitationAcceptanceService.name);

  constructor(
    private readonly prisma: PrismaClient,
    /**
     * ⚠ **PER TOKEN, AND THAT IS NOT THE SAME AS PER CALLER** — the same
     * limitation `email-verification.service.ts` states at length. It bounds
     * repeated work against one link and does NOT bound a flood, because an
     * attacker varies the token for free. The ceiling that would is per-IP, and
     * this API cannot have one until `main.ts` trusts the proxy. What makes it
     * tolerable here: the token is 256 bits of CSPRNG output, so there is
     * nothing to guess, and a rejected one costs one hash before the sweep.
     */
    private readonly throttle: SignInThrottle,
  ) {}

  /**
   * Describe an outstanding invitation without spending it.
   *
   * Everything returned is already in the email the caller is reading it from —
   * the practice invited this address and sent them this link — so naming the
   * firm, the address and the role discloses nothing. That is what separates
   * this screen from `/signup/check-email`, which may say nothing at all: that
   * one answers whoever typed an address, this one answers whoever holds a token
   * we delivered to it.
   */
  async preview(token: string, nowMs: number = Date.now()): Promise<InvitationPreviewOutcome> {
    const key = throttleKey(token);
    const standing = this.throttle.inspect(key, nowMs);
    if (standing.locked) throw new RateLimitedException(standing.retryAfterSeconds);

    const found = await this.resolve(token, nowMs);
    if (!found.ok) return this.refuse(key, nowMs, found.reason);

    const invitation = found.invitation;
    const { practiceName, invitedByName } = await scopedDb(
      this.prisma,
      systemContext(invitation.actor.practiceId, invitation.actor.systemUserId),
      async (db) => {
        const practice = await db.practice.findUnique({
          where: { id: invitation.actor.practiceId },
          select: { name: true },
        });
        return { practiceName: practice?.name ?? null, invitedByName: await readInviterName(db, invitation.invitedByUserId) };
      },
    );

    // A practice that vanished between the invitation and this call. Uniform
    // refusal: there is nothing to accept, and "the firm that invited you no
    // longer exists" is not a sentence to put in front of a stranger.
    if (practiceName === null) return this.refuse(key, nowMs, 'unknown-token');

    this.throttle.recordSuccess(key);
    return {
      practiceName,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      invitedByName,
    };
  }

  /**
   * Spend the invitation: one user, their memberships, the stamp, the audit
   * row. **One transaction**, because a user without their membership resolves
   * to a 401 on every request afterwards and a stamped invitation with no user
   * behind it can never be retried.
   *
   * The invitation is resolved twice on purpose. The sweep below is a read that
   * finds WHICH practice can see this token; the `SELECT … FOR UPDATE` inside
   * the transaction is what makes the decision, because between the two a
   * concurrent acceptance could have spent it. The row lock is what turns
   * "check then write" into one atomic answer, the same move
   * `email-verification.service.ts` makes with its conditional `updateMany`.
   */
  async accept(input: InvitationAcceptanceInput, nowMs: number = Date.now()): Promise<InvitationAcceptanceResult> {
    const key = throttleKey(input.token);
    const standing = this.throttle.inspect(key, nowMs);
    if (standing.locked) throw new RateLimitedException(standing.retryAfterSeconds);

    const found = await this.resolve(input.token, nowMs);
    if (!found.ok) return this.refuse(key, nowMs, found.reason);
    const invitation = found.invitation;

    // ⚠ HASH BEFORE THE TRANSACTION OPENS. scrypt burns ~50-100 ms of CPU on
    // the event loop; doing it inside would hold a database transaction — and
    // the advisory lock the audit append takes — for the whole burn. The same
    // ordering, for the same reason, as `practice-signup.service.ts`.
    const passwordHash = hashPassword(input.password);
    const tokenHash = hashSetupToken(input.token);

    let outcome: { ok: true; email: string } | { ok: false; reason: RefusalReason };
    try {
      outcome = await scopedDb(
        this.prisma,
        systemContext(invitation.actor.practiceId, invitation.actor.systemUserId),
        (db) => this.provision(db, invitation, { tokenHash, passwordHash, input, nowMs }),
      );
    } catch (error) {
      // P2002 on `users.email`: a concurrent signup or acceptance won the race
      // between the existence check and the insert. Same outcome as finding it
      // there — the whole transaction rolled back, so no orphan membership and
      // no consumed invitation.
      if (!isUniqueEmailViolation(error)) throw error;
      outcome = { ok: false, reason: 'address-taken' };
    }

    if (!outcome.ok) return this.refuse(key, nowMs, outcome.reason);
    this.throttle.recordSuccess(key);
    return { email: outcome.email };
  }

  /**
   * The whole write, inside the caller's open transaction.
   *
   * `businessIds` decides the membership SHAPE, and this is where per-client
   * access stops being a field and becomes a tenancy fact:
   *
   * - **Practice-WIDE** (`practiceId` set, `businessId` null) for a
   *   `CLIENT_ADMIN` and for a `PRACTICE_STANDARD` invited with no client list.
   *   RLS's practice-membership branch then reaches every client of the firm.
   * - **One BUSINESS-SCOPED membership per assigned client** (`practiceId`
   *   **null**, `businessId` set) otherwise. ⚠ The null practice id is the whole
   *   mechanism: `app_can_access_business`'s third branch grants access to every
   *   business of any practice the user holds a `practice_id` on, so a scoped
   *   colleague whose rows also carried one would see exactly the clients the
   *   scope was meant to withhold. Written null, RLS confines them to their own
   *   list with no new policy and no application filter.
   *
   * `isOwner` is **always false**. Exactly one membership per practice carries
   * it — the one signup writes — and nothing in the contract moves it, so an
   * invited colleague can never release (`mayRelease` is `canRelease(role) &&
   * isOwner`). That is the invariant the invite boundary's `PRACTICE_ADMIN`
   * refusal exists to keep coherent.
   */
  private async provision(
    db: ScopedClient,
    invitation: ResolvedInvitation,
    facts: { tokenHash: string; passwordHash: string; input: InvitationAcceptanceInput; nowMs: number },
  ): Promise<{ ok: true; email: string } | { ok: false; reason: RefusalReason }> {
    // The row lock. Raw because Prisma has no `FOR UPDATE`, and inside this
    // transaction because a lock taken anywhere else is a lock nothing holds by
    // the time the write happens. `invites` is policed and the context is this
    // practice's, so a token belonging to another firm returns no row here even
    // though the sweep already said it belongs to this one.
    const locked = await db.$queryRaw<{ accepted_at: Date | null; expires_at: Date }[]>`
      SELECT accepted_at, expires_at FROM invites WHERE token_hash = ${facts.tokenHash} FOR UPDATE`;
    const row = locked[0];
    if (row === undefined) return { ok: false, reason: 'unknown-token' };
    if (row.accepted_at !== null) return { ok: false, reason: 'already-accepted' };
    if (row.expires_at.getTime() <= facts.nowMs) return { ok: false, reason: 'expired' };

    // The cheap, common case: an address that is plainly taken must not create a
    // user and roll it back. `users.email` is `@unique`, so this is an index
    // probe, and the P2002 catch in `accept` covers the race it cannot.
    const existing = await db.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
    if (existing !== null) return { ok: false, reason: 'address-taken' };

    // Re-checked at acceptance, not trusted from the invitation: a client may
    // have been offboarded in the seven days since. Read through RLS under the
    // practice context, so this is the same set the inviter could see.
    const scoped = invitation.businessIds.length === 0
      ? []
      : (await db.business.findMany({ where: { id: { in: [...invitation.businessIds] } }, select: { id: true } })).map((b) => b.id);
    // Every client the invitation named is gone. Granting practice-wide access
    // instead would be widening a decision nobody took, and granting nothing
    // would create an account that cannot sign in at all (`loadScopeForUser`
    // returns null with no memberships, which is a 401 on every request). So the
    // invitation is refused and a fresh one is the way forward.
    if (invitation.businessIds.length > 0 && scoped.length === 0) return { ok: false, reason: 'no-clients-left' };

    const user = await db.user.create({
      data: {
        kind: 'HUMAN',
        email: invitation.email,
        // True, and the token is the proof — see the class header. Nothing else
        // in this system may set it without proving control of the address.
        emailVerified: true,
        passwordHash: facts.passwordHash,
        firstName: facts.input.firstName.trim(),
        lastName: facts.input.lastName.trim(),
      },
      select: { id: true },
    });

    const memberships = scoped.length === 0
      ? [{
          userId: user.id,
          practiceId: invitation.actor.practiceId,
          role: invitation.role,
          isOwner: false,
          hideFinancialFields: invitation.hideFinancialFields,
        }]
      : scoped.map((businessId) => ({
          userId: user.id,
          // NULL — see this method's header. It is what makes RLS confine them.
          practiceId: null,
          businessId,
          role: invitation.role,
          isOwner: false,
          hideFinancialFields: invitation.hideFinancialFields,
        }));
    await db.membership.createMany({ data: memberships });

    // Consumed. Conditional on it still being unaccepted even under the row
    // lock: `updateMany` costs nothing and means a lock that was somehow not
    // held still cannot produce two acceptances.
    const stamped = await db.invite.updateMany({
      where: { id: invitation.id, acceptedAt: null },
      data: { acceptedAt: new Date(facts.nowMs) },
    });
    if (stamped.count === 0) return { ok: false, reason: 'already-accepted' };

    await appendPracticeAuditEvent(db, {
      event: MEMBER_JOINED_EVENT,
      // The address is hashed rather than stored: `audit_events` is append-only
      // by policy AND by trigger, so a mailbox written here could never be
      // erased. `users.email` is the erasable record; this proves which address
      // accepted if it is ever put to us. Same stance as the terms row.
      payloadHash: sha256Hex(
        canonicalStringify({
          practiceId: invitation.actor.practiceId,
          inviteId: invitation.id,
          email: invitation.email,
          role: invitation.role,
        }),
      ),
      outcome: {
        practiceId: invitation.actor.practiceId,
        inviteId: invitation.id,
        userId: user.id,
        role: invitation.role,
        businessIds: scoped,
        invitedByUserId: invitation.invitedByUserId,
        acceptedAt: new Date(facts.nowMs).toISOString(),
      },
      traceId: null,
    });

    return { ok: true, email: invitation.email };
  }

  /**
   * Token → the invitation and the practice that can see it, by **the sanctioned
   * sweep** (`common/db/resolve-system-actor.ts`): every practice's SYSTEM actor,
   * each context asked in turn whether RLS lets it see this row. `invites` is
   * policed, so an unscoped read would return nothing and a hand-written
   * practice filter would be the boundary rather than the database.
   */
  private async resolve(
    token: string,
    nowMs: number,
  ): Promise<{ ok: true; invitation: ResolvedInvitation } | { ok: false; reason: RefusalReason }> {
    const tokenHash = hashSetupToken(token);
    const candidates = await systemActorsByPractice(this.prisma);
    // No practice has a SYSTEM actor, so there is nothing to search UNDER.
    // Distinguished from `unknown-token` in the LOG because the two look
    // identical from outside and have nothing in common as fixes: this one is an
    // unprovisioned tenant (`db/backfill-system-actors.ts`), not a bad link.
    if (candidates.length === 0) return { ok: false, reason: 'no-practice-actor' };

    let reason: RefusalReason = 'unknown-token';
    for (const actor of candidates) {
      const found = await scopedDb(this.prisma, systemContext(actor.practiceId, actor.systemUserId), async (db) => {
        const invite = await db.invite.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            practiceId: true,
            businessId: true,
            email: true,
            role: true,
            businessIds: true,
            hideFinancialFields: true,
            expiresAt: true,
            acceptedAt: true,
            invitedByUserId: true,
          },
        });
        // `reason` is only ever narrowed by a practice that can SEE the row; a
        // practice that cannot leaves it as `unknown-token`, which is what the
        // sweep means for every other practice in the account.
        if (invite === null) return null;
        // A CLIENT invitation. It is a real row and it is not this door's:
        // `/app/setup` spends it, with an emailed code and no password. Passing
        // it here would create a workspace USER for somebody the practice
        // invited as a client contact.
        if (invite.practiceId === null || invite.businessId !== null || invite.email === null) {
          reason = 'not-a-practice-invite';
          return null;
        }
        if (invite.acceptedAt !== null) { reason = 'already-accepted'; return null; }
        if (invite.expiresAt.getTime() <= nowMs) { reason = 'expired'; return null; }

        return {
          actor,
          id: invite.id,
          email: invite.email.toLowerCase(),
          role: invite.role,
          businessIds: invite.businessIds,
          hideFinancialFields: invite.hideFinancialFields,
          expiresAt: invite.expiresAt,
          invitedByUserId: invite.invitedByUserId,
        } satisfies ResolvedInvitation;
      });
      if (found !== null) return { ok: true, invitation: found };
    }
    return { ok: false, reason };
  }

  /**
   * Count the failure, log the reason, answer uniformly.
   *
   * The reason reaches the LOG and never the caller — `portal/CLAUDE.md` records
   * what the alternative costs: a silent refusal that is also a silent log is a
   * night spent guessing, and the operator is not the person the uniformity
   * protects anyone from. The token itself is never logged.
   */
  private refuse(key: string, nowMs: number, reason: RefusalReason): never {
    this.logger.warn(`invitation refused · reason=${reason}`);
    const verdict = this.throttle.recordFailure(key, nowMs);
    if (verdict.locked) throw new RateLimitedException(verdict.retryAfterSeconds);
    throw reason === 'expired' ? expiredInvitation() : invalidInvitation();
  }
}

/**
 * The throttle namespace for this path.
 *
 * ⚠ Keyed on a HASH of the token, never the token: the throttle keeps its keys
 * in a process-wide `Map`, and a live credential is not something to leave lying
 * in one. The `inv:` prefix keeps this key space disjoint from the login
 * counter's (a normalised email address) and from email verification's (`ev:`) —
 * three counters that must not be able to lock each other out.
 */
function throttleKey(token: string): string {
  return `inv:${createHash('sha256').update(token).digest('hex')}`;
}

/** `users` carries no RLS, so this read is bounded by the id the invitation row itself supplied. */
async function readInviterName(db: ScopedClient, invitedByUserId: string | null): Promise<string | null> {
  if (invitedByUserId === null) return null;
  const user = await db.user.findUnique({ where: { id: invitedByUserId }, select: { firstName: true, lastName: true } });
  if (user === null) return null;
  const name = [user.firstName, user.lastName].filter((part) => part !== null && part.trim() !== '').join(' ').trim();
  return name === '' ? null : name;
}

function invalidInvitation(): AppException {
  return new AppException(
    'NT-AUTH-004',
    HttpStatus.UNAUTHORIZED,
    'Invitation not valid',
    'That invitation link is not valid. Ask whoever invited you to send a new one.',
  );
}

function expiredInvitation(): AppException {
  return new AppException(
    'NT-AUTH-005',
    HttpStatus.UNAUTHORIZED,
    'Invitation expired',
    'That invitation link has expired. Ask whoever invited you to send a new one.',
  );
}

/**
 * Prisma's unique-constraint error, duck-typed rather than caught by class — the
 * same helper `practice-signup.service.ts` carries, and for the same reason:
 * importing `Prisma.PrismaClientKnownRequestError` as a VALUE would put a runtime
 * dependency on the generated client into a module that otherwise only receives
 * one.
 */
function isUniqueEmailViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  // Narrow to the email index specifically. A P2002 on anything else is a real
  // bug and must not be swallowed as "that address is taken".
  if (Array.isArray(target)) return target.includes('email');
  return typeof target === 'string' ? target.includes('email') : false;
}
