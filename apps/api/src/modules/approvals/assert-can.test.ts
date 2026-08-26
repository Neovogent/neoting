import { ProposalKind, WorkspaceRole } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import type { ScopedClient } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { canRelease } from '../clients-team-settings/index.js';
import {
  type Actor,
  assertCan,
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
