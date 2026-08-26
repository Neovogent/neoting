import { HttpStatus } from '@nestjs/common';

import type { ProposalKind, WorkspaceRole } from '@neoting/contracts/model';

import type { ScopeContext } from '../../common/db/scope-context.js';
import type { ScopedClient } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { canRelease } from '../clients-team-settings/index.js';

/**
 * The release gate — stage A12, D44, Governance §11.2.
 *
 * > *Accountants and their team members may compose and edit — chase message
 * > text, document coding, every extracted field. Only the accounting firm's
 * > super admin may release: authorise a chase SMS to send, and move an item
 * > from Ready to Published.* (SoT v1.6, D44)
 *
 * Governance §11.2's words are `assertCan(actor, 'publish.release', resource)`
 * **in the service layer**, and it adds *"a UI that merely hides the button is
 * not an implementation of this"*. So this is a server refusal on the one door
 * every irreversible outward act goes through — the engine's approve path — and
 * the UI's job is to degrade honestly against the 403 it gets back, not to be
 * the gate.
 *
 * ## Why the check is on the ENGINE and not in the executors
 *
 * `proposal-executor.ts` states the seam: *an executor performs exactly one
 * effect and decides nothing about whether it may happen*. Two authorisation
 * mechanisms — one beside the engine, one inside `publish-batch.ts` — are two
 * things free to disagree, and the more permissive of two always wins on the day
 * it matters. `publish-batch.ts`'s header names this file's call site for
 * exactly that reason and deliberately left the check out.
 *
 * ## Who the super admin is — `PRACTICE_ADMIN` **and** `isOwner`
 *
 * The role half is {@link canRelease}, imported from
 * `clients-team-settings/index.ts` (A11's public seam) rather than re-derived,
 * so "which role may release" is written once. A11's own header hands the second
 * half here in as many words: *"A practice may have more than one
 * `PRACTICE_ADMIN`, so this is 'a super admin', not 'the named principal'.
 * `memberships.is_owner` narrows it to the one person who created the practice
 * if a stricter reading is wanted — that is A12's call to make."*
 *
 * **A12 takes the stricter reading, and requires both.** Three reasons, in the
 * order they mattered:
 *
 * 1. **D44 says *the* firm's super admin, singular.** `PRACTICE_ADMIN` alone
 *    reads as *any* admin, which is a wider grant than the decision makes.
 * 2. **It costs nothing today and prevents a silent widening tomorrow.** No code
 *    path in this repo can mint a second `PRACTICE_ADMIN`: signup writes exactly
 *    one (`auth-tenancy/practice-signup.service.ts`, `isOwner: true` on the same
 *    row), and `POST /businesses/{id}/members` refuses every practice-level role.
 *    So the two rules select the same person right now. They diverge on the day
 *    an invite path for a second admin lands — and on that day the role-only rule
 *    would hand release authority to a newly invited colleague with no decision
 *    having been taken, which is the failure mode a permission check exists to
 *    prevent.
 * 3. **It fails closed.** An `isOwner` that was never set refuses; a role that
 *    was granted loosely does not.
 *
 * ⚠ **The cost, stated rather than discovered:** there is no
 * ownership-**transfer** operation in the contract, so a practice whose owner is
 * unavailable cannot release until they are back. That bus factor is identical
 * under the role-only rule today (there is only ever one `PRACTICE_ADMIN`), so
 * this choice does not create it — but it is the thing to fix first when a
 * second admin becomes possible. Recorded in `approvals/CLAUDE.md`.
 *
 * ⚠ **`memberships.permissions` is deliberately NOT consulted.** Governance
 * §11.1 mentions per-permission toggles, and `prisma/seed.ts` populates the array
 * for its demo admin — but `practice-signup.service.ts` leaves it `[]`, so a
 * freshly signed-up firm's owner has no `publish` string on their row. Requiring
 * one would mean nobody could ever release, and defaulting an empty array to
 * "allowed" would make the field decorative. Role + ownership is the whole rule
 * until a grant surface exists to fill that array.
 */

/**
 * The actions this module authorises. One member today, and it is the contract's
 * own name for it (Governance §11.2) rather than a local coinage — a second
 * member arrives with the surface that needs it.
 */
export type PermittedAction = 'publish.release';

/**
 * The acting person, resolved from their membership. Everything needed to answer
 * "may they release?" and nothing else — no session, no request, no Prisma row,
 * so {@link assertCan} stays a pure function a test can drive directly.
 */
export interface Actor {
  readonly actorId: string;
  /**
   * The role on the actor's PRACTICE-WIDE membership, or `null` when they hold
   * none. Null is the honest answer for a client-workspace user and for a
   * membership that was deactivated between sign-in and this request; both
   * refuse.
   */
  readonly role: WorkspaceRole | null;
  /** `memberships.is_owner` — the firm's single super admin (A1's choice). */
  readonly isOwner: boolean;
}

/** What is being authorised. The proposal, named by the only facts the decision uses. */
export interface ProposalResource {
  readonly kind: ProposalKind;
  readonly proposalId: string;
  readonly businessId: string | null;
}

