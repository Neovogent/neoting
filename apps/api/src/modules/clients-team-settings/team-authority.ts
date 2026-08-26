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
