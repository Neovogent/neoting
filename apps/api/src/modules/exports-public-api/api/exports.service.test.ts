import { createHash } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../../common/problem/problem.js';
import type { DocumentStore } from '../../ingestion-routing/index.js';
import type { CanonicalSourceLink } from '../canonical/canonical-row.js';
import type { DocumentLinkService } from '../links/document-link.service.js';

import { ExportsService, MAX_EXPORT_DOCUMENTS } from './exports.service.js';

const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const NOW = new Date('2026-02-01T09:30:00.000Z');
const KEY = '11111111-2222-4333-8444-555555555555';

interface FakeDocument {
  id: string;
  businessId: string | null;
  inbox: 'COSTS' | 'SALES' | 'UNROUTED';
  docType: 'INVOICE' | 'CREDIT_NOTE' | 'RECEIPT' | null;
  supplierName: string | null;
  customerName: string | null;
  documentDate: Date | null;
  totalPence: number | null;
  taxPence: number | null;
  reference: string | null;
  categoryCode: string | null;
  s3Key: string;
  mimeType: string;
  byteHash: string;
}

const ORIGINAL_BYTES = Buffer.from('%PDF-1.4 a supplier invoice', 'utf8');
const ORIGINAL_HASH = createHash('sha256').update(ORIGINAL_BYTES).digest('hex');

function document(id: string, over: Partial<FakeDocument> = {}): FakeDocument {
  return {
    id,
    businessId: 'biz_1',
    inbox: 'COSTS',
    docType: 'INVOICE',
    supplierName: 'Épicerie Dubois, S.à r.l.',
    customerName: null,
    documentDate: new Date('2026-01-14T00:00:00.000Z'),
    totalPence: 12_000,
    taxPence: 2_000,
    reference: 'INV-4471',
    categoryCode: 'Cost of sales: Purchases',
    s3Key: `w/biz_1/documents/${id}`,
    mimeType: 'application/pdf',
    byteHash: ORIGINAL_HASH,
    ...over,
  };
}

interface Calls {
  documentFindMany: { where?: unknown; take?: number }[];
  exportCreate: { data: Record<string, unknown> }[];
  exportFindMany: { where?: unknown; orderBy?: unknown; take?: number }[];
  put: { contentType: string; workspaceId: string | null; bytes: Buffer }[];
  presignGet: { key: string; expiresInSeconds: number; contentType: string; filename: string }[];
  linksFor: string[][];
}

function harness(
  options: {
    documents?: FakeDocument[];
    exports?: Record<string, unknown>[];
    business?: { id: string } | null;
    /** Documents the link minter can see. Defaults to all of them. */
    linkable?: (id: string) => boolean;
    /** Object keys that read back as bytes. Defaults to every document's key. */
    storage?: Map<string, Buffer>;
  } = {},
) {
  const documents = options.documents ?? [document('doc_1')];
  const calls: Calls = {
    documentFindMany: [],
    exportCreate: [],
    exportFindMany: [],
    put: [],
    presignGet: [],
    linksFor: [],
  };
  const storage = options.storage ?? new Map(documents.map((d) => [d.s3Key, ORIGINAL_BYTES]));

  const tx = {
    $executeRaw: async () => 0,
    business: {
      findUnique: async () => (options.business === undefined ? { id: 'biz_1' } : options.business),
    },
    // ⚠ There is deliberately NO `update`, `updateMany` or `delete` on this
    // fake. An export READS; the moment this service writes to `documents` the
    // test crashes with "not a function" rather than passing quietly. A5
    // removed auto-archive precisely because ARCHIVED is past the only state
    // this query can see.
    document: {
      findMany: async (args: { where?: unknown; take?: number }) => {
        calls.documentFindMany.push(args);
        return documents;
      },
    },
    export: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.exportCreate.push(args);
        return {
          id: `exp_${calls.exportCreate.length}`,
          virusScanned: false,
          expiresAt: null,
          createdAt: NOW,
          ...args.data,
        };
      },
      findMany: async (args: { where?: unknown; orderBy?: unknown; take?: number }) => {
        calls.exportFindMany.push(args);
        return options.exports ?? [];
      },
    },
  };

  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;

  const store: DocumentStore = {
    put: async (input) => {
      calls.put.push({ contentType: input.contentType, workspaceId: input.workspaceId, bytes: input.bytes });
      const key = `w/${input.workspaceId ?? '_unrouted'}/documents/${input.sha256}`;
      storage.set(key, input.bytes);
      return { key, sha256: input.sha256, byteLength: input.bytes.length };
    },
    get: async (key) => {
      const bytes = storage.get(key);
      if (bytes === undefined) throw new Error(`no object stored at key ${key}`);
      return bytes;
    },
    sha256: async () => ORIGINAL_HASH,
    head: async () => null,
    presignPut: async () => ({ key: 'k', url: 'https://fixture.local/k', headers: {} }),
    presignGet: async (input) => {
      calls.presignGet.push(input);
      return { url: `https://storage.test/${input.key}?sig=x`, expiresAt: new Date(NOW.getTime() + 600_000) };
    },
  };

  const linkable = options.linkable ?? (() => true);
  const links = {
    linksFor: async (_ctx: ScopeContext, ids: readonly string[]): Promise<Map<string, CanonicalSourceLink>> => {
      calls.linksFor.push([...ids]);
      const map = new Map<string, CanonicalSourceLink>();
      for (const [index, id] of ids.entries()) {
        if (!linkable(id)) continue;
        const code = `K7QM2X${String(index).padStart(2, '0')}`;
        map.set(id, { code, url: `https://neoacc.neovogent.com/d/${code}` });
      }
      return map;
    },
  } as unknown as DocumentLinkService;

  return {
    calls,
    storage,
    service: new ExportsService(prisma, store, links, new InMemoryIdempotencyStore(), () => NOW),
  };
}

