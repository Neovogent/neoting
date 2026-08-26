import type { ReprocessPayload } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { reprocessDocumentExecutor } from './reprocess-document.js';

/**
 * `document.reprocess` against a recording fake. The two properties that carry
 * the stage are here: the failure reason is CLEARED by the machine on the way to
 * PROCESSING, and the document lands where readiness says rather than in a state
 * nobody can work.
 */

const CTX = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface Row {
  id: string;
  state: string;
  failureCode: string | null;
  failureMessage: string | null;
  totalPence: number | null;
  supplierName: string | null;
  categoryCode: string | null;
}

function failed(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    state: 'FAILED',
    failureCode: 'NT-EXT-001',
    failureMessage: 'We could not read this document',
    totalPence: null,
    supplierName: null,
    categoryCode: null,
    ...over,
  };
}

function harness(rows: Row[]) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const events: Record<string, unknown>[] = [];
  const db = {
    document: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => map.get(id)).filter((r) => r !== undefined),
      updateMany: async (args: { where: { id: string; state: string }; data: Record<string, unknown> }) => {
        const row = map.get(args.where.id);
        if (row === undefined || row.state !== args.where.state) return { count: 0 };
        updates.push(args);
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
  } as unknown as ScopedClient;
  return { db, map, updates, events };
}

const run = (db: ScopedClient, payload: ReprocessPayload) =>
  reprocessDocumentExecutor.execute(db, { proposalId: 'prop_1', payload, ctx: CTX, traceId: 'trace-a12' });

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no-throw';
  } catch (e) {
    return e instanceof ProposalExecutionRefused ? e.message : `unexpected:${String(e)}`;
  }
};

test('a FAILED extraction is re-armed: the reason is cleared and the document lands in To Review', async () => {
  const { db, map, events, updates } = harness([failed('doc_1')]);
  const result = await run(db, { documentIds: ['doc_1'] });

  const row = map.get('doc_1');
  expect(row?.state).toBe('TO_REVIEW');
  // The machine clears these on REJECTED|FAILED → PROCESSING; a retried
  // document must not still carry why its last attempt failed.
  expect(row?.failureCode).toBeNull();
  expect(row?.failureMessage).toBeNull();
  expect(updates[0]?.data).toMatchObject({ state: 'PROCESSING', failureCode: null, failureMessage: null });

  // Two edges, two events — PROCESSING is the machine's only exit from FAILED.
  expect(events.map((e) => e['outcome'])).toEqual(['PROCESSING', 'TO_REVIEW']);
  expect(events[0]?.['detail']).toMatchObject({ from: 'FAILED', to: 'PROCESSING', proposalId: 'prop_1', via: 'reprocess' });

  expect(result).toMatchObject({ alreadyApplied: false, followUps: [] });
  expect(result.detail).toMatchObject({ retried: 1, ready: 0, toReview: 1, extractionRerun: false });
});

test('a rejection over a fully coded document is undone cleanly — reject then reprocess returns it to Ready', async () => {
  const { db, map, events } = harness([
    failed('doc_1', {
      state: 'REJECTED',
      failureCode: 'NT-DOC-001',
      failureMessage: 'Wrong client',
      totalPence: 12_000,
      supplierName: 'Currys',
      categoryCode: 'OFFICE_EQUIPMENT',
    }),
  ]);
  const result = await run(db, { documentIds: ['doc_1'] });
  expect(map.get('doc_1')?.state).toBe('READY');
  expect(map.get('doc_1')?.failureMessage).toBeNull();
  expect(events.map((e) => e['outcome'])).toEqual(['PROCESSING', 'READY']);
  expect(result.detail).toMatchObject({ ready: 1, toReview: 0 });
});

test('readiness decides the landing state, one field at a time', async () => {
  // Two of three mandatory fields present is still To Review — `readiness.ts` is
  // the one place that choice lives and this executor does not re-state it.
  const { db, map } = harness([failed('doc_1', { totalPence: 0, supplierName: 'Shell' })]);
  await run(db, { documentIds: ['doc_1'] });
  expect(map.get('doc_1')?.state).toBe('TO_REVIEW');

  // A £0.00 total is a real value, not a missing one — with the category it is Ready.
  const complete = harness([failed('doc_2', { totalPence: 0, supplierName: 'Shell', categoryCode: 'MOTOR' })]);
  await run(complete.db, { documentIds: ['doc_2'] });
  expect(complete.map.get('doc_2')?.state).toBe('READY');
});

test('only what the read surface marks retryable is retryable — everything else refuses, untouched', async () => {
  for (const state of ['RECEIVED', 'PROCESSING', 'TO_REVIEW', 'READY', 'PUBLISHED', 'ARCHIVED']) {
    const { db, map, events } = harness([failed('doc_1', { state, failureCode: null, failureMessage: null })]);
    expect(await refusal(run(db, { documentIds: ['doc_1'] }))).toContain('cannot be retried');
    expect(map.get('doc_1')?.state).toBe(state);
    expect(events).toEqual([]);
  }
});

test('all-or-nothing: an unreachable id refuses the batch before anything moves', async () => {
  const { db, map, events } = harness([failed('doc_1')]);
  expect(await refusal(run(db, { documentIds: ['doc_1', 'doc_missing'] }))).toContain('not reachable');
  expect(map.get('doc_1')?.state).toBe('FAILED');
  expect(events).toEqual([]);
});

test('a batch retries every document and reports the split', async () => {
  const { db, map } = harness([
    failed('doc_1'),
    failed('doc_2', { state: 'REJECTED', totalPence: 500, supplierName: 'Costco', categoryCode: 'STOCK' }),
  ]);
  const result = await run(db, { documentIds: ['doc_1', 'doc_2'] });
  expect(map.get('doc_1')?.state).toBe('TO_REVIEW');
  expect(map.get('doc_2')?.state).toBe('READY');
  expect(result.detail).toMatchObject({ retried: 2, ready: 1, toReview: 1 });
  expect(result.changed).toEqual([
    { entity: 'document', id: 'doc_1' },
    { entity: 'document', id: 'doc_2' },
  ]);
});

test('fromStage is RECORDED, never silently dropped — and never silently honoured', async () => {
  const { db, events } = harness([failed('doc_1')]);
  const result = await run(db, { documentIds: ['doc_1'], fromStage: 'extract' });
  expect(events[0]?.['detail']).toMatchObject({ fromStage: 'extract' });
  expect(result.detail).toMatchObject({ fromStage: 'extract' });
  // The outcome states the limit in the same breath: the bytes were not re-read.
  expect(result.detail).toMatchObject({ extractionRerun: false });

  const nullStage = harness([failed('doc_2')]);
  const plain = await run(nullStage.db, { documentIds: ['doc_2'], fromStage: null });
  expect(plain.detail?.['fromStage']).toBeUndefined();
});

test('the batch ceiling matches the contract, and refuses before any read', async () => {
  const { db, events } = harness([]);
  const ids = Array.from({ length: 501 }, (_, i) => `doc_${i}`);
  expect(await refusal(run(db, { documentIds: ids }))).toContain('limited to 500 documents');
  expect(events).toEqual([]);
});
