import { createHash } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { AppException } from '../../../common/problem/problem.js';
import { InMemoryDocumentStore } from '../../ingestion-routing/storage/document-store.js';
import { DocumentLinkService } from '../links/document-link.service.js';

import { ExportsService } from './exports.service.js';

/**
 * Stage A9's acceptance, against a real database as `nt_app`.
 *
 * What is worth proving here is not the TypeScript — the unit suite covers the
 * mapping, the refusals and the cap against fakes that agree with whatever they
 * are told. It is the three claims that are about POSTGRES:
 *
 * 1. an export written by one practice is invisible to another (`exports_tenant`),
 * 2. `POST /exports` for a business RLS cannot reach is a **404, never a 403**,
 * 3. **the export changes the state of nothing** — the documents it read are
 *    still `PUBLISHED` and still un-archived afterwards. A5 removed auto-archive
 *    precisely because ARCHIVED is past the only state this query can see, and a
 *    regression there would make the SECOND export of a month silently empty.
 *
 * Plus the one end-to-end fact the release is judged on (D43): the file that
 * comes out carries a capability code that a document actually has, and
 * re-exporting the same month produces the same code — or the accountant's
 * saved VT conversion table stops matching and every import goes manual again.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (a red
 * run) when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

// A disjoint id namespace, torn down by EXPLICIT id lists — never `startsWith`,
// whose LIKE leaves `_` a wildcard and has eaten another suite's fixtures.
const PRACTICE_A = 'a9x_pracA';
const PRACTICE_B = 'a9x_pracB';
const BIZ_A = 'a9x_bizA';
const BIZ_B = 'a9x_bizB';
const DOC_IN = 'a9x_docIn';
const DOC_OUT = 'a9x_docOut';
const DOC_READY = 'a9x_docReady';
const DOC_IDS = [DOC_IN, DOC_OUT, DOC_READY];
const BIZ_IDS = [BIZ_A, BIZ_B];
const USER_IDS = ['a9x_staffA', 'a9x_staffB'];
const MEMBERSHIP_IDS = ['a9x_memA', 'a9x_memB'];

const BYTES = Buffer.from('%PDF-1.4\nthe supplier invoice\n', 'ascii');
const BYTE_HASH = createHash('sha256').update(BYTES).digest('hex');
const KEY_IN = 'w/a9x_bizA/documents/in';

let owner: PrismaClient;
let app: PrismaClient;
let store: InMemoryDocumentStore;

const STAFF_A = ScopeContextSchema.parse({ actorId: 'a9x_staffA', practiceId: PRACTICE_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 'a9x_staffB', practiceId: PRACTICE_B });

const JANUARY = { periodStart: '2026-01-01', periodEnd: '2026-01-31' } as const;

function service(): ExportsService {
  return new ExportsService(
    app,
    store,
    new DocumentLinkService(app, { origin: 'https://neoacc.neovogent.com' }),
    new InMemoryIdempotencyStore(),
  );
}

function request(over: Record<string, unknown> = {}) {
  return { businessId: BIZ_A, target: 'VT_TRANSACTION_PLUS', ...JANUARY, ...over } as never;
}

/** A fresh UUID per call — the contract makes `Idempotency-Key` one per logical operation. */
function key(): string {
  return crypto.randomUUID();
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
  await owner.export.deleteMany({ where: { businessId: { in: BIZ_IDS } } });
  await owner.documentLink.deleteMany({ where: { businessId: { in: BIZ_IDS } } });
  await owner.documentEvent.deleteMany({ where: { documentId: { in: DOC_IDS } } });
  await owner.document.deleteMany({ where: { id: { in: DOC_IDS } } });
  await owner.membership.deleteMany({ where: { id: { in: MEMBERSHIP_IDS } } });
  await owner.user.deleteMany({ where: { id: { in: USER_IDS } } });
  await owner.business.deleteMany({ where: { id: { in: BIZ_IDS } } });
  await owner.practice.deleteMany({ where: { id: { in: [PRACTICE_A, PRACTICE_B] } } });
}

