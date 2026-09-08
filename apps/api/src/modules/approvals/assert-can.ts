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
export type PermittedAction =
  | 'publish.release'
  /**
   * Approving a TIER-1 proposal that is not one of D44's two outward acts —
   * a coding correction, a statement removal, a purge, an offboard, a rule
   * (`docs/Access_and_Approval_Matrix.md`, Part 2, review item 66).
   *
   * ⚠ **The same predicate as `publish.release`, and a separate NAME on
   * purpose.** `publish.release` is Governance §11.2's own literal and its
   * refusals say *"release documents for export"* and *"authorise a message to
   * a client"*. Neither is true of somebody who pressed Approve on a category
   * fix, and the message is the whole user-facing product of a permission
   * check — the rule this file established at `business.billing.manage` and
   * `team.manage`, applied a third time. A second PREDICATE would be a second
   * thing free to disagree; a second NAME costs ten lines.
   */
  | 'proposal.approve'
  | 'team.invite'
  | 'team.manage'
  | 'business.people.manage'
  | 'business.profile.manage'
  | 'business.billing.manage';

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
 * **The TIER-1 table** — total over `ProposalKind` by the mapped type, the way
 * `ExecutorRegistry` is. A new kind that fails to compile here is the point:
 * "does the firm's principal sign for this?" is a question a new proposal kind
 * must answer, not one it may inherit a default for.
 *
 * ## What this table selects for CHANGED on 6 Sep 2026 (review item 66)
 *
 * It was built to select for **acts that reach outside the product** — D44's
 * two, and only those. `docs/Access_and_Approval_Matrix.md` Part 2 asks a
 * different question, and it is the one the product owner asked:
 *
 * > *define activity that is must get approval, such as any publishing, any
 * > filed update like the category… prepare a fine line and divide it that what
 * > needs approval what not*
 *
 * So the predicate is now **"is this the principal's signature?"**, of which
 * "reaches outside and cannot be taken back" is one answer among several.
 * Irreversibility and blast radius are the others. FIVE entries moved as a
 * result, and three of them overturn arguments written in this file — each is
 * named at its entry, because a reversed ruling that is not visible at the
 * reversal is a trap for the next reader.
 *
 * **Tier 1 (`true`) — seven kinds.** Only `mayRelease(actor)` may approve one.
 * **Tier 2 (`false`) — nine kinds.** Any member the RLS context admits.
 *
 * ⚠ **The tier changes WHO approves and WHETHER it queues, never whether it is
 * recorded.** Every kind in both tiers still mints a proposal, still records
 * Read review and its hash, still echoes that hash at Approve, still writes the
 * audit row, and is still enforced again by `action_proposals_guard()` in the
 * database. Governance §10's spine is not what Part 2 legislates over.
 *
 * ⚠ **Tier 1 does not mean "waits for somebody".** When the super admin is the
 * one staging, the same stage → Read review → Approve happens inline in the
 * dialog they are standing in (matrix gate ⚖6) — identical record, no queue.
 * The tier only says whose signature the record has to carry.
 *
 * ⚠ **`document.revoke-link` stays `false`, and it is the one outward act that
 * does.** It turns a working link inside somebody's ledger into a 410, and
 * gating it was the first instinct both times this table was written.
 * Revocation is a **containment** action: the reason to press it is that a
 * capability URL has leaked, and a rule that says only one person in the firm
 * may stop a leak makes the leak last longer. A8 owns that lane and may revisit
 * with the surface in front of it.
 */
