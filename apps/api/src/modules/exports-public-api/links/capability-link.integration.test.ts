import { HttpStatus } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { AppException } from '../../../common/problem/problem.js';
import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { ActionProposalsService } from '../../approvals/action-proposals.service.js';
import { InMemoryDocumentStore } from '../../ingestion-routing/storage/document-store.js';
import { buildExecutorRegistry, type PublishGateway } from '../../validation-dedupe/index.js';

import { CapabilityLinkService } from './capability-link.service.js';
import { DocumentLinkService } from './document-link.service.js';
import { InMemoryCapabilityLinkRateLimiter } from './link-rate-limit.js';

/**
 * Stage A8's acceptance, against a real database as `nt_app`.
 *
 * Everything interesting about this feature is a claim about POSTGRES, not
 * about TypeScript: that `document_links` is genuinely policed, that
 * `app_resolve_document_link` is genuinely the only way past that policy, and
 * that a revoked link genuinely stops resolving. A mock would agree with
 * whatever we told it.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (a red
 * run) when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

// A disjoint id namespace, torn down by EXPLICIT id lists — never `startsWith`,
// whose LIKE leaves `_` a wildcard (the p4/p40 collision this suite must not
// repeat).
const PRACTICE_A = 'a8x_pracA';
const PRACTICE_B = 'a8x_pracB';
const BIZ_A = 'a8x_bizA';
const BIZ_B = 'a8x_bizB';
const DOC_A = 'a8x_docA';
const DOC_B = 'a8x_docB';
const USER_IDS = ['a8x_staffA', 'a8x_sysA', 'a8x_staffB', 'a8x_sysB'];
const MEMBERSHIP_IDS = ['a8x_memA', 'a8x_memSysA', 'a8x_memB', 'a8x_memSysB'];

const KEY_A = 'w/a8x_bizA/documents/aaa';
const BYTES_A = Buffer.from('%PDF-1.4\nthe invoice\n', 'ascii');

let owner: PrismaClient;
let app: PrismaClient;
let store: InMemoryDocumentStore;

const STAFF_A = ScopeContextSchema.parse({ actorId: 'a8x_staffA', practiceId: PRACTICE_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 'a8x_staffB', practiceId: PRACTICE_B });

const STUB_PUBLISHING: PublishGateway = {
  ledger: { publishBill: async () => ({ ok: true, externalRef: 'STUB', attachmentSent: false }) },
  previewPublishBatch: () => ({ ok: true, preview: { itemCount: 0, grossPence: 0, vatPence: 0 } }),
};

function minter(): DocumentLinkService {
  return new DocumentLinkService(app, { origin: 'https://neoacc.neovogent.com' });
}

function resolver(): CapabilityLinkService {
  return new CapabilityLinkService(app, store, new InMemoryCapabilityLinkRateLimiter());
}

function engine(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ publishing: STUB_PUBLISHING }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    STUB_PUBLISHING,
    new InMemoryIdempotencyStore(),
  );
}

async function refusal(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
    throw new Error('expected a refusal, got a resolution');
  } catch (error) {
    if (!(error instanceof AppException)) throw error;
    return error;
  }
}

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.actionProposal.deleteMany({
    where: { OR: [{ practiceId: { in: [PRACTICE_A, PRACTICE_B] } }, { businessId: { in: [BIZ_A, BIZ_B] } }] },
  });
  await owner.documentLink.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.documentEvent.deleteMany({ where: { documentId: { in: [DOC_A, DOC_B] } } });
  await owner.document.deleteMany({ where: { id: { in: [DOC_A, DOC_B] } } });
  await owner.membership.deleteMany({ where: { id: { in: MEMBERSHIP_IDS } } });
  await owner.user.deleteMany({ where: { id: { in: USER_IDS } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ_A, BIZ_B] } } });
  await owner.practice.deleteMany({ where: { id: { in: [PRACTICE_A, PRACTICE_B] } } });
}

function documentRow(id: string, practiceId: string, businessId: string, s3Key: string) {
  return {
    id,
    practiceId,
    businessId,
    s3Key,
    originalFilename: 'invoice.pdf',
    mimeType: 'application/pdf',
    byteSize: BYTES_A.length,
    byteHash: 'a'.repeat(64),
    channel: 'WEB_UPLOAD' as const,
    inbox: 'COSTS' as const,
    state: 'PUBLISHED' as const,
    supplierName: 'Bidfood Ltd',
    totalPence: 123_456,
    categoryCode: 'COST_OF_SALES_FOOD',
  };
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();

  await owner.practice.create({ data: { id: PRACTICE_A, name: 'A8 Practice A', documentLinkTtlDays: 30 } });
  await owner.practice.create({ data: { id: PRACTICE_B, name: 'A8 Practice B' } });
  await owner.business.create({ data: { id: BIZ_A, practiceId: PRACTICE_A, name: 'Sparkle Cleaning Ltd' } });
  await owner.business.create({ data: { id: BIZ_B, practiceId: PRACTICE_B, name: 'Other Client Ltd' } });

  await owner.user.create({ data: { id: 'a8x_staffA', email: 'a8x-a@example.test' } });
  await owner.user.create({ data: { id: 'a8x_staffB', email: 'a8x-b@example.test' } });
  await owner.user.create({ data: { id: 'a8x_sysA', kind: 'SYSTEM' } });
  await owner.user.create({ data: { id: 'a8x_sysB', kind: 'SYSTEM' } });
  await owner.membership.create({ data: { id: 'a8x_memA', userId: 'a8x_staffA', practiceId: PRACTICE_A, role: 'PRACTICE_ADMIN' } });
  await owner.membership.create({ data: { id: 'a8x_memB', userId: 'a8x_staffB', practiceId: PRACTICE_B, role: 'PRACTICE_ADMIN' } });
  await owner.membership.create({ data: { id: 'a8x_memSysA', userId: 'a8x_sysA', practiceId: PRACTICE_A, role: 'PRACTICE_STANDARD' } });
  await owner.membership.create({ data: { id: 'a8x_memSysB', userId: 'a8x_sysB', practiceId: PRACTICE_B, role: 'PRACTICE_STANDARD' } });

  await owner.document.create({ data: documentRow(DOC_A, PRACTICE_A, BIZ_A, KEY_A) });
  await owner.document.create({ data: documentRow(DOC_B, PRACTICE_B, BIZ_B, 'w/a8x_bizB/documents/bbb') });

  store = new InMemoryDocumentStore();
  store.putRaw(KEY_A, BYTES_A);
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('A8 — the source-document link, against a real database', () => {
  test('the acceptance test: mint a link for a Published document, then resolve it with no session at all', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    expect(link).not.toBeNull();
    expect(link?.url).toBe(`https://neoacc.neovogent.com/d/${link?.code}`);

    // No ScopeContext, no cookie, no bearer. The code IS the authorisation.
    const redirect = await resolver().resolve({ code: link!.code, ip: '203.0.113.9' });
    expect(redirect.url).toContain(KEY_A);
    expect(redirect.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('the practice’s own TTL is applied, not the platform default', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    const row = await owner.documentLink.findUnique({ where: { code: link!.code }, select: { expiresAt: true } });
    const days = (row!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  test('re-exporting the same document reuses the SAME code — byte-stability across exports', async () => {
    const first = await minter().linkFor(STAFF_A, DOC_A);
    const second = await minter().linkFor(STAFF_A, DOC_A);
    expect(second?.code).toBe(first?.code);
    expect(await owner.documentLink.count({ where: { documentId: DOC_A } })).toBe(1);
  });

  test('the access log is real: the counter moves and the document’s own log gains a row', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    const before = await owner.documentLink.findUnique({ where: { code: link!.code } });

    await resolver().resolve({ code: link!.code, ip: '203.0.113.9', traceId: 'a8x-trace' });

    const after = await owner.documentLink.findUnique({ where: { code: link!.code } });
    expect(after!.accessCount).toBe(before!.accessCount + 1);
    expect(after!.lastAccessedAt).not.toBeNull();

    const events = await owner.documentEvent.findMany({
      where: { documentId: DOC_A, stage: 'source-link', outcome: 'accessed' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.traceId).toBe('a8x-trace');
    // The raw address is nowhere in it.
    expect(JSON.stringify(events[0]?.detail)).not.toContain('203.0.113.9');
  });

  test('a lowercase code typed off a spreadsheet reaches the same document', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    await expect(resolver().resolve({ code: link!.code.toLowerCase() })).resolves.toBeDefined();
  });
});

describe.skipIf(!enabled)('⚠ tenancy — document_links is policed, and the resolver is the ONE way past it', () => {
  test('another practice cannot mint a link for a document it cannot see', async () => {
    const links = await minter().linksFor(STAFF_B, [DOC_A]);
    // Not a 403, not an error — the document is simply invisible, so there is
    // nothing to link. The emitter then warns `source-link-missing`.
    expect(links.size).toBe(0);
  });

  test('another practice cannot READ the link row, even knowing its id', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    const row = await owner.documentLink.findUnique({ where: { code: link!.code } });

    const seenByB = await scopedDb(app, STAFF_B, async (db) => db.documentLink.findUnique({ where: { id: row!.id } }));
    expect(seenByB).toBeNull();

    const seenByA = await scopedDb(app, STAFF_A, async (db) => db.documentLink.findUnique({ where: { id: row!.id } }));
    expect(seenByA?.id).toBe(row!.id);
  });

  test('⚠ `document_links` is INVISIBLE to a contextless query, and `app_resolve_document_link` is the whole bypass', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);

    // As `nt_app`, with NO scope context set. The table returns nothing —
    // every policy branch begins `app_actor_id() IS NOT NULL`.
    const direct = await app.$queryRaw<unknown[]>`SELECT id FROM document_links WHERE code = ${link!.code}`;
    expect(direct).toEqual([]);

    // The SECURITY DEFINER function returns exactly one row of ids and
    // booleans, and that is the ONLY thing it can be made to return.
    const viaFunction = await app.$queryRaw<
      { link_id: string; document_id: string; business_id: string; practice_id: string; revoked: boolean; expired: boolean }[]
    >`SELECT * FROM app_resolve_document_link(${link!.code})`;
    expect(viaFunction).toHaveLength(1);
    expect(viaFunction[0]).toMatchObject({ document_id: DOC_A, business_id: BIZ_A, practice_id: PRACTICE_A, revoked: false, expired: false });
    // No financial data crosses the bypass — six columns, all opaque.
    expect(Object.keys(viaFunction[0]!).sort()).toEqual([
      'business_id',
      'document_id',
      'expired',
      'link_id',
      'practice_id',
      'revoked',
    ]);
  });

  test('a code cannot be made to return another practice’s document', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    const redirect = await resolver().resolve({ code: link!.code });
    // The key is practice A's, and there is no parameter on the route that
    // could steer it anywhere else.
    expect(redirect.url).toContain(KEY_A);
    expect(redirect.url).not.toContain('a8x_bizB');
  });
});

describe.skipIf(!enabled)('⚠ the refusals, against the real function', () => {
  test('an unknown code is a 404', async () => {
    const error = await refusal(() => resolver().resolve({ code: 'ZZZZZZZZ' }));
    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
  });

  test('an EXPIRED link is a 410, and the expiry is computed by POSTGRES, not by us', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    await owner.documentLink.update({
      where: { code: link!.code },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const error = await refusal(() => resolver().resolve({ code: link!.code }));
    expect(error.getStatus()).toBe(HttpStatus.GONE);
    expect(error.code).toBe('NT-EXP-002');
    expect(error.publicDetail).toContain('expired');

    await owner.documentLink.deleteMany({ where: { code: link!.code } });
  });

  test('⚠ REVOCATION GOES THROUGH REVIEW → APPROVE, and the link stops resolving the moment it commits', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    const row = await owner.documentLink.findUnique({ where: { code: link!.code } });

    // It resolves before.
    await expect(resolver().resolve({ code: link!.code })).resolves.toBeDefined();

    const service = engine();
    const created = await service.create(
      STAFF_A,
      {
        kind: 'document.revoke-link',
        businessId: BIZ_A,
        payload: { documentLinkIds: [row!.id], reason: 'Client left the practice' },
      },
      'a8x-key-revoke',
    );
    expect(created.state).toBe('CREATED');

    // Approve is unreachable until the review has been opened — server-side.
    const early = await refusal(() => service.approve(STAFF_A, created.id, { renderedSummaryHash: 'x' }, 'a8x-key-early'));
    expect(early.code).toBe('NT-PRP-002');

    const review = await service.review(STAFF_A, created.id, 'a8x-key-review');
    const approved = await service.approve(
      STAFF_A,
      created.id,
      { renderedSummaryHash: review.renderedSummaryHash },
      'a8x-key-approve',
    );
    expect(approved.state).toBe('EXECUTED');

    // And now it is gone — 410, not 404, so an accountant holding a dead link
    // inside their ledger is told it was revoked rather than left thinking
    // they mistyped it (openapi.yaml and rls.sql §4b both say so explicitly).
    const error = await refusal(() => resolver().resolve({ code: link!.code }));
    expect(error.getStatus()).toBe(HttpStatus.GONE);
    expect(error.code).toBe('NT-EXP-002');
    expect(error.publicDetail).toContain('revoked');

    // Revocation minted no replacement.
    const live = await owner.documentLink.count({ where: { documentId: DOC_A, revokedAt: null } });
    expect(live).toBe(0);

    // The document's own log records why.
    const events = await owner.documentEvent.findMany({ where: { documentId: DOC_A, stage: 'source-link', outcome: 'revoked' } });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.detail)).toContain('Client left the practice');
  });

  test('a NEW export after a revocation mints a NEW code — the old one stays dead', async () => {
    const revoked = await owner.documentLink.findFirst({ where: { documentId: DOC_A, revokedAt: { not: null } } });
    expect(revoked).not.toBeNull();

    const fresh = await minter().linkFor(STAFF_A, DOC_A);
    expect(fresh!.code).not.toBe(revoked!.code);

    await expect(resolver().resolve({ code: fresh!.code })).resolves.toBeDefined();
    expect((await refusal(() => resolver().resolve({ code: revoked!.code }))).getStatus()).toBe(HttpStatus.GONE);
  });

  test('another practice cannot revoke a link it cannot see', async () => {
    const link = await minter().linkFor(STAFF_A, DOC_A);
    const row = await owner.documentLink.findUnique({ where: { code: link!.code } });

    const service = engine();
    const created = await service.create(
      STAFF_B,
      { kind: 'document.revoke-link', businessId: BIZ_B, payload: { documentLinkIds: [row!.id], reason: null } },
      'a8x-key-revoke-b',
    );
    const review = await service.review(STAFF_B, created.id, 'a8x-key-review-b');
    const error = await refusal(() =>
      service.approve(STAFF_B, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'a8x-key-approve-b'),
    );

    // The executor refuses: RLS returned no row, which is indistinguishable
    // from an id that does not exist — 404-never-403, applied to effects.
    expect(error.code).toBe('NT-PRP-006');

    // And practice A's link is untouched.
    const after = await owner.documentLink.findUnique({ where: { id: row!.id } });
    expect(after!.revokedAt).toBeNull();
  });
});