function request(over: Record<string, unknown> = {}) {
  return {
    businessId: 'biz_1',
    target: 'VT_TRANSACTION_PLUS',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    ...over,
  } as never;
}

async function refusal(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a refusal');
}

/** The CSV that was handed to storage, decoded past its BOM. */
function emittedCsv(calls: Calls): string {
  const csv = calls.put.find((call) => call.contentType === 'text/csv');
  if (csv === undefined) throw new Error('no CSV was stored');
  return csv.bytes.toString('utf8').replace(/^﻿/, '');
}

// ── the happy path ──────────────────────────────────────────────────────────

test('an export produces the import file, the bundle and one succeeded record', async () => {
  const { calls, service } = harness();

  const result = await service.createExport(CTX, request(), KEY);

  expect(result.state).toBe('succeeded');
  expect(result.rowCount).toBe(1);
  expect(result.documentCount).toBe(1);
  expect(result.file?.mimeType).toBe('text/csv');
  expect(result.bundle?.mimeType).toBe('application/zip');
  expect(calls.exportCreate).toHaveLength(1);
  expect(calls.exportCreate[0]?.data).toMatchObject({
    businessId: 'biz_1',
    target: 'VT_TRANSACTION_PLUS',
    state: 'succeeded',
    rowCount: 1,
    createdByUserId: 'usr_1',
  });
});

test('the file really is VT Universal Input Sheet, and the capability code is in Entry details', async () => {
  // The end-to-end assertion the whole stage exists for: the accountant opens
  // this file in VT and can get from a line back to the document (D43).
  const { calls, service } = harness();
  await service.createExport(CTX, request(), KEY);

  const csv = emittedCsv(calls);
  const [header, row] = csv.trim().split('\r\n');

  expect(header).toBe('Type,Ref no,Date,Primary account,Details,Total,VAT,Analysis,Analysis account,Entry details,Transaction notes');
  expect(row).toContain('PIN');
  // DD/MM/YYYY, and amounts positive — VT derives debit and credit from Type.
  expect(row).toContain('14/01/2026');
  expect(row).toContain('120.00');
  expect(row).toContain('K7QM2X00');
  expect(row).toContain('https://neoacc.neovogent.com/d/K7QM2X00');
  expect(row).toContain('Imported from Neo Accounting');
  // The comma and the accent survive the hand-rolled serialiser.
  expect(row).toContain('"Épicerie Dubois, S.à r.l."');
});

