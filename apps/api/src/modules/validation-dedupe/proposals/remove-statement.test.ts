import { expect, test } from 'vitest';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import {
  type BankRemoveStatementPayload,
  computeRemoveStatementPayload,
  MAX_REMOVE_STATEMENT_BATCH,
  removeStatementExecutor,
} from './remove-statement.js';

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface StatementRow {
  id: string;
  businessId: string;
  documentId: string | null;
  rowCount: number | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}
interface TxnRow {
  id: string;
  importBatchId: string | null;
  matchState: 'UNMATCHED' | 'SUGGESTED' | 'CONFIRMED' | 'EXCLUDED';
}
interface MatchRow {
  id: string;
  transactionId: string;
  state: 'UNMATCHED' | 'SUGGESTED' | 'CONFIRMED' | 'EXCLUDED';
}
interface ChaseRow {
  id: string;
  businessId: string;
  state: string;
  transactionId: string | null;
  itemRefs: unknown;
}
interface EventRow {
  documentId: string;
  stage: string;
  outcome: string;
  detail: Record<string, unknown>;
}

/**
 * A recording fake, the confirm-match harness shape: assertions are on the
 * writes that reach the database, and RLS is modelled by simply not putting a
 * row in the map — an invisible record and an absent one are the same thing to
 * an executor, which is the point.
 */
function harness(
  options: {
    statements?: StatementRow[];
    txns?: TxnRow[];
    matches?: MatchRow[];
    chases?: ChaseRow[];
    documents?: { id: string; originalFilename: string }[];
    events?: EventRow[];
  } = {},
) {
  const statements = new Map(
    (
      options.statements ?? [
        {
          id: 'st_1',
          businessId: 'biz_1',
          documentId: 'doc_1',
          rowCount: 2,
          periodStart: new Date('2026-07-01T00:00:00.000Z'),
          periodEnd: new Date('2026-07-31T00:00:00.000Z'),
        },
      ]
    ).map((s) => [s.id, s]),
  );
  const txns =
    options.txns ??
    ([
      { id: 'txn_1', importBatchId: 'st_1', matchState: 'UNMATCHED' },
      { id: 'txn_2', importBatchId: 'st_1', matchState: 'UNMATCHED' },
    ] as TxnRow[]);
  const matches = options.matches ?? [];
  const chases = options.chases ?? [];
  const documents = options.documents ?? [{ id: 'doc_1', originalFilename: 'july.csv' }];
  const events: EventRow[] = [...(options.events ?? [])];

  const txnDeletes: Record<string, unknown>[] = [];
  const statementDeletes: Record<string, unknown>[] = [];
  const eventCreates: EventRow[] = [];

  const db = {
    statement: {
      findUnique: async ({ where }: { where: { id: string } }) => statements.get(where.id) ?? null,
      deleteMany: async ({ where }: { where: { id: string } }) => {
        statementDeletes.push(where);
        const existed = statements.delete(where.id);
        return { count: existed ? 1 : 0 };
      },
    },
    bankTransaction: {
      findMany: async ({ where }: { where: { importBatchId: string } }) =>
        txns.filter((t) => t.importBatchId === where.importBatchId),
      deleteMany: async ({ where }: { where: { importBatchId: string } }) => {
        txnDeletes.push(where);
        return { count: txns.filter((t) => t.importBatchId === where.importBatchId).length };
      },
    },
    match: {
      findMany: async ({ where }: { where: { transactionId: { in: string[] }; state: string } }) =>
        matches.filter((m) => where.transactionId.in.includes(m.transactionId) && m.state === where.state),
    },
    chase: {
      findMany: async ({ where }: { where: { businessId: string; state: { in: string[] } } }) =>
        chases.filter((c) => c.businessId === where.businessId && where.state.in.includes(c.state)),
    },
    document: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        documents.filter((d) => where.id.in.includes(d.id)),
    },
    documentEvent: {
      findFirst: async ({
        where,
      }: {
        where: { documentId: string; stage: string; outcome: string; detail: { path: string[]; equals: string } };
      }) => {
        const all = [...events, ...eventCreates];
        const hit = all.find(
          (e) =>
            e.documentId === where.documentId &&
            e.stage === where.stage &&
            e.outcome === where.outcome &&
            e.detail[where.detail.path[0] ?? ''] === where.detail.equals,
        );
        return hit === undefined ? null : { id: 'evt_hit' };
      },
      create: async ({ data }: { data: EventRow }) => {
        eventCreates.push(data);
        return {};
      },
    },
  } as unknown as ScopedClient;

  return { db, txnDeletes, statementDeletes, eventCreates };
}

