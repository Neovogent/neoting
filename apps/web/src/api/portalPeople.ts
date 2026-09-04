import {
  invitePortalPerson,
  listPortalPeople,
  removePortalPerson,
  updatePortalPerson,
} from '@neoting/contracts/client';
import { invitePortalPersonBody, listPortalPeopleResponse, updatePortalPersonBody } from '@neoting/contracts/zod';
import type { PortalPerson, WorkspaceRole } from '@neoting/contracts/model';

import { unwrapBody } from './envelope';

/**
 * **The business's own people** — Settings → People, in the client's portal
 * (D45, D49).
 *
 * Until 2 Sep 2026 that screen said *"Managed by your accountant … they cannot
 * be added from this screen."* The product owner ruled that wrong: the manager,
 * the HR lead or the owner of a client business is the person who knows who
 * handles their paperwork, and making an accounting firm the registrar of a
 * restaurant's kitchen staff put a support ticket between a new starter and
 * their first receipt.
 *
 * ## ⚠ `canManagePeople` is a FACT, never a gate
 *
 * Governance §11.2: *"a UI that merely hides the button is not an
 * implementation of this."* The server refuses all three mutations regardless of
 * what this browser believes — it resolves the acting person from the
 * `otp_sessions` row and asks `assertCan(actor, 'business.people.manage')`. This
 * flag exists so a plain member is shown a readable list with an explanation
 * rather than a section that pretends not to exist.
 *
 * ## Why this is its own module, and not part of `onboarding.ts`
 *
 * `onboarding.ts` is reachable from the portal's floor. This module is imported
 * only by the lazily-loaded People panel, so the four generated client functions
 * and their schemas land on that chunk — the `api/exports.ts` and
 * `api/proposals.ts` precedent, and it matters here because the portal route is
 * the surface this product promises will load on a bad connection in a car park.
 *
 * ⚠ For the same reason nothing here uses the GENERATED HOOKS or their
 * query-key machinery — the plain functions only, called from the panel's own
 * `useQuery`. The marginal cost of a generated barrel is per-EXPORT.
 */

const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

/**
 * One person on this workspace, in the shape the screen renders.
 *
 * ⚠ A LOCAL shape rather than the contract's `PortalPerson`, and the difference
 * is one word: the contract marks `name`, `email` and `jobTitle` OPTIONAL as
 * well as nullable, so under `exactOptionalPropertyTypes` they are
 * `string | null | undefined` — three states for a question with two answers.
 * The parse is still the contract's; this is the same normalisation every other
 * api module in this app does, and it means no component has to decide what an
 * absent-versus-null name means.
 */
export interface PortalPersonRow {
  readonly id: string;
  readonly name: string | null;
  /** How they sign in, and how a document they forward is recognised (D45). */
  readonly email: string | null;
  /** FREE TEXT. Owner/Manager/Staff are suggestions on the screen, never an enum. */
  readonly jobTitle: string | null;
  /** The AUTHORITY. The last-owner rule keys on this, not on a word somebody typed. */
  readonly access: WorkspaceRole;
  readonly canSendDocuments: boolean;
  readonly canSeeTotals: boolean;
  /** True on exactly one row — the person holding this session. */
  readonly isYou: boolean;
  /** False for somebody whose access was revoked. Removal is deactivation, never deletion. */
  readonly isActive: boolean;
  readonly addedAt: string;
}

/** One person, plus what the server would let this session do to the list. */
export interface PortalPeopleList {
  readonly people: readonly PortalPersonRow[];
  /** Whether this session may invite, change and remove. A fact for honest degradation. */
  readonly canManagePeople: boolean;
  /** True when the workspace holds more people than one response serves. Said out loud. */
  readonly truncated: boolean;
}

/**
 * The three roles a business may hold on its own portal.
 *
 * ⚠ `WorkspaceRole` also contains the FIRM's roles, which this screen must never
 * offer — a client granting themselves `PRACTICE_ADMIN` would be a client
 * promoting themselves into their accountant's practice. The server refuses them
 * with `NT-VAL-001`; this list is what keeps the screen from asking.
 */
export const PORTAL_ACCESS_ROLES = ['BUSINESS_ADMIN', 'USER_ADMIN', 'BUSINESS_STANDARD'] as const;

