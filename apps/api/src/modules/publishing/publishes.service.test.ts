import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { Publish as PublishRow } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import type { AppException } from '../../common/problem/problem.js';
import { PublishesService } from './publishes.service.js';

// `ScopeContext` is the schema's OUTPUT type, so the defaulted fields are
// required here even though a caller may omit them on the way in.
const CTX: ScopeContext = {
  actorId: 'usr_1',
  practiceId: 'prac_1',
  sessionScope: 'user',
  grantedItemIds: [],
};
const NOW = new Date('2026-08-20T09:15:30.000Z');

function row(id: string, over: Partial<PublishRow> = {}): PublishRow {
  return {
    id,
    businessId: 'biz_1',
    documentId: `doc_${id}`,
    integrationId: 'int_1',
    mode: 'MANUAL',
    state: 'SUCCEEDED',
    externalRef: 'XERO-INV-0042',
    idempotencyKey: `prop_1:doc_${id}`,
    attachmentSent: true,
    actionProposalId: 'prop_1',
    failureCode: null,
    failureMessage: null,
    publishedByUserId: 'usr_1',
    createdAt: NOW,
    completedAt: NOW,
    ...over,
  } as PublishRow;
}

interface Call {
  where?: unknown;
  orderBy?: unknown;
  take?: number;
}

/**
 * A fake Prisma that records what it was asked for.
 *
 * The assertions in this file are on the `where` / `orderBy` / `take` that
 * REACH the database, not on Prisma working. That is the only level at which
 * "no second tenancy mechanism" and "the cursor is ANDed under the filters
 * rather than replacing them" are checkable — a status-code assertion cannot
 * see either.
 */
