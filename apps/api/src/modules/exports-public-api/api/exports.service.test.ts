import { createHash } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../../common/problem/problem.js';
import type { DocumentStore } from '../../ingestion-routing/index.js';
import type { CanonicalSourceLink } from '../canonical/canonical-row.js';
import { VT_LIST_COLUMNS } from '../emitters/vt/vt-transaction-plus-emitter.js';
import type { DocumentLinkService } from '../links/document-link.service.js';

import { type ChartOfAccountsReader, ExportsService, MAX_EXPORT_DOCUMENTS } from './exports.service.js';

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
  documentAggregate: { where?: unknown }[];
  exportCreate: { data: Record<string, unknown> }[];
  exportFindMany: { where?: unknown; orderBy?: unknown; take?: number }[];
  put: { contentType: string; workspaceId: string | null; bytes: Buffer }[];
  presignGet: { key: string; expiresInSeconds: number; contentType: string; filename: string }[];
  linksFor: string[][];
  /** The `businessId` each chart-of-accounts read asked for. One per export. */
  getChartOfAccounts: string[];
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
    /**
     * This client's Published documents whose date falls OUTSIDE the requested
     * period — what the `NT-EXP-001` refusal counts so an accountant is told
     * where their documents actually are.
     *
     * A separate list rather than a filter over `documents`, because this fake's
     * `findMany` deliberately ignores `where` (see the ⚠ on `document` below):
     * making the aggregate derive the same answer from the same list would be a
     * fake reimplementing the query it is standing in for, and would pass
     * whatever the service asked. The real predicate is proven against a real
     * database in `exports.integration.test.ts`.
     */
    publishedOutsidePeriod?: FakeDocument[];
    /**
     * The client's chart of accounts, as `{ code, name }` with `name` already
     * ledger-prefixed — what `ChartOfAccountsService.getChartOfAccounts` hands
     * over. Absent means no reader at all (the pre-2 Sep 2026 shape, and what a
     * caller that constructs this service without one gets); `'unavailable'`
     * makes the read throw, which must degrade to bare codes rather than to a
     * failed export.
     */
    chart?: readonly { code: string; name: string }[] | 'unavailable';
  } = {},
) {
  const documents = options.documents ?? [document('doc_1')];
  const calls: Calls = {
    documentFindMany: [],
    documentAggregate: [],
    exportCreate: [],
    exportFindMany: [],
    put: [],
    presignGet: [],
    linksFor: [],
    getChartOfAccounts: [],
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
      aggregate: async (args: { where?: unknown }) => {
        calls.documentAggregate.push(args);
        const outside = options.publishedOutsidePeriod ?? [];
        const dates = outside
          .map((row) => row.documentDate)
          .filter((date): date is Date => date !== null)
          .sort((a, b) => a.getTime() - b.getTime());
        return {
          _count: { _all: outside.length },
          _min: { documentDate: dates[0] ?? null },
          _max: { documentDate: dates[dates.length - 1] ?? null },
        };
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

  // Structural, exactly as `ChartOfAccountsService` satisfies it — the port is
  // "give me this client's `{ code, name }` pairs" and nothing else.
  const charts: ChartOfAccountsReader | null =
    options.chart === undefined
      ? null
      : {
          getChartOfAccounts: async (_ctx: ScopeContext, businessId: string) => {
            calls.getChartOfAccounts.push(businessId);
            if (options.chart === 'unavailable') throw new Error('reference_syncs is unreachable');
            return { categories: options.chart ?? [] };
          },
        };

  return {
    calls,
    storage,
    service: new ExportsService(prisma, store, links, new InMemoryIdempotencyStore(), () => NOW, charts),
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
/**
 * The export artefact is a ZIP now (A10): VT applies one journal date to a whole
 * file, so one export becomes one CSV per document date. Both stored artefacts
 * are therefore `application/zip` — the export archive and A8's source-document
 * bundle — so they are told apart by order, not by content type.
 */
function exportArchive(calls: Calls): Map<string, Buffer> {
  const stored = calls.put[0];
  if (stored === undefined) throw new Error('nothing was stored');

  const archive = stored.bytes;
  const eocd = archive.length - 22;
  const entryCount = archive.readUInt16LE(eocd + 10);
  const files = new Map<string, Buffer>();

  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const size = archive.readUInt32LE(cursor + 24);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('ascii');
    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    files.set(name, archive.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** The one CSV in the export archive, as text. */
function emittedCsv(calls: Calls): string {
  for (const [name, bytes] of exportArchive(calls)) {
    if (name.endsWith('.csv')) return bytes.toString('utf8').replace(/^﻿/, '');
  }
  throw new Error('no CSV in the export archive');
}
// ── the happy path ──────────────────────────────────────────────────────────

test('an export produces the import file, the bundle and one succeeded record', async () => {
  const { calls, service } = harness();

  const result = await service.createExport(CTX, request(), KEY);

  expect(result.state).toBe('succeeded');
  expect(result.rowCount).toBe(1);
  expect(result.documentCount).toBe(1);
  expect(result.file?.mimeType).toBe('application/zip');
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

test('the file really is a VT journal import, and the capability code rides Column B', async () => {
  // The end-to-end assertion the whole stage exists for: the accountant opens
  // this file in VT and can get from a line back to the document (D43).
  const { calls, service } = harness();
  await service.createExport(CTX, request(), KEY);

  const rows = emittedCsv(calls).trim().split('\r\n');
  const row = rows[0] ?? '';

  // NO HEADER: VT's journal import is positional and reads row 1 as data, so the
  // first line is a transaction (A10). Seven columns, not eleven, and no type
  // code — the accountant picks purchases-versus-sales as the data format.
  expect(rows).toHaveLength(1);
  expect(row).not.toContain('Primary account');
  expect(row).not.toContain('PIN');

  // No date column either. The date is in the FILENAME, because VT applies one
  // date to a whole journal.
  expect(row).not.toContain('14/01/2026');
  expect([...exportArchive(calls).keys()]).toContain('2026-01-14-purchase-invoices.csv');

  expect(row).toContain('120.00');
  expect(row).toContain('K7QM2X00');
  expect(row).toContain('https://neoacc.neovogent.com/d/K7QM2X00');
  expect(row).toContain('Imported from Neo Accounting');
  // The comma and the accent survive the hand-rolled serialiser — and A10
  // confirmed they survive VT's own parser too.
  expect(row).toContain('"Épicerie Dubois, S.à r.l."');
});

test('the download filenames name the target and the period, and nothing else', async () => {
  const { calls, service } = harness();
  await service.createExport(CTX, request(), KEY);

  const names = calls.presignGet.map((call) => call.filename);
  expect(names).toEqual([
    'vt-transaction-plus-2026-01-01-to-2026-01-31.zip',
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

// ---------------------------------------------------------------------------
// Column G — the nominal, and the defect this service shipped with
// ---------------------------------------------------------------------------

/**
 * The client's chart, in the shape `ChartOfAccountsService.getChartOfAccounts`
 * returns: `{ code, name }` with `name` ALREADY ledger-prefixed.
 * `analysisAccount()` in `rules-suggestions` is the one place that join
 * happens, and nothing on this side of the seam rebuilds it — VT's Converter
 * saves the accountant's mapping against the exact string it was given.
 */
const CHART = [
  { code: 'COS_PURCHASES', name: 'Cost of sales: Purchases' },
  { code: 'SOFTWARE_AND_SUBSCRIPTIONS', name: 'Expenses: Software and subscriptions' },
];

/**
 * Column G of the first emitted row, read back out of the real ZIP.
 *
 * ⚠ **Quote-aware, and it has to be.** This fixture's supplier is
 * `Épicerie Dubois, S.à r.l.` and Column B carries a `·`-joined details string,
 * so a naive `split(',')` lands on the amount in Column C. The emitter's own
 * suite has the same parser for the same reason.
 */
function analysisAccountCell(calls: Calls): string {
  const line = emittedCsv(calls).trim().split('\r\n')[0] ?? '';
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);

  expect(cells).toHaveLength(VT_LIST_COLUMNS.length);
  return cells[cells.length - 1] ?? '';
}

test('the Analysis account column carries the LEDGER-PREFIXED name, not the category code', async () => {
  /**
   * ⚠ **THE DEFECT, AND THE ONE ASSERTION THAT PROVES IT GONE.**
   *
   * `documents.category_code` holds `COS_PURCHASES`. VT Transaction+ wants
   * `Cost of sales: Purchases` in Column G — VT's format designer type-guesses
   * each cell, so a bare code is read as text VT cannot match to a nominal (and
   * a numeric one, `5001`, renders as the NUMBER `5,001.00`). Until this fix the
   * service passed the column straight into the column and every client's import
   * file carried the code.
   *
   * This reads the bytes back out of the archive rather than trusting a return
   * value, because the file is the deliverable.
   */
  const { calls, service } = harness({
    documents: [document('doc_1', { categoryCode: 'COS_PURCHASES' })],
    chart: CHART,
  });

  const result = await service.createExport(CTX, request(), KEY);

  expect(analysisAccountCell(calls)).toBe('Cost of sales: Purchases');
  // And it is not a warning case any more: the prefix is there, so VT matches
  // the nominal with no mapping at all.
  expect(result.warnings?.map((w) => w.code) ?? []).not.toContain('analysis-account-unprefixed');
});

test('a code the client’s chart does not carry is WARNED about, never guessed into a ledger', async () => {
  /**
   * The honest unresolvable answer, and the reason it is not a refusal.
   *
   * `documents.category_code` is free text in the schema and an accountant's own
   * explicit rule may legitimately name a code the chart does not carry, so
   * dropping the row would be the silently-short file §24.3.4 exists to prevent.
   * Inventing `Expenses: Subscriptions` to make the cell LOOK right would be
   * worse still — a wrong nominal in somebody's books, which §24.4.6 ranks above
   * every other coding error.
   *
   * So the cell keeps exactly what the column held, and the document is named in
   * `warnings` — which is the same array the publish review card renders, so the
   * accountant meets this BEFORE releasing rather than inside VT afterwards.
   */
  const { calls, service } = harness({
    documents: [document('doc_1', { categoryCode: 'SUBSCRIPTIONS' })],
    chart: CHART,
  });

  const result = await service.createExport(CTX, request(), KEY);

  const warning = result.warnings?.find((w) => w.code === 'analysis-account-unprefixed');
  expect(warning).toBeDefined();
  expect(warning?.documentId).toBe('doc_1');
  // It names the account so the accountant knows WHICH one to fix.
  expect(warning?.message).toContain('SUBSCRIPTIONS');
  expect(warning?.message).toContain('no ledger prefix');

  // The bare code did reach the file — but loudly. What must never appear is a
  // ledger nobody chose.
  expect(analysisAccountCell(calls)).toBe('SUBSCRIPTIONS');
  expect(analysisAccountCell(calls)).not.toContain(':');
  // And the row is still there: a refusal would have been a short file.
  expect(result.rowCount).toBe(1);
});

test('a chart that cannot be read costs the prefix, never the export', async () => {
  // The chart is a picklist, not the client's money. Losing it must not make a
  // month unexportable — every row falls back to its bare code and every one of
  // them warns, which is loud and recoverable in VT's Converter.
  const { calls, service } = harness({
    documents: [document('doc_1', { categoryCode: 'COS_PURCHASES' })],
    chart: 'unavailable',
  });

  const result = await service.createExport(CTX, request(), KEY);

  expect(result.state).toBe('succeeded');
  expect(result.rowCount).toBe(1);
  expect(analysisAccountCell(calls)).toBe('COS_PURCHASES');
  expect(result.warnings?.map((w) => w.code)).toContain('analysis-account-unprefixed');
});

test('the chart is read ONCE for the batch, and against the requested client', async () => {
  // 500 documents is the batch cap and the chart is one client's picklist —
  // re-reading it per row would be 500 scoped reads inside one synchronous
  // request (Governance §5.1). The `businessId` is the export's own, so the
  // nominals come from the books the file is for.
  const { calls, service } = harness({
    documents: [
      document('doc_1', { categoryCode: 'COS_PURCHASES' }),
      document('doc_2', { categoryCode: 'SOFTWARE_AND_SUBSCRIPTIONS' }),
      document('doc_3', { categoryCode: 'COS_PURCHASES' }),
    ],
    chart: CHART,
  });

  const result = await service.createExport(CTX, request(), KEY);

  expect(result.rowCount).toBe(3);
  expect(calls.getChartOfAccounts).toEqual(['biz_1']);
});

// ── the refusals ────────────────────────────────────────────────────────────

test('nothing Published in the period is NT-EXP-001, and it names the period in UK d/m/y', async () => {
  const { service } = harness({ documents: [] });

  const error = await refusal(() => service.createExport(CTX, request(), KEY));

  expect(error.code).toBe('NT-EXP-001');
  expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  expect(error.publicDetail).toContain('01/01/2026 to 31/01/2026');
  // A client with genuinely nothing Published gets the plain refusal. "0
  // documents outside the period" is noise, and an always-present extension
  // would make its absence meaningless to a consumer.
  expect(error.extension).toBeUndefined();
  expect(error.publicDetail).toContain('no Published documents outside that period either');
});

/**
 * ⚠ **THE DEAD END THIS FIXES, reported from the live app.**
 *
 * A practice had exactly one Published document — supplier *Nexora Solutions
 * LLC*, **dated 12 May 2025** — and the export screen, defaulting to last
 * month, answered *"No documents reached Published in 01/08/2026 to 31/08/2026
 * for this client."* The accountant read that as **published, but it will not
 * export**, and concluded the feature was broken.
 *
 * The code was right: the period selects on the document's own date, and May
 * 2025 is genuinely outside an August 2026 window. The PRODUCT was unhelpful —
 * it told the one person who could fix it nothing they could act on. So the
 * refusal now answers the question it provokes.
 */
test('a client whose Published documents sit OUTSIDE the period is told so, with the dates', async () => {
  const { service } = harness({
    documents: [],
    publishedOutsidePeriod: [document('doc_nexora', { documentDate: new Date('2025-05-12T00:00:00.000Z') })],
  });

  const error = await refusal(() => service.createExport(CTX, request(), KEY));

  expect(error.code).toBe('NT-EXP-001');
  expect(error.title).toBe('Nothing to export in that period');
  // The sentence an accountant reads: what is true, why, and what to do.
  expect(error.publicDetail).toContain('There is 1 Published document');
  expect(error.publicDetail).toContain('dated 12/05/2025');
  expect(error.publicDetail).toContain("selects on the document's own date, not on when it was released");
  expect(error.publicDetail).toContain('Widen the period to include it');

  // And the same fact as DATA, so the screen can offer the period rather than
  // asking the accountant to parse an English sentence for two dates.
  expect(error.extension?.publishedOutsidePeriod).toEqual({
    count: 1,
    earliestDocumentDate: '2025-05-12',
    latestDocumentDate: '2025-05-12',
  });
});

test('several documents outside the period report the span that would include them all', async () => {
  const { service, calls } = harness({
    documents: [],
    publishedOutsidePeriod: [
      document('a', { documentDate: new Date('2025-05-12T00:00:00.000Z') }),
      document('b', { documentDate: new Date('2025-11-30T00:00:00.000Z') }),
      document('c', { documentDate: new Date('2025-07-01T00:00:00.000Z') }),
    ],
  });

  const error = await refusal(() => service.createExport(CTX, request(), KEY));

  expect(error.publicDetail).toContain('There are 3 Published documents');
  expect(error.publicDetail).toContain('dated between 12/05/2025 and 30/11/2025');
  expect(error.extension?.publishedOutsidePeriod).toEqual({
    count: 3,
    earliestDocumentDate: '2025-05-12',
    latestDocumentDate: '2025-11-30',
  });

  // ⚠ The count comes from the SAME predicate the export selects on, with the
  // date clause and NOTHING else dropped. A different state, a different
  // business, or a `documentIds` narrowing the export honoured and this did not
  // would make the refusal describe documents the export would never include.
  const aggregate = calls.documentAggregate[0]?.where as Record<string, unknown>;
  expect(aggregate?.['businessId']).toBe('biz_1');
  expect(aggregate?.['state']).toBe('PUBLISHED');
  expect(aggregate?.['NOT']).toEqual({ documentDate: { gte: expect.any(Date), lt: expect.any(Date) } });
});

test('⚠ Trash is excluded from the SELECTION and from the outside-period count — the same set, or the advice cannot be followed', async () => {
  // Soft delete (`documents.deleted_at`, 2 Sep 2026). `state: 'PUBLISHED'` does
  // NOT save this query: deletion is a timestamp, not a state, so a Published
  // document keeps its state when it is deleted and would otherwise walk
  // straight into an export file an accountant hands to a client.
  const { service, calls } = harness({
    documents: [],
    publishedOutsidePeriod: [document('doc_outside', { documentDate: new Date('2025-05-12T00:00:00.000Z') })],
  });
  await refusal(() => service.createExport(CTX, request(), KEY));

  const selection = calls.documentFindMany[0]?.where as Record<string, unknown>;
  const diagnostic = calls.documentAggregate[0]?.where as Record<string, unknown>;

  expect(selection?.['deletedAt']).toBeNull();

  // ⚠ The count that tells an accountant to WIDEN THE PERIOD must reach the
  // same set the selection can. Filtering only the selection would make this
  // the worse bug: the refusal says "there are 3 Published documents outside
  // that period, widen it to include them", they widen it exactly as
  // instructed, and the export comes back empty again — with the suggested
  // bounds having been read off a document that can never be selected. That is
  // why `publishedWhere()` is one function and why the predicate lives inside
  // it rather than at either call site.
  expect(diagnostic?.['deletedAt']).toBeNull();

  // Said as an identity rather than as two separate `toBeNull`s: everything
  // except the date clause has to be common to both, so a future clause added
  // to one and not the other fails here too.
  const { documentDate: _selectionDate, ...selectionRest } = selection;
  const { NOT: _diagnosticDate, ...diagnosticRest } = diagnostic;
  expect(selectionRest).toEqual(diagnosticRest);
});

test('a named id that is not exportable is still NT-VAL-001, and never reaches the outside-period count', async () => {
  const { service, calls } = harness({
    documents: [],
    publishedOutsidePeriod: [document('doc_named', { documentDate: new Date('2025-05-12T00:00:00.000Z') })],
  });

  const error = await refusal(() => service.createExport(CTX, request({ documentIds: ['doc_named'] }), KEY));

  // Unchanged behaviour, and it is the disclosure-safe one: naming an id that
  // is not exportable is refused BEFORE anything counts documents, so the new
  // fact can never become an oracle for "does this id exist, just elsewhere?".
  expect(error.code).toBe('NT-VAL-001');
  expect(calls.documentAggregate).toHaveLength(0);

  // When the count IS reached with ids named, it is narrowed to those ids —
  // "outside the period" means outside it among the ids the caller asked
  // about, never a count over documents they did not.
  const empty = harness({ documents: [], publishedOutsidePeriod: [] });
  await refusal(() => empty.service.createExport(CTX, request({ documentIds: [] }), KEY));
  expect((empty.calls.documentAggregate[0]?.where as Record<string, unknown>)?.['id']).toEqual({ in: [] });
});

test('documents Published but undated are counted by neither side — there is no period to widen to', async () => {
  const { service } = harness({
    documents: [],
    publishedOutsidePeriod: [document('doc_undated', { documentDate: null })],
  });

  const error = await refusal(() => service.createExport(CTX, request(), KEY));

  // The aggregate finds a row and no dates. Naming a range would be inventing
  // one, so the plain refusal is the honest answer.
  expect(error.code).toBe('NT-EXP-001');
  expect(error.extension).toBeUndefined();
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