const input = (payload: BankRemoveStatementPayload) => ({
  proposalId: 'prop_1',
  payload,
  ctx: CTX,
  traceId: 'trace-rm',
});

const refusalOf = async (work: Promise<unknown>): Promise<ProposalExecutionRefused> => {
  const outcome = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(outcome).toBeInstanceOf(ProposalExecutionRefused);
  return outcome as ProposalExecutionRefused;
};

// ---------------------------------------------------------------------------
// computeRemoveStatementPayload — the creation-time half
// ---------------------------------------------------------------------------

test('the preview is the SERVER’s: provable counts, file name, period, total', async () => {
  const h = harness();

  const payload = await computeRemoveStatementPayload(h.db, ['st_1']);

  expect(payload).toEqual({
    statementIds: ['st_1'],
    preview: {
      statements: [
        {
          statementId: 'st_1',
          documentId: 'doc_1',
          fileName: 'july.csv',
          periodStart: '2026-07-01',
          periodEnd: '2026-07-31',
          transactionCount: 2,
          matchedCount: 0,
          openChaseCount: 0,
        },
      ],
      totalTransactions: 2,
    },
  });
});

test('an unreachable statement refuses without confirming it exists', async () => {
  const h = harness();
  const e = await refusalOf(computeRemoveStatementPayload(h.db, ['st_other']));
  expect(e.message).toContain('no statement with that id');
});

test('a batch spanning two clients refuses — one approval must not destroy two workspaces’ bank data', async () => {
  const h = harness({
    statements: [
      { id: 'st_1', businessId: 'biz_1', documentId: 'doc_1', rowCount: 0, periodStart: null, periodEnd: null },
      { id: 'st_2', businessId: 'biz_2', documentId: 'doc_2', rowCount: 0, periodStart: null, periodEnd: null },
    ],
    txns: [],
    documents: [
      { id: 'doc_1', originalFilename: 'a.csv' },
      { id: 'doc_2', originalFilename: 'b.csv' },
    ],
  });
  const e = await refusalOf(computeRemoveStatementPayload(h.db, ['st_1', 'st_2']));
  expect(e.message).toContain('cannot cross a workspace');
});

test('rows with no provenance stamp refuse by name — deleting by guess removes another statement’s lines', async () => {
  // A pre-stamp import: the statement records 2 rows, none carry its id.
  const h = harness({ txns: [] });
  const e = await refusalOf(computeRemoveStatementPayload(h.db, ['st_1']));
  expect(e.message).toContain('records 2 imported line(s) but 0 are provably linked');
});

test('a CONFIRMED match blocks removal and the refusal carries the count', async () => {
  const h = harness({
    txns: [
      { id: 'txn_1', importBatchId: 'st_1', matchState: 'CONFIRMED' },
      { id: 'txn_2', importBatchId: 'st_1', matchState: 'UNMATCHED' },
    ],
    matches: [{ id: 'mat_1', transactionId: 'txn_1', state: 'CONFIRMED' }],
  });
  const e = await refusalOf(computeRemoveStatementPayload(h.db, ['st_1']));
  expect(e.message).toContain('1 line(s) on this statement are matched');
  expect(e.message).toContain('bank.unmatch');
});

test('a SUGGESTED match does not block — a machine’s question is not an assertion', async () => {
  const h = harness({
    matches: [{ id: 'mat_1', transactionId: 'txn_1', state: 'SUGGESTED' }],
  });
  const payload = await computeRemoveStatementPayload(h.db, ['st_1']);
  expect(payload.preview.statements[0]?.transactionCount).toBe(2);
});

test('an OPEN chase blocks removal, found through itemRefs — a grouped chase names only its first line in the column', async () => {
  const h = harness({
    chases: [
      // The column points at some other line; txn_2 is only inside itemRefs.
      { id: 'chs_1', businessId: 'biz_1', state: 'SENT', transactionId: 'txn_zz', itemRefs: ['txn_zz', 'txn_2'] },
    ],
  });
  const e = await refusalOf(computeRemoveStatementPayload(h.db, ['st_1']));
  expect(e.message).toContain('open chase');
});

test('a CLOSED chase does not block — its record survives the line (SetNull)', async () => {
  const h = harness({
    chases: [
      { id: 'chs_1', businessId: 'biz_1', state: 'CLOSED_RECEIVED', transactionId: 'txn_1', itemRefs: ['txn_1'] },
    ],
  });
  const payload = await computeRemoveStatementPayload(h.db, ['st_1']);
  expect(payload.preview.totalTransactions).toBe(2);
});

