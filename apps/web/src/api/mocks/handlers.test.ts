import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listDocumentsResponse } from '@neoting/contracts/zod';
import type { DocumentSummary } from '@neoting/contracts/model';

import { documentFixtures } from './fixtures';
import { filterDocuments } from './handlers';

/**
 * The inbox is ONE endpoint serving four screens purely through query
 * parameters, so this is where a filtering regression would land: a mock that
 * quietly returns everything looks fine on screen and hides the bug that
 * integration finds.
 *
 * Every expectation is computed from the fixture set rather than hard-coded to
 * a count, so adding a seed document does not turn these red for no reason —
 * but the shape of the answer (which rows, in what order, on which page) is
 * asserted exactly.
 */

const ask = (query: string) => filterDocuments(new URL(`http://localhost/v1/documents${query}`));
const ids = (rows: DocumentSummary[]) => rows.map((d) => d.id);

describe('filterDocuments — no filter', () => {
  it('returns every fixture, and never an archived one', () => {
    const { data, hasMore, nextCursor } = ask('');

    expect(ids(data)).toEqual(ids(documentFixtures));
    expect(data.every((d) => d.state !== 'ARCHIVED')).toBe(true);
    expect(hasMore).toBe(false);
    expect(nextCursor).toBeNull();
  });

  it('sorts newest first, which is what every screen renders', () => {
    const received = ask('').data.map((d) => d.receivedAt);
    const descending = [...received].sort((a, b) => b.localeCompare(a));

    expect(received).toEqual(descending);
  });

  it('answers with a body the contract actually accepts', () => {
    const { data, nextCursor, hasMore } = ask('');
    const parsed = listDocumentsResponse.safeParse({ data, pageInfo: { nextCursor, hasMore } });

    // The failure message matters more than the boolean when this breaks.
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });
});

describe('filterDocuments — the four screens', () => {
  it('costs inbox returns only costs', () => {
    const { data } = ask('?inbox=COSTS');

    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.inbox === 'COSTS')).toBe(true);
    expect(ids(data)).toEqual(ids(documentFixtures.filter((d) => d.inbox === 'COSTS')));
  });

  it('sales inbox returns only sales, and those carry a customer rather than a supplier', () => {
    const { data } = ask('?inbox=SALES');

    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.inbox === 'SALES')).toBe(true);
    expect(data.every((d) => d.customerName && !d.supplierName)).toBe(true);
  });

  it('costs and sales together partition the inbox — no row belongs to both, none is lost', () => {
    const costs = ids(ask('?inbox=COSTS').data);
    const sales = ids(ask('?inbox=SALES').data);

    expect(costs.filter((id) => sales.includes(id))).toEqual([]);
    expect([...costs, ...sales].sort()).toEqual(ids(documentFixtures).sort());
  });

  it('the rejected view returns only rejected work', () => {
    const { data } = ask('?state=REJECTED');

    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.state === 'REJECTED')).toBe(true);
    // The contract promises a reason on every rejected row.
    expect(data.every((d) => Boolean(d.failureCode) && Boolean(d.failureMessage))).toBe(true);
  });

  it('a repeated state parameter is a union, not the last one winning', () => {
    const both = ask('?state=REJECTED&state=READY');
    const rejected = ask('?state=REJECTED');
    const ready = ask('?state=READY');

    expect(both.data.length).toBe(rejected.data.length + ready.data.length);
    expect(ids(both.data).sort()).toEqual([...ids(rejected.data), ...ids(ready.data)].sort());
  });
});

describe('filterDocuments — per-client', () => {
  const businessIds = [...new Set(documentFixtures.map((d) => d.businessId))];

  it.each(businessIds)('%s sees only its own documents', (businessId) => {
    const { data } = ask(`?businessId=${businessId}`);

    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.businessId === businessId)).toBe(true);
  });

  it('the per-client filters together account for every document', () => {
    const perClient = businessIds.flatMap((id) => ids(ask(`?businessId=${id}`).data));

    expect(perClient.sort()).toEqual(ids(documentFixtures).sort());
  });

  it('a client with nothing on file gets an empty page, not everybody else’s', () => {
    const { data, hasMore, nextCursor } = ask('?businessId=biz_nobody');

    expect(data).toEqual([]);
    expect(hasMore).toBe(false);
    expect(nextCursor).toBeNull();
  });

  it('combines with the inbox filter rather than one overriding the other', () => {
    const [businessId] = businessIds;
    const { data } = ask(`?businessId=${businessId}&inbox=COSTS`);

    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.businessId === businessId && d.inbox === 'COSTS')).toBe(true);
  });
});

