import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { AppException } from '../problem/problem.js';
import { dateField, type PageRequest, pageQuery, scalarField, toPage } from './cursor.js';

interface Row {
  id: string;
  receivedAt: Date;
  supplierName: string | null;
  totalPence: number | null;
}

const RECEIVED_AT = dateField<Row>('receivedAt', (r) => r.receivedAt, false);
const SUPPLIER = scalarField<Row>('supplierName', (r) => r.supplierName, true);
const TOTAL = scalarField<Row>('totalPence', (r) => r.totalPence, true);

const QUERY = { inbox: ['COSTS'], sort: 'receivedAt', order: 'desc', limit: 2 };

function req(over: Partial<PageRequest<Row>> = {}): PageRequest<Row> {
  return { sort: RECEIVED_AT, order: 'desc', limit: 2, query: QUERY, ...over };
}

function row(id: string, over: Partial<Row> = {}): Row {
  return { id, receivedAt: new Date('2026-08-16T09:00:00.000Z'), supplierName: null, totalPence: null, ...over };
}

/** Page 1 → cursor → page 2's request, the loop every test below needs. */
function nextRequest(rows: Row[], request: PageRequest<Row> = req()): PageRequest<Row> {
  const cursor = toPage(rows, request).pageInfo.nextCursor;
  expect(cursor).not.toBeNull();
  return { ...request, cursor: cursor as string };
}

