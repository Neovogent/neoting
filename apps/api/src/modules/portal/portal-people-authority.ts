import type { PortalPerson } from '@neoting/contracts/model';
import type { WorkspaceRole } from '@neoting/contracts/model';

import type { Actor } from '../approvals/index.js';

/**
 * **Who is acting in a portal session, and what a business's people may do.**
 * Pure — no Prisma, no request, no session. Everything here is a function of
 * `contacts` rows, so a test drives it directly and the service below it has no
 * judgement of its own to get wrong.
 *
 * ## The blocker this file exists to answer: a portal session identified a
 * BUSINESS, not a PERSON
 *
 * `PortalSessionClaims` carries `{otpSessionId, businessId, practiceId,
 * expiresAtMs}` and `systemScopeFor` acts as the practice's SYSTEM user — so for
 * every read the portal makes, the acting identity is *the workspace*. That is
 * fine for "show me my documents" and useless for "may you remove Tom", which is
 * a question about a person.
 *
 * **The row already knew.** `otp_sessions.contact_id` is written by both
 * sign-in routes — `resolveByAddress` sets it to the contact whose address
 * proved control, `resolveInvite` to the contact the invitation names — and was
 * simply never read back out. So the acting person is resolved the way every
 * other portal fact is: from the ROW, re-read on every request, under the
 * practice SYSTEM context.
 *
 * ⚠ **The role is deliberately NOT put on the token.** The bearer is signed,
 * short-lived and re-read against the row for exactly this reason
 * (`portal-session-context.ts` applies five row checks that outrank it), and a
 * role in the claims would be a sixth fact that the row could contradict — for
 * up to an hour, in the direction that matters: an owner demoted at 10:00 would
 * still be holding an owner's bearer at 10:59. Authority is read where it is
 * stored, every time.
 *
 * ⚠ **`contactId` null fails closed.** A chase session sets it to NULL on
 * purpose (the link is forwardable and guessing who holds it would be worse than
 * an absence), and an onboarding session can have it null if the invite named an
 * address no `contacts` row carries. Neither can be resolved to a person, so
 * neither manages anybody — and `resolveOnboarding` has already refused the
 * chase session before this is reached.
 *
 * ## Two things both get called "role", and they are not the same thing
 *
 * - **`contacts.role`** is FREE TEXT and is the job title. *"A restaurant has a
 *   Head Chef and a site has a Foreman, and forcing those into 'Staff' loses the
 *   only thing that made the role worth recording."* Nothing in this file or the
 *   service reads it to decide anything; it is a label the business chose.
 * - **`contacts.portal_role`** is `WorkspaceRole` and is the AUTHORITY. The
 *   prototype's last-owner rule keys on the word "Owner"; here it keys on
 *   `BUSINESS_ADMIN`, because a protection that can be defeated by retyping a
 *   label is not a protection.
 */

/**
 * The three roles a business may hold on its own portal.
 *
 * `PRACTICE_ADMIN`, `PRACTICE_STANDARD` and `CLIENT_ADMIN` are the FIRM's roles
 * (`clients-team-settings/team-authority.ts` partitions the enum) and cannot be
 * granted here — a client's own person is never practice staff.
 */
export const PORTAL_ACCESS_ROLES = ['BUSINESS_ADMIN', 'USER_ADMIN', 'BUSINESS_STANDARD'] as const;

export type PortalAccessRole = (typeof PORTAL_ACCESS_ROLES)[number];

export function isPortalAccessRole(role: WorkspaceRole): role is PortalAccessRole {
  return (PORTAL_ACCESS_ROLES as readonly WorkspaceRole[]).includes(role);
}

