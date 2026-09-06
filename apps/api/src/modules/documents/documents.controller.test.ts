import { expect, test } from 'vitest';

import type { RequestContext } from '../../common/context/request-context.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import type { AppException } from '../../common/problem/problem.js';
import type { PortalSessionContextResolver, PortalSessionFacts } from '../portal/index.js';
import { portalSessionRequired } from '../portal/index.js';
import { DocumentsController } from './documents.controller.js';
import type { DocumentsService } from './documents.service.js';

/**
 * Which principal is asking for a document's original, and what each of them
 * gets to run as.
 *
 * `getDocumentOriginal` is the ONE operation on this controller with two
 * security schemes (`openapi.yaml`, 2 Sep 2026). That is not a widening — the
 * operation's own description has asserted *"a delegated OTP session may only
 * call this for items in its grant"* since the spec was drafted, and
 * `documents_delegated_upload` has permitted exactly that for just as long,
 * while the missing `security:` block meant the operation inherited the global
 * `workspaceSession` default and no client could open the receipt they had just
 * sent.
 *
 * These tests pin the CHOICE between the principals and the shape of the
 * context each produces. What the database then does with that context — the
 * grant actually bounding the read — is `portal-client-surface.integration.test.ts`,
 * because only Postgres can answer it.
 */

const COOKIE_CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };

function facts(over: Partial<PortalSessionFacts> = {}): PortalSessionFacts {
  return {
    otpSessionId: 'otp_1',
    businessId: 'biz_burger',
    practiceId: 'prac_1',
    systemUserId: 'usr_system_1',
    actorId: 'usr_system_1',
    contactId: null,
    chaseId: null,
    grantedItemIds: ['doc_mine'],
    expiresAt: new Date('2026-09-02T12:00:00.000Z'),
    ...over,
  };
}

function harness(over: { portal?: () => Promise<PortalSessionFacts> } = {}) {
  // ⚠ `alsoWhere` is recorded too (review item 18). It is the whole of the
  // tenancy on the portal path now that RLS is not narrowing it, so a test that
  // watched only the context would pass with the predicate deleted.
  const seen: { ctx: ScopeContext; documentId: string; alsoWhere?: unknown }[] = [];

  const context = { require: async () => COOKIE_CTX } as RequestContext;

  const service = {
    getDocumentOriginal: async (ctx: ScopeContext, documentId: string, alsoWhere?: unknown) => {
      seen.push({ ctx, documentId, ...(alsoWhere === undefined ? {} : { alsoWhere }) });
      return { url: 'https://fixture.local/get', expiresAt: '2026-09-02T12:05:00.000Z', mimeType: 'image/jpeg', byteSize: 1 };
    },
  } as unknown as DocumentsService;

  const portal = {
    resolveForDocumentOriginal: over.portal ?? (async () => facts()),
  } as unknown as PortalSessionContextResolver;

  return { controller: new DocumentsController(context, service, portal), seen };
}

const grab = async (run: () => Promise<unknown>): Promise<AppException> => {
  try {
    await run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
};

test('no Authorization header is the accountant — the cookie path is untouched', async () => {
  const { controller, seen } = harness();
  await controller.original('doc_mine', undefined);
  expect(seen).toEqual([{ ctx: COOKIE_CTX, documentId: 'doc_mine' }]);
});

test('an empty Authorization header is not a bearer — it falls to the cookie', async () => {
  // A proxy that adds the header blank must not be routed down a path whose
  // whole boundary is a grant that does not exist.
  const { controller, seen } = harness();
  await controller.original('doc_mine', '   ');
  expect(seen[0]?.ctx).toEqual(COOKIE_CTX);
});

test('⚠ a bearer reads what the client’s own LIST shows — the SAME predicate (review item 18)', async () => {
  const { controller, seen } = harness();
  await controller.original('doc_mine', 'Bearer portal.token');

  // ⚠ It was `delegatedScopeFor(facts)` until 7 Sep 2026, so
  // `documents_delegated_upload`'s `id = ANY(app_granted_item_ids())` decided —
  // the stronger kind of boundary, and it meant a client could open almost
  // nothing: a grant holds only what THIS sign-in uploaded. Probed live against
  // American Burger, every row of the client's own list answered 404.
  //
  // Shakib's ruling was "any document in their own list", so the boundary is now
  // the practice SYSTEM context narrowed IN THE QUERY — the application
  // guarantee `GET /portal/documents` already rests on, stated as one.
  // ⚠ The practice SYSTEM context is `sessionScope: 'user'` acting AS the
  // practice's system actor — not a scope name of its own (`systemContext`).
  // What identifies it is the actor and the practice, so that is what is
  // asserted; asserting a literal 'system' would be asserting a word that does
  // not exist.
  expect(seen[0]?.ctx).toMatchObject({ actorId: 'usr_system_1', practiceId: 'prac_1', sessionScope: 'user' });
  // NOT the delegated scope any more — that is the change.
  expect(seen[0]?.ctx.sessionScope).not.toBe('delegated_upload');
  expect(seen[0]?.ctx.grantedItemIds).toEqual([]);

  // And the narrowing itself, which is the whole of the tenancy on this path:
  // `portalVisibleDocuments(facts)` — the session's own business, minus what
  // the list hides. The set a client can open and the set a client can see are
  // ONE set, by construction.
  expect(seen[0]?.alsoWhere).toEqual({
    businessId: 'biz_burger',
    state: { not: 'ARCHIVED' },
    deletedAt: null,
  });
});

test('the accountant carries NO extra predicate — RLS alone, exactly as before', async () => {
  const { controller, seen } = harness();
  await controller.original('doc_mine', undefined);
  expect(seen[0]?.alsoWhere).toBeUndefined();
});

test('a session with an empty grant is no longer refused before the database — the business is what bounds it', async () => {
  // This used to be an indistinguishable 404 raised by the handler, because
  // `ScopeContextSchema` refuses a delegated context with an empty grant. An
  // onboarding session that has never uploaded now reads its own business like
  // any other, which is the ruling. What still refuses is a document outside
  // that business, and the refusal is the QUERY's — see the integration suite.
  const { controller, seen } = harness({ portal: async () => facts({ grantedItemIds: [] }) });
  await controller.original('doc_mine', 'Bearer portal.token');

  expect(seen[0]?.ctx).toMatchObject({ actorId: 'usr_system_1', practiceId: 'prac_1' });
  expect(seen[0]?.alsoWhere).toMatchObject({ businessId: 'biz_burger' });
});

test('a bearer the portal refuses never reaches the service at all', async () => {
  const { controller, seen } = harness({
    portal: async () => {
      throw portalSessionRequired('missing or invalid portal session');
    },
  });
  const error = await grab(() => controller.original('doc_mine', 'Bearer forged'));
  expect(error.code).toBe('NT-OTP-002');
  expect(error.getStatus()).toBe(401);
  expect(seen).toEqual([]);
});

test('the other four reads did NOT gain a second principal', async () => {
  // `getDocumentOriginal` is the only operation in this module the contract puts
  // the portal bearer on. `getDocument` returns the practice's full record
  // including the accepted extraction and its coding, `listDocuments` is the
  // inbox, and the two child lists are the internal processing log — none of
  // them is a client's to read, and none takes an `authorization` argument.
  // This is what says so if one is given one without the contract moving first.
  const { controller } = harness();
  expect(controller.original.length).toBe(2);
  expect(controller.get.length).toBe(1);
  expect(controller.list.length).toBe(1);
  expect(controller.events.length).toBe(2);
  expect(controller.extractions.length).toBe(2);
});
