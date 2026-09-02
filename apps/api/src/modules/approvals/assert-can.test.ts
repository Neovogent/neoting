import { ProposalKind, WorkspaceRole } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import type { ScopedClient } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { canRelease } from '../clients-team-settings/index.js';
import {
  type Actor,
  assertCan,
  mayManagePeople,
  mayManageTeam,
  mayRelease,
  RELEASE_KINDS,
  requiresReleaseAuthority,
  resolveActor,
} from './assert-can.js';

/**
 * The release gate as a pure decision (A12, D44). Every assertion here is about
 * a REFUSAL, because a permission check that is only tested on its happy path
 * has not been tested.
 */

const RESOURCE = { kind: 'publish.batch' as const, proposalId: 'prop_1', businessId: 'biz_1' };

function actor(over: Partial<Actor> = {}): Actor {
  return { actorId: 'usr_1', role: WorkspaceRole.PRACTICE_ADMIN, isOwner: true, ...over };
}

const refusal = (fn: () => void): AppException | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppException ? e : null;
  }
};

// ---- who may release ---------------------------------------------------------

test('release authority is the release ROLE and the ownership flag — either one alone refuses', () => {
  expect(mayRelease(actor())).toBe(true);
  // A PRACTICE_ADMIN who is not the owner: the role-only reading of D44, refused.
  expect(mayRelease(actor({ isOwner: false }))).toBe(false);
  // Owner flag on a role that may not release cannot manufacture authority.
  expect(mayRelease(actor({ role: WorkspaceRole.PRACTICE_STANDARD }))).toBe(false);
  expect(mayRelease(actor({ role: null }))).toBe(false);
});

test("the role half is A11's canRelease, not a second opinion — every role agrees with the seam", () => {
  for (const role of Object.values(WorkspaceRole)) {
    expect(mayRelease(actor({ role, isOwner: true }))).toBe(canRelease(role));
  }
});

test('no role other than PRACTICE_ADMIN may release, owner flag or not', () => {
  const others = Object.values(WorkspaceRole).filter((r) => r !== WorkspaceRole.PRACTICE_ADMIN);
  expect(others).toHaveLength(5); // the assertion must be able to fail
  for (const role of others) {
    expect(mayRelease(actor({ role, isOwner: true }))).toBe(false);
    expect(mayRelease(actor({ role, isOwner: false }))).toBe(false);
  }
});

// ---- which kinds are a release ------------------------------------------------

test("the release map is total over ProposalKind, and gates exactly D44's two acts", () => {
  for (const kind of Object.values(ProposalKind)) {
    expect(typeof RELEASE_KINDS[kind]).toBe('boolean');
  }
  const gated = Object.values(ProposalKind).filter((k) => requiresReleaseAuthority(k)).sort();
  expect(gated).toEqual(['chase.send', 'publish.batch']);
});

test('document.purge is UNGATED, and the export protection is the executor refusal instead', () => {
  // ⚠ The arguable one. Purge IS irreversible — but `RELEASE_KINDS` selects for
  // acts that reach OUTSIDE the product and cannot be taken back (a message to
  // somebody else's client, a figure released for export), and a purge reaches
  // nowhere: it destroys one of the practice's own rows, inside their own
  // workspace, after a human already put it in Trash.
  //
  // What protects the D43 promise is not the approver's rank: a published
  // document, or one carrying an export link, cannot be purged by ANYBODY,
  // super admin included. A permission gate would have been a weaker guarantee
  // wearing a stronger word — it would let the one person who may release also
  // destroy the link their release created.
  expect(requiresReleaseAuthority('document.purge')).toBe(false);
});

test('every compose-and-edit kind is ungated — including reject and reprocess, which undo each other', () => {
  for (const kind of ['document.archive', 'document.update-coding', 'document.reject', 'document.reprocess', 'rule.create'] as const) {
    expect(requiresReleaseAuthority(kind)).toBe(false);
  }
});

// ---- the refusal --------------------------------------------------------------

test('a refused release is 403 NT-PRM-001, names the authority, and echoes no proposal id', () => {
  const problem = refusal(() => assertCan(actor({ isOwner: false }), 'publish.release', RESOURCE));
  expect(problem?.code).toBe('NT-PRM-001');
  expect(problem?.getStatus()).toBe(403);
  expect(problem?.title).toBe('Not permitted');
  expect(problem?.publicDetail).toContain('super admin');
  // Nothing about WHICH proposal, so the body cannot be read as confirmation of
  // one id over another. Visibility was already decided upstream by RLS.
  expect(problem?.publicDetail).not.toContain('prop_1');
  expect(problem?.publicDetail).not.toContain('biz_1');
});

test('the detail speaks the language of the act — a chase says message, a batch says export', () => {
  const chase = refusal(() => assertCan(actor({ role: null }), 'publish.release', { ...RESOURCE, kind: 'chase.send' }));
  expect(chase?.publicDetail).toContain('message to a client');
  const publish = refusal(() => assertCan(actor({ role: null }), 'publish.release', RESOURCE));
  expect(publish?.publicDetail).toContain('release documents for export');
  // Both are the same code, so a client branches on NT-PRM-001 and reads the detail.
  expect(chase?.code).toBe(publish?.code);
});

