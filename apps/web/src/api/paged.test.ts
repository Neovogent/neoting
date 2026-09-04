import { describe, expect, test } from 'vitest';

import { fetchAllPages, MAX_PAGES, PAGE_LIMIT } from './paged';

/**
 * ⚠ The regression this file exists to hold down.
 *
 * `AppContext` asked for `{ limit: 100 }` on three slices and **nothing outside
 * the tests ever read `nextCursor` or `hasMore`** — `pageInfo` was parsed,
 * returned from every hook, and dropped. A real client with 2,288 bank
 * transactions had 95.6% of their financial records unreachable in the product,
 * with no message and no control, and every figure derived from the array (the
 * "unexplained" total, the footer counts, the chase candidates) was reduced over
 * the 4.4% that made it. It was invisible because the old seed held 27 rows.
 *
 * So the assertions below are about exactly two things: that the whole list is
 * read, and that the one case where it cannot be is REPORTED rather than
 * swallowed. Silently truncating a client's financial records is not
 * acceptable; a visible limit is.
 */

/** A server with `total` rows, paged, that records what it was asked for. */
function server(total: number, pageSize = PAGE_LIMIT) {
  const asked: (string | undefined)[] = [];
  return {
    asked,
    fetchPage: async (cursor: string | undefined) => {
      asked.push(cursor);
      const offset = cursor === undefined ? 0 : Number(cursor);
      const rows = Array.from({ length: Math.min(pageSize, total - offset) }, (_, i) => ({ id: `r${offset + i}` }));
      const next = offset + rows.length;
      return {
        data: rows,
        pageInfo: { nextCursor: next < total ? String(next) : null, hasMore: next < total },
      };
    },
  };
}

const rowsOf = (bodies: readonly unknown[]) => bodies.flatMap((b) => (b as { data: unknown[] }).data);

describe('reading a whole list', () => {
  test('⚠ 2,288 rows come back as 2,288 rows, not 100', async () => {
    // The exact shape of the defect, at the exact size it was found at.
    const s = server(2_288);
    const { bodies, truncated } = await fetchAllPages(s.fetchPage);

    expect(rowsOf(bodies)).toHaveLength(2_288);
    expect(truncated).toBe(false);
    // 23 requests: 22 full pages and a 88-row remainder.
    expect(s.asked).toHaveLength(23);
    expect(s.asked[0]).toBeUndefined();
  });

  test('a single short page is one request and no cursor', async () => {
    const s = server(27);
    const { bodies, truncated } = await fetchAllPages(s.fetchPage);
    expect(rowsOf(bodies)).toHaveLength(27);
    expect(truncated).toBe(false);
    expect(s.asked).toEqual([undefined]);
  });

  test('an exactly-full page still asks once more, because the server says so', async () => {
    // `hasMore` is the server's answer, never inferred from the row count — a
    // list whose length happens to be a multiple of the page size is the classic
    // off-by-one place to lose the last page.
    const s = server(PAGE_LIMIT);
    expect(rowsOf((await fetchAllPages(s.fetchPage)).bodies)).toHaveLength(PAGE_LIMIT);
    expect(s.asked).toEqual([undefined]);
  });

  test('an empty list is one request and no rows', async () => {
    const { bodies, truncated } = await fetchAllPages(server(0).fetchPage);
    expect(rowsOf(bodies)).toHaveLength(0);
    expect(truncated).toBe(false);
  });

  test('each page carries the cursor the previous one returned', async () => {
    const s = server(250);
    await fetchAllPages(s.fetchPage);
    expect(s.asked).toEqual([undefined, '100', '200']);
  });
});

describe('the cap is REPORTED, never swallowed', () => {
  test('reaching it sets truncated', async () => {
    const { bodies, truncated } = await fetchAllPages(server(1_000).fetchPage, 3);
    expect(rowsOf(bodies)).toHaveLength(300);
    // The whole point: the caller now knows the list on screen is partial and
    // can say so. The bug was that nobody could tell.
    expect(truncated).toBe(true);
  });

  test('stopping exactly at the end is NOT truncated', async () => {
    // An off-by-one here would put a permanent amber "there are more" badge on a
    // complete list, which teaches accountants to ignore the one warning that
    // matters.
    const { truncated } = await fetchAllPages(server(300).fetchPage, 3);
    expect(truncated).toBe(false);
  });

  test('the default cap covers a real client several times over', () => {
    // 2,288 transactions is 23 pages. The cap is not a number to be tuned
    // casually — it is the boundary between "the whole ledger" and "a warning".
    expect(MAX_PAGES * PAGE_LIMIT).toBeGreaterThan(2_288);
  });
});

describe('it cannot loop', () => {
  test('hasMore with no cursor STOPS', async () => {
    // A server that cannot say where the next page starts has not got one.
    // Asking again would re-fetch the same page forever and pin the tab.
    let calls = 0;
    const { bodies, truncated } = await fetchAllPages(async () => {
      calls += 1;
      return { data: [{ id: 'a' }], pageInfo: { nextCursor: null, hasMore: true } };
    });
    expect(calls).toBe(1);
    expect(rowsOf(bodies)).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  test('an empty-string cursor is treated as absent', async () => {
    let calls = 0;
    await fetchAllPages(async () => {
      calls += 1;
      return { data: [], pageInfo: { nextCursor: '', hasMore: true } };
    });
    expect(calls).toBe(1);
  });

  test('a body with no pageInfo at all stops after one page', async () => {
    let calls = 0;
    await fetchAllPages(async () => {
      calls += 1;
      return { data: [{ id: 'a' }] };
    });
    expect(calls).toBe(1);
  });
});

describe('the envelope', () => {
  test('the generated `{ data, status }` wrapper is unwrapped per page', async () => {
    // orval types every operation as a status-discriminated envelope while the
    // mutator returns the raw body. `documents.ts` shipped reading one level too
    // deep once already; this is the same trap, once per page.
    const { bodies } = await fetchAllPages(async () => ({
      status: 200,
      data: { data: [{ id: 'a' }], pageInfo: { nextCursor: null, hasMore: false } },
    }));
    expect(rowsOf(bodies)).toEqual([{ id: 'a' }]);
  });
});
