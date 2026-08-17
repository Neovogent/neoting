import { DocumentState } from '@prisma/client';
import { expect, test } from 'vitest';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import {
  type DocumentTransition,
  IllegalDocumentTransition,
  isLegalTransition,
  LEGAL_TRANSITIONS,
  StaleDocumentState,
  transitionDocument,
} from './document-state.js';

const ALL_STATES = Object.values(DocumentState);

/** A recording fake: the assertions are on what reaches the database. */
function harness(options: { updateCount?: number } = {}) {
  const updates: { where: unknown; data: Record<string, unknown> }[] = [];
  const events: { data: Record<string, unknown> }[] = [];
  const db = {
    document: {
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: options.updateCount ?? 1 };
      },
    },
    documentEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        events.push(args);
        return {};
      },
    },
  } as unknown as ScopedClient;
  return { db, updates, events };
}

const failed = (to: 'REJECTED' | 'FAILED'): DocumentTransition => ({
  to,
  failure: { code: 'NT-ING-004', message: 'The file was rejected by sanitisation.' },
  traceId: 'trace-80',
});

test('the transition table is total over the enum — a new state cannot arrive undecided', () => {
  // LEGAL_TRANSITIONS is typed as a total Record, so this is belt-and-braces
  // for a runtime cast; the real enforcement is the compile error.
  for (const state of ALL_STATES) expect(LEGAL_TRANSITIONS[state]).toBeDefined();
});

test('every pair in the table is accepted and EVERY other pair throws', async () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const legal = LEGAL_TRANSITIONS[from].includes(to);
      expect(isLegalTransition(from, to)).toBe(legal);

      const { db } = harness();
      const spec: DocumentTransition =
        to === 'REJECTED' || to === 'FAILED' ? failed(to) : { to, traceId: 'trace-80' };
      const run = transitionDocument(db, { id: 'doc_1', state: from }, spec);
      if (legal) {
        await expect(run).resolves.toBeUndefined();
      } else {
        await expect(run).rejects.toThrow(IllegalDocumentTransition);
      }
    }
  }
});

test('no state may transition to itself — a no-op write is not a transition', () => {
  for (const state of ALL_STATES) expect(isLegalTransition(state, state)).toBe(false);
});

test('REJECTED and FAILED are unreachable without a code and a message, even past the types', async () => {
  const { db } = harness();
  // The union forbids this shape; the cast simulates a caller that forced it.
  const forged = { to: 'FAILED', traceId: 't' } as unknown as DocumentTransition;
  await expect(transitionDocument(db, { id: 'doc_1', state: 'PROCESSING' }, forged)).rejects.toThrow(
    IllegalDocumentTransition,
  );
});

test('a failure transition writes the reason onto the row AND into the event', async () => {
  const { db, updates, events } = harness();
  await transitionDocument(db, { id: 'doc_1', state: 'PROCESSING' }, failed('FAILED'));

  expect(updates[0]?.data).toMatchObject({
    state: 'FAILED',
    failureCode: 'NT-ING-004',
    failureMessage: 'The file was rejected by sanitisation.',
  });
  expect(events[0]?.data).toMatchObject({
    documentId: 'doc_1',
    stage: 'state',
    outcome: 'FAILED',
    traceId: 'trace-80',
    detail: { from: 'PROCESSING', to: 'FAILED', failureCode: 'NT-ING-004' },
  });
});

test('reprocess clears the failure reason; archiving a rejection keeps it', async () => {
  const reprocess = harness();
  await transitionDocument(reprocess.db, { id: 'doc_1', state: 'FAILED' }, { to: 'PROCESSING', traceId: 't' });
  expect(reprocess.updates[0]?.data).toMatchObject({ state: 'PROCESSING', failureCode: null, failureMessage: null });

  const archive = harness();
  await transitionDocument(archive.db, { id: 'doc_1', state: 'REJECTED' }, { to: 'ARCHIVED', traceId: 't' });
  const data = archive.updates[0]?.data ?? {};
  // The reason must survive the archive: an unarchived rejection restores as a
  // rejection and needs its reason back.
  expect('failureCode' in data).toBe(false);
  expect(data['archivedAt']).toBeInstanceOf(Date);
});

test('archivedAt is stamped on the way in and cleared on the way out', async () => {
  const into = harness();
  await transitionDocument(into.db, { id: 'doc_1', state: 'PUBLISHED' }, { to: 'ARCHIVED', traceId: 't' });
  expect(into.updates[0]?.data['archivedAt']).toBeInstanceOf(Date);

  const outOf = harness();
  await transitionDocument(outOf.db, { id: 'doc_1', state: 'ARCHIVED' }, { to: 'PUBLISHED', traceId: 't' });
  expect(outOf.updates[0]?.data['archivedAt']).toBeNull();
});

test('the write is guarded on the expected from-state — a lost race throws, never clobbers', async () => {
  const { db, updates, events } = harness({ updateCount: 0 });
  await expect(
    transitionDocument(db, { id: 'doc_1', state: 'READY' }, { to: 'PUBLISHED', traceId: 't' }),
  ).rejects.toThrow(StaleDocumentState);
  expect(updates[0]?.where).toEqual({ id: 'doc_1', state: 'READY' });
  expect(events).toHaveLength(0); // no event for a transition that did not happen
});

test('every transition writes exactly one event, with the trace id', async () => {
  const { db, events } = harness();
  await transitionDocument(db, { id: 'doc_1', state: 'RECEIVED' }, { to: 'PROCESSING', traceId: 'trace-xyz' });
  expect(events).toHaveLength(1);
  expect(events[0]?.data['traceId']).toBe('trace-xyz');
});