/** The `contacts` fields this module reads. A row, narrowed to what decides things. */
export interface PortalPersonRow {
  readonly id: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  /** The FREE-TEXT job title. Decides nothing — see the header. */
  readonly role: string | null;
  readonly portalRole: WorkspaceRole | null;
  readonly isPrimary: boolean;
  readonly canSendDocuments: boolean;
  readonly canSeeTotals: boolean;
  readonly deactivatedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * The authority a contact actually holds, including for every row written before
 * the column existed.
 *
 * **`portal_role` is nullable and there is no backfill**, so this derivation is
 * what makes the feature work on day one for businesses that already exist. The
 * rule is one line and it is the honest one: intake writes exactly one
 * `is_primary` contact per business — the person the accountant registered, the
 * one `BusinessSummary.primaryContactEmail` reports and the one chases go to —
 * and that person is the owner. Everybody else a client already had was added by
 * `POST /businesses/{id}/members`, which writes `is_primary: false` because *"a
 * team member is a permitted SENDER, not automatically the person the chase goes
 * to"* — a plain member, which is exactly right.
 *
 * The alternative was `@default(BUSINESS_STANDARD)` plus an `UPDATE` over a live
 * table holding real client records. That is a migration that writes data, and
 * it would leave every workspace with nobody who could manage anyone for the
 * window between the two statements.
 *
 * ⚠ Once a row is written explicitly the derivation stops applying to it —
 * `portalRole` wins whenever it is set, including when it disagrees with
 * `isPrimary`. That is deliberate: promoting somebody must not be undone by who
 * happens to receive the chases.
 */
export function effectivePortalRole(row: Pick<PortalPersonRow, 'portalRole' | 'isPrimary'>): WorkspaceRole {
  if (row.portalRole !== null) return row.portalRole;
  return row.isPrimary ? 'BUSINESS_ADMIN' : 'BUSINESS_STANDARD';
}

/**
 * The acting person, in the shape `assertCan` takes.
 *
 * ⚠ **`actorId` is a `contacts` id, not a `users` id**, and that is the one
 * place this reuse is not exact. `Actor` is documented as "the acting person,
 * resolved from their membership", and a portal person usually HAS no membership
 * — most have no `users` row at all (SoT §3.3's phone-only contacts are real).
 * It is safe because `assertCan` reads only `role`, and it is honest because a
 * contact id is a genuine, stable identifier for the person who is acting. A
 * `null` contact yields `role: null`, which every branch of `assertCan` refuses.
 *
 * `isOwner` mirrors `BUSINESS_ADMIN` so the field means the same thing it means
 * everywhere else — *the one person who owns this thing* — one level down from
 * the practice.
 */
export function portalActorFor(row: PortalPersonRow | null): Actor {
  if (row === null) return { actorId: '', role: null, isOwner: false };
  const role = effectivePortalRole(row);
  return { actorId: row.id, role, isOwner: role === 'BUSINESS_ADMIN' };
}

/**
 * Is this the workspace's only owner?
 *
 * The prototype states the rule and the sentence that has to be shown when it
 * bites: *"This is your only Owner — make someone else an Owner first."* It
 * exists because a business with no `BUSINESS_ADMIN` and no `USER_ADMIN` can
 * never add or remove anybody again, and there is no route back from inside the
 * portal — it would be a support call, which is the failure this whole feature
 * was ruled in to remove.
 *
 * **Only ACTIVE people count.** A deactivated owner is not somebody who can
 * promote a replacement, so counting them would let the last real owner be
 * demoted behind a revoked one.
 */
export function isLastOwner(people: readonly PortalPersonRow[], personId: string): boolean {
  const owners = people.filter(
    (p) => p.deactivatedAt === null && effectivePortalRole(p) === 'BUSINESS_ADMIN',
  );
  return owners.length === 1 && owners[0]!.id === personId;
}

/**
 * Whether an address is already somebody on this workspace.
 *
 * **One email is one person**, because the address IS the sign-in channel: two
 * people sharing one would be sent each other's six-digit codes and would
 * collide on every send. It is also the sender-map key (D45), so a second row
 * carrying the same address would put one identity on two `contacts` rows and
 * make "who sent this" ambiguous for the ingest router.
 *
 * Case-insensitive, and **deactivated rows still count**: reviving somebody is
 * a different act from inviting a second person under their address, and letting
 * the second one through would leave two rows the sender map would then have to
 * choose between.
 *
 * ⚠ **A row with NO email holds no address, and an empty `email` matches
 * nothing.** Without the guard, `(p.email ?? '')` made every phone-only contact
 * — SoT §3.3 says those are real — collide with `''`, so a blank address would
 * have reported "already on this workspace" and named a person who has no
 * address at all. Nothing reachable passes `''` today (the contract's zod
 * requires a valid address before this is called), which is exactly why it is
 * worth closing here rather than relying on the caller: this function is the
 * rule, and a rule that is only correct because of who happens to call it is one
 * the next caller breaks.
 */
export function addressTaken(people: readonly PortalPersonRow[], email: string, exceptId?: string): boolean {
  const wanted = email.trim().toLowerCase();
  if (wanted === '') return false;
  return people.some((p) => p.id !== exceptId && (p.email ?? '').trim().toLowerCase() === wanted);
}

/**
 * A `contacts` row → the contract's `PortalPerson`.
 *
 * ⚠ **`name` is composed here and is NOT `contacts.role`.** The two were easy to
 * confuse while writing this and the projection is where the confusion would
 * have shipped.
 *
 * `isYou` is passed in rather than derived, because the session is what knows it
 * and this function deliberately knows nothing about sessions.
 */
export function toPortalPerson(row: PortalPersonRow, actingContactId: string | null): PortalPerson {
  const name = [row.firstName, row.lastName].filter((part) => part !== null && part !== '').join(' ');
  return {
    id: row.id,
    name: name === '' ? null : name,
    email: row.email,
    jobTitle: row.role,
    access: effectivePortalRole(row),
    canSendDocuments: row.canSendDocuments,
    canSeeTotals: row.canSeeTotals,
    isYou: actingContactId !== null && row.id === actingContactId,
    isActive: row.deactivatedAt === null,
    addedAt: row.createdAt.toISOString(),
  };
}

/**
 * `"Tom Whyte"` → `{firstName: 'Tom', lastName: 'Whyte'}`.
 *
 * The screen asks for ONE name field, because a client adding their kitchen
 * staff should not be made to fill in two — and `contacts` has two columns,
 * which every other producer in the product already writes. Splitting on the
 * LAST space keeps multi-part forenames intact (`Mary Anne Clarke` →
 * `Mary Anne` + `Clarke`), which is the commoner shape here than a multi-part
 * surname. A single word is a forename with no surname rather than a surname
 * with no forename, because that is what the screens render first.
 */
export function splitName(name: string): { firstName: string; lastName: string | null } {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  const cut = trimmed.lastIndexOf(' ');
  if (cut <= 0) return { firstName: trimmed, lastName: null };
  return { firstName: trimmed.slice(0, cut), lastName: trimmed.slice(cut + 1) };
}