test('the download filenames name the target and the period, and nothing else', async () => {
  const { calls, service } = harness();
  await service.createExport(CTX, request(), KEY);

  const names = calls.presignGet.map((call) => call.filename);
  expect(names).toEqual([
    'vt-transaction-plus-2026-01-01-to-2026-01-31.csv',
    'source-documents-2026-01-01-to-2026-01-31.zip',
  ]);
  // Minutes, not hours — the URL is bearer authority with no session behind it.
  for (const call of calls.presignGet) expect(call.expiresInSeconds).toBeLessThanOrEqual(900);
});

test('only PUBLISHED documents inside the period are asked for, and the end day is included', async () => {
  const { calls, service } = harness();
  await service.createExport(CTX, request(), KEY);

  expect(calls.documentFindMany[0]?.where).toMatchObject({
    businessId: 'biz_1',
    state: 'PUBLISHED',
    documentDate: {
      gte: new Date('2026-01-01T00:00:00.000Z'),
      lt: new Date('2026-02-01T00:00:00.000Z'),
    },
  });
  // One over the cap, so NT-EXP-003 can be answered without an unbounded load.
  expect(calls.documentFindMany[0]?.take).toBe(MAX_EXPORT_DOCUMENTS + 1);
});

test('the export writes to `exports` and to nothing else — no document is archived', async () => {
  // The fake transaction has no document writer at all, so this passing IS the
  // assertion. Stated explicitly so a future refactor that adds one fails here.
  const { service } = harness();
  await expect(service.createExport(CTX, request(), KEY)).resolves.toBeDefined();
});

// ── what did not travel ─────────────────────────────────────────────────────

test('a document that cannot be coded is warned about, not silently dropped', async () => {
  const { calls, service } = harness({
    documents: [document('doc_1'), document('doc_2', { categoryCode: null })],
  });

  const result = await service.createExport(CTX, request(), KEY);

  expect(result.rowCount).toBe(1);
  expect(result.warnings?.map((w) => w.code)).toContain('document-missing-category');
  expect(result.warnings?.find((w) => w.code === 'document-missing-category')?.documentId).toBe('doc_2');
  // And the one that could be exported still was.
  expect(emittedCsv(calls)).toContain('K7QM2X00');
});

test('a document with no link keeps its row and raises D43’s own warning, once', async () => {
  const { service } = harness({ linkable: (id) => id !== 'doc_1' });

  const result = await service.createExport(CTX, request(), KEY);

  expect(result.rowCount).toBe(1);
  const missing = result.warnings?.filter((w) => w.code === 'source-link-missing') ?? [];
  expect(missing).toHaveLength(1);
  // It is left out of the bundle (the archive is keyed by code) but is not
  // warned about a second time for the same fact.
  expect(result.documentCount).toBe(0);
});

test('a document whose bytes cannot be read is named, and the export still ships', async () => {
  const { service } = harness({ storage: new Map() });

  const result = await service.createExport(CTX, request(), KEY);

  expect(result.rowCount).toBe(1);
  expect(result.documentCount).toBe(0);
  expect(result.warnings?.map((w) => w.code)).toContain('source-document-unreadable');
});

test('emitter warnings travel to the caller — a collapsed multi-nominal is not silent', async () => {
  const { service } = harness({ documents: [document('doc_1', { categoryCode: 'Purchases' })] });

  const result = await service.createExport(CTX, request(), KEY);

  // No ledger prefix, so VT may not match it to a nominal. §24.3.4: the
  // alternative to this array is silent flattening.
  expect(result.warnings?.map((w) => w.code)).toContain('analysis-account-unprefixed');
});

// ── the refusals ────────────────────────────────────────────────────────────

test('nothing Published in the period is NT-EXP-001, and it names the period in UK d/m/y', async () => {
  const { service } = harness({ documents: [] });

  const error = await refusal(() => service.createExport(CTX, request(), KEY));

  expect(error.code).toBe('NT-EXP-001');
  expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  expect(error.publicDetail).toContain('01/01/2026 to 31/01/2026');
});

test('documents found but none exportable is still NT-EXP-001, carrying the first reason', async () => {
  const { service } = harness({ documents: [document('doc_1', { totalPence: null })] });

  const error = await refusal(() => service.createExport(CTX, request(), KEY));

  expect(error.code).toBe('NT-EXP-001');
  expect(error.publicDetail).toContain('no total');
});

