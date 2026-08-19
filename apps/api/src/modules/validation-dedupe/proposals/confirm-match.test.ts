import type { BankConfirmMatchPayload } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { confirmMatchExecutor } from './confirm-match.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface TxnRow {
  id: string;
  businessId: string;
  matchState: 'UNMATCHED' | 'SUGGESTED' | 'CONFIRMED' | 'EXCLUDED';
}
interface DocRow {
  id: string;
  businessId: string;
  state: string;
}
interface MatchRow {
  id: string;
  documentId: string;
  transactionId: string;
  state: 'UNMATCHED' | 'SUGGESTED' | 'CONFIRMED' | 'EXCLUDED';
}

/**
 * A recording fake — the assertions are on the writes that reach the database.
 * RLS is modelled by simply not putting a row in the map: an invisible record
 * and an absent one are the same thing to an executor, which is the point.
 */
function harness(options: { txns?: TxnRow[]; docs?: DocRow[]; matches?: MatchRow[] } = {}) {
  const txns = new Map((options.txns ?? [{ id: 'txn_1', businessId: 'biz_1', matchState: 'UNMATCHED' }]).map((t) => [t.id, t]));
  const docs = new Map((options.docs ?? [{ id: 'doc_1', businessId: 'biz_1', state: 'READY' }]).map((d) => [d.id, d]));
  const matches = options.matches ?? [];

  const created: Record<string, unknown>[] = [];
  const updated: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const txnUpdates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const events: Record<string, unknown>[] = [];

  const db = {
    bankTransaction: {
      findUnique: async ({ where }: { where: { id: string } }) => txns.get(where.id) ?? null,
      update: async (args: { where: { where?: unknown; id: string }; data: Record<string, unknown> }) => {
        txnUpdates.push(args as never);
        return {};
      },
    },
    document: {
      findUnique: async ({ where }: { where: { id: string } }) => docs.get(where.id) ?? null,
    },
    match: {
      findMany: async ({ where }: { where: { transactionId: string } }) =>
        matches.filter((m) => m.transactionId === where.transactionId),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'mat_new' };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updated.push(args);
        return { id: args.where.id };
      },
    },
    documentEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return {};
      },
    },
  } as unknown as ScopedClient;

  return { db, created, updated, txnUpdates, events };
}

const payload = (over: Partial<BankConfirmMatchPayload> = {}): BankConfirmMatchPayload => ({
  transactionId: 'txn_1',
  documentId: 'doc_1',
  matchKind: 'EXACT',
  ...over,
});

const input = (p: BankConfirmMatchPayload) => ({ proposalId: 'prop_1', payload: p, ctx: CTX, traceId: 'trace-s11' });

const refusal = async (db: ScopedClient, p: BankConfirmMatchPayload): Promise<unknown> =>
  confirmMatchExecutor.execute(db, input(p)).then(
    () => null,
    (e: unknown) => e,
  );

test('confirming writes the match row AND flips match_state — both, or the client gets chased for a filed receipt', async () => {
  const h = harness();

  const result = await confirmMatchExecutor.execute(h.db, input(payload({ confidence: 0.94 })));

  expect(h.created).toEqual([
    {
      businessId: 'biz_1',
      documentId: 'doc_1',
      transactionId: 'txn_1',
      kind: 'EXACT',
      confidence: 0.94,
      state: 'CONFIRMED',
      matchedByUserId: 'usr_1',
      matchedBy: 'human',
    },
  ]);
  // The half that makes the Bank screen and the chase list agree: chase
  // detection reads `match_state`, so a match row alone would leave the line
  // in the unmatched set.
  expect(h.txnUpdates).toEqual([{ where: { id: 'txn_1' }, data: { matchState: 'CONFIRMED' } }]);
  expect(result.alreadyApplied).toBe(false);
  expect(result.changed).toEqual([{ entity: 'document', id: 'doc_1' }]);
});

test('an existing SUGGESTED row is PROMOTED, not duplicated', async () => {
  const h = harness({
    txns: [{ id: 'txn_1', businessId: 'biz_1', matchState: 'SUGGESTED' }],
    matches: [{ id: 'mat_1', documentId: 'doc_1', transactionId: 'txn_1', state: 'SUGGESTED' }],
  });

  await confirmMatchExecutor.execute(h.db, input(payload({ matchKind: 'PROBABILISTIC', confidence: 0.78 })));

  // `matches` has no unique constraint on (document_id, transaction_id), so a
  // blind create would leave two live rows for one pairing and the Matches
  // list would show the same match twice with no way to tell which is which.
  expect(h.created).toEqual([]);
  expect(h.updated).toHaveLength(1);
  expect(h.updated[0]?.where).toEqual({ id: 'mat_1' });
  expect(h.updated[0]?.data).toEqual({
    kind: 'PROBABILISTIC',
    confidence: 0.78,
    state: 'CONFIRMED',
    matchedByUserId: 'usr_1',
    matchedBy: 'human',
    // A row broken once and confirmed again must not keep the timestamp of
    // when it was broken.
    unmatchedAt: null,
  });
  expect(h.txnUpdates).toHaveLength(1);
});

test('a replay is a success that writes nothing', async () => {
  const h = harness({
    txns: [{ id: 'txn_1', businessId: 'biz_1', matchState: 'CONFIRMED' }],
    matches: [{ id: 'mat_1', documentId: 'doc_1', transactionId: 'txn_1', state: 'CONFIRMED' }],
  });

  const result = await confirmMatchExecutor.execute(h.db, input(payload()));

  expect(result.alreadyApplied).toBe(true);
  expect(h.created).toEqual([]);
  expect(h.updated).toEqual([]);
  expect(h.txnUpdates).toEqual([]);
  expect(h.events).toEqual([]);
});