describe('filterDocuments — search', () => {
  it('matches a supplier name, case-insensitively', () => {
    const lower = ids(ask('?q=bidfood').data);
    const upper = ids(ask('?q=BIDFOOD').data);

    expect(lower.length).toBeGreaterThan(0);
    expect(lower).toEqual(upper);
    expect(ask('?q=bidfood').data.every((d) => /bidfood/i.test(JSON.stringify(d)))).toBe(true);
  });

  it('reaches the customer name too — a supplier-only search would miss every sales row', () => {
    const sales = ask('?inbox=SALES').data[0];
    expect(sales?.customerName).toBeTruthy();

    const { data } = ask(`?q=${encodeURIComponent(String(sales?.customerName))}`);

    expect(ids(data)).toContain(sales?.id);
  });

  it('reaches the original filename, which is all a photographed receipt has', () => {
    const { data } = ask('?q=till-receipt');

    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.originalFilename.includes('till-receipt'))).toBe(true);
  });

  it('narrows rather than widens when combined with an inbox', () => {
    const searchOnly = ask('?q=costco').data;
    const narrowed = ask('?q=costco&inbox=SALES').data;

    expect(searchOnly.length).toBeGreaterThan(0);
    expect(narrowed).toEqual([]);
  });

  it('a term nothing matches returns nothing', () => {
    expect(ask('?q=zzzznotasupplier').data).toEqual([]);
  });
});

describe('filterDocuments — cursor pagination', () => {
  it('walks every row exactly once, in the same order as the unpaged answer', () => {
    const expected = ids(ask('').data);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: ReturnType<typeof filterDocuments> = ask(`?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.data.length).toBeLessThanOrEqual(5);
      seen.push(...ids(page.data));
      cursor = page.nextCursor;
      pages++;
      // A cursor loop that never terminates is the failure worth guarding.
      expect(pages).toBeLessThan(50);
    } while (cursor);

    expect(seen).toEqual(expected);
    expect(pages).toBe(Math.ceil(expected.length / 5));
  });

  it('reports hasMore honestly and stops offering a cursor on the last page', () => {
    const first = ask('?limit=5');
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const whole = ask('?limit=200');
    expect(whole.hasMore).toBe(false);
    expect(whole.nextCursor).toBeNull();
  });

  it('carries the filter across pages — page two of Costs is still Costs', () => {
    const first = ask('?inbox=COSTS&limit=3');
    const second = ask(`?inbox=COSTS&limit=3&cursor=${first.nextCursor}`);

    expect(second.data.length).toBeGreaterThan(0);
    expect(second.data.every((d) => d.inbox === 'COSTS')).toBe(true);
    expect(ids(second.data).filter((id) => ids(first.data).includes(id))).toEqual([]);
  });

  it('honours the requested page size, and caps an unreasonable one', () => {
    expect(ask('?limit=3').data.length).toBe(3);
    // The cap is 200; with a seed set smaller than that the observable
    // behaviour is that an absurd limit is answered rather than refused.
    expect(ask('?limit=100000').data.length).toBe(Math.min(documentFixtures.length, 200));
  });
});

describe('filterDocuments — sorting', () => {
  it('sorts by money when asked, ascending and descending', () => {
    const ascending = ask('?sort=totalPence&order=asc').data.map((d) => d.totalPence ?? 0);
    const descending = ask('?sort=totalPence&order=desc').data.map((d) => d.totalPence ?? 0);

    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
    expect(descending).toEqual([...ascending].reverse());
  });

  it('sorts money numerically, not as text — 340 before 1420, never after', () => {
    const ascending = ask('?sort=totalPence&order=asc').data.map((d) => d.totalPence ?? 0);
    const stringSorted = [...ascending].sort((a, b) => String(a).localeCompare(String(b)));

    expect(ascending).not.toEqual(stringSorted);
  });

  it('sorts by supplier name when asked', () => {
    const names = ask('?inbox=COSTS&sort=supplierName&order=asc').data.map((d) => d.supplierName ?? '');

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

/**
 * "Omitted means every state except ARCHIVED" is the contract's default, and
 * nothing in the seed data is archived — so the branch is only reachable
 * against a fixture set that has one.
 */
describe('filterDocuments — the archived default', () => {
  const base: DocumentSummary = {
    id: 'live-1',
    businessId: 'biz_1',
    inbox: 'COSTS',
    state: 'READY',
    docType: 'RECEIPT',
    channel: 'EMAIL',
    originalFilename: 'live.pdf',
    receivedAt: '2026-08-10T09:00:00Z',
    supplierName: 'Bidfood UK',
    customerName: null,
    documentDate: '2026-08-10',
    dueDate: null,
    currency: 'GBP',
    totalPence: 142050,
    taxPence: null,
    reference: null,
    categoryCode: 'Cost of Sales Food',
    description: null,
    projectRef: null,
    parentDocumentId: null,
    failureCode: null,
    failureMessage: null,
    retryable: false,
    archivedAt: null,
  };

  const withArchived = [
    base,
    { ...base, id: 'archived-1', state: 'ARCHIVED' as const, archivedAt: '2026-08-12T09:00:00Z' },
  ];

  const load = async () => {
    vi.resetModules();
    vi.doMock('./fixtures', () => ({ documentFixtures: withArchived }));
    return (await import('./handlers')).filterDocuments;
  };

  beforeEach(() => {
    vi.doUnmock('./fixtures');
    vi.resetModules();
  });

  it('hides archived documents when no state is asked for', async () => {
    const filter = await load();
    const { data } = filter(new URL('http://localhost/v1/documents'));

    expect(data.map((d) => d.id)).toEqual(['live-1']);
  });

  it('shows them when the archive is what was asked for', async () => {
    const filter = await load();
    const { data } = filter(new URL('http://localhost/v1/documents?state=ARCHIVED'));

    expect(data.map((d) => d.id)).toEqual(['archived-1']);
  });
});