export const RELEASE_KINDS: Readonly<Record<ProposalKind, boolean>> = {
  // ⚠ **TIER 2 since 8 Sep 2026 — the owner narrowed D44 to its second half.**
  //
  // > *"Only publishing an entry requires approval by default; a normal email
  // > chase is going under approval [and should not]."* (item 3, live pass 3)
  //
  // D44's sentence named two outward acts and this table priced them the same.
  // The owner has now separated them, and the distinction he drew is the one
  // that survives inspection: a published entry changes the books and cannot
  // be recalled, while a chase asks a client for a document they already owe.
  // Chasing is the daily work of the person doing the bookkeeping, and a rule
  // that made every routine "please send your August statement" wait for the
  // firm's principal made the principal the bottleneck on the product's most
  // frequent act.
  //
  // ⚠ **What tier 2 does NOT change**, and the reason this is a tier flip
  // rather than a new send endpoint: the chase still mints a proposal, still
  // records Read review with its hash, still echoes that hash at Approve, is
  // still executed exactly once, and still writes the audit row. Governance
  // §10's spine is untouched — what moved is WHOSE signature the record has to
  // carry, which is exactly what this table legislates and all it legislates.
  'chase.send': false,
  // The one act that lets a figure leave the product, and the only one D44's
  // release authority still guards.
  'publish.batch': true,
  // ⚠ **TIER 1 since 6 Sep 2026 (item 66, matrix gate ⚖5) — the LITERAL
  // reading, taken deliberately.** The owner was offered a field split
  // (accounting-meaning fields tier 1, labels tier 2) and declined it: *"any
  // filed update like the category… and this typo things must need approval"*
  // means every field, so a supplier-spelling fix waits for the super admin
  // exactly as a category change does. Item 22 is the case law — a team member
  // typed £9,000 of tax onto a £994 invoice and it reached the export because
  // nobody with authority ever looked.
  //
  // The queue-volume objection was put and answered by the FAST PATH, not by
  // narrowing the rule: the person the queue waits for is also the person doing
  // most of the correcting, and their own corrections never queue (⚖6). The
  // field split is kept in the matrix as the option NOT taken — it is the
  // change to make on the day the queue does drown, and its reasoning should
  // not have to be rebuilt.
  //
  // ⚠ The web consequence is real and is item 24's other half: a member who
  // cannot release must STAGE AND STOP rather than run
  // `updateCodingProposal`'s third call into a 403 and read "that correction
  // was NOT saved" about an act that was, in fact, queued.
  // ⚠ **TIER 2 since 9 Sep 2026 — the owner's third and final correction.**
  //
  // > *"No approval will be required for anything, except for when the document
  // > is going for publishing. I have corrected this twice already. Now I'm
  // > saying it for the third time."*
  //
  // Asked to choose between taking that literally and keeping the record while
  // dropping the wait, he chose the literal reading. This is the same tier flip
  // `chase.send` took on 8 Sep and it is made for the same reason: the person
  // correcting a category is the person doing the bookkeeping, and making every
  // category tap wait for the firm's principal made the principal the
  // bottleneck on the second most frequent act in the product.
  //
  // ⚠ **What this flip does NOT change.** The proposal is still minted, Read
  // review is still recorded server-side with its hash, the hash is still
  // echoed at Approve, the executor still runs exactly once and the audit row
  // is still written. Governance §10's spine is untouched — what moved is
  // WHOSE signature the record carries, which is all this table legislates.
  // The £9,000-of-tax argument above is answered by the review the server
  // still renders and records, not by whose name is on it.
  'document.update-coding': false,
  'document.route': false,
  'document.archive': false,
  'document.move-business': false,
  'document.reprocess': false,
  'document.reject': false,
  'document.split': false,
  'bank.confirm-match': false,
  // ⚠ **TIER 1 since 6 Sep 2026 (item 66) — this RATIFIES the flag the entry
  // was carrying.** It read `false` on the ground that removal destroys DERIVED
  // rows only: the source document stays in the vault and re-import re-proves
  // D41. Both halves are still true and neither is an undo. The derived rows
  // ARE the period's reconciliation — every match, every explained line, every
  // chase raised off a gap — and re-importing is a fresh run of the D41
  // completeness gate, not a restore. The executor's refusals (confirmed
  // matches, open chases, unprovable provenance) stay exactly as they are and
  // bind the super admin too; they are a different guarantee, not a substitute
  // for a signature.
  'bank.remove-statement': true,
  // ⚠ **TIER 1 since 6 Sep 2026 (item 66), and the widest blast radius in the
  // product.** Governance §10.5 lets a standing policy execute WITHOUT a
  // per-item proposal, on the sole ground that the policy itself was approved
  // through this contract. If any member can approve the policy, that argument
  // has nothing left in it: one approval buys unattended coding of every
  // future document the rule matches. The review card already renders the rule
  // in full — tier, scope, conditions and every field it sets — precisely
  // because a reviewer has to see what will start coding their client's books.
  // This says whose reading that has to be.
  'rule.create': true,
  'document.revoke-link': false,
  // ⚠ **TIER 1 since 6 Sep 2026 (item 66) — overturning the argument written
  // here.** It read `false` because offboarding is soft and entirely internal:
  // it flips `businesses.is_active`, sends nothing, and lets no figure leave
  // the product. Two things answer that. First, this entry's own closing line
  // asked to be revisited — *"there is no `business.reactivate` kind yet, so
  // the undo is a later surface"* — and that day has not come, so the flag is
  // one nobody in the product can flip back. Second, ending a client
  // relationship is not the same size of act as archiving a receipt: the
  // client's staff lose portal access the moment it executes, and item 67 is
  // about to give it a deletion SCOPE and a subscription consequence (D48).
  // A card whose blast radius has to be stated at Read review is a card
  // somebody senior signs.
  //
  // ⚠ **That day HAS now come (7 Sep 2026, item 67) and the tier does not
  // move.** `business.reactivate` exists below, so the first argument is
  // spent — but it was only ever half. The second stands and got heavier: the
  // scope is real now, `documentScope: 'trash'` moves every one of the
  // client's documents in one approval, and the card states that blast radius
  // precisely so somebody senior reads it before signing. A kind does not
  // become tier 2 because its undo arrived.
  'business.offboard': true,
  // **TIER 1, and for the plainest reason in this table: the undo of a tier-1
  // act belongs to the same signature.** If a standard user could restore a
  // client the super admin had removed, the removal would not really have been
  // the super admin's decision — it would have been a suggestion with a delay
  // on it. Symmetry here is not tidiness; it is what makes the removal mean
  // something.
  //
  // The counter-argument, recorded because it is a fair one: restoring is the
  // SAFE direction. Nothing is destroyed, nothing leaves the product, and the
  // worst outcome of a wrong restore is a client back on a list who can be
  // removed again. That is true, and it is why this is worth writing down
  // rather than asserting. It loses to the symmetry point: ending and resuming
  // a client relationship are the same decision read in two directions, and
  // D48 hangs a live subscription off the answer.
  'business.reactivate': true,
  // ⚠ **TIER 1 since 6 Sep 2026 (item 66) — this is the reversal to read
  // carefully, because the argument for `false` was a good one.**
  //
  // It said: irreversibility is only HALF of what this table is about, and the
  // other half — reaching outside the product — a purge does not do. It
  // destroys one of the practice's own rows, inside their own workspace, after
  // a human already put it in Trash. That was sound while the table selected
  // for outward acts. Part 2 changed the question to "whose signature does
  // this carry", and a purge is the only unrecoverable thing in the product:
  // the row, its extractions, its processing log and its duplicate pairs all
  // go, and nothing brings them back.
  //
  // ⚠ **The executor's refusals are UNCHANGED and are still the real D43
  // guarantee.** A document that has been published, or that carries a
  // capability link, or that a statement names, cannot be purged by ANYBODY —
  // the super admin included. That was the old entry's strongest point and it
  // survives intact: it protects the export link, which is a different
  // question from who signs for destroying a client's record. The two are
  // belt and braces now rather than one standing in for the other.
  'document.purge': true,
  // **TIER 2, ratified by item 66** (`docs/Access_and_Approval_Matrix.md`
  // Part 2) — this kind landed on a parallel branch the day the matrix was
  // decided, and it was classified with the rest rather than carried past
  // them. It reads the same under either question: a verdict a LATER verdict
  // supersedes, and `delete-copy` is the reversible Trash seam (restoration
  // undoes it exactly), so nothing here is a signature anybody is stuck with.
  // ⚠ It is not tier 1 by the purge argument: what `delete-copy` does is
  // exactly what the Trash button does, and that is tier 3 — asking for the
  // super admin's signature here and not there would be the same act priced
  // two ways.
  'document.resolve-duplicate': false,
  // ⚠ **TIER 1, by `rule.create`'s argument and one more.** Governance §10.5
  // lets a standing policy act without a per-item proposal on the sole ground
  // that the policy itself was approved through this contract; if any member
  // could arm one, that ground is gone. This kind is the wider of the two,
  // because a workflow does not merely code documents — it decides whether
  // anything stops for a signature at all.
  //
  // ⚠ And the DISARM direction is the reason it is one kind rather than a
  // tier-1 arm and a tier-2 release. Turning a workflow off removes a control
  // a client may be relying on, silently, with nothing on any screen changing
  // except that items stop pausing. "Off" is not the safe direction here, and
  // a table that priced it as one would be the way around the gate.
  'policy.activate': true,
};

