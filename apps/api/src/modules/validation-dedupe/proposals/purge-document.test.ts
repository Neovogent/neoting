import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { purgeDocumentExecutor } from './purge-document.js';

/**
 * `document.purge` against a recording fake.
 *
 * The properties that matter here are all NEGATIVES — what must not be
 * destroyed — so every test asserts that `deleteMany` was never called, not
 * only that an error was thrown. A refusal that threw after deleting would pass
 * a status-code assertion and would still have destroyed the row.
 *
 * The refusal is D43: *every exported transaction carries a resolvable link to
 * its source document*. Purging one turns a working capability URL inside an
 * accountant's VT file into a permanent 410 that nothing in this product would
 * ever surface.
 */

const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const DELETED_AT = new Date('2026-09-01T12:00:00.000Z');

interface Row {
  id: string;
  state: string;
  deletedAt: Date | null;
  links: number;
  publishes: number;
}

/** A document already in Trash, unpublished, with no export link — the purgeable case. */
function purgeable(over: Partial<Row> = {}): Row {
  return { id: 'doc_1', state: 'READY', deletedAt: DELETED_AT, links: 0, publishes: 0, ...over };
}

function harness(rows: Row[], statements = 0, supplierStatements = 0) {
  const calls: { findMany: unknown[]; deleteMany: unknown[] } = { findMany: [], deleteMany: [] };
  const db = {
    statement: { count: async () => statements },
    supplierStatement: { count: async () => supplierStatements },
    document: {
      findMany: async (args: unknown) => {
        calls.findMany.push(args);
        return rows.map((row) => ({
          id: row.id,
          state: row.state,
          deletedAt: row.deletedAt,
          _count: { links: row.links, publishes: row.publishes },
        }));
      },
      deleteMany: async (args: unknown) => {
        calls.deleteMany.push(args);
        return { count: rows.length };
      },
    },
  } as unknown as ScopedClient;
  return { calls, db };
}

function run(db: ScopedClient, documentIds: string[], reason?: string) {
  return purgeDocumentExecutor.execute(db, {
    proposalId: 'prp_1',
    payload: { documentIds, ...(reason === undefined ? {} : { reason }) },
    ctx: CTX,
    traceId: 'trace_1',
  });
}

test('a document in Trash, unpublished and with no export link, is purged by explicit id list', async () => {
  const { calls, db } = harness([purgeable()]);
  const result = await run(db, ['doc_1'], 'Duplicate scan');

  // ⚠ `deleteMany` names the exact ids and nothing else — never a filter, never
  // a prefix. The statement can destroy nothing the per-document checks above
  // it did not individually clear.
  expect(calls.deleteMany[0]).toEqual({ where: { id: { in: ['doc_1'] } } });
  expect(result.changed).toEqual([{ entity: 'document', id: 'doc_1' }]);
  // Said out loud in the stored outcome, not only on the review card: an
  // operator reading this row later must not conclude the bytes are gone.
  expect(result.detail).toMatchObject({ storedObjectsRetained: true, purged: 1 });
});

test('REFUSES a PUBLISHED document, and destroys nothing — NT-DOC-002', async () => {
  const { calls, db } = harness([purgeable({ state: 'PUBLISHED' })]);
  const error = await run(db, ['doc_1']).catch((e: ProposalExecutionRefused) => e);

  expect(error).toBeInstanceOf(ProposalExecutionRefused);
  expect((error as ProposalExecutionRefused).code).toBe('NT-DOC-002');
  expect(calls.deleteMany).toHaveLength(0);
});

test('REFUSES a document with a publishes row even when `state` has moved on', async () => {
  // ⚠ The reason the check reads ROWS and not the state column. Unarchiving a
  // published document demotes it to READY or TO_REVIEW, and publish-batch's
  // retry edge takes a REJECTED one through PROCESSING — so a document that has
  // been in an export can be sitting in any of five states by the time somebody
  // purges it. `state` alone would miss every one of those.
  const { calls, db } = harness([purgeable({ state: 'READY', publishes: 1 })]);
  await expect(run(db, ['doc_1'])).rejects.toBeInstanceOf(ProposalExecutionRefused);
  expect(calls.deleteMany).toHaveLength(0);
});

