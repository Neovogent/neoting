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
 * written, plus the shape of what it writes. The ledger is never reached from
 * here by design (that is the post-commit follow-up's job, and
 * `publish-batch.integration.test.ts` proves the pair against a real database),
 * so the adapter in the gateway is a tripwire: if this executor ever calls it,
 * these tests fail.
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
  orgRef: string | null;
  isActive: boolean;
}

function harness(rows: DocRow[], integrations: IntegrationRow[] = [{ id: 'int_1', businessId: 'biz_1', kind: 'XERO', orgRef: 'org', isActive: true }], publishes: PublishRow[] = []) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const created: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
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
        created.push(data);
        return data;
      },
    },
  } as unknown as ScopedClient;
  return { db, created, events, map };
}

/** The REAL preview (pure), and a ledger that fails the test if it is ever called. */
const PUBLISHING: PublishGateway = {
  ledger: {
    publishBill: async () => {
      throw new Error('the effect transaction must never call the ledger — that is what the post-commit follow-up is for');
    },
  },
  previewPublishBatch,
};

const executor = createPublishBatchExecutor(PUBLISHING);
const input = (payload: PublishBatchPayload, proposalId = 'prop_1') => ({ proposalId, payload, ctx: CTX, traceId: 'trace-10' });
const preview = (itemCount: number, grossPence: number, vatPence: number) => ({ itemCount, grossPence, vatPence });

test('the effect writes QUEUED rows and a publish follow-up — it does not touch the ledger', async () => {
  const { db, created, map } = harness([doc('doc_1'), doc('doc_2')]);
  const result = await executor.execute(db, input({ documentIds: ['doc_1', 'doc_2'], preview: preview(2, 195_240, 32_540) }));

  expect(created).toHaveLength(2);
  expect(created[0]).toMatchObject({
    businessId: 'biz_1',
    documentId: 'doc_1',
    integrationId: 'int_1',
    mode: 'MANUAL',
    state: 'QUEUED',
    idempotencyKey: 'prop_1:doc_1',
    actionProposalId: 'prop_1',
    publishedByUserId: 'usr_1',
  });
  expect(result.followUps).toEqual([{ kind: 'publish', proposalId: 'prop_1', businessId: 'biz_1' }]);
  expect(result.alreadyApplied).toBe(false);
  expect(result.detail).toMatchObject({ queued: 2, integrationId: 'int_1' });
  // Nothing moved state: the documents are still READY until the ledger answers.
  expect(map.get('doc_1')?.state).toBe('READY');
});

test('the idempotency key is proposal + document, so a replay collides and a retry does not', () => {
  expect(publishIdempotencyKey('prop_1', 'doc_1')).toBe('prop_1:doc_1');
  expect(publishIdempotencyKey('prop_2', 'doc_1')).not.toBe(publishIdempotencyKey('prop_1', 'doc_1'));
});

test('a replay of the same proposal is alreadyApplied, with no second row and no second follow-up', async () => {
  const { db, created } = harness([doc('doc_1')], undefined, [
    { documentId: 'doc_1', state: 'QUEUED', actionProposalId: 'prop_1' },
  ]);
  const result = await executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }));
  expect(result.alreadyApplied).toBe(true);
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
  expect(created).toHaveLength(0); // all-or-nothing: doc_1 did not publish either
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

test('a batch spanning two businesses refuses — there is no single ledger to publish it through', async () => {
  const { db } = harness([doc('doc_1'), doc('doc_2', { businessId: 'biz_2' })]);
  await expect(
    executor.execute(db, input({ documentIds: ['doc_1', 'doc_2'], preview: preview(2, 195_240, 32_540) })),
  ).rejects.toThrow('one business');
});