export type PortalAccessRole = (typeof PORTAL_ACCESS_ROLES)[number];

export function isPortalAccessRole(role: WorkspaceRole): role is PortalAccessRole {
  return (PORTAL_ACCESS_ROLES as readonly WorkspaceRole[]).includes(role);
}

/** Everyone with access to this workspace, oldest first. */
export async function fetchPortalPeople(sessionToken: string): Promise<PortalPeopleList> {
  const body = listPortalPeopleResponse.parse(unwrapBody(await listPortalPeople(bearer(sessionToken))));
  return {
    people: body.people.map(toRow),
    canManagePeople: body.canManagePeople,
    truncated: body.truncated,
  };
}

/** The contract's optional-and-nullable trio collapsed to the two states a screen has. */
function toRow(person: {
  id: string;
  name?: string | null | undefined;
  email?: string | null | undefined;
  jobTitle?: string | null | undefined;
  access: WorkspaceRole;
  canSendDocuments: boolean;
  canSeeTotals: boolean;
  isYou: boolean;
  isActive: boolean;
  addedAt: string;
}): PortalPersonRow {
  return {
    id: person.id,
    name: person.name ?? null,
    email: person.email ?? null,
    jobTitle: person.jobTitle ?? null,
    access: person.access,
    canSendDocuments: person.canSendDocuments,
    canSeeTotals: person.canSeeTotals,
    isYou: person.isYou,
    isActive: person.isActive,
    addedAt: person.addedAt,
  };
}

/** What the invite form collects. `jobTitle` is free text and decides nothing. */
export interface InvitePersonInput {
  readonly name: string;
  readonly email: string;
  readonly jobTitle: string | null;
  readonly access: PortalAccessRole;
  readonly canSendDocuments: boolean;
  readonly canSeeTotals: boolean;
}

/**
 * Add one of this business's own people.
 *
 * ⚠ The request is built as a literal and validated in place rather than by
 * passing the parse's output on — Zod types an optional field's output as
 * `x?: T | undefined`, which under `exactOptionalPropertyTypes` is not
 * assignable to the generated shape. Same boundary, same check, no cast: the
 * parse still throws on drift.
 */
export async function invitePerson(sessionToken: string, input: InvitePersonInput): Promise<PortalPersonRow> {
  const request = {
    name: input.name.trim(),
    email: input.email.trim(),
    jobTitle: input.jobTitle,
    access: input.access,
    canSendDocuments: input.canSendDocuments,
    canSeeTotals: input.canSeeTotals,
  };
  invitePortalPersonBody.parse(request);
  return toRow(unwrapBody(await invitePortalPerson(request, bearer(sessionToken))) as PortalPerson);
}

/**
 * Change what one of your people may do.
 *
 * ⚠ There is deliberately **no `email`**. The address is the sign-in channel and
 * the ingest sender-map key at once, so changing it is removing one person and
 * inviting another; doing that under the word "update" would silently transfer
 * whatever the first person had already sent. The contract's own body omits it,
 * so this is not a policy this screen could relax.
 */
export interface UpdatePersonInput {
  readonly name?: string;
  readonly jobTitle?: string | null;
  readonly access?: PortalAccessRole;
  readonly canSendDocuments?: boolean;
  readonly canSeeTotals?: boolean;
}

export async function updatePerson(
  sessionToken: string,
  personId: string,
  input: UpdatePersonInput,
): Promise<PortalPersonRow> {
  updatePortalPersonBody.parse(input);
  return toRow(unwrapBody(await updatePortalPerson(personId, input, bearer(sessionToken))) as PortalPerson);
}

/**
 * Remove someone's access.
 *
 * **A revocation, not a deletion.** The server deactivates the `contacts` row and
 * answers with the person, now inactive — so the screen renders server truth
 * instead of predicting it, which is what makes *"they stop being able to send
 * documents immediately"* something a client can see rather than be told.
 */
export async function removePerson(sessionToken: string, personId: string): Promise<PortalPersonRow> {
  return toRow(unwrapBody(await removePortalPerson(personId, bearer(sessionToken))) as PortalPerson);
}
