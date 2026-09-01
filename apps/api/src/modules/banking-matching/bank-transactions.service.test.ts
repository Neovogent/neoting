import { expect, test } from 'vitest';

import { listBankTransactionsQueryParams } from '@neoting/contracts/zod';
import type { BankTransaction as BankTransactionRow } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { BankTransactionsService } from './bank-transactions.service.js';

// `ScopeContext` is the schema's OUTPUT type, so the defaulted fields are
// required here even though a caller may omit them on the way in.
const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const NOW = new Date('2026-08-19T09:00:00.000Z');

const DEFAULTS = {
  businessId: 'biz_1',
  accountId: 'acc_1',
  providerTransactionId: 'tl_1',
  bookedAt: NOW,
  pendingAt: null,
  amountPence: -129_900,
  currency: 'GBP',
  descriptionRaw: 'CURRYS 0842',
  merchantName: 'CURRYS',
  classification: 'expense',
  balanceAfterPence: 1_841_255,
  counterparty: null,
  standingOrderRef: null,
  importBatchId: null,
  rawPayloadRef: null,
  matchState: 'UNMATCHED',
  chaseSuppressed: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function txn(id: string, over: Partial<BankTransactionRow> = {}): BankTransactionRow {
  return { ...DEFAULTS, id, ...over } as unknown as BankTransactionRow;
}

/** The parsed query, built through the CONTRACT's schema so a test can never
 *  assert on a shape the endpoint would reject. */
function query(raw: Record<string, unknown> = {}) {
  return listBankTransactionsQueryParams.parse(raw);
}

/**
 * A fake Prisma that records what it was asked for. The assertion is on the
 * `where` / `orderBy` / `take` that reach the database, not on Prisma working.
 */
function harness(rows: BankTransactionRow[] = [txn('txn_1')]) {
  const calls: { where?: unknown; orderBy?: unknown; take?: number }[] = [];
  const tx = {
    $executeRaw: async () => 0,
    bankTransaction: {
      findMany: async (args: { where?: unknown; orderBy?: unknown; take?: number }) => {
        calls.push(args);
        return rows;
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  return { calls, service: new BankTransactionsService(prisma) };
}

test('the row is projected onto the contract shape, pence untouched', async () => {
  const { service } = harness([txn('txn_1', { amountPence: -129_900 } as Partial<BankTransactionRow>)]);

  const page = await service.listBankTransactions(CTX, query());

  expect(page.data).toEqual([
    {
      id: 'txn_1',
      businessId: 'biz_1',
      accountId: 'acc_1',
      bookedAt: '2026-08-19T09:00:00.000Z',
      // The integer arrives as the integer. A projection that divided here
      // would put a float on the money path, which is the repo's most-guarded
      // invariant — and the Bank screen would still look right.
      amountPence: -129_900,
      currency: 'GBP',
      descriptionRaw: 'CURRYS 0842',
      merchantName: 'CURRYS',
      classification: 'expense',
      balanceAfterPence: 1_841_255,
      matchState: 'UNMATCHED',
      matchedDocumentId: null,
      chaseSuppressed: false,
    },
  ]);
});

test('nullable columns emit null, never a missing member', async () => {
  const { service } = harness([
    txn('txn_1', { merchantName: null, classification: null, balanceAfterPence: null } as Partial<BankTransactionRow>),
  ]);

  const [row] = (await service.listBankTransactions(CTX, query())).data;

  // `toHaveProperty` rather than a truthiness check: `JSON.stringify` drops an
  // undefined member entirely, so a required-but-nullable field would simply
  // vanish from the body and fail the generated client's parse at the consumer.
  expect(row).toHaveProperty('merchantName', null);
  expect(row).toHaveProperty('classification', null);
  expect(row).toHaveProperty('balanceAfterPence', null);
});

test('the response satisfies the generated response schema', async () => {
  const { service } = harness([txn('txn_1'), txn('txn_2', { matchState: 'CONFIRMED' } as Partial<BankTransactionRow>)]);

  const page = await service.listBankTransactions(CTX, query());

  // The contract is the authority, not this file's idea of the shape: parsed
  // through the same generated schema `apps/web` runs the body through.
  const { listBankTransactionsResponse } = await import('@neoting/contracts/zod');
  expect(listBankTransactionsResponse.safeParse(page).success).toBe(true);
});

test('newest booked first, with id as the tiebreak the cursor seeks on', async () => {
  const { calls, service } = harness();

  await service.listBankTransactions(CTX, query());

  // The contract declares no `sort`/`order` parameter and fixes the answer in
  // prose ("newest booked first"), so this is pinned rather than configurable.
  expect(calls[0]?.orderBy).toEqual([{ bookedAt: 'desc' }, { id: 'desc' }]);
});

test('take is limit + 1 — the extra row is the whole hasMore mechanism', async () => {
  const { calls, service } = harness();

  await service.listBankTransactions(CTX, query({ limit: 25 }));

  expect(calls[0]?.take).toBe(26);
});

test('a full page mints a cursor; a short page does not', async () => {
  const rows = [txn('txn_1'), txn('txn_2'), txn('txn_3')];

  const full = await harness(rows).service.listBankTransactions(CTX, query({ limit: 2 }));
  expect(full.data).toHaveLength(2);
  expect(full.pageInfo.hasMore).toBe(true);
  expect(full.pageInfo.nextCursor).not.toBeNull();

  const short = await harness(rows).service.listBankTransactions(CTX, query({ limit: 10 }));
  expect(short.pageInfo.hasMore).toBe(false);
  // A cursor that returns an empty page reads to a client as "keep going",
  // and infinite scroll does.
  expect(short.pageInfo.nextCursor).toBeNull();
});

test("page 1's own cursor is accepted by page 2 and seeks past the last row", async () => {
  const rows = [txn('txn_1'), txn('txn_2'), txn('txn_3')];
  const page1 = await harness(rows).service.listBankTransactions(CTX, query({ limit: 2 }));

  const { calls, service } = harness(rows);
  // The regression shape from `modules/documents/CLAUDE.md`: a fingerprint
  // computed over the query INCLUDING the cursor makes every page-2 request a
  // 400, and no single-page test notices.
  await service.listBankTransactions(CTX, query({ limit: 2, cursor: page1.pageInfo.nextCursor ?? '' }));

  const where = calls[0]?.where as { AND?: unknown[] };
  expect(where.AND).toBeDefined();
  expect(JSON.stringify(where)).toContain('txn_2');
});

test('no filter means no where clause — tenancy is RLS, not a hand-written predicate', async () => {
  const { calls, service } = harness();

  await service.listBankTransactions(CTX, query());

  // Asserted on the KEYS: a manual `businessId`/`practiceId` clause alongside
  // an RLS policy is two mechanisms that can disagree, and the more permissive
  // one wins exactly when it matters. There is also no hidden default the way
  // `GET /documents` excludes ARCHIVED — a bank feed has no archive, and a
  // transaction quietly missing is a reconciliation that never balances.
  expect(Object.keys(calls[0]?.where as object)).toEqual([]);
});

test('the three filters narrow, and an empty matchState array is not a filter', async () => {
  const { calls, service } = harness();

  await service.listBankTransactions(CTX, query({ businessId: 'biz_1', accountId: 'acc_1', matchState: ['UNMATCHED', 'SUGGESTED'] }));
  expect(calls[0]?.where).toMatchObject({
    businessId: 'biz_1',
    accountId: 'acc_1',
    matchState: { in: ['UNMATCHED', 'SUGGESTED'] },
  });

  const empty = harness();
  await empty.service.listBankTransactions(CTX, query({ matchState: [] }));
  // `{ in: [] }` matches nothing and reads on screen as "the feed is empty"
  // rather than "you filtered everything out".
  expect(empty.calls[0]?.where).not.toHaveProperty('matchState');
});

test('the service has no method that writes — the no-side-effect rule, structurally', () => {
  const methods = Object.getOwnPropertyNames(BankTransactionsService.prototype).filter((n) => n !== 'constructor');

  // Confirming a match is a `bank.confirm-match` proposal on the Review →
  // Approve spine (Governance §10). If a mutating method ever appears here,
  // this fails before a controller can be pointed at it. Both members are
  // reads: the list, and the document's bank-match lookup (Phase 4).
  expect(methods).toEqual(['listBankTransactions', 'getDocumentBankMatch']);
});
