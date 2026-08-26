import { expect, test } from 'vitest';

import type { PublishBatchPayload } from '@neoting/contracts/model';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { previewPublishBatch } from '../../publishing/index.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { createPublishBatchExecutor, publishIdempotencyKey, type PublishGateway } from './publish-batch.js';

/**
 * The `publish.batch` EFFECT, offline — every refusal it makes before a row is
 * written, and the shape of the release it performs when it does not refuse.
 *
 * ⚠ **D42 is what most of these tests are actually about.** *Published* is an
 * internal state meaning approved and released for export; nothing here talks
 * to a ledger, and the adapter on the gateway is a TRIPWIRE — if this executor
 * ever calls it, every test in this file fails. The three properties that used
 * to be impossible and are now pinned:
 *
 * - a client with **no** integration row releases (that refusal is why nothing
 *   could ever reach Published);
 * - a dormant ledger-vendor row is never adopted as an export destination, and
 *   naming one refuses;
 * - a released document stays **PUBLISHED** — it does not auto-archive, because
 *   `POST /v1/exports` exports only PUBLISHED documents.
 */

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface DocRow {
  id: string;
  state: string;
  businessId: string | null;
  supplierName: string | null;
  categoryCode: string | null;
  totalPence: number | null;
  taxPence: number | null;
}

interface PublishRow {
  id?: string;
  documentId: string;
  state: string;
  actionProposalId: string | null;
  [key: string]: unknown;
}

function doc(id: string, over: Partial<DocRow> = {}): DocRow {
  return {
    id,
    state: 'READY',
    businessId: 'biz_1',
    supplierName: 'Bidfood Ltd',
    categoryCode: 'COST_OF_SALES',
    totalPence: 97_620,
    taxPence: 16_270,
    ...over,
  };
}

interface IntegrationRow {
  id: string;
  businessId: string;
  kind: string;
  isActive: boolean;
}

/** The default: one VT export destination, which is what A11's client intake creates. */
const VT_DESTINATION: IntegrationRow[] = [{ id: 'int_vt', businessId: 'biz_1', kind: 'VT', isActive: true }];

function harness(rows: DocRow[], integrations: IntegrationRow[] = VT_DESTINATION, publishes: PublishRow[] = []) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const created: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const store = new Map<string, PublishRow>();
  let seq = 0;
  const db = {
    document: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => map.get(id)).filter((r) => r !== undefined),
      updateMany: async (args: { where: { id: string; state: string }; data: Record<string, unknown> }) => {
        const row = map.get(args.where.id);
        if (row === undefined || row.state !== args.where.state) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    documentEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return {};
      },
    },
    integration: {
      findUnique: async ({ where }: { where: { id: string } }) => integrations.find((i) => i.id === where.id) ?? null,
      findMany: async ({ where }: { where: { businessId: string; isActive: boolean } }) =>
        integrations.filter((i) => i.businessId === where.businessId && i.isActive === where.isActive),
    },
    publish: {
      findMany: async ({ where }: { where: { actionProposalId: string } }) =>
        publishes.filter((p) => p.actionProposalId === where.actionProposalId),
      count: async ({ where }: { where: { documentId: string; state: string } }) =>
        publishes.filter((p) => p.documentId === where.documentId && p.state === where.state).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = { id: `pub_${seq}`, ...data } as unknown as PublishRow;
        created.push(row);
        store.set(row.id ?? '', row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.get(where.id);
        if (row === undefined) throw new Error(`no publish row ${where.id}`);
        Object.assign(row, data);
        return row;
      },
    },
  } as unknown as ScopedClient;
  return { db, created, events, map };
}

/** The REAL preview (pure), and a ledger that fails the test if it is ever called. */
const PUBLISHING: PublishGateway = {
  ledger: {
    publishBill: async () => {
      throw new Error('D42: releasing a document for export must never reach a ledger — the adapter is dormant, not a dependency');
    },
  },
  previewPublishBatch,
};