test('over the cap is NT-EXP-003 naming the cap, never a truncated file', async () => {
  const documents = Array.from({ length: MAX_EXPORT_DOCUMENTS + 1 }, (_, i) => document(`doc_${i}`));
  const { calls, service } = harness({ documents });

  const error = await refusal(() => service.createExport(CTX, request(), KEY));

  expect(error.code).toBe('NT-EXP-003');
  expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  expect(error.publicDetail).toContain(String(MAX_EXPORT_DOCUMENTS));
  // Nothing was written and nothing was signed.
  expect(calls.exportCreate).toHaveLength(0);
  expect(calls.put).toHaveLength(0);
});

test('the cap is A8’s cap, so a request cannot pass here and fail inside the link minter', async () => {
  // Three ceilings would mean three different messages for one condition.
  const { MAX_LINKS_PER_CALL } = await import('../links/document-link.service.js');
  expect(MAX_EXPORT_DOCUMENTS).toBe(MAX_LINKS_PER_CALL);
});

test('a business the caller cannot reach is 404, never 403', async () => {
  const { calls, service } = harness({ business: null });

  const error = await refusal(() => service.createExport(CTX, request({ businessId: 'biz_other' }), KEY));

  expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect(error.code).toBe('NT-VAL-001');
  // The document query never ran, so nothing about that business was probed.
  expect(calls.documentFindMany).toHaveLength(0);
});

test('a named documentId that is not exportable refuses the whole export', async () => {
  // The contract's own rule: "refused rather than silently skipped — a short
  // export file that looked complete is the failure this whole surface is
  // designed against."
  const { calls, service } = harness({ documents: [document('doc_1')] });

  const error = await refusal(() =>
    service.createExport(CTX, request({ documentIds: ['doc_1', 'doc_missing'] }), KEY),
  );

  expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(error.fieldErrors?.map((f) => f.field)).toEqual(['documentIds/doc_missing']);
  expect(calls.exportCreate).toHaveLength(0);
});

test('a period that ends before it starts is refused before anything is read', async () => {
  const { calls, service } = harness();

  const error = await refusal(() =>
    service.createExport(CTX, request({ periodStart: '2026-01-31', periodEnd: '2026-01-01' }), KEY),
  );

  expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(calls.documentFindMany).toHaveLength(0);
});

// ── idempotency ─────────────────────────────────────────────────────────────

test('the same key replays the original result and does not export twice', async () => {
  const { calls, service } = harness();

  const first = await service.createExport(CTX, request(), KEY);
  const second = await service.createExport(CTX, request(), KEY);

  expect(second).toEqual(first);
  expect(calls.exportCreate).toHaveLength(1);
});

test('the same key with a different payload is 409, not a silently different export', async () => {
  const { service } = harness();
  await service.createExport(CTX, request(), KEY);

  const error = await refusal(() => service.createExport(CTX, request({ periodEnd: '2026-02-28' }), KEY));

  expect(error.code).toBe('NT-IDM-001');
  expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
});

// ── the history ─────────────────────────────────────────────────────────────

test('listExports pages newest first and filters by business, with no live URLs', async () => {
  const { calls, service } = harness({
    exports: [
      {
        id: 'exp_2',
        businessId: 'biz_1',
        target: 'VT_TRANSACTION_PLUS',
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2026-01-31T00:00:00.000Z'),
        rowCount: 3,
        filters: { documentCount: 3, warnings: [] },
        state: 'succeeded',
        createdAt: NOW,
        completedAt: NOW,
      },
    ],
  });

  const page = await service.listExports(CTX, { limit: 50, businessId: 'biz_1' } as never);

  expect(page.data).toHaveLength(1);
  expect(page.data[0]?.file).toBeNull();
  expect(page.data[0]?.documentCount).toBe(3);
  expect(calls.exportFindMany[0]?.where).toMatchObject({ businessId: 'biz_1' });
  expect(calls.exportFindMany[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
});

test('listExports with no filter is genuinely unfiltered — RLS is the only boundary', async () => {
  const { calls, service } = harness({ exports: [] });

  await service.listExports(CTX, { limit: 50 } as never);

  expect(calls.exportFindMany[0]?.where).toEqual({});
});
