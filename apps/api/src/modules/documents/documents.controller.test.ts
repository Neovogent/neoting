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
  const seen: { ctx: ScopeContext; documentId: string }[] = [];

  const context = { require: async () => COOKIE_CTX } as RequestContext;

  const service = {
    getDocumentOriginal: async (ctx: ScopeContext, documentId: string) => {
      seen.push({ ctx, documentId });
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

test('⚠ a bearer runs under the DELEGATED scope, whose granted ids are the boundary', async () => {
  const { controller, seen } = harness();
  await controller.original('doc_mine', 'Bearer portal.token');

  // Not the practice SYSTEM context the portal's other reads use. This one is
  // `delegated_upload`, so `documents_delegated_upload`'s
  // `id = ANY(app_granted_item_ids())` decides — a database guarantee, and the
  // reason this handler adds no ownership check of its own.
  expect(seen[0]?.ctx).toEqual({
    actorId: 'usr_system_1',
    businessId: 'biz_burger',
    sessionScope: 'delegated_upload',
    grantedItemIds: ['doc_mine'],
  });
  // No `practiceId`: the delegated policies read the business and the grant and
  // nothing else, and a practice in scope would only widen what a later
  // `user`-scope mistake could see.
  expect(seen[0]?.ctx.practiceId).toBeUndefined();
});

test('a session with an EMPTY grant reaches nothing, and the refusal is indistinguishable from "no such document"', async () => {
  // An onboarding session that has never uploaded. `ScopeContextSchema` refuses
  // to build a delegated context for it — an empty grant reads as "no
  // restriction" to a human and denies everything in SQL — so the handler
  // answers before the database is touched.
  //
  // The answer must be word-for-word the service's own 404: a caller must not
  // be able to tell "your session may reach no documents at all" from "that
  // document is not yours".
  const { controller, seen } = harness({ portal: async () => facts({ grantedItemIds: [] }) });
  const error = await grab(() => controller.original('doc_mine', 'Bearer portal.token'));

  expect(error.getStatus()).toBe(404);
  expect(error.code).toBe('NT-VAL-001');
  expect(error.message).toBe('Document not found');
  expect(seen).toEqual([]);
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
