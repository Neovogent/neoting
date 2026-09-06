import { expect, test } from 'vitest';

import { resolveDuplicateExecutor } from './resolve-duplicate.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import type { DuplicateResolvePayload } from '@neoting/contracts/model';

/**
 * `document.resolve-duplicate` (review item 49): the recording-fake harness —
 * the assertions are on the writes that reach the database, not on Prisma
 * working. The RLS-shaped facts (which documents are visible) are the fake's
 * inputs, the way the compose-chase-send tests drive theirs.
 */

interface DocRow {
  id: string;
  businessId: string | null;
  deletedAt: Date | null;
  state: string;
}

interface DupRow {
  id: string;
  verdict: string;
}

function harness(opts: { docs: DocRow[]; existingPair?: DupRow }) {
  const writes: { table: string; op: string; args: unknown }[] = [];
  const db = {
    document: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        opts.docs.filter((d) => where.id.in.includes(d.id)),
      updateMany: async (args: { where: { id: string; deletedAt: null } }) => {
        writes.push({ table: 'document', op: 'updateMany', args });
        const target = opts.docs.find((d) => d.id === args.where.id);
        return { count: target !== undefined && target.deletedAt === null ? 1 : 0 };
      },
    },
    duplicate: {
      findFirst: async () => opts.existingPair ?? null,
      update: async (args: unknown) => {
        writes.push({ table: 'duplicate', op: 'update', args });
        return {};
      },
      create: async (args: unknown) => {
        writes.push({ table: 'duplicate', op: 'create', args });
        return {};
      },
    },
    documentEvent: {
      create: async (args: unknown) => {
        writes.push({ table: 'documentEvent', op: 'create', args });
        return {};
      },
    },
  } as unknown as ScopedClient;
  return { db, writes };
}

const CTX = { actorId: 'usr_approver', practiceId: 'prc_1' } as unknown as ScopeContext;

const inputFor = (payload: DuplicateResolvePayload) => ({
  proposalId: 'prp_1',
  payload,
  ctx: CTX,
  traceId: 'trc_1',
});

const doc = (id: string, over: Partial<DocRow> = {}): DocRow => ({
  id,
  businessId: 'biz_1',
  deletedAt: null,
  state: 'TO_REVIEW',
  ...over,
});

test('different-documents on a client-derived pair CREATES the row with the accountant marker, never a detector score', async () => {
  const { db, writes } = harness({ docs: [doc('doc_keep'), doc('doc_copy')] });
  const result = await resolveDuplicateExecutor.execute(
    db,
    inputFor({ documentKeepId: 'doc_keep', documentCopyId: 'doc_copy', resolution: 'different-documents' }),
  );

  const create = writes.find((w) => w.table === 'duplicate' && w.op === 'create');
  const data = (create?.args as { data: Record<string, unknown> }).data;
  expect(data.verdict).toBe('CONFIRMED_DIFFERENT');
  expect(data.decidedByUserId).toBe('usr_approver');
  expect(data.score).toBe(0);
  expect(data.signals).toEqual({ resolvedBy: 'accountant' });
  // Nothing was trashed and no document row moved.
  expect(writes.some((w) => w.table === 'document')).toBe(false);
  expect(result.alreadyApplied).toBe(false);
  expect(result.detail?.copyMovedToTrash).toBe(false);
});

test('keep-both UPDATES the detector row to KEEP_BOTH rather than minting a second pair', async () => {
  const { db, writes } = harness({
    docs: [doc('doc_keep'), doc('doc_copy')],
    existingPair: { id: 'dup_1', verdict: 'PENDING' },
  });
  await resolveDuplicateExecutor.execute(
    db,
    inputFor({ documentKeepId: 'doc_keep', documentCopyId: 'doc_copy', resolution: 'keep-both' }),
  );

  expect(writes.some((w) => w.table === 'duplicate' && w.op === 'create')).toBe(false);
  const update = writes.find((w) => w.table === 'duplicate' && w.op === 'update');
  expect((update?.args as { data: { verdict: string } }).data.verdict).toBe('KEEP_BOTH');
});

test('delete-copy trashes the COPY (compare-and-swap on deletedAt: null) and writes the Trash log row', async () => {
  const { db, writes } = harness({ docs: [doc('doc_keep'), doc('doc_copy')] });
  const result = await resolveDuplicateExecutor.execute(
    db,
    inputFor({ documentKeepId: 'doc_keep', documentCopyId: 'doc_copy', resolution: 'delete-copy' }),
  );

  const trash = writes.find((w) => w.table === 'document');
  expect((trash?.args as { where: { id: string; deletedAt: null } }).where).toEqual({
    id: 'doc_copy',
    deletedAt: null,
  });
  // The same per-document log row the Trash endpoint writes — the timeline has
  // no gap where a resolution made a document vanish.
  const event = writes.find((w) => w.table === 'documentEvent');
  const eventData = (event?.args as { data: Record<string, unknown> }).data;
  expect(eventData.stage).toBe('delete');
  expect(eventData.outcome).toBe('DELETED');
  expect(result.detail?.copyMovedToTrash).toBe(true);
  expect(result.detail?.recoverable).toBe(true);
});

test('a replay — same verdict, copy already in Trash — is alreadyApplied with NO second write', async () => {
  const { db, writes } = harness({
    docs: [doc('doc_keep'), doc('doc_copy', { deletedAt: new Date('2026-09-01T00:00:00Z') })],
    existingPair: { id: 'dup_1', verdict: 'CONFIRMED_DUPLICATE' },
  });
  const result = await resolveDuplicateExecutor.execute(
    db,
    inputFor({ documentKeepId: 'doc_keep', documentCopyId: 'doc_copy', resolution: 'delete-copy' }),
  );

  expect(writes).toHaveLength(0);
  expect(result.alreadyApplied).toBe(true);
});

test('a later human decision SUPERSEDES an earlier verdict — re-ruling is not a replay', async () => {
  const { db, writes } = harness({
    docs: [doc('doc_keep'), doc('doc_copy')],
    existingPair: { id: 'dup_1', verdict: 'CONFIRMED_DIFFERENT' },
  });
  const result = await resolveDuplicateExecutor.execute(
    db,
    inputFor({ documentKeepId: 'doc_keep', documentCopyId: 'doc_copy', resolution: 'keep-both' }),
  );

  expect(writes.some((w) => w.table === 'duplicate' && w.op === 'update')).toBe(true);
  expect(result.alreadyApplied).toBe(false);
});

test.each([
  ['an unreachable document', { docs: [doc('doc_keep')] }],
  [
    'a pair spanning two clients',
    { docs: [doc('doc_keep'), doc('doc_copy', { businessId: 'biz_2' })] },
  ],
  [
    'a document with no business (unrouted)',
    { docs: [doc('doc_keep', { businessId: null }), doc('doc_copy', { businessId: null })] },
  ],
])('refuses %s', async (_name, opts) => {
  const { db } = harness(opts as { docs: DocRow[] });
  await expect(
    resolveDuplicateExecutor.execute(
      db,
      inputFor({ documentKeepId: 'doc_keep', documentCopyId: 'doc_copy', resolution: 'keep-both' }),
    ),
  ).rejects.toThrow(ProposalExecutionRefused);
});

test('refuses a "pair" of one document', async () => {
  const { db } = harness({ docs: [doc('doc_keep')] });
  await expect(
    resolveDuplicateExecutor.execute(
      db,
      inputFor({ documentKeepId: 'doc_keep', documentCopyId: 'doc_keep', resolution: 'keep-both' }),
    ),
  ).rejects.toThrow(/two different documents/);
});
