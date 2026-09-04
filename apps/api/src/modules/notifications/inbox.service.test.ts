import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import { listNotificationsResponse } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { NotificationsInboxService } from './inbox.service.js';

/**
 * The bell's service (review item 12, 5 Sep 2026), driven through a recording
 * fake Prisma — the `documents.service.test.ts` idiom: the assertions are on
 * the `where`/`orderBy`/`take` that reach the database and on the projection,
 * not on Prisma working. RLS applies the tenancy predicate; the only thing
 * this layer decides is what the query says.
 */

const CTX: ScopeContext = {
  actorId: 'usr_1',
  practiceId: 'prac_1',
  sessionScope: 'user',
  grantedItemIds: [],
};

const NOW = new Date('2026-09-05T09:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'ntf_1',
    businessId: 'biz_1',
    event: 'portal.upload',
    recipientUserId: null,
    channels: [],
    payload: { documentId: 'doc_1', otpSessionId: 'otp_1', source: 'portal' },
    readAt: null,
    sentAt: null,
    createdAt: NOW,
    business: { name: 'Zeplow Inc' },
    ...over,
  };
}

interface Calls {
  findMany: { where?: unknown; orderBy?: unknown; take?: number; include?: unknown }[];
  count: { where?: unknown }[];
  updateMany: { where?: unknown; data?: unknown }[];
}

function fixture(rows: ReturnType<typeof row>[] = [row()], unread = 3) {
  const calls: Calls = { findMany: [], count: [], updateMany: [] };
  const tx = {
    $executeRaw: async () => 0,
    notification: {
      findMany: async (args: Calls['findMany'][number]) => {
        calls.findMany.push(args);
        return rows;
      },
      count: async (args: { where?: unknown }) => {
        calls.count.push(args);
        return unread;
      },
      updateMany: async (args: Calls['updateMany'][number]) => {
        calls.updateMany.push(args);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  const service = new NotificationsInboxService(prisma, new InMemoryIdempotencyStore());
  return { calls, service };
}

test('the list is newest-first, joined to the business name, and the body parses as the contract', async () => {
  const { calls, service } = fixture([
    row(),
    row({
      id: 'ntf_2',
      event: 'chase.closed',
      payload: { chaseId: 'chs_1', documentId: 'doc_2', reason: 'matched-inbound-document' },
      readAt: new Date('2026-09-05T10:00:00.000Z'),
    }),
  ]);

  const { page, unreadCount } = await service.list(CTX, { limit: 50 });

  expect(calls.findMany[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  expect(calls.findMany[0]?.take).toBe(51);
  expect(unreadCount).toBe(3);

  // The projection is the contract's — parsed by the generated schema, so a
  // drift surfaces here with the field named.
  const parsed = listNotificationsResponse.safeParse({ data: page.data, pageInfo: page.pageInfo, unreadCount });
  expect(parsed.success).toBe(true);

  expect(page.data[0]).toEqual({
    id: 'ntf_1',
    event: 'portal.upload',
    businessId: 'biz_1',
    businessName: 'Zeplow Inc',
    documentId: 'doc_1',
    chaseId: null,
    createdAt: NOW.toISOString(),
    readAt: null,
  });
  expect(page.data[1]?.chaseId).toBe('chs_1');
  expect(page.data[1]?.readAt).toBe('2026-09-05T10:00:00.000Z');
});

test('unread=true narrows the where to readAt null; the default where carries no filter', async () => {
  const { calls, service } = fixture();
  await service.list(CTX, { limit: 50, unread: true });
  await service.list(CTX, { limit: 50 });

  expect(calls.findMany[0]?.where).toEqual({ readAt: null });
  // No hidden filter and no second tenancy mechanism — RLS already bounded it.
  expect(calls.findMany[1]?.where).toEqual({});
});

test('a payload from an older writer with an unexpected shape projects nulls, never throws', async () => {
  const { service } = fixture([
    row({ payload: null }),
    row({ id: 'ntf_3', payload: 'a bare string' }),
    row({ id: 'ntf_4', payload: { documentId: 42 } }),
  ]);
  const { page } = await service.list(CTX, { limit: 50 });
  expect(page.data.map((item) => item.documentId)).toEqual([null, null, null]);
});

test('markRead is guarded on readAt null, filters to the named ids, and returns server truth', async () => {
  const { calls, service } = fixture([], 0);
  const result = await service.markRead(CTX, 'key-1', ['ntf_1', 'ntf_2']);

  expect(calls.updateMany[0]?.where).toEqual({ readAt: null, id: { in: ['ntf_1', 'ntf_2'] } });
  expect(result.unreadCount).toBe(0);
});

test('markRead with no ids marks everything unread — no id clause at all', async () => {
  const { calls, service } = fixture([], 0);
  await service.markRead(CTX, 'key-2', undefined);
  expect(calls.updateMany[0]?.where).toEqual({ readAt: null });
});

test('a replayed key returns the stored answer without a second write; a different payload is 409 NT-IDM-001', async () => {
  const { calls, service } = fixture([], 0);
  const first = await service.markRead(CTX, 'key-3', ['ntf_1']);
  const replay = await service.markRead(CTX, 'key-3', ['ntf_1']);

  expect(replay).toEqual(first);
  expect(calls.updateMany).toHaveLength(1);

  const refusal = await service.markRead(CTX, 'key-3', ['ntf_9']).then(
    () => null,
    (error: AppException) => error,
  );
  expect(refusal?.code).toBe('NT-IDM-001');
  expect(refusal?.getStatus()).toBe(HttpStatus.CONFLICT);
});

test("the replay fingerprint is actor-scoped — another actor's key never replays this caller's response", async () => {
  const { service } = fixture([], 0);
  await service.markRead(CTX, 'key-4', ['ntf_1']);

  const other: ScopeContext = { ...CTX, actorId: 'usr_2' };
  const refusal = await service.markRead(other, 'key-4', ['ntf_1']).then(
    () => null,
    (error: AppException) => error,
  );
  expect(refusal?.code).toBe('NT-IDM-001');
});