function harness(rows: PublishRow[] = [row('pub_1')]) {
  const calls: Call[] = [];
  const tx = {
    $executeRaw: async () => 0,
    publish: {
      findMany: async (args: Call) => {
        calls.push(args);
        return rows;
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  return { calls, service: new PublishesService(prisma) };
}

/** The parsed-query shape the controller hands the service, with the contract's default limit. */
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

test('listPublishes returns the contract envelope, newest first, asking for limit + 1 rows', async () => {
  const { calls, service } = harness();
  const page = await service.listPublishes(CTX, listQuery({ limit: 2 }));

  expect(page.data).toHaveLength(1);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  // "Publish history, newest first" is the contract's ordering, and `listPublishes`
  // exposes no sort parameter, so it is fixed. The `id` tie-break is not
  // cosmetic: a batch fans out to one row per item inside ONE transaction, so a
  // 40-item publish shares a `createdAt` to the microsecond and has no total
  // order without it — a page boundary inside the batch would skip and repeat.
  expect(calls[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  expect(calls[0]?.take).toBe(3); // the probe row, not a second COUNT query
});

test('rows are projected onto the contract Publish — internal columns never reach the wire', async () => {
  const { service } = harness([row('pub_1', { state: 'FAILED', externalRef: null, failureCode: 'NT-PUB-002', failureMessage: 'Xero rejected the bill.' })]);
  const [publish] = (await service.listPublishes(CTX, listQuery())).data;

  expect(publish?.id).toBe('pub_1');
  expect(publish?.failureCode).toBe('NT-PUB-002');
  expect(publish?.createdAt).toBe(NOW.toISOString());
  expect(publish).not.toHaveProperty('idempotencyKey');
  expect(publish).not.toHaveProperty('publishedByUserId');
});

test('an omitted state filter means EVERY state, and adds no manual tenancy clause', async () => {
  // Two claims in one assertion, both deliberate.
  //
  // 1. The contract's `state` parameter says "Omitted means every state" —
  //    unlike `GET /documents`, where omitted excludes ARCHIVED. Publish
  //    history is an audit trail; a state hidden by default would mean a failed
  //    publish quietly missing from the record of what was attempted.
  // 2. The tenancy guard is RLS inside `scopedDb`. If this ever starts seeing a
  //    hand-written practiceId/businessId clause nobody asked for, someone has
  //    added a second enforcement mechanism that can disagree with the policy —
  //    and the more permissive of the two wins exactly when it matters.
  const { calls, service } = harness();
  await service.listPublishes(CTX, listQuery());

  expect(calls[0]?.where).toEqual({});
});

test('a repeated state widens into one IN, rather than two round trips', async () => {
  const { calls, service } = harness();
  await service.listPublishes(CTX, listQuery({ state: ['QUEUED', 'FAILED'] }));

  expect(calls[0]?.where).toEqual({ state: { in: ['QUEUED', 'FAILED'] } });
});

test('businessId and state are ANDed together as filters over the already-scoped set', async () => {
  const { calls, service } = harness();
  await service.listPublishes(CTX, listQuery({ businessId: 'biz_9', state: ['FAILED'] }));

  expect(calls[0]?.where).toEqual({ businessId: 'biz_9', state: { in: ['FAILED'] } });
});

test('an unreachable businessId is an empty page — not 404, not 403', async () => {
  // RLS already removed the rows; the filter simply matches none of them. A 404
  // or a 403 here would confirm whether that business exists.
  const { service } = harness([]);
  const page = await service.listPublishes(CTX, listQuery({ businessId: 'biz_other' }));

  expect(page.data).toEqual([]);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
});

test('a malformed cursor is a 400, not a silent first page', async () => {
  const { service } = harness();
  const err = await grab(() => service.listPublishes(CTX, listQuery({ cursor: 'not-a-cursor!!' })));

  expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect((err as AppException).code).toBe('NT-VAL-001');
});

test("page 1's own cursor is accepted by page 2 and seeks past the last row", async () => {
  // REGRESSION, inherited from `GET /documents`: the fingerprint must be
  // computed over the query MINUS the cursor. Folding the cursor in makes the
  // digest sealed into page 1 unmatchable on the way back, and EVERY page-2
  // request 400s with "issued for a different set of filters". A malformed
  // -cursor test does not catch it — only a genuine two-page round trip does.
  const rows = [row('pub_1'), row('pub_2'), row('pub_3')];
  const query = { limit: 2, state: ['SUCCEEDED'] };

  const first = harness(rows);
  const page1 = await first.service.listPublishes(CTX, listQuery(query));
  expect(page1.pageInfo.hasMore).toBe(true);
  const cursor = page1.pageInfo.nextCursor;
  expect(cursor).not.toBeNull();

  const second = harness(rows);
  const page2 = await second.service.listPublishes(CTX, listQuery({ ...query, cursor }));

  // Not merely "not a 400": the seek was ANDed UNDER the same filters rather
  // than replacing them, so page 2 cannot widen past what page 1 was allowed.
  expect(second.calls[0]?.where).toEqual({
    AND: [
      { state: { in: ['SUCCEEDED'] } },
      {
        OR: [
          { createdAt: { lt: NOW } }, // a Date, never the ISO string — Postgres would compare text
          { createdAt: NOW, id: { lt: 'pub_2' } }, // the id tie-break, since a batch shares createdAt
        ],
      },
    ],
  });
  expect(page2.data).toHaveLength(2);
});

test('a cursor minted under one state filter is refused under another', async () => {
  // Paging is only coherent within one query. A cursor from `state=SUCCEEDED`
  // replayed against `state=FAILED` seeks to a position that means nothing in
  // the second list, and would silently serve a wrong page rather than error.
  const first = harness([row('pub_1'), row('pub_2')]);
  const page1 = await first.service.listPublishes(CTX, listQuery({ limit: 1, state: ['SUCCEEDED'] }));
  const cursor = page1.pageInfo.nextCursor;
  expect(cursor).not.toBeNull();

  const second = harness([row('pub_9')]);
  const err = await grab(() => second.service.listPublishes(CTX, listQuery({ limit: 1, state: ['FAILED'], cursor })));

  expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect((err as AppException).code).toBe('NT-VAL-001');
});

test('the service has no way to change state — the read surface cannot grow one by accident', () => {
  // Structural, not a promise: publishing is a `publish.batch` proposal on the
  // Review → Approve spine (Governance §10) and retry is a NEW proposal over
  // the failed item. If a mutating method ever appears on this class, the
  // side-effect path exists whether or not a route reaches it yet.
  const methods = Object.getOwnPropertyNames(PublishesService.prototype).filter((name) => name !== 'constructor');

  expect(methods).toEqual(['listPublishes']);
});
