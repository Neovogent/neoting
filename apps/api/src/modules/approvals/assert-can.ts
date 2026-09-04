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
 * The actions this module authorises. Both are the contract's own names for
 * them (Governance §11.2) rather than local coinages.
 *
 * A second member arrived with the surface that needed it — `POST
 * /v1/practice-members`, the first operation in the product that grants
 * somebody access to a practice. It is here rather than in
 * `clients-team-settings` on purpose: a permission model with a role check in
 * every module that offers a guarded act has no single place to read, and the
 * more permissive of two copies always wins on the day it matters.
 */
export type PermittedAction = 'publish.release' | 'team.invite' | 'business.people.manage' | 'business.profile.manage';

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
  // Not a release: removal destroys DERIVED rows only — the source document
  // stays in the vault and re-import re-proves D41, so it is internal and
  // reversible in the sense that matters. What protects a client's bank data
  // is the executor's refusals (confirmed matches, open chases, unprovable
  // provenance), which bind the super admin too — the document.purge
  // precedent. The banking design note recommended `false`; flagged for human
  // ratification like every entry in this table (it is permission logic).
  'bank.remove-statement': false,
  'rule.create': false,
  'document.revoke-link': false,
  // Not a release: offboarding is soft and entirely internal — it flips
  // `businesses.is_active`, sends nothing, and lets no figure leave the
  // product (books, documents and audit trail are retained, D12). Nothing
  // irreversible happens at the row level; the flag can be restored. D44's
  // compose half therefore applies, the same reading as every other internal
  // kind. Note there is no `business.reactivate` kind yet — the undo is a
  // later surface, the `bank.unmatch` shape — so revisit this ruling if that
  // asymmetry starts to matter in practice.
  'business.offboard': false,
  // ⚠ **`document.purge` is `false`, and this one was genuinely arguable.** It
  // is irreversible — the only irreversible thing that can happen to a document
  // — and irreversibility is half of what `RELEASE_KINDS` is about. It is
  // `false` because the OTHER half is what the gate actually selects for:
  // D44's two kinds both **reach outside the product** — a message to somebody
  // else's client, a figure released for export — and a purge reaches nowhere.
  // It destroys one of the practice's own rows, inside their own workspace,
  // after a human already put it in Trash.
  //
  // What protects the outward promise here is not the approver's rank but the
  // executor's refusal: a document that has been published or that carries a
  // D43 capability link **cannot be purged by anybody**, super admin included.
  // A permission gate would have been a weaker guarantee wearing a stronger
  // word — it would let the one person who may release also destroy the link
  // their release created. Revisit if a firm asks for it; the refusal is the
  // part that must not move.
  'document.purge': false,
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
 * May this actor invite a colleague into the practice?
 *
 * **The release ROLE, and deliberately NOT the `isOwner` narrowing** —
 * `canRelease(role)` alone. The two rules diverge here for the first time, so
 * the reasoning is written out rather than left to be inferred from the missing
 * conjunct:
 *
 * 1. **Inviting is reversible and internal.** {@link RELEASE_KINDS} draws its
 *    line at acts that reach outside the product and cannot be taken back — a
 *    message to somebody else's client, a figure released for export. An
 *    invitation reaches one colleague's inbox, grants nothing until they accept,
 *    and expires by itself in seven days. It is D44's *compose and edit* half,
 *    not its release half.
 * 2. **Requiring ownership would make team management a bus factor of one.**
 *    Exactly one membership in a practice can ever carry `isOwner` (signup
 *    writes it and nothing moves it), and there is no ownership-TRANSFER
 *    operation in the contract. Under the stricter rule, a firm whose founder is
 *    on holiday could not add the temp they hired that morning — and the fix
 *    would be a DBA, which is not a permission model, it is an outage.
 * 3. **The cost is bounded by what an invitation can grant.**
 *    `PRACTICE_ADMIN` is refused at the invite boundary, so no admin can mint a
 *    second admin, and an invited colleague can never release: `mayRelease`
 *    still requires `isOwner`, which acceptance never sets. So the widest thing
 *    this permits is a `PRACTICE_ADMIN` adding someone who composes and edits —
 *    which is what an admin is for.
 *
 * `role === null` refuses, as everywhere here: a client-workspace user and a
 * membership deactivated between sign-in and this request both arrive that way,
 * and both must fail closed.
 */
export function mayManageTeam(actor: Actor): boolean {
  return actor.role !== null && canRelease(actor.role);
}