const executor = createPublishBatchExecutor(PUBLISHING);
const input = (payload: PublishBatchPayload, proposalId = 'prop_1') => ({ proposalId, payload, ctx: CTX, traceId: 'trace-10' });
const preview = (itemCount: number, grossPence: number, vatPence: number) => ({ itemCount, grossPence, vatPence });

test('the effect releases for export: SUCCEEDED rows, the documents reach PUBLISHED, no ledger and no follow-up', async () => {
  const { db, created, map } = harness([doc('doc_1'), doc('doc_2')]);
  const result = await executor.execute(db, input({ documentIds: ['doc_1', 'doc_2'], preview: preview(2, 195_240, 32_540) }));

  expect(created).toHaveLength(2);
  expect(created[0]).toMatchObject({
    businessId: 'biz_1',
    documentId: 'doc_1',
    integrationId: 'int_vt',
    mode: 'MANUAL',
    // Born QUEUED, resolved in the same transaction — there is no vendor to wait for.
    state: 'SUCCEEDED',
    idempotencyKey: 'prop_1:doc_1',
    actionProposalId: 'prop_1',
    publishedByUserId: 'usr_1',
  });
  expect(created[0]?.['completedAt']).toBeInstanceOf(Date);
  // Nothing was reached, so there is no reference to record and nothing travelled.
  expect(created[0]?.['externalRef']).toBeUndefined();
  expect(created[0]?.['attachmentSent']).toBeUndefined();

  // No follow-up: releasing for export calls nothing, so there is no work that
  // must not run inside the effect transaction.
  expect(result.followUps).toEqual([]);
  expect(result.alreadyApplied).toBe(false);
  expect(result.detail).toMatchObject({ released: 2, releasedForExport: true, exportDestinationId: 'int_vt', exportDestinationKind: 'VT' });

  // PUBLISHED, and it STAYS published: `POST /v1/exports` exports only
  // PUBLISHED documents, so auto-archiving here would hide every one of them.
  expect(map.get('doc_1')?.state).toBe('PUBLISHED');
  expect(map.get('doc_2')?.state).toBe('PUBLISHED');
});

test('the audit trail says released-for-export, never posted or sent', async () => {
  const { db, events } = harness([doc('doc_1')]);
  await executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }));

  const published = events.find((event) => event['outcome'] === 'PUBLISHED');
  expect(published).toBeDefined();
  const detail = published?.['detail'] as Record<string, unknown>;
  expect(detail['via']).toBe('release-for-export');
  expect(detail['releasedForExport']).toBe(true);
  expect(detail['exportDestinationKind']).toBe('VT');
  // D42: no surface, no string and no audit line may imply a ledger was written to.
  const wording = JSON.stringify(events).toLowerCase();
  for (const forbidden of ['posted', 'synced', 'sent to', 'xero']) {
    expect(wording).not.toContain(forbidden);
  }
});

test('the idempotency key is proposal + document, so a replay collides and a retry does not', () => {
  expect(publishIdempotencyKey('prop_1', 'doc_1')).toBe('prop_1:doc_1');
  expect(publishIdempotencyKey('prop_2', 'doc_1')).not.toBe(publishIdempotencyKey('prop_1', 'doc_1'));
});

test('a replay of the same proposal is alreadyApplied, with no second row and no second release', async () => {
  const { db, created } = harness([doc('doc_1')], undefined, [
    { documentId: 'doc_1', state: 'SUCCEEDED', actionProposalId: 'prop_1' },
  ]);
  const result = await executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }));
  expect(result.alreadyApplied).toBe(true);
  expect(result.detail).toMatchObject({ released: 0, alreadyReleased: 1 });
  expect(result.followUps).toEqual([]);
  expect(created).toHaveLength(0);
});