test('a statement with no source document refuses — nothing could re-import it', async () => {
  const h = harness({
    statements: [{ id: 'st_1', businessId: 'biz_1', documentId: null, rowCount: 0, periodStart: null, periodEnd: null }],
    txns: [],
  });
  const e = await refusalOf(computeRemoveStatementPayload(h.db, ['st_1']));
  expect(e.message).toContain('no source document');
});

test('the batch is bounded and duplicate ids collapse to one entry', async () => {
  const h = harness();

  const tooMany = Array.from({ length: MAX_REMOVE_STATEMENT_BATCH + 1 }, (_, i) => `st_${i}`);
  await refusalOf(computeRemoveStatementPayload(h.db, tooMany));
  await refusalOf(computeRemoveStatementPayload(h.db, []));

  const payload = await computeRemoveStatementPayload(h.db, ['st_1', 'st_1']);
  expect(payload.statementIds).toEqual(['st_1']);
  expect(payload.preview.statements).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// removeStatementExecutor — the effect
// ---------------------------------------------------------------------------

const approvedPayload = (over: Partial<BankRemoveStatementPayload> = {}): BankRemoveStatementPayload => ({
  statementIds: ['st_1'],
  preview: {
    statements: [
      {
        statementId: 'st_1',
        documentId: 'doc_1',
        fileName: 'july.csv',
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        transactionCount: 2,
        matchedCount: 0,
        openChaseCount: 0,
      },
    ],
    totalTransactions: 2,
  },
  ...over,
});

test('removal deletes the provable set AND the statement row, and stamps the source document', async () => {
  const h = harness();

  const result = await removeStatementExecutor.execute(h.db, input(approvedPayload()));

  expect(h.txnDeletes).toEqual([{ importBatchId: 'st_1' }]);
  expect(h.statementDeletes).toEqual([{ id: 'st_1' }]);
  // The event is the audit surface for the document AND the replay marker.
  expect(h.eventCreates).toEqual([
    {
      documentId: 'doc_1',
      stage: 'statement',
      outcome: 'removed',
      traceId: 'trace-rm',
      detail: { proposalId: 'prop_1', statementId: 'st_1', transactionsRemoved: 2 },
    },
  ]);
  expect(result.alreadyApplied).toBe(false);
  expect(result.changed).toEqual([{ entity: 'document', id: 'doc_1' }]);
  expect(result.detail).toEqual({ statementsRemoved: 1, transactionsRemoved: 2 });
});

test('facts that moved between review and approve refuse — NT-PRP-004 cannot see this drift', async () => {
  // The reviewer approved 2 lines; a third arrived under the same batch id.
  const h = harness({
    txns: [
      { id: 'txn_1', importBatchId: 'st_1', matchState: 'UNMATCHED' },
      { id: 'txn_2', importBatchId: 'st_1', matchState: 'UNMATCHED' },
      { id: 'txn_3', importBatchId: 'st_1', matchState: 'UNMATCHED' },
    ],
    statements: [
      { id: 'st_1', businessId: 'biz_1', documentId: 'doc_1', rowCount: 3, periodStart: null, periodEnd: null },
    ],
  });
  const e = await refusalOf(removeStatementExecutor.execute(h.db, input(approvedPayload())));
  expect(e.message).toContain('changed since the removal was reviewed');
  expect(h.txnDeletes).toEqual([]);
  expect(h.statementDeletes).toEqual([]);
});

test('a match confirmed after review refuses at approve, before any delete', async () => {
  const h = harness({
    matches: [{ id: 'mat_1', transactionId: 'txn_1', state: 'CONFIRMED' }],
  });
  const e = await refusalOf(removeStatementExecutor.execute(h.db, input(approvedPayload())));
  expect(e.message).toContain('matched to documents');
  expect(h.txnDeletes).toEqual([]);
});

test('idempotent replay: the statement is gone and the marker names this proposal — applied, nothing deleted twice', async () => {
  const h = harness({
    statements: [],
    events: [
      {
        documentId: 'doc_1',
        stage: 'statement',
        outcome: 'removed',
        detail: { proposalId: 'prop_1', statementId: 'st_1', transactionsRemoved: 2 },
      },
    ],
  });

  const result = await removeStatementExecutor.execute(h.db, input(approvedPayload()));

  expect(result.alreadyApplied).toBe(true);
  expect(result.changed).toEqual([{ entity: 'document', id: 'doc_1' }]);
  expect(h.txnDeletes).toEqual([]);
  expect(h.statementDeletes).toEqual([]);
  expect(h.eventCreates).toEqual([]);
});

test('gone with NO marker refuses — an absent row and an invisible one are the same answer', async () => {
  const h = harness({ statements: [] });
  const e = await refusalOf(removeStatementExecutor.execute(h.db, input(approvedPayload())));
  expect(e.message).toContain('no statement with that id');
});