test('REFUSES a document with a document_links row — the D43 code is the thing that actually breaks', async () => {
  const { calls, db } = harness([purgeable({ links: 1 })]);
  const error = await run(db, ['doc_1']).catch((e: ProposalExecutionRefused) => e);

  expect((error as ProposalExecutionRefused).code).toBe('NT-DOC-002');
  expect(calls.deleteMany).toHaveLength(0);
  // Refused, never CASCADED. Revoking the links first and purging anyway would
  // be this executor quietly performing a `document.revoke-link` that nobody
  // reviewed, on rows sitting in somebody else's ledger.
  expect(JSON.stringify(calls)).not.toContain('revoke');
});

test('one exported document in a batch refuses the WHOLE batch — the successful half could not be re-run', async () => {
  const { calls, db } = harness([purgeable({ id: 'doc_1' }), purgeable({ id: 'doc_2', links: 1 })]);
  await expect(run(db, ['doc_1', 'doc_2'])).rejects.toBeInstanceOf(ProposalExecutionRefused);
  expect(calls.deleteMany).toHaveLength(0);
});

test('REFUSES a document that is not in Trash — deleting first is the reversible step', async () => {
  // Trash is the undo. Skipping it would make a single approval the whole
  // distance between a live document and no document.
  const { calls, db } = harness([purgeable({ deletedAt: null })]);
  const error = await run(db, ['doc_1']).catch((e: ProposalExecutionRefused) => e);

  expect(error).toBeInstanceOf(ProposalExecutionRefused);
  // NOT NT-DOC-002: this is not the export protection, it is the two-step, and
  // a client branching on the export code must not be told that is what
  // happened. It falls to the engine's generic NT-PRP-006.
  expect((error as ProposalExecutionRefused).code).toBeUndefined();
  expect(calls.deleteMany).toHaveLength(0);
});

test('an unreachable id refuses the batch, and RLS is what made it unreachable', async () => {
  // Two named, one visible: an id another practice owns is removed by RLS
  // before Prisma sees it, so it is indistinguishable from an id that never
  // existed — and both must refuse rather than silently purge the rest.
  const { calls, db } = harness([purgeable({ id: 'doc_1' })]);
  await expect(run(db, ['doc_1', 'doc_elsewhere'])).rejects.toThrow('not reachable');
  expect(calls.deleteMany).toHaveLength(0);
});

test('the refusal message names no document id', async () => {
  // 404-never-403 applied to effects: the batch refused as a whole, and naming
  // which member caused it would answer a question about a document the caller
  // may not be entitled to ask.
  const { db } = harness([purgeable({ links: 1 })]);
  const error = await run(db, ['doc_1']).catch((e: ProposalExecutionRefused) => e);
  expect((error as ProposalExecutionRefused).message).not.toContain('doc_1');
});


test('REFUSES a document that a bank statement names as its source — the reference has NO foreign key', async () => {
  // ⚠ `statements.document_id` is a plain nullable column, so Postgres would
  // happily let a purge leave it dangling and nothing would notice. Under D40
  // manual statement upload is the ONLY bank input, which makes that reference
  // the sole answer to "which uploaded file produced these bank lines".
  const { calls, db } = harness([purgeable()], 1, 0);
  const error = await run(db, ['doc_1']).catch((e: ProposalExecutionRefused) => e);

  expect((error as ProposalExecutionRefused).code).toBe('NT-DOC-002');
  expect(calls.deleteMany).toHaveLength(0);
});

test('REFUSES a document a supplier statement names, for the same reason', async () => {
  const { calls, db } = harness([purgeable()], 0, 1);
  await expect(run(db, ['doc_1'])).rejects.toBeInstanceOf(ProposalExecutionRefused);
  expect(calls.deleteMany).toHaveLength(0);
});

test('no refusal message anywhere on this executor uses ledger-posting vocabulary (D42)', () => {
  // *Published* here means approved and RELEASED FOR EXPORT. Nothing is posted,
  // synced or sent anywhere, and a refusal a human reads must not imply it was.
  const source = readFileSync(new URL('./purge-document.ts', import.meta.url), 'utf8');
  for (const forbidden of [/\bposted\b/i, /\bposting to\b/i, /published to\b/i, /\bsynced\b/i]) {
    expect(source).not.toMatch(forbidden);
  }
  expect(source).toContain('released for export');
});
