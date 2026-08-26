import type { RejectPayload } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { HUMAN_REJECTION_CODE, MAX_REJECT_BATCH, rejectDocumentExecutor } from './reject-document.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

/**
 * `document.reject` against a recording fake — the assertions are on the writes
 * that reach the database, and on the refusals, which are the half that matters.
 */

const CTX = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface Row {
  id: string;
  state: string;
  failureCode: string | null;
  failureMessage: string | null;
  archivedAt: Date | null;
}

function doc(id: string, state: string): Row {
  return { id, state, failureCode: null, failureMessage: null, archivedAt: null };
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

const run = (db: ScopedClient, payload: RejectPayload) =>
  rejectDocumentExecutor.execute(db, { proposalId: 'prop_1', payload, ctx: CTX, traceId: 'trace-a12' });

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no-throw';
  } catch (e) {
    return e instanceof ProposalExecutionRefused ? e.message : `unexpected:${String(e)}`;
  }
};

test('rejecting stores the reason VERBATIM with the human code, and drives the state machine', async () => {
  const { db, map, events } = harness([doc('doc_1', 'TO_REVIEW')]);
  const result = await run(db, { documentIds: ['doc_1'], reason: 'Personal receipt — not a business cost' });

  const row = map.get('doc_1');
  expect(row?.state).toBe('REJECTED');
  expect(row?.failureCode).toBe(HUMAN_REJECTION_CODE);
  // Verbatim: the words the reviewer read are the words on the document.
  expect(row?.failureMessage).toBe('Personal receipt — not a business cost');

  // Through the machine, so the processing log has no gap.
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ documentId: 'doc_1', stage: 'state', outcome: 'REJECTED', traceId: 'trace-a12' });
  expect(events[0]?.['detail']).toMatchObject({ from: 'TO_REVIEW', to: 'REJECTED', proposalId: 'prop_1', via: 'reject' });

  expect(result).toMatchObject({ alreadyApplied: false, followUps: [] });
  expect(result.changed).toEqual([{ entity: 'document', id: 'doc_1' }]);
  expect(result.detail).toMatchObject({ rejected: 1, skippedAlreadyRejected: 0, code: HUMAN_REJECTION_CODE });
});

test('the code is a human decision, not a subsystem failure — it is neither an ingest nor an extraction code', async () => {
  expect(HUMAN_REJECTION_CODE).toBe('NT-DOC-001');
  expect(HUMAN_REJECTION_CODE.startsWith('NT-ING')).toBe(false);
  expect(HUMAN_REJECTION_CODE.startsWith('NT-EXT')).toBe(false);
});

test('every state the machine allows is rejectable — RECEIVED, PROCESSING, TO_REVIEW and READY', async () => {
  for (const state of ['RECEIVED', 'PROCESSING', 'TO_REVIEW', 'READY']) {
    const { db, map } = harness([doc('doc_1', state)]);
    await run(db, { documentIds: ['doc_1'], reason: 'Wrong client' });
    expect(map.get('doc_1')?.state).toBe('REJECTED');
  }
});

test('a PUBLISHED document cannot be rejected — it has already been released for export', async () => {
  const { db, map, events } = harness([doc('doc_1', 'PUBLISHED')]);
  expect(await refusal(run(db, { documentIds: ['doc_1'], reason: 'no' }))).toContain('published document cannot be rejected');
  expect(map.get('doc_1')?.state).toBe('PUBLISHED');
  expect(events).toEqual([]);
});

test("a FAILED document is the pipeline's verdict — reject refuses it, reprocess is the way out", async () => {
  const { db } = harness([doc('doc_1', 'FAILED')]);
  expect(await refusal(run(db, { documentIds: ['doc_1'], reason: 'no' }))).toContain('failed document cannot be rejected');
});

test('an ARCHIVED document is refused even though the machine allows the edge — rejecting must not silently unarchive', async () => {
  const { db, map, events } = harness([{ ...doc('doc_1', 'ARCHIVED'), archivedAt: new Date() }]);
  expect(await refusal(run(db, { documentIds: ['doc_1'], reason: 'no' }))).toContain('restore it from the archive first');
  expect(map.get('doc_1')?.state).toBe('ARCHIVED');
  expect(map.get('doc_1')?.archivedAt).not.toBeNull();
  expect(events).toEqual([]);
});

test('an already-rejected document is an idempotent skip: no second event, and the FIRST reason stands', async () => {
  const { db, map, events } = harness([
    { id: 'doc_1', state: 'REJECTED', failureCode: HUMAN_REJECTION_CODE, failureMessage: 'The first reason', archivedAt: null },
  ]);
  const result = await run(db, { documentIds: ['doc_1'], reason: 'A different reason' });
  expect(map.get('doc_1')?.failureMessage).toBe('The first reason');
  expect(events).toEqual([]);
  expect(result.alreadyApplied).toBe(true);
  expect(result.detail).toMatchObject({ rejected: 0, skippedAlreadyRejected: 1 });
});

test('all-or-nothing: one unreachable id refuses the whole batch, and nothing is written', async () => {
  const { db, map, events } = harness([doc('doc_1', 'READY')]);
  expect(await refusal(run(db, { documentIds: ['doc_1', 'doc_missing'], reason: 'no' }))).toContain('not reachable');
  expect(map.get('doc_1')?.state).toBe('READY');
  expect(events).toEqual([]);
});

test('one refusable document in a batch stops the batch — the refusal is not per document', async () => {
  const { db, map } = harness([doc('doc_1', 'READY'), doc('doc_2', 'PUBLISHED')]);
  expect(await refusal(run(db, { documentIds: ['doc_1', 'doc_2'], reason: 'no' }))).toContain('cannot be rejected');
  // doc_1 was written before doc_2 refused; the ENGINE's transaction is what
  // rolls it back, which is why the executor may not open one of its own.
  expect(map.get('doc_2')?.state).toBe('PUBLISHED');
});

test('the batch ceiling is enforced here because the contract declares none', async () => {
  const { db, events } = harness([]);
  const ids = Array.from({ length: MAX_REJECT_BATCH + 1 }, (_, i) => `doc_${i}`);
  expect(await refusal(run(db, { documentIds: ids, reason: 'no' }))).toContain(`limited to ${MAX_REJECT_BATCH} documents`);
  // Refused before any read: an unbounded all-or-nothing transaction never opens.
  expect(events).toEqual([]);
});