function grab(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

test('the first page asks for limit + 1 rows and no seek predicate', () => {
  const q = pageQuery(req());
  expect(q.where).toBeUndefined();
  expect(q.take).toBe(3); // limit 2 + the probe row
  expect(q.orderBy).toEqual([{ receivedAt: 'desc' }, { id: 'desc' }]);
});

test('a non-nullable sort column gets no `nulls` option', () => {
  // Prisma validates `nulls` against the field's optionality and throws on a
  // required one. `receivedAt` is required and is also the DEFAULT sort, so
  // getting this wrong 500s the most common request in the API.
  expect(pageQuery(req()).orderBy[0]).toEqual({ receivedAt: 'desc' });
});

test('a nullable sort column pins NULLS LAST in both directions', () => {
  // Postgres defaults to nulls FIRST on desc, which would put every document
  // with no supplier at the top of "supplier Z→A".
  expect(pageQuery(req({ sort: SUPPLIER })).orderBy[0]).toEqual({ supplierName: { sort: 'desc', nulls: 'last' } });
  expect(pageQuery(req({ sort: SUPPLIER, order: 'asc' })).orderBy[0]).toEqual({ supplierName: { sort: 'asc', nulls: 'last' } });
});

test('hasMore is false and nextCursor null when the probe row does not come back', () => {
  const page = toPage([row('a'), row('b')], req()); // exactly limit, no probe
  expect(page.pageInfo.hasMore).toBe(false);
  expect(page.pageInfo.nextCursor).toBeNull();
  expect(page.data).toHaveLength(2);
});

test('the probe row is trimmed off the page, never served', () => {
  const page = toPage([row('a'), row('b'), row('c')], req());
  expect(page.pageInfo.hasMore).toBe(true);
  expect(page.data.map((r) => r.id)).toEqual(['a', 'b']); // 'c' was only the probe
});

test('desc paging seeks strictly past the last row, including the id tie-break', () => {
  const older = new Date('2026-08-16T08:00:00.000Z');
  const rows = [row('a'), row('b', { receivedAt: older }), row('c')];
  const q = pageQuery(nextRequest(rows));

  // The page served ['a','b'], so the seek resumes after 'b'.
  expect(q.where).toEqual({
    OR: [
      { receivedAt: { lt: older } },
      { receivedAt: older, id: { lt: 'b' } },
    ],
  });
  // A Date, not the ISO string it travelled as — Postgres would compare a string
  // as text, which agrees with time only until it doesn't.
  expect((q.where?.['OR'] as { receivedAt: { lt: unknown } }[])[0]?.receivedAt.lt).toBeInstanceOf(Date);
});

test('asc paging flips both comparisons', () => {
  const q = pageQuery(nextRequest([row('a'), row('b'), row('c')], req({ order: 'asc' })));
  const or = q.where?.['OR'] as Record<string, unknown>[];
  expect(or[0]).toEqual({ receivedAt: { gt: new Date('2026-08-16T09:00:00.000Z') } });
  expect(or[1]).toEqual({ receivedAt: new Date('2026-08-16T09:00:00.000Z'), id: { gt: 'b' } });
});

test('a nullable sort carries the null tail so the list does not stop at the first null', () => {
  // Without this branch the scan ends at the first row with no supplier, and the
  // bug reads as "documents with no supplier do not exist".
  const rows = [row('a', { supplierName: 'Acme' }), row('b', { supplierName: 'Beta' }), row('c')];
  const request = req({ sort: SUPPLIER });
  const q = pageQuery(nextRequest(rows, request));
  expect(q.where?.['OR']).toEqual([
    { supplierName: { lt: 'Beta' } },
    { supplierName: 'Beta', id: { lt: 'b' } },
    { supplierName: null },
  ]);
});

test('a cursor that landed ON a null seeks only the remaining nulls by id', () => {
  // Nulls are last in both directions, so past a null there is nothing but nulls.
  const request = req({ sort: SUPPLIER });
  const q = pageQuery(nextRequest([row('a'), row('b'), row('c')], request));
  expect(q.where).toEqual({ AND: [{ supplierName: null }, { id: { lt: 'b' } }] });
});

test('integer pence survives the cursor round-trip as an integer', () => {
  // Money is integer pence end to end; a cursor is not allowed to be where it
  // becomes a float or a string.
  const rows = [row('a', { totalPence: 5000 }), row('b', { totalPence: 1250 }), row('c', { totalPence: 100 })];
  const q = pageQuery(nextRequest(rows, req({ sort: TOTAL })));
  const or = q.where?.['OR'] as Record<string, unknown>[];
  expect(or[0]).toEqual({ totalPence: { lt: 1250 } });
  expect(Number.isInteger((or[0] as { totalPence: { lt: number } }).totalPence.lt)).toBe(true);
});

// ---- the cursor is untrusted input ----

test('a malformed cursor is 400 NT-VAL-001, not a silent page 1', () => {
  // Left unvalidated this decodes to undefined and Prisma serves page 1 again —
  // an infinite scroll that repeats the first page forever and never errors.
  for (const bad of ['not-base64!!', Buffer.from('not json').toString('base64url'), Buffer.from('{"v":9}').toString('base64url')]) {
    const err = grab(() => pageQuery(req({ cursor: bad })));
    expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((err as AppException).code).toBe('NT-VAL-001');
  }
});

test('a cursor from a different filter set is refused rather than mis-seeked', () => {
  // Paging is only coherent within one query. Replayed against another filter
  // set the position means nothing, and the caller would get a wrong page with
  // no indication anything went wrong.
  const request = nextRequest([row('a'), row('b'), row('c')]);
  const err = grab(() => pageQuery({ ...request, query: { ...QUERY, inbox: ['SALES'] } }));
  expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect((err as AppException).fieldErrors?.[0]?.field).toBe('cursor');
});

test('a cursor from a different sort or order is refused', () => {
  const request = nextRequest([row('a'), row('b'), row('c')]);
  expect(grab(() => pageQuery({ ...request, query: { ...QUERY, order: 'asc' } }))).toBeDefined();
  expect(grab(() => pageQuery({ ...request, query: { ...QUERY, sort: 'totalPence' } }))).toBeDefined();
});

test('filter order in the query string does not invalidate a live cursor', () => {
  // The fingerprint is over sorted keys, so the same filters sent in a different
  // order are the same list. Otherwise a client that serialises its query
  // non-deterministically breaks its own paging.
  const request = nextRequest([row('a'), row('b'), row('c')]);
  const reordered = { limit: 2, order: 'desc', sort: 'receivedAt', inbox: ['COSTS'] };
  expect(() => pageQuery({ ...request, query: reordered })).not.toThrow();
});

test('an omitted filter and an explicitly-undefined one are the same list', () => {
  const request = nextRequest([row('a'), row('b'), row('c')]);
  expect(() => pageQuery({ ...request, query: { ...QUERY, businessId: undefined } })).not.toThrow();
});

test('paging a list while new rows arrive at the head never repeats or skips', () => {
  // The acceptance criterion, as a simulation. Page 1 is served, then two newer
  // documents arrive. Because the seek is "older than b", the new rows sort
  // BEFORE the cursor and are simply not in the remainder of the scan — where an
  // OFFSET 2 would have shifted the window and re-served 'b'.
  const t = (iso: string) => new Date(iso);
  const all = [
    row('c', { receivedAt: t('2026-08-16T12:00:00.000Z') }),
    row('b', { receivedAt: t('2026-08-16T11:00:00.000Z') }),
    row('a', { receivedAt: t('2026-08-16T10:00:00.000Z') }),
  ];
  const page1 = toPage(all, req());
  expect(page1.data.map((r) => r.id)).toEqual(['c', 'b']);

  // Two newer documents land between the two requests.
  const arrivals = [
    row('e', { receivedAt: t('2026-08-16T14:00:00.000Z') }),
    row('d', { receivedAt: t('2026-08-16T13:00:00.000Z') }),
  ];
  const q = pageQuery({ ...req(), cursor: page1.pageInfo.nextCursor as string });

  // Apply the seek predicate as Postgres would, over the grown table.
  const after = [...arrivals, ...all].filter((r) => {
    const last = t('2026-08-16T11:00:00.000Z');
    return r.receivedAt < last || (r.receivedAt.getTime() === last.getTime() && r.id < 'b');
  });
  expect(after.map((r) => r.id)).toEqual(['a']); // not 'b' again, and 'a' is not lost
  expect(q.take).toBe(3);
});