/** Does approving this kind need the super admin — i.e. is it tier 1? */
export function requiresReleaseAuthority(kind: ProposalKind): boolean {
  return RELEASE_KINDS[kind];
}

/**
 * Which {@link PermittedAction} names the approval of this kind.
 *
 * D44's two keep `publish.release` — Governance §11.2's own literal, and the
 * only two acts its sentences describe truthfully. Everything else tier 1 got
 * with item 66 is `proposal.approve`, whose sentences name the act the person
 * actually pressed. Tier-2 kinds never reach here: the caller asks
 * {@link requiresReleaseAuthority} first.
 */
function approvalAction(kind: ProposalKind): 'publish.release' | 'proposal.approve' {
  return kind === 'publish.batch' ? 'publish.release' : 'proposal.approve';
}

/**
 * The one call site's convenience — the approve path asks this and nothing
 * else. It exists because {@link assertCan} is overloaded per action name, so a
 * caller holding a UNION of two names matches neither overload; picking the
 * name here keeps that choice in the file that owns the reasoning rather than
 * in the engine.
 */
export function assertCanApprove(actor: Actor, resource: ProposalResource): void {
  const action = approvalAction(resource.kind);
  if (action === 'publish.release') assertCan(actor, action, resource);
  else assertCan(actor, action, resource);
}

