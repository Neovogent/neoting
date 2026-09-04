import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import { getChatConversationResponse, listChatConversationsResponse } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { ChatConversationsService } from './chat-conversations.service.js';

/**
 * Saved conversations (review item 9, 5 Sep 2026), driven through a recording
 * fake Prisma. What these pin, in order of what it would cost to lose:
 *
 * 1. **Every query carries the owner filter** (`createdByUserId`). RLS bounds
 *    the practice; this filter is the whole of the member-privacy guarantee,
 *    and it is an application one — so the test asserts the `where` that
 *    reaches the database, not a re-implementation of the filtering.
 * 2. **A stored message that fails the shape is dropped, never thrown on** —
 *    the Json column may carry anything an older build wrote.
 * 3. **A businessId the caller cannot see is stored as NO scope**, because the
 *    RLS WITH CHECK would otherwise fail the write as a 500 and the visible
 *    check must not become a 404 that confirms the id names something.
 */

const CTX: ScopeContext = {
  actorId: 'usr_1',
  practiceId: 'prac_1',
  sessionScope: 'user',
  grantedItemIds: [],
};

const NOW = new Date('2026-09-05T09:00:00.000Z');

function conversationRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cuid_1',
    practiceId: 'prac_1',
    businessId: null,
    createdByUserId: 'usr_1',
    clientKey: 'c1',
    title: 'Chasing American Burger',
    pinned: false,
    messages: [
      { role: 'user', content: 'chase them', at: NOW.toISOString() },
      { role: 'assistant', content: 'Drafted.', intent: 'LIVE_CHASE', at: NOW.toISOString() },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

interface Calls {
  findMany: { where?: unknown; orderBy?: unknown; take?: number }[];
  findFirst: { where?: unknown }[];
  upsert: { where?: unknown; create?: unknown; update?: unknown }[];
  deleteMany: { where?: unknown }[];
  businessLookups: unknown[];
}

function fixture(options: { rows?: ReturnType<typeof conversationRow>[]; businessVisible?: boolean } = {}) {
  const rows = options.rows ?? [conversationRow()];
  const calls: Calls = { findMany: [], findFirst: [], upsert: [], deleteMany: [], businessLookups: [] };
  const tx = {
    $executeRaw: async () => 0,
    chatConversation: {
      findMany: async (args: Calls['findMany'][number]) => {
        calls.findMany.push(args);
        return rows;
      },
      findFirst: async (args: Calls['findFirst'][number]) => {
        calls.findFirst.push(args);
        return rows[0] ?? null;
      },
      upsert: async (args: Calls['upsert'][number]) => {
        calls.upsert.push(args);
        return rows[0] ?? conversationRow();
      },
      deleteMany: async (args: Calls['deleteMany'][number]) => {
        calls.deleteMany.push(args);
        return { count: rows.length };
      },
    },
    business: {
      findUnique: async (args: unknown) => {
        calls.businessLookups.push(args);
        return options.businessVisible === false ? null : { id: 'biz_1' };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  return { calls, service: new ChatConversationsService(prisma, new InMemoryIdempotencyStore()) };
}

test('the list carries the owner filter, sorts by newest activity, and parses as the contract', async () => {
  const { calls, service } = fixture();
  const page = await service.list(CTX, { limit: 50 });

  const where = calls.findMany[0]?.where as { createdByUserId?: unknown } | { AND?: unknown };
  expect(JSON.stringify(where)).toContain('"createdByUserId":"usr_1"');
  expect(calls.findMany[0]?.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);

  const parsed = listChatConversationsResponse.safeParse(page);
  expect(parsed.success).toBe(true);
  expect(page.data[0]).toMatchObject({ id: 'c1', title: 'Chasing American Burger', messageCount: 2 });
});

test('get returns the transcript, contract-parsed, with the owner filter in the query', async () => {
  const { calls, service } = fixture();
  const detail = await service.get(CTX, 'c1');

  expect(calls.findFirst[0]?.where).toMatchObject({ createdByUserId: 'usr_1', clientKey: 'c1' });
  expect(getChatConversationResponse.safeParse(detail).success).toBe(true);
  expect(detail.messages).toHaveLength(2);
  expect(detail.messages[1]).toEqual({ role: 'assistant', content: 'Drafted.', intent: 'LIVE_CHASE', at: NOW.toISOString() });
});

test("somebody else's conversation — indistinguishable from none — is a 404 that never echoes the id", async () => {
  const { service } = fixture({ rows: [] });
  const refusal = await service.get(CTX, 'c9').then(
    () => null,
    (error: AppException) => error,
  );
  expect(refusal?.getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect(JSON.stringify(refusal?.getResponse())).not.toContain('c9');
});

test('a malformed stored message is DROPPED — the drawer survives an older build\'s rows', async () => {
  const { service } = fixture({
    rows: [
      conversationRow({
        messages: [
          { role: 'user', content: 'hello', at: NOW.toISOString() },
          { role: 'model', content: 'wrong role', at: NOW.toISOString() },
          { role: 'assistant', content: 42, at: NOW.toISOString() },
          'not even an object',
        ],
      }),
    ],
  });
  const detail = await service.get(CTX, 'c1');
  expect(detail.messages).toHaveLength(1);
  expect(detail.messageCount).toBe(1);
});

test('save upserts on the (practice, creator, clientKey) identity with the caller as creator', async () => {
  const { calls, service } = fixture();
  await service.save(CTX, 'c1', { title: 'T', businessId: 'biz_1', pinned: true, messages: [] }, 'key-1');

  expect(calls.upsert[0]?.where).toEqual({
    practiceId_createdByUserId_clientKey: { practiceId: 'prac_1', createdByUserId: 'usr_1', clientKey: 'c1' },
  });
  expect(calls.upsert[0]?.create).toMatchObject({ businessId: 'biz_1', title: 'T', pinned: true });
});

test('a businessId the caller cannot see is stored as NO scope — narrowed, never a 404 or a 500', async () => {
  const { calls, service } = fixture({ businessVisible: false });
  await service.save(CTX, 'c1', { title: 'T', businessId: 'biz_other', messages: [] }, 'key-2');
  expect(calls.upsert[0]?.create).toMatchObject({ businessId: null });
});

test('a session with no practice is refused honestly, before any query', async () => {
  const { calls, service } = fixture();
  const noPractice: ScopeContext = { actorId: 'usr_1', businessId: 'biz_1', sessionScope: 'user', grantedItemIds: [] };
  const refusal = await service.save(noPractice, 'c1', { title: 'T', messages: [] }, 'key-3').then(
    () => null,
    (error: AppException) => error,
  );
  expect(refusal?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(calls.upsert).toHaveLength(0);
});

test('delete carries the owner filter and deleting nothing is still a success', async () => {
  const { calls, service } = fixture({ rows: [] });
  await service.delete(CTX, 'c1', 'key-4');
  expect(calls.deleteMany[0]?.where).toMatchObject({ createdByUserId: 'usr_1', clientKey: 'c1' });
});

test('key reuse with a different payload is 409 NT-IDM-001; the same payload replays silently', async () => {
  const { calls, service } = fixture();
  await service.save(CTX, 'c1', { title: 'T', messages: [] }, 'key-5');
  await service.save(CTX, 'c1', { title: 'T', messages: [] }, 'key-5');
  // The replay guard refuses misuse; an identical retry is allowed through
  // (the write is naturally idempotent — replace with the same bytes).
  const refusal = await service.save(CTX, 'c1', { title: 'DIFFERENT', messages: [] }, 'key-5').then(
    () => null,
    (error: AppException) => error,
  );
  expect(refusal?.code).toBe('NT-IDM-001');
  expect(calls.upsert.length).toBeGreaterThanOrEqual(1);
});