function documentRow(
  id: string,
  over: {
    businessId?: string;
    practiceId?: string;
    state?: 'PUBLISHED' | 'READY';
    documentDate?: Date;
    s3Key?: string;
  } = {},
) {
  return {
    id,
    practiceId: over.practiceId ?? PRACTICE_A,
    businessId: over.businessId ?? BIZ_A,
    s3Key: over.s3Key ?? KEY_IN,
    originalFilename: 'invoice.pdf',
    mimeType: 'application/pdf',
    byteSize: BYTES.length,
    byteHash: BYTE_HASH,
    channel: 'WEB_UPLOAD' as const,
    inbox: 'COSTS' as const,
    state: over.state ?? ('PUBLISHED' as const),
    docType: 'INVOICE' as const,
    supplierName: 'Épicerie Dubois, S.à r.l.',
    documentDate: over.documentDate ?? new Date('2026-01-14T00:00:00.000Z'),
    totalPence: 12_000,
    taxPence: 2_000,
    reference: 'INV-4471',
    categoryCode: 'Cost of sales: Purchases',
  };
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();

  await owner.practice.create({ data: { id: PRACTICE_A, name: 'A9 Practice A' } });
  await owner.practice.create({ data: { id: PRACTICE_B, name: 'A9 Practice B' } });
  await owner.business.create({ data: { id: BIZ_A, practiceId: PRACTICE_A, name: 'Sparkle Cleaning Ltd' } });
  await owner.business.create({ data: { id: BIZ_B, practiceId: PRACTICE_B, name: 'Other Client Ltd' } });

  await owner.user.create({ data: { id: 'a9x_staffA', email: 'a9x-a@example.test' } });
  await owner.user.create({ data: { id: 'a9x_staffB', email: 'a9x-b@example.test' } });
  await owner.membership.create({
    data: { id: 'a9x_memA', userId: 'a9x_staffA', practiceId: PRACTICE_A, role: 'PRACTICE_ADMIN' },
  });
  await owner.membership.create({
    data: { id: 'a9x_memB', userId: 'a9x_staffB', practiceId: PRACTICE_B, role: 'PRACTICE_ADMIN' },
  });

  await owner.document.create({ data: documentRow(DOC_IN) });
  // February — outside January, so it must not appear in January's file.
  await owner.document.create({
    data: documentRow(DOC_OUT, { documentDate: new Date('2026-02-03T00:00:00.000Z'), s3Key: 'w/a9x_bizA/documents/out' }),
  });
  // Approved but not released. Only PUBLISHED is exported — that is where the
  // human authorisation lives (D44).
  await owner.document.create({
    data: documentRow(DOC_READY, { state: 'READY', s3Key: 'w/a9x_bizA/documents/ready' }),
  });

  store = new InMemoryDocumentStore();
  store.putRaw(KEY_IN, BYTES);
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('A9 — Export for VT, against a real database', () => {
  test('the acceptance path: one Published document becomes a VT file carrying its own capability code', async () => {
    const result = await service().createExport(STAFF_A, request(), key());

    expect(result.state).toBe('succeeded');
    expect(result.rowCount).toBe(1);
    expect(result.documentCount).toBe(1);
    expect(result.file).not.toBeNull();
    expect(result.bundle).not.toBeNull();

    const link = await owner.documentLink.findFirst({ where: { documentId: DOC_IN } });
    expect(link).not.toBeNull();

    const csv = store.get(new URL(result.file!.url).pathname.replace(/^\//, ''));
    const text = (await csv).toString('utf8').replace(/^﻿/, '');
    expect(text).toContain(link!.code);
    expect(text).toContain(`https://neoacc.neovogent.com/d/${link!.code}`);
    expect(text).toContain('14/01/2026');
    // Only January's document travelled.
    expect(text).not.toContain('03/02/2026');
  });

  test('re-exporting the same month reuses the SAME code, so a saved VT conversion table keeps matching', async () => {
    await service().createExport(STAFF_A, request(), key());
    const first = await owner.documentLink.findMany({ where: { documentId: DOC_IN } });

    await service().createExport(STAFF_A, request(), key());
    const second = await owner.documentLink.findMany({ where: { documentId: DOC_IN } });

    expect(second).toHaveLength(1);
    expect(second[0]?.code).toBe(first[0]?.code);
  });

  test('⚠ the export changes the state of NOTHING — the document is still Published and un-archived', async () => {
    await service().createExport(STAFF_A, request(), key());

    const after = await owner.document.findUnique({
      where: { id: DOC_IN },
      select: { state: true, archivedAt: true },
    });
    expect(after?.state).toBe('PUBLISHED');
    expect(after?.archivedAt).toBeNull();

    // And it can therefore be exported again, which is the whole point.
    await expect(service().createExport(STAFF_A, request(), key())).resolves.toMatchObject({ rowCount: 1 });
  });

  test('a READY document is not exported — only the super admin’s release makes one exportable', async () => {
    const error = await refusal(() =>
      service().createExport(STAFF_A, request({ documentIds: [DOC_READY] }), key()),
    );
    expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error.fieldErrors?.[0]?.field).toBe(`documentIds/${DOC_READY}`);
  });

  test('the record lands in `exports` with its period, its target and its row count', async () => {
    const result = await service().createExport(STAFF_A, request(), key());

    const row = await owner.export.findUnique({ where: { id: result.id } });
    expect(row).toMatchObject({
      businessId: BIZ_A,
      target: 'VT_TRANSACTION_PLUS',
      state: 'succeeded',
      rowCount: 1,
      createdByUserId: 'a9x_staffA',
    });
    expect(row?.periodStart?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row?.s3Key).not.toBeNull();
    expect(row?.completedAt).not.toBeNull();
  });
});

describe.skipIf(!enabled)('⚠ tenancy — the export surface is policed by RLS and nothing else', () => {
  test('another practice cannot export this client, and learns nothing: 404, never 403', async () => {
    const error = await refusal(() => service().createExport(STAFF_B, request(), key()));

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.code).toBe('NT-VAL-001');
    // Not 403 — a 403 would confirm the client business exists.
    expect(error.getStatus()).not.toBe(HttpStatus.FORBIDDEN);
  });

  test('another practice sees none of these exports in its own history', async () => {
    await service().createExport(STAFF_A, request(), key());

    const mine = await service().listExports(STAFF_A, { limit: 50 } as never);
    const theirs = await service().listExports(STAFF_B, { limit: 50 } as never);

    expect(mine.data.some((row) => row.businessId === BIZ_A)).toBe(true);
    expect(theirs.data.some((row) => row.businessId === BIZ_A)).toBe(false);
  });

  test('filtering history by a business RLS cannot reach is an empty page, not an error', async () => {
    const page = await service().listExports(STAFF_B, { limit: 50, businessId: BIZ_A } as never);
    expect(page.data).toEqual([]);
  });
});
