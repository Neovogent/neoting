import { randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { Document, DocumentUpload } from '@neoting/contracts/model';

import type { RequestContext } from '../../../common/context/request-context.js';
import { type ScopeContext, ScopeContextSchema } from '../../../common/db/scope-context.js';
import { AppException } from '../../../common/problem/problem.js';
import { WebUploadController } from './web-upload.controller.js';
import type { WebUploadService } from './web-upload.service.js';

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });
const KEY = randomUUID();

interface Seen {
  create?: { ctx: ScopeContext; request: unknown; key?: string };
  complete?: { ctx: ScopeContext; uploadId: string; byteHash: string; key?: string };
}

function harness(): { controller: WebUploadController; seen: Seen } {
  const seen: Seen = {};
  const service = {
    async createUpload(ctx: ScopeContext, request: unknown, key?: string) {
      seen.create = { ctx, request, ...(key === undefined ? {} : { key }) };
      return { uploadId: 'tok', upload: { method: 'PUT', url: 'https://x/y', headers: {} }, expiresAt: 'now', maxBytes: 1 } as DocumentUpload;
    },
    async completeUpload(ctx: ScopeContext, uploadId: string, byteHash: string, key?: string) {
      seen.complete = { ctx, uploadId, byteHash, ...(key === undefined ? {} : { key }) };
      return { id: 'doc_1' } as Document;
    },
  } as unknown as WebUploadService;
  const context: RequestContext = { require: () => CTX };
  return { controller: new WebUploadController(context, service), seen };
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
  await controller.complete('tok_1', { byteHash: hash }, KEY);
  expect(seen.complete).toMatchObject({ uploadId: 'tok_1', byteHash: hash, key: KEY });

  const err = await grab(() => controller.complete('tok_1', { byteHash: 'A'.repeat(64) }, KEY));
  expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(err.fieldErrors?.[0]?.field).toBe('byteHash');
});
