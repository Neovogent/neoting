import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ProposalKind } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { archiveDocumentExecutor } from './archive-document.js';
import { ProposalExecutionRefused, ProposalNotImplementedError } from './proposal-executor.js';
import { buildExecutorRegistry } from './registry.js';
import { routeDocumentExecutor } from './route-document.js';

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface DocRow {
  id: string;
  state: string;
  businessId: string | null;
  practiceId: string | null;
  inbox: string;
  byteHash: string;
  archivedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  totalPence: number | null;
  supplierName: string | null;
  categoryCode: string | null;
}

function doc(id: string, over: Partial<DocRow> = {}): DocRow {
  return {
    id,
    state: 'RECEIVED',
    businessId: null,
    practiceId: 'prac_1',
    inbox: 'UNROUTED',
    byteHash: 'h1',
    archivedAt: null,
    failureCode: null,
    failureMessage: null,
    totalPence: null,
    supplierName: null,
    categoryCode: null,
    ...over,
  };
}

/** A recording fake — the assertions are on the writes that reach the database. */
function harness(rows: DocRow[], businesses: string[] = ['biz_1']) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const events: Record<string, unknown>[] = [];
  const db = {
    document: {
      findUnique: async ({ where }: { where: { id: string } }) => map.get(where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => map.get(id)).filter((r) => r !== undefined),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        Object.assign(map.get(args.where.id) ?? {}, args.data);
        return map.get(args.where.id);
      },
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
      findFirst: async ({ where }: { where: { documentId: string; outcome: string } }) => {
        const hit = [...events]
          .reverse()
          .find((e) => e['documentId'] === where.documentId && e['stage'] === 'state' && e['outcome'] === where.outcome);
        return hit === undefined ? null : { detail: hit['detail'] };
      },
    },
    business: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        businesses.includes(where.id) ? { id: where.id } : null,
    },
  } as unknown as ScopedClient;
  return { db, updates, events, map };
}

const input = <P>(payload: P) => ({ proposalId: 'prop_1', payload, ctx: CTX, traceId: 'trace-81' });

// ---- registry --------------------------------------------------------------

test('the registry is total over the contract enum, and the holes throw by name', async () => {
  const registry = buildExecutorRegistry();
  for (const kind of Object.values(ProposalKind)) {
    expect(registry[kind]).toBeDefined();
    expect(registry[kind].kind).toBe(kind);
  }
  const { db } = harness([]);
  for (const kind of [
    'document.move-business',
    'document.reprocess',
    'document.reject',
    'document.split',
    // METH Stage 2 (#120) — holes until their stages land executors. chase.send
    // is now real (METH S8), so it is no longer in this list.
    'publish.batch',
    'bank.confirm-match',
    'rule.create',
  ] as const) {
    const err = await registry[kind]
      .execute(db, input({} as never))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProposalNotImplementedError);
    expect((err as Error).message).toContain(kind);
    expect((err as Error).message).toContain('#81');
  }
});

test('no controller imports the executors — the engine gate cannot be reached around', () => {
  // The other half (the engine keeping its registry token out of public
  // providers) is S1's; this half pins that no HTTP surface imports the
  // proposals directory today.
  const SRC = fileURLToPath(new URL('../..', import.meta.url));
  const controllers: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.controller.ts')) controllers.push(p);
    }
  })(SRC);
  expect(controllers.length).toBeGreaterThan(0); // the assertion must be able to fail
  for (const file of controllers) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/validation-dedupe\/proposals/);
  }
});

// ---- document.route --------------------------------------------------------

test('route assigns the business and inbox, keeps the practice anchor, and defers dedupe', async () => {
  const { db, updates, events } = harness([doc('doc_1')]);
  const result = await routeDocumentExecutor.execute(db, input({ documentId: 'doc_1', inbox: 'COSTS', toBusinessId: 'biz_1' }));

  expect(updates[0]?.data).toEqual({ inbox: 'COSTS', businessId: 'biz_1' }); // practiceId untouched
  expect(events.map((e) => `${e['stage']}:${e['outcome']}`)).toEqual(['route:routed', 'dedupe:deferred']);
  expect(result.followUps).toEqual([{ kind: 'dedupe', documentId: 'doc_1', businessId: 'biz_1', practiceId: 'prac_1' }]);
  expect(result.alreadyApplied).toBe(false);
});

test('route is idempotent: the same proposal replayed changes nothing and defers nothing', async () => {
  const { db, updates, events } = harness([doc('doc_1', { businessId: 'biz_1', inbox: 'COSTS' })]);
  const result = await routeDocumentExecutor.execute(db, input({ documentId: 'doc_1', inbox: 'COSTS', toBusinessId: 'biz_1' }));
  expect(result.alreadyApplied).toBe(true);
  expect(result.followUps).toEqual([]);
  expect(updates).toHaveLength(0);
  expect(events).toHaveLength(0);
});