test('a half-applied match is completed, not skipped', async () => {
  // The match row landed and the transaction update did not — a crash between
  // two writes that a `matchState === CONFIRMED` early return would leave
  // permanently broken, invisible to both screens.
  const h = harness({
    txns: [{ id: 'txn_1', businessId: 'biz_1', matchState: 'UNMATCHED' }],
    matches: [{ id: 'mat_1', documentId: 'doc_1', transactionId: 'txn_1', state: 'CONFIRMED' }],
  });

  const result = await confirmMatchExecutor.execute(h.db, input(payload()));

  expect(result.alreadyApplied).toBe(false);
  expect(h.txnUpdates).toEqual([{ where: { id: 'txn_1' }, data: { matchState: 'CONFIRMED' } }]);
});

test('an invisible transaction and an absent one are the same refusal', async () => {
  const h = harness({ txns: [] });

  const err = await refusal(h.db, payload());

  expect(err).toBeInstanceOf(ProposalExecutionRefused);
  expect((err as Error).message).toContain('no bank transaction with that id');
  // The refusal must not confirm existence, so it never echoes the id back.
  expect((err as Error).message).not.toContain('txn_1');
  expect(h.txnUpdates).toEqual([]);
});

test('an invisible document is the same refusal, and nothing is written first', async () => {
  const h = harness({ docs: [] });

  const err = await refusal(h.db, payload());

  expect(err).toBeInstanceOf(ProposalExecutionRefused);
  expect((err as Error).message).toContain('no document with that id');
  expect(h.created).toEqual([]);
});

test('a match may not cross a workspace, even when the approver can see both rows', async () => {
  // A practice-scoped approver sees every workspace it administers, so RLS
  // alone would let one client's receipt become another client's evidence —
  // and `matches.business_id` can only hold one of the two.
  const h = harness({
    txns: [{ id: 'txn_1', businessId: 'biz_1', matchState: 'UNMATCHED' }],
    docs: [{ id: 'doc_1', businessId: 'biz_2', state: 'READY' }],
  });

  const err = await refusal(h.db, payload());

  expect(err).toBeInstanceOf(ProposalExecutionRefused);
  expect((err as Error).message).toContain('different clients');
  expect(h.created).toEqual([]);
  expect(h.txnUpdates).toEqual([]);
});

test.each(['ARCHIVED', 'REJECTED'])('a %s document is not evidence for anything', async (state) => {
  const h = harness({ docs: [{ id: 'doc_1', businessId: 'biz_1', state }] });

  const err = await refusal(h.db, payload());

  expect(err).toBeInstanceOf(ProposalExecutionRefused);
  expect((err as Error).message).toContain(state.toLowerCase());
  expect(h.txnUpdates).toEqual([]);
});

test('a transaction already confirmed against another document is refused, not overwritten', async () => {
  const h = harness({
    txns: [{ id: 'txn_1', businessId: 'biz_1', matchState: 'CONFIRMED' }],
    docs: [
      { id: 'doc_1', businessId: 'biz_1', state: 'READY' },
      { id: 'doc_9', businessId: 'biz_1', state: 'READY' },
    ],
    matches: [{ id: 'mat_1', documentId: 'doc_9', transactionId: 'txn_1', state: 'CONFIRMED' }],
  });

  const err = await refusal(h.db, payload());

  expect(err).toBeInstanceOf(ProposalExecutionRefused);
  // There is no `bank.unmatch` kind in the contract's ProposalKind enum, so
  // breaking a confirmed match has no approved path — quietly overwriting one
  // would be that missing path's bypass.
  expect((err as Error).message).toContain('already matched to another document');
  expect(h.created).toEqual([]);
  expect(h.updated).toEqual([]);
});

test('confidence is recorded and gates nothing', async () => {
  // A score is not an authorisation (Governance §9.5) — the human's approval
  // is the decision, which is what makes a display-tier suggester acceptable.
  const low = harness();
  await confirmMatchExecutor.execute(low.db, input(payload({ confidence: 0.01 })));
  expect(low.created[0]).toMatchObject({ confidence: 0.01, state: 'CONFIRMED' });

  const none = harness();
  await confirmMatchExecutor.execute(none.db, input(payload()));
  expect(none.created[0]).toMatchObject({ confidence: null });
});

test('the processing log records the link, with the proposal that authorised it', async () => {
  const h = harness();

  await confirmMatchExecutor.execute(h.db, input(payload({ confidence: 0.5 })));

  expect(h.events).toEqual([
    {
      documentId: 'doc_1',
      stage: 'match',
      outcome: 'confirmed',
      traceId: 'trace-s11',
      detail: {
        proposalId: 'prop_1',
        matchId: 'mat_new',
        transactionId: 'txn_1',
        matchKind: 'EXACT',
        promoted: false,
        confidence: 0.5,
      },
    },
  ]);
});

test('no amount is ever read or written — the suggester’s float pounds stay display-tier', async () => {
  const h = harness();

  await confirmMatchExecutor.execute(h.db, input(payload()));

  // The executor selects no money column and writes none, so there is no
  // server-side tolerance for the client-side engine's arithmetic to leak
  // into. Pinned as a negative because the failure mode — a plausible
  // `amountPence` comparison creeping in later — reads as a feature.
  const written = JSON.stringify([...h.created, ...h.updated, ...h.txnUpdates, ...h.events]);
  expect(written).not.toContain('amountPence');
  expect(written).not.toContain('Pence');
});
