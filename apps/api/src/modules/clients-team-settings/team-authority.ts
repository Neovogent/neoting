import { WorkspaceRole } from '@neoting/contracts/model';

/**
 * D44, as two predicates: **compose is everyone, release is the super admin.**
 *
 * > *Accountants and their team members may compose and edit — chase message
 * > text, document coding, every extracted field. Only the accounting firm's
 * > super admin may release: authorise a chase SMS to send, and move an item
 * > from Ready to Published.* (SoT v1.6, D44)
 *
 * The role enum comes from `@neoting/contracts/model`, which
 * `check-contract.mjs` checks **verbatim** against `prisma/schema.prisma`. A
 * local copy of the six role strings would be a third opinion, free to drift
 * from both.
 *
 * ## Where this is and is not enforced
 *
 * Nothing in this file gates anything by itself, deliberately. It is the shared
 * definition; the enforcement point for release is the **approve** path in
 * `modules/approvals` (stage A12), because that is the one door every
 * irreversible outward act goes through. A role check scattered across the
 * surfaces that *offer* those acts would be a permission model with no single
 * place to read, and the UI is presentation either way — a hidden button is not
 * a rule (Governance §11.2).
 *
 * A12 imports `canRelease` from this module's public seam rather than
 * re-deriving "who is the super admin", so the answer exists once.
 */

/**
 * The firm's super admin (SoT §3.3: *Practice Admin — everything*; D44's
 * "practice principal").
 *
 * ⚠ A practice may have more than one `PRACTICE_ADMIN`, so this is "a super
 * admin", not "the named principal". `memberships.is_owner` narrows it to the
 * one person who created the practice if a stricter reading is wanted — that is
 * A12's call to make on the enforcement path, and the flag is surfaced on
 * `BusinessMember.isOwner` so a screen can show it either way.
 */
export const RELEASE_ROLE = WorkspaceRole.PRACTICE_ADMIN;

/**
 * May this role **release**? Authorise a chase to send, or move Ready →
 * Published (D42: released for export — never "posted to a ledger").
 */
export function canRelease(role: WorkspaceRole): boolean {
  return role === RELEASE_ROLE;
}

/**
 * May this role **compose and edit**? Yes — every member of the practice or the
 * client workspace can draft, correct and edit. That is the whole of D44's
 * first half, and it is stated as a function rather than assumed so that the
 * split reads as two authorities in code, not as one rule plus a silence.
 *
 * It takes the role for symmetry with {@link canRelease} and so that a future
 * read-only role has an obvious place to be refused.
 */
export function canCompose(_role: WorkspaceRole): boolean {
  return true;
}

/**
 * The three roles `POST /businesses/{businessId}/members` accepts.
 *
 * The contract's words: *"Only the three business-level roles are accepted
 * here: `BUSINESS_ADMIN`, `USER_ADMIN`, `BUSINESS_STANDARD` … a practice-level
 * role sent here is refused with `NT-VAL-001`."* The request schema takes the
 * whole enum because there is exactly one copy of it in the contract, so the
 * narrowing has to happen here.
 */
export const BUSINESS_LEVEL_ROLES: readonly WorkspaceRole[] = [
  WorkspaceRole.BUSINESS_ADMIN,
  WorkspaceRole.USER_ADMIN,
  WorkspaceRole.BUSINESS_STANDARD,
];

/** Is this a role a client workspace may hold? Practice-level roles are not granted through the client's own team list. */
export function isBusinessLevelRole(role: WorkspaceRole): boolean {
  return BUSINESS_LEVEL_ROLES.includes(role);
}

/**
 * The two roles `POST /v1/practice-members` accepts — and the notable absence
 * is the whole point of the constant.
 *
 * **`PRACTICE_ADMIN` is a practice-level role and is NOT here.** The refusal is
 * named rather than implied, because a reader counting the six `WorkspaceRole`
 * members will otherwise assume an omission:
 *
 * - `assertCan`'s release rule is `canRelease(role) && isOwner`, and exactly one
 *   membership per practice can carry `isOwner` — signup writes it and no
 *   operation in the contract moves it. An invited `PRACTICE_ADMIN` would
 *   therefore hold `canRelease === true` and `isOwner === false`: they could not
 *   release, and the refusal they met would tell them *"only your practice's
 *   super admin can"* — to somebody the team screen had just labelled an admin.
 *   Two true statements that cannot both be believed is the worst thing a
 *   permission model can say.
 * - There is no ownership-TRANSFER operation, so nothing could resolve that
 *   state afterwards. `approvals/CLAUDE.md` carries it as the thing to build
 *   alongside an admin invite path — **when it exists, this constant is what
 *   changes.**
 *
 * `CLIENT_ADMIN` is here despite reading like a client role, and is refused by
 * {@link isBusinessLevelRole} for the same reason from the other side: SoT §3.3
 * makes it practice staff who administer clients, not a client's own person.
 * The two predicates partition the enum minus `PRACTICE_ADMIN`, which neither
 * invite path may grant.
 */
export const INVITABLE_PRACTICE_ROLES: readonly WorkspaceRole[] = [
  WorkspaceRole.PRACTICE_STANDARD,
  WorkspaceRole.CLIENT_ADMIN,
];

/**
 * May this role be granted through the PRACTICE's own team list?
 *
 * Named `isPracticeLevelRole` to sit beside {@link isBusinessLevelRole}, and it
 * is deliberately narrower than its name reads on its own: `PRACTICE_ADMIN` IS
 * a practice-level role and this returns false for it. See
 * {@link INVITABLE_PRACTICE_ROLES} — the alternative was a name so long it would
 * be abbreviated at the call site anyway, and the call site is one service.
 */
export function isPracticeLevelRole(role: WorkspaceRole): boolean {
  return INVITABLE_PRACTICE_ROLES.includes(role);
}