test('route refuses: UNROUTED target, unreachable business, unreachable document, unrouted with no business', async () => {
  const { db } = harness([doc('doc_1'), doc('doc_routed', { businessId: 'biz_1', inbox: 'COSTS' })]);
  await expect(routeDocumentExecutor.execute(db, input({ documentId: 'doc_1', inbox: 'UNROUTED' }))).rejects.toThrow(
    ProposalExecutionRefused,
  );
  await expect(
    routeDocumentExecutor.execute(db, input({ documentId: 'doc_1', inbox: 'COSTS', toBusinessId: 'biz_other' })),
  ).rejects.toThrow('no reachable business');
  await expect(
    routeDocumentExecutor.execute(db, input({ documentId: 'doc_missing', inbox: 'COSTS', toBusinessId: 'biz_1' })),
  ).rejects.toThrow('no document');
  await expect(routeDocumentExecutor.execute(db, input({ documentId: 'doc_1', inbox: 'COSTS' }))).rejects.toThrow(
    'needs a business',
  );
  // Moving a routed document is move-business, not route.
  await expect(
    routeDocumentExecutor.execute(db, input({ documentId: 'doc_routed', inbox: 'COSTS', toBusinessId: 'biz_2' })),
  ).rejects.toThrow('move-business');
});

test('an inbox-only route on a routed document changes the inbox and never re-dedupes', async () => {
  const { db, updates, events } = harness([doc('doc_1', { businessId: 'biz_1', inbox: 'COSTS' })]);
  const result = await routeDocumentExecutor.execute(db, input({ documentId: 'doc_1', inbox: 'SALES' }));
  expect(updates[0]?.data).toEqual({ inbox: 'SALES' });
  expect(events.map((e) => e['outcome'])).toEqual(['inbox-changed']);
  expect(result.followUps).toEqual([]);
});

test('teachRouterForSender is recorded as a deferred seam, never dropped and never built here', async () => {
  const { db, events } = harness([doc('doc_1')]);
  await routeDocumentExecutor.execute(
    db,
    input({ documentId: 'doc_1', inbox: 'COSTS', toBusinessId: 'biz_1', teachRouterForSender: true }),
  );
  expect((events[0]?.['detail'] as Record<string, unknown>)['teachRouterDeferred']).toBe(true);
});

// ---- document.archive ------------------------------------------------------

test('archive drives the state machine per document and is idempotent across the batch', async () => {
  const { db, events } = harness([
    doc('doc_a', { state: 'READY' }),
    doc('doc_b', { state: 'ARCHIVED', archivedAt: new Date() }),
  ]);
  const result = await archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a', 'doc_b'], archived: true }));

  expect(result.alreadyApplied).toBe(false); // one applied, one skipped
  expect(result.detail).toMatchObject({ applied: 1, skippedAlreadyInState: 1 });
  expect(events.filter((e) => e['outcome'] === 'ARCHIVED')).toHaveLength(1); // no event for the no-op

  const replay = await archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a', 'doc_b'], archived: true }));
  expect(replay.alreadyApplied).toBe(true);
});

test('archive refuses a batch containing an unreachable document — all or nothing', async () => {
  const { db } = harness([doc('doc_a', { state: 'READY' })]);
  await expect(
    archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a', 'doc_ghost'], archived: true })),
  ).rejects.toThrow('not reachable');
});

test('unarchive restores the pre-archive state from the event log', async () => {
  const { db, map } = harness([doc('doc_a', { state: 'PUBLISHED' })]);
  await archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a'], archived: true }));
  expect(map.get('doc_a')?.state).toBe('ARCHIVED');

  await archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a'], archived: false }));
  expect(map.get('doc_a')?.state).toBe('PUBLISHED'); // from the archive event's detail.from
});

test('clearPublishingData demotes a PUBLISHED restore to readiness, recording the deferred clear', async () => {
  const { db, map, events } = harness([
    doc('doc_a', { state: 'PUBLISHED', totalPence: 100, supplierName: 'Bidfood', categoryCode: 'COGS' }),
  ]);
  await archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a'], archived: true }));
  await archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a'], archived: false, clearPublishingData: true }));

  expect(map.get('doc_a')?.state).toBe('READY'); // fields complete → READY, not PUBLISHED
  const restore = events.at(-1) as Record<string, unknown>;
  expect((restore['detail'] as Record<string, unknown>)['publishingDataClearDeferred']).toBe(true);
});

test('a restored failure carries its recorded reason back through the machine', async () => {
  const { db, map } = harness([
    doc('doc_a', { state: 'FAILED', failureCode: 'NT-ING-004', failureMessage: 'Rejected by sanitisation.' }),
  ]);
  await archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a'], archived: true }));
  expect(map.get('doc_a')?.failureCode).toBe('NT-ING-004'); // the archive keeps the reason
  await archiveDocumentExecutor.execute(db, input({ documentIds: ['doc_a'], archived: false }));
  expect(map.get('doc_a')?.state).toBe('FAILED');
});