/**
 * What a refused approver READS, per tier-1 kind that is not D44's two.
 *
 * Written to be read by the person who pressed the button. Each names the act
 * in their words, says who holds it, and — unlike the two release sentences —
 * states that the thing they did is not lost: under item 66's literal ruling a
 * standard user's ordinary coding correction now lands here, and telling them
 * only "you may not" about a proposal that IS staged and IS in the queue would
 * be a true sentence that leaves them believing something false.
 *
 * ⚠ Total over the five, by construction: the fallback is unreachable for a
 * tier-1 kind today, and a kind promoted to tier 1 without a sentence gets a
 * generic one rather than a crash. The sentence is the product; add it.
 */
const TIER_1_REFUSAL: Partial<Record<ProposalKind, string>> = {
  'document.update-coding':
    "Only your practice's super admin can approve a change to a document's figures or coding. This correction is queued for them — nothing on the document has changed yet.",
  'bank.remove-statement':
    "Only your practice's super admin can approve removing a bank statement. The removal is queued for them; every transaction is still there.",
  'document.purge':
    "Only your practice's super admin can approve deleting documents permanently. The deletion is queued for them; the documents are still in Trash.",
  'business.offboard':
    "Only your practice's super admin can approve removing a client. The removal is queued for them; the client is unchanged.",
  'business.reactivate':
    "Only your practice's super admin can approve bringing a removed client back. The restore is queued for them; the client stays on the removed list until they approve it.",
  'rule.create':
    "Only your practice's super admin can approve a new coding rule. The rule is queued for them and codes nothing until they approve it.",
  'policy.activate':
    "Only your practice's super admin can approve turning an approval workflow on or off. The change is queued for them; the workflow is exactly as it was.",
};

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
 * `team.manage` — changing a colleague's role or client list, ending their
 * access, revoking an outstanding invitation, sending a fresh link (review
 * item 57, 6 Sep 2026).
 *
 * ⚠ **It shares {@link mayManageTeam} with `team.invite`: ONE predicate, two
 * action names.** The authority is genuinely the same — every one of these acts
 * is reversible, internal, and reaches nobody outside the firm — so a second
 * predicate would be a second thing free to disagree, which is what this file's
 * header refuses. What differs is only the SENTENCE a refused caller reads, and
 * that is worth a name: *"Only a practice admin can invite a colleague"* said
 * to somebody who pressed Remove is a wrong answer in a right status code. The
 * same reasoning separated `business.billing.manage` from
 * `business.profile.manage` (`docs/Access_and_Approval_Matrix.md`, gate ⚖2).
 *
 * The refusals that bound what this permits are NOT here — they are the
 * service's, because they are about the SUBJECT rather than the actor: the
 * owner can never be removed or changed (D44 — release authority must always
 * exist), nobody may remove themselves, and `PRACTICE_ADMIN` cannot be granted
 * by an edit any more than by an invitation (ruled at gate ⚖3, 6 Sep 2026).
 * An authority check answers "may this person act"; those answer "may this
 * happen to that person", and folding them together would put a rule about the
 * owner inside a function that has never been told who the subject is.
 */