/**
 * Which kinds are a RELEASE — total over `ProposalKind` by the mapped type, the
 * way `ExecutorRegistry` is. A new kind that fails to compile here is the point:
 * "is this an irreversible outward act?" is a question a new proposal kind must
 * answer, not one it may inherit a default for.
 *
 * D44 names two, and they are the two things this product does that reach
 * outside itself and cannot be taken back:
 *
 * - **`chase.send`** — a text or an email to somebody else's client. Once sent,
 *   it is sent.
 * - **`publish.batch`** — Ready → Published, which under D42 means released for
 *   export. The export is ID's only egress, so this is the act that lets a
 *   figure leave the product.
 *
 * ⚠ **`document.revoke-link` is deliberately `false`.** It is an outward act —
 * it turns a working link inside somebody's ledger into a 410 — and gating it
 * was the first instinct. It is not gated because revocation is a
 * **containment** action: the reason to press it is that a capability URL has
 * leaked, and a rule that says only one person in the firm may stop a leak makes
 * the leak last longer. A8 owns that lane and may revisit with the surface in
 * front of it.
 *
 * Everything else is internal and reversible by a further proposal — archive
 * unarchives, coding is corrected again, a rejection is reprocessed — so D44's
 * first half applies: the team composes and edits.
 */
export const RELEASE_KINDS: Readonly<Record<ProposalKind, boolean>> = {
  'chase.send': true,
  'publish.batch': true,
  'document.route': false,
  'document.archive': false,
  'document.update-coding': false,
  'document.move-business': false,
  'document.reprocess': false,
  'document.reject': false,
  'document.split': false,
  'bank.confirm-match': false,
  'rule.create': false,
  'document.revoke-link': false,
};

/** Does approving this kind need release authority? */
export function requiresReleaseAuthority(kind: ProposalKind): boolean {
  return RELEASE_KINDS[kind];
}

/** D44's whole rule, in one expression: the release role AND the ownership flag. */
export function mayRelease(actor: Actor): boolean {
  return actor.role !== null && canRelease(actor.role) && actor.isOwner;
}

/**
 * Governance §11.2's check. Throws {@link AppException} `NT-PRM-001` (403) when
 * the actor may not perform `action` on `resource`; returns silently otherwise.
 *
 * ## 403 here, 404 elsewhere — and why that is not a leak
 *
 * The house rule is **404, never 403** for a record the caller cannot see, and it
 * is untouched: the caller reached this function only because the proposal came
 * back through `scopedDb`, which means RLS already decided they may see it. What
 * is refused here is not visibility, it is **authority**, and the two want
 * opposite answers:
 *
 * - a 404 for a proposal they can list, open and read the review of would be a
 *   lie, and an unhelpful one — the honest product answer is *"this exists, you
 *   may not release it, ask the person who can"*;
 * - the 403 discloses nothing new, because every fact it implies (the proposal
 *   exists, it is theirs, it is a chase or a publish) is already on
 *   `GET /v1/action-proposals/{id}` for this same caller.
 *
 * So the refusal is ordered **after** the RLS lookup and its 404, and **before**
 * every other gate. An actor who may not release learns nothing about whether the
 * proposal was reviewed, whether it expired, or whether their echoed hash was
 * stale — those are answers to a question they were not allowed to ask. The
 * detail names the authority, never the proposal id.
 */
export function assertCan(actor: Actor, action: PermittedAction, resource: ProposalResource): void {
  if (action === 'publish.release' && mayRelease(actor)) return;
  throw new AppException(
    'NT-PRM-001',
    HttpStatus.FORBIDDEN,
    'Not permitted',
    resource.kind === 'chase.send'
      ? "Only your practice's super admin can authorise a message to a client. Ask them to approve it."
      : "Only your practice's super admin can release documents for export. Ask them to approve it.",
  );
}

/**
 * Read the acting membership for the release decision, inside the caller's OPEN
 * transaction.
 *
 * **Practice-WIDE only** (`practiceId` set, `businessId` null). The firm's super
 * admin is a property of the firm, so a membership scoped to one client workspace
 * is not it, and neither is a caller with no practice in scope at all — both
 * return `role: null` and refuse. That is the same widest-membership rule
 * `auth-tenancy/session-scope.ts` uses to pick a session's acting membership, so
 * who-you-are and what-you-may-release cannot disagree.
 *
 * ⚠ **`memberships` carries no RLS** — it is one of the tables the policies
 * themselves read, and a policed one would recurse (`common/db/CLAUDE.md`,
 * `clients-team-settings/CLAUDE.md`). So the `userId` filter below is not a
 * convenience, it is the boundary: it is the ONLY thing narrowing this read to
 * the caller, and `ctx.actorId` is the verified session's subject. The practice
 * comes from the same verified context, and RLS has already tied the proposal to
 * it by the time this runs.
 *
 * Deactivated users are excluded on the same grounds `loadScopeForUser` excludes
 * them: offboarding must end authority at the next request, not at cookie expiry
 * (Governance §11.1, 60 seconds).
 */
export async function resolveActor(db: ScopedClient, ctx: ScopeContext): Promise<Actor> {
  if (ctx.practiceId === undefined) return { actorId: ctx.actorId, role: null, isOwner: false };

  const membership = await db.membership.findFirst({
    where: {
      userId: ctx.actorId,
      practiceId: ctx.practiceId,
      businessId: null,
      user: { kind: 'HUMAN', deactivatedAt: null },
    },
    select: { role: true, isOwner: true },
    orderBy: { createdAt: 'asc' },
  });

  if (membership === null) return { actorId: ctx.actorId, role: null, isOwner: false };
  return { actorId: ctx.actorId, role: membership.role, isOwner: membership.isOwner };
}