test('the super admin passes without throwing', () => {
  expect(refusal(() => assertCan(actor(), 'publish.release', RESOURCE))).toBeNull();
});

// ---- resolving the actor from their membership --------------------------------

function db(rows: { userId: string; practiceId: string | null; businessId: string | null; role: string; isOwner: boolean }[]) {
  const queries: Record<string, unknown>[] = [];
  return {
    queries,
    client: {
      membership: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          queries.push(where);
          const hit = rows.find(
            (r) =>
              r.userId === where['userId'] &&
              r.practiceId === where['practiceId'] &&
              r.businessId === (where['businessId'] as string | null),
          );
          return hit === undefined ? null : { role: hit.role, isOwner: hit.isOwner };
        },
      },
    } as unknown as ScopedClient,
  };
}

const OWNER_ROW = { userId: 'usr_1', practiceId: 'prac_1', businessId: null, role: 'PRACTICE_ADMIN', isOwner: true };

test('resolveActor reads the PRACTICE-WIDE membership, filtered by the verified actor id', async () => {
  const { client, queries } = db([OWNER_ROW]);
  const ctx = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });
  expect(await resolveActor(client, ctx)).toEqual({ actorId: 'usr_1', role: 'PRACTICE_ADMIN', isOwner: true });

  // `memberships` carries no RLS, so these two filters ARE the boundary.
  expect(queries[0]).toMatchObject({ userId: 'usr_1', practiceId: 'prac_1', businessId: null });
  // And a deactivated or non-human account never counts as the super admin.
  expect(queries[0]?.['user']).toEqual({ kind: 'HUMAN', deactivatedAt: null });
});

test("a caller with no practice in scope is never the firm's super admin — and no membership is read at all", async () => {
  const { client, queries } = db([OWNER_ROW]);
  const businessOnly = ScopeContextSchema.parse({ actorId: 'usr_1', businessId: 'biz_1' });
  const resolved = await resolveActor(client, businessOnly);
  expect(resolved).toEqual({ actorId: 'usr_1', role: null, isOwner: false });
  expect(queries).toEqual([]);
  expect(mayRelease(resolved)).toBe(false);
});

test('a membership scoped to one client workspace does not answer the question', async () => {
  // The same person, holding only a business-level row in the practice.
  const { client } = db([{ userId: 'usr_1', practiceId: 'prac_1', businessId: 'biz_1', role: 'PRACTICE_ADMIN', isOwner: true }]);
  const ctx = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });
  const resolved = await resolveActor(client, ctx);
  expect(resolved).toEqual({ actorId: 'usr_1', role: null, isOwner: false });
  expect(mayRelease(resolved)).toBe(false);
});

test("another practice's owner resolves to nothing here — the practice comes from the verified context", async () => {
  const { client } = db([{ ...OWNER_ROW, practiceId: 'prac_other' }]);
  const ctx = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });
  expect(mayRelease(await resolveActor(client, ctx))).toBe(false);
});

// ---- who may invite a colleague ---------------------------------------------

test('team management is the release ROLE WITHOUT the ownership narrowing — and that divergence is deliberate', () => {
  // The owner may, obviously.
  expect(mayManageTeam(actor())).toBe(true);
  // ⚠ THE ROW THAT MATTERS: a PRACTICE_ADMIN who is not the owner may NOT
  // release and MAY invite. Requiring ownership here would mean a firm whose
  // founder is on holiday could not add the person they hired that morning, and
  // there is no ownership-transfer operation to resolve it with.
  expect(mayRelease(actor({ isOwner: false }))).toBe(false);
  expect(mayManageTeam(actor({ isOwner: false }))).toBe(true);
});

test('mayManageTeam over all six roles: PRACTICE_ADMIN only, owner flag or not', () => {
  const roles = Object.values(WorkspaceRole);
  expect(roles).toHaveLength(6); // the assertion must be able to fail
  for (const role of roles) {
    const expected = role === WorkspaceRole.PRACTICE_ADMIN;
    expect(mayManageTeam(actor({ role, isOwner: true }))).toBe(expected);
    expect(mayManageTeam(actor({ role, isOwner: false }))).toBe(expected);
    // The role half is A11's seam, never a second opinion.
    expect(mayManageTeam(actor({ role, isOwner: false }))).toBe(canRelease(role));
  }
  // No membership at all fails closed, like everywhere else here.
  expect(mayManageTeam(actor({ role: null }))).toBe(false);
});

test('assertCan(team.invite) refuses with NT-PRM-001 and names the authority, not a record', () => {
  expect(refusal(() => assertCan(actor(), 'team.invite'))).toBeNull();

  const refused = refusal(() => assertCan(actor({ role: WorkspaceRole.PRACTICE_STANDARD }), 'team.invite'));
  expect(refused?.code).toBe('NT-PRM-001');
  expect(refused?.getStatus()).toBe(403);
  expect(refused?.publicDetail).toContain('practice admin');
  // It says what to do next, which is the whole point of a 403 over a 404 here.
  expect(refused?.publicDetail).toContain('Ask one of your admins');
});