test('the integration is resolved, never guessed: none, several, wrong client and disconnected all refuse', async () => {
  const payload: PublishBatchPayload = { documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) };

  const none = harness([doc('doc_1')], []);
  await expect(none.db && executor.execute(none.db, input(payload))).rejects.toThrow('no active ledger connection');

  const several = harness([doc('doc_1')], [
    { id: 'int_1', businessId: 'biz_1', kind: 'XERO', orgRef: null, isActive: true },
    { id: 'int_2', businessId: 'biz_1', kind: 'QUICKBOOKS', orgRef: null, isActive: true },
  ]);
  await expect(executor.execute(several.db, input(payload))).rejects.toThrow('more than one active ledger connection');

  const foreign = harness([doc('doc_1')], [{ id: 'int_x', businessId: 'biz_other', kind: 'XERO', orgRef: null, isActive: true }]);
  await expect(
    executor.execute(foreign.db, input({ ...payload, integrationId: 'int_x' })),
  ).rejects.toThrow('not reachable for this batch');

  const off = harness([doc('doc_1')], [{ id: 'int_1', businessId: 'biz_1', kind: 'XERO', orgRef: null, isActive: false }]);
  await expect(executor.execute(off.db, input({ ...payload, integrationId: 'int_1' }))).rejects.toThrow('disconnected');
});

test('only READY, or a document whose last publish FAILED, may enter a batch', async () => {
  const payload: PublishBatchPayload = { documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) };

  for (const state of ['TO_REVIEW', 'PUBLISHED', 'ARCHIVED', 'PROCESSING'] as const) {
    const { db, created } = harness([doc('doc_1', { state })]);
    await expect(executor.execute(db, input(payload))).rejects.toThrow('cannot be published');
    expect(created).toHaveLength(0);
  }

  // Rejected for something other than a failed publish: proposing a publish is
  // not how a human rejection gets undone.
  const rejected = harness([doc('doc_1', { state: 'REJECTED' })]);
  await expect(executor.execute(rejected.db, input(payload))).rejects.toThrow('other than a failed publish');
});

test('a document with a publish already IN FLIGHT is refused — the double-post the key cannot catch', async () => {
  // The window this closes: the happy path leaves the document READY until the
  // post-commit follow-up hears back, so a READY document can already be QUEUED
  // in `publishes`. A SECOND proposal has a different id, so
  // `<proposalId>:<documentId>` is a different idempotency key and the unique
  // constraint never fires — the same bill posts to the ledger twice.
  const { db, created } = harness([doc('doc_1', { state: 'READY' })], undefined, [
    { documentId: 'doc_1', state: 'QUEUED', actionProposalId: 'prop_first' },
  ]);

  await expect(
    executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }, 'prop_second')),
  ).rejects.toThrow('already in flight');
  expect(created).toHaveLength(0);
});

test('a SUCCEEDED publish does not block a later batch through this gate — the state machine already refuses it', async () => {
  // Guard the guard: it keys on QUEUED only, so it cannot swallow the retry path
  // (FAILED) or duplicate the state gate's job (a succeeded publish leaves the
  // document PUBLISHED/ARCHIVED, which `cannot be published` already refuses).
  const { db } = harness([doc('doc_1', { state: 'PUBLISHED' })], undefined, [
    { documentId: 'doc_1', state: 'SUCCEEDED', actionProposalId: 'prop_first' },
  ]);
  await expect(
    executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }, 'prop_second')),
  ).rejects.toThrow('cannot be published');
});

test('a retry re-arms the failed document REJECTED → PROCESSING → READY, both edges logged', async () => {
  const { db, created, events, map } = harness([doc('doc_1', { state: 'REJECTED' })], undefined, [
    { documentId: 'doc_1', state: 'FAILED', actionProposalId: 'prop_0' },
  ]);
  const result = await executor.execute(
    db,
    input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) }, 'prop_retry'),
  );

  // PROCESSING is the machine's only exit from REJECTED, and the only edge
  // that clears the reason — a document that publishes must not still claim
  // the ledger refused it.
  expect(events.map((e) => e['outcome'])).toEqual(['PROCESSING', 'READY']);
  expect(map.get('doc_1')?.state).toBe('READY');
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ idempotencyKey: 'prop_retry:doc_1' });
  expect(result.followUps).toEqual([{ kind: 'publish', proposalId: 'prop_retry', businessId: 'biz_1' }]);
});

test('an unrouted document has no client books to publish into', async () => {
  const { db } = harness([doc('doc_1', { businessId: null })]);
  await expect(
    executor.execute(db, input({ documentIds: ['doc_1'], preview: preview(1, 97_620, 16_270) })),
  ).rejects.toThrow('no client books');
});