test('one item short of the minimum refuses the WHOLE batch with NT-PUB-001, naming the fields', async () => {
  const { db, created } = harness([doc('doc_1'), doc('doc_2', { categoryCode: null, supplierName: null })]);
  const error = await executor
    .execute(db, input({ documentIds: ['doc_1', 'doc_2'], preview: preview(2, 195_240, 32_540) }))
    .then(() => null)
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ProposalExecutionRefused);
  expect((error as Error).message).toContain('NT-PUB-001');
  expect((error as Error).message).toContain('supplier, category');
  expect((error as Error).message).toContain('half-coded books');
  expect(created).toHaveLength(0); // all-or-nothing: doc_1 was not released either
});

test('an unreachable document refuses the batch without saying whether it exists', async () => {
  const { db } = harness([doc('doc_1')]);
  await expect(
    executor.execute(db, input({ documentIds: ['doc_1', 'doc_ghost'], preview: preview(2, 195_240, 32_540) })),
  ).rejects.toThrow('not reachable');
});

test('figures that no longer match the reviewed preview refuse — the drift NT-PRP-004 cannot see', async () => {
  const { db } = harness([doc('doc_1')]);
  await expect(
    executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 1, 0) })),
  ).rejects.toThrow('no longer matches the figures that were reviewed');
});

test('a batch spanning two clients refuses — one export file belongs to one client', async () => {
  const { db } = harness([doc('doc_1'), doc('doc_2', { businessId: 'biz_2' })]);
  await expect(
    executor.execute(db, input({ documentIds: ['doc_1', 'doc_2'], preview: preview(2, 195_240, 32_540) })),
  ).rejects.toThrow('one client');
});

test('D42/D47: a client with NO integration row still releases — the refusal that stranded every document is gone', async () => {
  // This is the whole stage. `resolveIntegration` used to throw "this client
  // has no active ledger connection", `integration.create` existed only in
  // prisma/seed.ts, and D47 forbids intake from asking for a connection — so
  // nothing could ever reach PUBLISHED and the export had nothing to export.
  const { db, created, map } = harness([doc('doc_1')], []);
  const result = await executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }));

  expect(map.get('doc_1')?.state).toBe('PUBLISHED');
  // Null, not invented: the schema makes `publishes.integration_id` nullable
  // for exactly this.
  expect(created[0]).toMatchObject({ integrationId: null, state: 'SUCCEEDED' });
  expect(result.detail).not.toHaveProperty('exportDestinationId');
  expect(result.detail).toMatchObject({ released: 1, releasedForExport: true });
});

test('a dormant ledger-vendor row is never adopted as an export destination', async () => {
  // prisma/seed.ts has seeded XERO rows since long before D42. Recording one
  // against a release would put a vendor's name on an act that never touched a
  // vendor.
  const { db, created, map } = harness([doc('doc_1')], [{ id: 'int_xero', businessId: 'biz_1', kind: 'XERO', isActive: true }]);
  await executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }));

  expect(created[0]).toMatchObject({ integrationId: null });
  expect(map.get('doc_1')?.state).toBe('PUBLISHED');
});

test('the export destination is resolved, never guessed: two, wrong client, switched off and a ledger vendor all refuse', async () => {
  const payload: PublishBatchPayload = { documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) };

  // `@@unique([businessId, kind])` permits VT *and* MANUAL. A11 creates one, so
  // this is unreachable in practice — and stays a refusal rather than a coin toss.
  const several = harness([doc('doc_1')], [
    { id: 'int_vt', businessId: 'biz_1', kind: 'VT', isActive: true },
    { id: 'int_man', businessId: 'biz_1', kind: 'MANUAL', isActive: true },
  ]);
  await expect(executor.execute(several.db, input(payload))).rejects.toThrow('more than one export destination');

  const foreign = harness([doc('doc_1')], [{ id: 'int_x', businessId: 'biz_other', kind: 'VT', isActive: true }]);
  await expect(
    executor.execute(foreign.db, input({ ...payload, integrationId: 'int_x' })),
  ).rejects.toThrow('not reachable for this batch');

  const off = harness([doc('doc_1')], [{ id: 'int_vt', businessId: 'biz_1', kind: 'VT', isActive: false }]);
  await expect(executor.execute(off.db, input({ ...payload, integrationId: 'int_vt' }))).rejects.toThrow('switched off');

  const vendor = harness([doc('doc_1')], [{ id: 'int_xero', businessId: 'biz_1', kind: 'XERO', isActive: true }]);
  await expect(
    executor.execute(vendor.db, input({ ...payload, integrationId: 'int_xero' })),
  ).rejects.toThrow('does not write to accounting software');
});