export function assertCanManageTeam(actor: Actor): void {
  assertCan(actor, 'team.manage');
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
 * Who may reach the client's own SUBSCRIPTION — start it, change the card, read
 * an invoice, **cancel it** (review item 44, 6 Sep 2026).
 *
 * > *"The team member of a client don't need to see the plan subscribed"*
 *
 * ## What this closes, stated plainly because it was a live hole
 *
 * `POST /v1/billing/portal-sessions` and `POST /v1/billing/checkout-sessions`
 * accept a portal bearer (D48 makes the CLIENT the payer, so they must). Their
 * shared `principalFor` checked that the session's business equalled the body's
 * `businessId` — a tenancy check, and a correct one — **and nothing else**. So
 * any contact of the business holding a portal bearer, including a
 * `BUSINESS_STANDARD` added to photograph receipts, could mint a Stripe
 * customer-portal session and reach the card, every invoice and cancellation.
 * The UI simply rendered the button for everyone, which is how it was found.
 *
 * ## `BUSINESS_ADMIN` only — the same predicate as {@link mayManageProfile},
 * and a SEPARATE ACTION on purpose
 *
 * Reusing `business.profile.manage` was the alternative and costs zero lines
 * (the two rules select the same person today). It was refused at the matrix
 * gate — `docs/Access_and_Approval_Matrix.md` ⚖2, Shakib, 6 Sep 2026 — because
 * the refusal MESSAGE is the whole user-facing product of a permission check,
 * and *"Only an owner at your business can change its own details"* said to
 * somebody who pressed a billing button is a wrong answer wearing a right
 * status code. Naming the act also keeps the two free to diverge without one
 * quietly widening the other, which is the failure this file's header exists to
 * prevent.
 *
 * ⚠ **A `USER_ADMIN` is refused, and that is the interesting cell.** They hold
 * people management and *"nothing else"* — that role's whole definition — and
 * an office manager who can add a new starter is not thereby somebody who may
 * cancel the company's subscription. The two are different kinds of authority
 * and the enum already keeps them apart.
 *
 * `role === null` refuses, as everywhere here: a chase session's `contact_id`
 * is deliberately NULL, so the holder of a forwardable link is nobody, and
 * nobody may reach a card.
 */
export function mayManageBilling(actor: Actor): boolean {
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
 * `proposal.approve` takes the resource for `publish.release`'s reason exactly:
 * the decision is authorised against ONE proposal, and the KIND is what selects
 * the sentence. Prefer {@link assertCanApprove} at a call site — it picks
 * between the two names so the engine does not have to know there are two.
 */
export function assertCan(actor: Actor, action: 'proposal.approve', resource: ProposalResource): void;
/**
 * `team.invite` takes NO resource, and the missing argument is the shape of the
 * decision rather than an omission. A release is authorised against one
 * proposal; inviting is authorised against the practice the session already
 * fixes, and there is no record for a caller to name — which is also why the
 * refusal below can be written once instead of per subject.
 */
export function assertCan(actor: Actor, action: 'team.invite'): void;
/**
 * `team.manage` takes no resource for `team.invite`'s reason one step on: the
 * practice is fixed by the session, and the SUBJECT — which colleague, which
 * invitation — is not an input to the authority question. Whether it may happen
 * to *that* person is the service's rule; see {@link assertCanManageTeam}.
 */
export function assertCan(actor: Actor, action: 'team.manage'): void;
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
/**
 * `business.billing.manage` — no resource, the same argument one more time: the
 * portal session's own row fixes the business, and the billing controller has
 * already refused a body naming a different one before this is reached.
 */
export function assertCan(actor: Actor, action: 'business.billing.manage'): void;
export function assertCan(actor: Actor, action: PermittedAction, resource?: ProposalResource): void {
  if (action === 'business.billing.manage') {
    if (mayManageBilling(actor)) return;
    throw new AppException(
      'NT-PRM-001',
      HttpStatus.FORBIDDEN,
      'Not permitted',
      // The person reading this is a member of staff who pressed a button they
      // should not have been shown. It names what is out of reach (the
      // subscription, not "billing", which they may not connect to anything on
      // screen) and the one action open to them, and it does not imply they
      // did anything wrong.
      'Only an owner at your business can manage the subscription. Ask them.',
    );
  }

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

  if (action === 'team.invite' || action === 'team.manage') {
    if (mayManageTeam(actor)) return;
    throw new AppException(
      'NT-PRM-001',
      HttpStatus.FORBIDDEN,
      'Not permitted',
      action === 'team.invite'
        ? 'Only a practice admin can invite a colleague. Ask one of your admins to send the invitation.'
        : // Deliberately vague about WHICH act, because one sentence serves
          // four (edit, remove, revoke, re-send) and naming the wrong one is
          // worse than naming none. It says what is out of reach and who has it.
          "Only a practice admin can change your firm's team. Ask one of your admins.",
    );
  }

  // `proposal.approve` and `publish.release` share ONE predicate — item 66's
  // tier 1 is `mayRelease` and nothing else — and differ only in the sentence.
  if (mayRelease(actor)) return;

  if (action === 'proposal.approve') {
    throw new AppException(
      'NT-PRM-001',
      HttpStatus.FORBIDDEN,
      'Not permitted',
      (resource === undefined ? undefined : TIER_1_REFUSAL[resource.kind]) ??
        "Only your practice's super admin can approve this. It is queued for them; nothing has changed yet.",
    );
  }

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
