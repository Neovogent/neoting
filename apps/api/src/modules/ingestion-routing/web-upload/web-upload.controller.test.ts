import { randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { Document, DocumentUpload } from '@neoting/contracts/model';

import type { RequestContext } from '../../../common/context/request-context.js';
import { type ScopeContext, ScopeContextSchema } from '../../../common/db/scope-context.js';
import { AppException } from '../../../common/problem/problem.js';
import type { PortalSessionFacts } from '../../portal/index.js';
import type { PortalCompletionNotifier, PortalCompletionResolver } from './delegated-completion.js';
import { WebUploadController } from './web-upload.controller.js';
import type { DelegatedCompletion, WebUploadService } from './web-upload.service.js';

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });
const KEY = randomUUID();

/** A resolved portal session whose grant already covers one document (METH Stage 9). */
const FACTS: PortalSessionFacts = {
  otpSessionId: 'otp_1',
  businessId: 'biz_burger',
  practiceId: 'prac_1',
  systemUserId: 'usr_system_1',
  actorId: 'usr_system_1',
  chaseId: 'chase_1',
  grantedItemIds: ['doc_granted'],
  expiresAt: new Date('2026-08-19T12:00:00.000Z'),
};

interface Seen {
  create?: { ctx: ScopeContext; request: unknown; key?: string };
  complete?: { ctx: ScopeContext; uploadId: string; byteHash: string; key?: string };
  delegated?: { caller: DelegatedCompletion; uploadId: string; byteHash: string; key?: string };
  resolved: (string | undefined)[];
  notified: string[];
}

function harness(over: { resolve?: () => Promise<PortalSessionFacts> } = {}): {
  controller: WebUploadController;
  seen: Seen;
} {
  const seen: Seen = { resolved: [], notified: [] };
  const service = {
    async createUpload(ctx: ScopeContext, request: unknown, key?: string) {
      seen.create = { ctx, request, ...(key === undefined ? {} : { key }) };
      return { uploadId: 'tok', upload: { method: 'PUT', url: 'https://x/y', headers: {} }, expiresAt: 'now', maxBytes: 1 } as DocumentUpload;
    },
    async completeUpload(ctx: ScopeContext, uploadId: string, byteHash: string, key?: string) {
      seen.complete = { ctx, uploadId, byteHash, ...(key === undefined ? {} : { key }) };
      return { id: 'doc_1' } as Document;
    },
    async completeDelegatedUpload(caller: DelegatedCompletion, uploadId: string, byteHash: string, key?: string) {
      seen.delegated = { caller, uploadId, byteHash, ...(key === undefined ? {} : { key }) };
      return { id: 'doc_delegated' } as Document;
    },
  } as unknown as WebUploadService;
  const context: RequestContext = { require: () => Promise.resolve(CTX) };
  const portal: PortalCompletionResolver = {
    resolveForUpload: async (header) => {
      seen.resolved.push(header);
      return over.resolve === undefined ? FACTS : over.resolve();
    },
  };
  const notifier: PortalCompletionNotifier = {
    notifyUploadReceived: async (_facts, notice) => {
      seen.notified.push(notice.documentId);
      return true;
    },
  };
  return { controller: new WebUploadController(context, service, portal, notifier), seen };
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { businessId: 'biz_1', channel: 'WEB_UPLOAD', filename: 'a.pdf', mimeType: 'application/pdf', byteSize: 10, ...over };
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
    throw new Error('expected a rejection');
  } catch (error) {
    return error as AppException;
  }
}

test('a valid body parses through the generated schema and reaches the service with the request context', async () => {
  const { controller, seen } = harness();
  await controller.create(body({ description: 'August invoices' }), KEY);
  expect(seen.create?.ctx).toBe(CTX);
  expect(seen.create?.key).toBe(KEY);
  expect(seen.create?.request).toMatchObject({ businessId: 'biz_1', description: 'August invoices' });
});

test('an unknown field is refused — the generated schema is .strict(), so drift is a 400 not a silent ignore', async () => {
  const { controller } = harness();
  const err = await grab(() => controller.create(body({ businesId: 'typo' }), KEY));
  expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(err.code).toBe('NT-VAL-001');
  expect(err.fieldErrors?.some((e) => e.field === 'businesId')).toBe(true);
});

