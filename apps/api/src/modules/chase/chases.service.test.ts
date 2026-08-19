import { expect, test } from 'vitest';

import type {
  BankTransaction as BankTransactionRow,
  Chase as ChaseRow,
  ChaseMessage as ChaseMessageRow,
  SmsLog as SmsLogRow,
} from '@prisma/client';

import { HttpStatus } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import type { AppException } from '../../common/problem/problem.js';
import { ChasesService } from './chases.service.js';

const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const NOW = new Date('2026-08-18T09:00:00.000Z');
const BOOKED = new Date('2026-08-09T12:00:00.000Z');

function chase(over: Partial<ChaseRow> = {}): ChaseRow {
  return {
    id: 'chase_1',
    businessId: 'biz_burger',
    detectionEngine: 'UNMATCHED_TRANSACTION',
    transactionId: 'txn_currys',
    itemRefs: ['txn_currys'],
    recipientContactId: 'contact_1',
    state: 'SENT',
    schedule: null,
    firstSentAt: NOW,
    lastSentAt: NOW,
    escalatedAt: null,
    closedAt: null,
    closedReason: null,
    closedByDocumentId: null,
    actionProposalId: 'prop_1',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as unknown as ChaseRow;
}

function txn(over: Partial<BankTransactionRow> = {}): BankTransactionRow {
  return {
    id: 'txn_currys',
    businessId: 'biz_burger',
    accountId: 'acct_1',
    bookedAt: BOOKED,
    amountPence: -129_900,
    currency: 'GBP',
    descriptionRaw: 'CURRYS 1234 LONDON',
    merchantName: 'Currys',
    matchState: 'UNMATCHED',
    chaseSuppressed: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as unknown as BankTransactionRow;
}

function message(over: Partial<ChaseMessageRow> = {}): ChaseMessageRow {
  return {
    id: 'msg_1',
    chaseId: 'chase_1',
    channel: 'sms',
    body: 'Upload securely: token123',
    recipientE164: '+447700900001',
    deliveryState: 'sent',
    sentAt: NOW,
    createdAt: NOW,
    ...over,
  } as unknown as ChaseMessageRow;
}

function sms(over: Partial<SmsLogRow> = {}): SmsLogRow {
  return {
    id: 'sms_1',
    businessId: 'biz_burger',
    toE164: '+447700900001',
    body: 'Upload securely: token123',
    deliveryState: 'sent',
    costPence: null,
    chaseId: 'chase_1',
    sentAt: NOW,
    ...over,
  } as unknown as SmsLogRow;
}

interface Calls {
  chaseFindMany: { where?: unknown; orderBy?: unknown; take?: number }[];
  chaseFindUnique: unknown[];
  txnFindMany: { where?: unknown }[];
  smsFindMany: { where?: unknown; orderBy?: unknown; take?: number }[];
}

/**
 * A recording fake Prisma. The point is not that Prisma works — it is that the
 * right `where` / `orderBy` / `take` reach it, that money passes through as an
 * integer, and that a missing chase never queries its items. Mirrors the
 * documents-surface harness.
 */
function harness(
  options: {
    chases?: ChaseRow[];
    chase?: ChaseRow | null;
    messages?: ChaseMessageRow[];
    transactions?: BankTransactionRow[];
    smsLogs?: SmsLogRow[];
  } = {},
) {
  const calls: Calls = { chaseFindMany: [], chaseFindUnique: [], txnFindMany: [], smsFindMany: [] };
  const chaseRows = options.chases ?? [chase()];
  const smsRows = options.smsLogs ?? [sms()];
  const detailChase = options.chase === undefined ? chase() : options.chase;

  const tx = {
    $executeRaw: async () => 0,
    chase: {
      findMany: async (args: { where?: unknown; orderBy?: unknown; take?: number }) => {
        calls.chaseFindMany.push(args);
        return chaseRows;
      },
      findUnique: async (args: unknown) => {
        calls.chaseFindUnique.push(args);
        if (detailChase === null) return null;
        return { ...detailChase, messages: options.messages ?? [message()] };
      },
    },
    bankTransaction: {
      findMany: async (args: { where?: unknown }) => {
        calls.txnFindMany.push(args);
        return options.transactions ?? [txn()];
      },
    },
    smsLog: {
      findMany: async (args: { where?: unknown; orderBy?: unknown; take?: number }) => {
        calls.smsFindMany.push(args);
        return smsRows;
      },
    },
  };

  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  return { calls, service: new ChasesService(prisma) };
}

function listQuery(over: Record<string, unknown> = {}) {
  return { limit: 50, ...over } as never;
}

async function grab(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ---- listChases ----

test('listChases returns the contract envelope, newest first, asking for limit + 1', async () => {
  const { calls, service } = harness();
  const page = await service.listChases(CTX, listQuery({ limit: 2 }));

  expect(page.data).toHaveLength(1);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  const [call] = calls.chaseFindMany;
  expect(call?.take).toBe(3); // the probe row, not a second COUNT
  expect(call?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
});

test('listChases projects onto ChaseSummary and keeps money nowhere near it — itemCount grouped', async () => {
  const { service } = harness({ chases: [chase({ itemRefs: ['txn_a', 'txn_b'] })] });
  const page = await service.listChases(CTX, listQuery());
  const [row] = page.data;
  expect(row?.id).toBe('chase_1');
  expect(row?.itemCount).toBe(2);
  expect(row?.createdAt).toBe(NOW.toISOString());
  // The detail half must not leak into a summary.
  expect(row).not.toHaveProperty('items');
  expect(row).not.toHaveProperty('messages');
});

test('the state filter is ANDed in; a businessId is a filter, not a second tenancy guard', async () => {
  const { calls, service } = harness();
  await service.listChases(CTX, listQuery({ state: ['SENT', 'CLOSED_RECEIVED'], businessId: 'biz_9' }));
  expect(calls.chaseFindMany[0]?.where).toEqual({
    businessId: 'biz_9',
    state: { in: ['SENT', 'CLOSED_RECEIVED'] },
  });
});

test('no filter means an empty where — RLS is the only tenancy mechanism', async () => {
  const { calls, service } = harness();
  await service.listChases(CTX, listQuery());
  // Unlike documents there is no default state exclusion — chases show every state.
  expect(calls.chaseFindMany[0]?.where).toEqual({});
});

// ---- getChase ----

test('getChase returns the full record: items joined by ref, messages, closure', async () => {
  const { service } = harness({
    chase: chase({ itemRefs: ['txn_currys', 'txn_google'] }),
    transactions: [txn({ id: 'txn_currys' }), txn({ id: 'txn_google', merchantName: 'Google', amountPence: -60_000 })],
    messages: [message()],
  });
  const detail = await service.getChase(CTX, 'chase_1');

  expect(detail.id).toBe('chase_1');
  expect(detail.items.map((i) => i.transactionId)).toEqual(['txn_currys', 'txn_google']);
  expect(detail.items[1]?.amountPence).toBe(-60_000); // integer pence, unchanged
  expect(detail.messages[0]?.body).toBe('Upload securely: token123');
});

test('getChase fetches items IN the same scoped call, by the chase refs only', async () => {
  const { calls, service } = harness({ chase: chase({ itemRefs: ['txn_currys'] }) });
  await service.getChase(CTX, 'chase_1');
  expect(calls.txnFindMany[0]?.where).toEqual({ id: { in: ['txn_currys'] } });
});

test('getChase on a chase RLS cannot see is a 404 that never queries items', async () => {
  const { calls, service } = harness({ chase: null });
  const err = (await grab(() => service.getChase(CTX, 'missing'))) as AppException;
  expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect(err.code).toBe('NT-VAL-001'); // NT-NOT-001 does not exist
  // The invisible parent must never trigger the item query — no leak of what it covers.
  expect(calls.txnFindMany).toHaveLength(0);
});

// ---- listSmsOutbox ----

test('listSmsOutbox returns the phone-screen rows, newest first, with the portal link extracted', async () => {
  const { calls, service } = harness({ smsLogs: [sms({ body: 'foo. Upload securely: tok.sig rest' })] });
  const page = await service.listSmsOutbox(CTX, listQuery({ limit: 5 }));

  expect(page.data[0]?.toE164).toBe('+447700900001');
  expect(page.data[0]?.portalUrl).toBe('tok.sig');
  expect(page.data[0]?.sentAt).toBe(NOW.toISOString());
  const [call] = calls.smsFindMany;
  expect(call?.take).toBe(6);
  expect(call?.orderBy).toEqual([{ sentAt: 'desc' }, { id: 'desc' }]);
});

test('listSmsOutbox businessId is a filter only; absent adds nothing', async () => {
  const filtered = harness();
  await filtered.service.listSmsOutbox(CTX, listQuery({ businessId: 'biz_9' }));
  expect(filtered.calls.smsFindMany[0]?.where).toEqual({ businessId: 'biz_9' });

  const bare = harness();
  await bare.service.listSmsOutbox(CTX, listQuery());
  expect(bare.calls.smsFindMany[0]?.where).toEqual({});
});