test('only READY, or a document whose last release FAILED, may enter a batch', async () => {
  const payload: PublishBatchPayload = { documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) };

  for (const state of ['TO_REVIEW', 'PUBLISHED', 'ARCHIVED', 'PROCESSING'] as const) {
    const { db, created } = harness([doc('doc_1', { state })]);
    await expect(executor.execute(db, input(payload))).rejects.toThrow('cannot be released');
    expect(created).toHaveLength(0);
  }

  // Rejected for something other than a failed release: proposing a release is
  // not how a human rejection gets undone.
  const rejected = harness([doc('doc_1', { state: 'REJECTED' })]);
  await expect(executor.execute(rejected.db, input(payload))).rejects.toThrow('other than a failed release');
});

test('a document with a release already IN FLIGHT is refused — the guard the dormant ledger lane still needs', async () => {
  // This executor cannot leave a QUEUED row behind (the row is created and
  // resolved in the same transaction as the transition). The guard stays for
  // rows written by the v1 ledger lane, and for rows an older release of this
  // code left behind: `<proposalId>:<documentId>` cannot catch them, because a
  // different proposal is a different key.
  const { db, created } = harness([doc('doc_1', { state: 'READY' })], undefined, [
    { documentId: 'doc_1', state: 'QUEUED', actionProposalId: 'prop_first' },
  ]);

  await expect(
    executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }, 'prop_second')),
  ).rejects.toThrow('already in flight');
  expect(created).toHaveLength(0);
});

test('a SUCCEEDED release does not block a later batch through this gate — the state machine already refuses it', async () => {
  // Guard the guard: it keys on QUEUED only, so it cannot swallow the retry path
  // (FAILED) or duplicate the state gate's job (a released document is
  // PUBLISHED, which `cannot be released` already refuses).
  const { db } = harness([doc('doc_1', { state: 'PUBLISHED' })], undefined, [
    { documentId: 'doc_1', state: 'SUCCEEDED', actionProposalId: 'prop_first' },
  ]);
  await expect(
    executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }, 'prop_second')),
  ).rejects.toThrow('cannot be released');
});

test('a retry re-arms the failed document REJECTED → PROCESSING → READY, both edges logged, then releases', async () => {
  const { db, created, events, map } = harness([doc('doc_1', { state: 'REJECTED' })], undefined, [
    { documentId: 'doc_1', state: 'FAILED', actionProposalId: 'prop_0' },
  ]);
  const result = await executor.execute(
    db,
    input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }, 'prop_retry'),
  );

  // PROCESSING is the machine's only exit from REJECTED, and the only edge
  // that clears the reason — a released document must not still carry the
  // reason its last attempt failed.
  expect(events.map((e) => e['outcome'])).toEqual(['PROCESSING', 'READY', 'PUBLISHED']);
  expect(map.get('doc_1')?.state).toBe('PUBLISHED');
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ idempotencyKey: 'prop_retry:doc_1' });
  expect(result.followUps).toEqual([]);
});

test('an unrouted document has no client to release it for', async () => {
  const { db } = harness([doc('doc_1', { businessId: null })]);
  await expect(
    executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) })),
  ).rejects.toThrow('no client to release it for');
});
