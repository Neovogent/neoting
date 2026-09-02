import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invitePracticeMember, listPracticeMembers } from '@neoting/contracts/client';
import { invitePracticeMemberBody, listPracticeMembersResponse } from '@neoting/contracts/zod';
import type { Invite, PracticeMember, WorkspaceRole } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';
import { type SliceStatus, sliceStatus } from './slices';

/**
 * The practice's own team, over `GET`/`POST /v1/practice-members`.
 *
 * **Before this module the Team screen was a drawing.** "Invite colleague"
 * opened a local record editor whose `onSave` wrote into React state and
 * evaporated on reload; the chat surface's invite card printed *"Invitation sent
 * to {email}"* over a handler that did nothing. There was no operation in the
 * contract to call, so there was nothing to be wired to — an admin could not add
 * a second person to their own firm.
 *
 * ## It computes its own `sliceStatus` and does NOT widen `SliceName`
 *
 * `api/slices.ts` names the DEMO ROUTE's context arrays; the practice team is
 * not one of them, and adding a member would drag this module onto the shared
 * bundle floor for every route in the app — the reachability rule
 * (`apps/web/CLAUDE.md`, *Bundle*). `DataSourceBadge`'s `slice` prop is already
 * a plain `string`, so the view passes its own label. This is the `ExportView`
 * precedent, followed deliberately.
 *
 * ## The plain generated function, not the generated hook
 *
 * Same reason `api/proposals.ts` gives: the marginal cost of a generated module
 * is per-EXPORT once its barrel is floor-reachable, so touching
 * `listPracticeMembers` costs one function and touching
 * `useListPracticeMembers` would additionally pull the hook and query-key
 * machinery. Read that comment before "cleaning this up".
 */

export type { Invite, PracticeMember };

/** The two roles `POST /practice-members` accepts. The server refuses the rest, by name. */
export const INVITABLE_ROLES: readonly WorkspaceRole[] = ['PRACTICE_STANDARD', 'CLIENT_ADMIN'];

/**
 * Who may open the invite form.
 *
 * ⚠ **This is presentation, never the gate.** Governance §11.2: *"a UI that
 * merely hides the button is not an implementation of this."* The server decides
 * with `assertCan(actor, 'team.invite')` and answers `403 NT-PRM-001`, and the
 * screen must handle that refusal honestly when it arrives anyway — a role read
 * from a `/me` that is thirty seconds stale is exactly how it arrives.
 *
 * It mirrors `mayManageTeam` server-side: the release ROLE, without the
 * ownership narrowing. A practice admin who is not the owner may invite and may
 * not release, and the two questions must not be answered by one flag here.
 */
export function mayInviteColleague(role: WorkspaceRole | undefined): boolean {
  return role === 'PRACTICE_ADMIN';
}

export const PRACTICE_TEAM_QUERY_KEY = ['practice-members'] as const;

export interface PracticeTeam {
  members: PracticeMember[];
  /** Invitations sent and not yet accepted. Unpaginated by contract. */
  pendingInvites: Invite[];
}

const EMPTY: PracticeTeam = { members: [], pendingInvites: [] };

/**
 * The colleagues list plus every outstanding invitation, parsed through the
 * generated Zod before anything touches it — a contract drift surfaces here with
 * the field named, not as `undefined is not an object` in a table cell.
 */
export function usePracticeTeam({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: PRACTICE_TEAM_QUERY_KEY,
    queryFn: () => listPracticeMembers({ limit: 100 }),
    enabled,
  });

  const parsed = useMemo(() => {
    if (!query.data) return { team: EMPTY, invalid: null as string | null };
    const result = listPracticeMembersResponse.safeParse(unwrapBody(query.data));
    if (!result.success) {
      return {
        team: EMPTY,
        invalid: result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
          .join('; '),
      };
    }
    return {
      team: {
        members: result.data.data as PracticeMember[],
        pendingInvites: result.data.pendingInvites as Invite[],
      },
      invalid: null,
    };
  }, [query.data]);

  const status: SliceStatus = sliceStatus(enabled, {
    isLoading: query.isLoading,
    error: query.error,
    contractError: parsed.invalid,
  });

  return {
    team: parsed.team,
    status,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface InviteColleagueRequest {
  email: string;
  role: WorkspaceRole;
  /** Empty means practice-wide — every client — and is what a CLIENT_ADMIN always gets. */
  businessIds?: string[];
}

/**
 * Send the invitation.
 *
 * The body is parsed by the contract's own schema before it travels, so a value
 * this screen should not have offered is refused here rather than becoming a
 * server-side `400` the user reads as a bug.
 *
 * ## ⚠ `firstName` / `lastName` are NOT sent, and the contract still declares them
 *
 * They were collected by the form and put on the wire, and
 * `practice-team.service.ts` reads neither: **`invites` has no column for a
 * name.** Acceptance then asks the invitee for their own first and last name as
 * REQUIRED fields (`views/invite/InviteView.tsx`), so even a persisted value
 * would be overwritten by the person it describes — the admin's guess at a
 * colleague's spelling is not a fact worth carrying.
 *
 * That is the same anti-pattern this change set condemned for
 * `hideFinancialFields`: a field accepted at a boundary and silently discarded.
 * The half that can be fixed from here is not asking for it. Removing the two
 * properties from `PracticeMemberInviteRequest` is a contract change (G7) and is
 * still owed; until then the server keeps accepting a key nothing in this app
 * sends.
 */
export async function inviteColleague(request: InviteColleagueRequest): Promise<Invite> {
  const body = invitePracticeMemberBody.parse({
    // Normalised here as well as on the server, for the same reason
    // `api/signup.ts` gives: `users.email` is unique on the literal bytes.
    email: request.email.trim().toLowerCase(),
    role: request.role,
    // `CLIENT_ADMIN` is practice-wide by definition and the server REFUSES a
    // client list for it rather than ignoring one, so the key is dropped rather
    // than sent empty.
    ...(request.businessIds === undefined || request.businessIds.length === 0
      ? {}
      : { businessIds: request.businessIds }),
  });

  // The parsed body's optional members are typed `T | undefined` while the
  // generated request type is `exactOptionalPropertyTypes`-strict about them.
  // The values are correct — the keys were OMITTED above, never set to
  // undefined — so the cast is about the two type shapes, not about the data.
  const created = await invitePracticeMember(body as Parameters<typeof invitePracticeMember>[0]);
  const value = unwrapBody(created);
  // orval emits no response schema for this `201` (the same gap
  // `submitClientIntake` documents), so the contract's required core is pinned
  // by hand rather than an unverified body being reported as a sent invitation.
  if (!isInvite(value)) {
    throw new Error('The server accepted the invitation but answered with a shape this app does not recognise.');
  }
  return value;
}

function isInvite(value: unknown): value is Invite {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string' && typeof row['role'] === 'string' && typeof row['expiresAt'] === 'string';
}

/** "Sam Patel", "Sam", or the address — never an empty cell where a person should be. */
export function memberLabel(member: Pick<PracticeMember, 'firstName' | 'lastName' | 'email'>): string {
  const name = [member.firstName, member.lastName]
    .filter((part): part is string => part !== null && part !== undefined && part.trim() !== '')
    .join(' ')
    .trim();
  if (name !== '') return name;
  return member.email ?? '';
}