test('the two actions do not share a verdict — a non-owner admin is refused release and allowed the invite', () => {
  const admin = actor({ isOwner: false });
  expect(refusal(() => assertCan(admin, 'publish.release', RESOURCE))?.code).toBe('NT-PRM-001');
  expect(refusal(() => assertCan(admin, 'team.invite'))).toBeNull();
});

// ---- who may manage a CLIENT BUSINESS's own people (D45, D49) ----------------

test('mayManagePeople over all six roles: the two business-level administrators, and nobody else', () => {
  const roles = Object.values(WorkspaceRole);
  expect(roles).toHaveLength(6); // the assertion must be able to fail
  const permitted = new Set<string>([WorkspaceRole.BUSINESS_ADMIN, WorkspaceRole.USER_ADMIN]);
  for (const role of roles) {
    const expected = permitted.has(role);
    // The ownership flag is not consulted at all here — `isOwner` MIRRORS
    // BUSINESS_ADMIN for a portal actor rather than adding a second condition,
    // so it must not be able to change the answer in either direction.
    expect(mayManagePeople(actor({ role, isOwner: true }))).toBe(expected);
    expect(mayManagePeople(actor({ role, isOwner: false }))).toBe(expected);
  }
});

test('a BUSINESS_STANDARD may not manage people — the refusal this feature turns on', () => {
  // The product owner's ruling gives the authority to the client's own manager,
  // HR lead or owner. Everybody else at the business reads the list and cannot
  // change it, and the SERVER is what says so.
  expect(mayManagePeople(actor({ role: WorkspaceRole.BUSINESS_STANDARD }))).toBe(false);
});

test('a practice role is never people-management authority on a client workspace', () => {
  // An accountant adding a client's user is the older, separate door
  // (`POST /businesses/{id}/members`, workspace cookie). This rule is only ever
  // consulted for a portal caller, whose actor is a contacts row.
  expect(mayManagePeople(actor({ role: WorkspaceRole.PRACTICE_ADMIN, isOwner: true }))).toBe(false);
  expect(mayManagePeople(actor({ role: WorkspaceRole.PRACTICE_STANDARD }))).toBe(false);
  expect(mayManagePeople(actor({ role: WorkspaceRole.CLIENT_ADMIN }))).toBe(false);
});

test('an unidentifiable caller fails closed', () => {
  // A portal session whose `otp_sessions.contact_id` is null — a chase link,
  // deliberately forwardable — resolves to no person at all.
  expect(mayManagePeople(actor({ role: null }))).toBe(false);
  expect(mayManagePeople({ actorId: '', role: null, isOwner: false })).toBe(false);
});

test('assertCan(business.people.manage) refuses with NT-PRM-001 and names who CAN, not who they are', () => {
  expect(refusal(() => assertCan(actor({ role: WorkspaceRole.BUSINESS_ADMIN }), 'business.people.manage'))).toBeNull();
  expect(refusal(() => assertCan(actor({ role: WorkspaceRole.USER_ADMIN }), 'business.people.manage'))).toBeNull();

  const refused = refusal(() => assertCan(actor({ role: WorkspaceRole.BUSINESS_STANDARD }), 'business.people.manage'));
  expect(refused?.code).toBe('NT-PRM-001');
  expect(refused?.getStatus()).toBe(403);
  // It says what to do next — "ask the owner" is the one action available to a
  // refused caller, and it is the whole reason this is a 403 and not a silence.
  expect(refused?.publicDetail).toContain('owner or a user administrator');
  expect(refused?.publicDetail).toContain('Ask one of them');
  // It must not name the people on screen; the list already shows that, and the
  // detail is rendered in a toast that outlives the row it would have named.
  expect(refused?.publicDetail).not.toContain('@');
});

test('the three actions are independent — a practice super admin holds two of them and not this one', () => {
  // The gates do not ladder. Being the firm's super admin says nothing about
  // whether you are staff at one of their clients, which is the whole point of
  // the principals being different.
  const superAdmin = actor();
  expect(refusal(() => assertCan(superAdmin, 'publish.release', RESOURCE))).toBeNull();
  expect(refusal(() => assertCan(superAdmin, 'team.invite'))).toBeNull();
  expect(refusal(() => assertCan(superAdmin, 'business.people.manage'))?.code).toBe('NT-PRM-001');

  // And the other way: a client's owner manages their own people and can do
  // neither of the firm's acts.
  const clientOwner = actor({ role: WorkspaceRole.BUSINESS_ADMIN, isOwner: true });
  expect(refusal(() => assertCan(clientOwner, 'business.people.manage'))).toBeNull();
  expect(refusal(() => assertCan(clientOwner, 'publish.release', RESOURCE))?.code).toBe('NT-PRM-001');
  expect(refusal(() => assertCan(clientOwner, 'team.invite'))?.code).toBe('NT-PRM-001');
});