/**
 * May this actor manage the PEOPLE of a client business — invite one, change
 * what they may do, revoke their access?
 *
 * ## Why it is here and not in the portal
 *
 * The product owner's ruling on 2 Sep 2026 was that a client's manager, HR lead
 * or owner adds their own staff; the portal's Settings → People screen said the
 * opposite. That made a THIRD guarded act, and this file's own header says what
 * to do with one: *"a permission model with a role check in every module that
 * offers a guarded act has no single place to read, and the more permissive of
 * two copies always wins on the day it matters."* So the rule is written once,
 * here, and `modules/portal` imports it through the seam rather than growing a
 * second opinion beside its service.
 *
 * ## The two roles, and why not the third
 *
 * `WorkspaceRole` already contained `BUSINESS_ADMIN`, `USER_ADMIN` and
 * `BUSINESS_STANDARD` before any of this was built, and the middle one reads as
 * purpose-built: a business-side **user** administrator. Nothing had ever
 * granted it, so this is the first surface that gives it a meaning.
 *
 * - **`BUSINESS_ADMIN`** — the owner. Everything, including making somebody else
 *   an owner, which is what makes the last-owner rule escapable.
 * - **`USER_ADMIN`** — the office manager or HR lead. The same people-management
 *   authority and nothing else; it grants no billing, no export, no release.
 * - **`BUSINESS_STANDARD`** — reads the list and cannot change it. Deliberately
 *   not "cannot see it": who else can send paperwork on your employer's behalf
 *   is not a secret from you, and hiding the section would be the *"pretend the
 *   action does not exist"* failure Governance §11.2 names. The screen shows the
 *   list, states who can change it, and the SERVER is what refuses.
 *
 * ## Practice roles are refused here, and that is not an oversight
 *
 * A `PRACTICE_ADMIN` is not a member of the client's staff, and this rule is
 * never consulted for one: the only caller is the portal, whose actor is a
 * `contacts` row on exactly one business. An accountant adding a client's user
 * on the client's behalf is the older, separate door
 * (`POST /businesses/{businessId}/members`, carrying the workspace cookie), and
 * it is unchanged. Two doors onto one outcome is a thing this codebase normally
 * refuses — the difference is that these two have different PRINCIPALS, so
 * collapsing them would mean one of the two authorities checking a credential it
 * cannot hold.
 *
 * `role === null` refuses, as everywhere here — a portal session whose
 * `otp_sessions.contact_id` is null cannot be resolved to a person at all, and an
 * unidentifiable caller must fail closed.
 */
export function mayManagePeople(actor: Actor): boolean {
  return actor.role === 'BUSINESS_ADMIN' || actor.role === 'USER_ADMIN';
}

/**
 * Who may restate the business's own record (the setup journey's details step,
 * 5 Sep 2026). **`BUSINESS_ADMIN` only — deliberately narrower than
 * `business.people.manage`.** A `USER_ADMIN` was granted exactly people
 * management and nothing else (that role's whole definition, portal-people);
 * a company number, a VAT registration and a legal structure are the owner's
 * facts to state. `role === null` refuses, as everywhere here.
 */
export function mayManageProfile(actor: Actor): boolean {
  return actor.role === 'BUSINESS_ADMIN';
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
export function assertCan(actor: Actor, action: 'publish.release', resource: ProposalResource): void;
/**
 * `team.invite` takes NO resource, and the missing argument is the shape of the
 * decision rather than an omission. A release is authorised against one
 * proposal; inviting is authorised against the practice the session already
 * fixes, and there is no record for a caller to name — which is also why the
 * refusal below can be written once instead of per subject.
 */
export function assertCan(actor: Actor, action: 'team.invite'): void;
/**
 * `business.people.manage` takes no resource either, and for the same reason
 * one level down: the business is fixed by the portal session's own
 * `otp_sessions` row before this is reached, so there is nothing for a caller to
 * name. A `businessId` argument here would be a second answer to a question the
 * session has already settled — and the one place a caller could get it wrong.
 */
export function assertCan(actor: Actor, action: 'business.people.manage'): void;
/**
 * `business.profile.manage` — no resource, the `business.people.manage`
 * argument verbatim: the portal session's row fixes the business before this
 * is reached.
 */
export function assertCan(actor: Actor, action: 'business.profile.manage'): void;
export function assertCan(actor: Actor, action: PermittedAction, resource?: ProposalResource): void {
  if (action === 'business.profile.manage') {
    if (mayManageProfile(actor)) return;
    throw new AppException(
      'NT-PRM-001',
      HttpStatus.FORBIDDEN,
      'Not permitted',
      'Only an owner at your business can change its own details. Ask them.',
    );
  }

  if (action === 'business.people.manage') {
    if (mayManagePeople(actor)) return;
    throw new AppException(
      'NT-PRM-001',
      HttpStatus.FORBIDDEN,
      'Not permitted',
      // Written to be read by the person who pressed the button, not by us. It
      // names what they can do (see the list) and the one action available to
      // them (ask somebody who can), and it never says which of the people on
      // screen those are — the list already shows that.
      'Only an owner or a user administrator at your business can add or remove people. Ask one of them.',
    );
  }

  if (action === 'team.invite') {
    if (mayManageTeam(actor)) return;
    throw new AppException(
      'NT-PRM-001',
      HttpStatus.FORBIDDEN,
      'Not permitted',
      'Only a practice admin can invite a colleague. Ask one of your admins to send the invitation.',
    );
  }

  if (mayRelease(actor)) return;
  throw new AppException(
    'NT-PRM-001',
    HttpStatus.FORBIDDEN,
    'Not permitted',
    resource?.kind === 'chase.send'
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