test('a missing Idempotency-Key is 400 — the contract makes it required on every mutation', async () => {
  const { controller } = harness();
  const err = await grab(() => controller.create(body(), undefined));
  expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(err.fieldErrors?.[0]?.field).toBe('Idempotency-Key');
});

test('a non-uuid Idempotency-Key is 400 rather than a key that can never be replayed', async () => {
  const { controller } = harness();
  const err = await grab(() => controller.create(body(), 'not-a-uuid'));
  expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
});

test('field errors name the field but never echo the value back', async () => {
  const { controller } = harness();
  const err = await grab(() => controller.create(body({ filename: 'x'.repeat(300) }), KEY));
  const rendered = JSON.stringify(err.fieldErrors);
  expect(rendered).toContain('filename');
  expect(rendered).not.toContain('xxx');
});

test('complete: byteHash must be lowercase hex sha256, and the uploadId reaches the service', async () => {
  const { controller, seen } = harness();
  const hash = 'a'.repeat(64);
  await controller.complete('tok_1', { byteHash: hash }, KEY, undefined);
  expect(seen.complete).toMatchObject({ uploadId: 'tok_1', byteHash: hash, key: KEY });
  // No Authorization header → the workspace path, and the portal resolver is
  // never asked. A portal 401 for an accountant with a cookie would be baffling.
  expect(seen.resolved).toEqual([]);

  const err = await grab(() => controller.complete('tok_1', { byteHash: 'A'.repeat(64) }, KEY, undefined));
  expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(err.fieldErrors?.[0]?.field).toBe('byteHash');
});

test('complete: an Authorization header takes the DELEGATED path — the portal bearer the contract puts on this operation', async () => {
  const { controller, seen } = harness();
  const hash = 'b'.repeat(64);

  const document = await controller.complete('tok_2', { byteHash: hash }, KEY, 'Bearer portal.token');

  expect(document.id).toBe('doc_delegated');
  expect(seen.complete).toBeUndefined(); // never the workspace path
  expect(seen.resolved).toEqual(['Bearer portal.token']);
  expect(seen.delegated?.uploadId).toBe('tok_2');
  // The document is written under the DELEGATED scope — that is what makes RLS,
  // not this handler, the thing that admits the row.
  expect(seen.delegated?.caller.context.sessionScope).toBe('delegated_upload');
  expect(seen.delegated?.caller.context.businessId).toBe('biz_burger');
  expect(seen.delegated?.caller.context.grantedItemIds).toEqual(['doc_granted']);
  // …and the events context is the practice SYSTEM one, because `document_events`
  // has no delegated policy. Two contexts, one completion.
  expect(seen.delegated?.caller.eventsContext.sessionScope).toBe('user');
  expect(seen.delegated?.caller.eventsContext.practiceId).toBe('prac_1');
  expect(seen.delegated?.caller.otpSessionId).toBe('otp_1');
  expect(seen.delegated?.caller.chaseId).toBe('chase_1');

  // The accountant's notification travels as a closure over the resolved
  // session, so the service never learns what a portal notification is — and
  // the service is what decides to call it (only on a real creation).
  await seen.delegated?.caller.notifyUploadReceived('doc_delegated');
  expect(seen.notified).toEqual(['doc_delegated']);
});

test('complete: a portal session with an EMPTY grant is refused — it has no upload of its own to complete', async () => {
  // `ScopeContextSchema` refuses a delegated context with no granted items, and a
  // session's grant is empty until `POST /portal/uploads` derives a document id.
  // The refusal must be the portal's own 401, not a Zod throw from the bottom of
  // a query.
  const { controller, seen } = harness({ resolve: async () => ({ ...FACTS, grantedItemIds: [] }) });

  const err = await grab(() => controller.complete('tok_3', { byteHash: 'c'.repeat(64) }, KEY, 'Bearer portal.token'));

  expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  expect(err.code).toBe('NT-OTP-002');
  expect(seen.delegated).toBeUndefined();
});
