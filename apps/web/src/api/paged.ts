import { unwrapBody } from './envelope';

/**
 * Reading a WHOLE list, rather than its first page and nothing else.
 *
 * ## ⚠ The defect this exists to close
 *
 * `AppContext` asked for `{ limit: 100 }` on bank transactions, documents and
 * businesses, and **nothing outside the tests ever read `nextCursor` or
 * `hasMore`.** `pageInfo` was parsed, plumbed through the api layer, returned
 * from every hook — and dropped at the call site. So a real client holding
 * 2,288 bank transactions had **95.6% of their financial records unreachable in
 * the product**, with no control, no message and no indication of any kind that
 * a limit had been applied.
 *
 * It was invisible because the old seed held 27 transactions. Every screen was
 * correct on demo data and silently wrong on real data — and not only the
 * table: the "unexplained" total on BankView, the unmatched KPI on Analytics,
 * every table footer count and the chase-candidate lists are all reduced over
 * the same truncated array, so they were quietly understating a client's
 * position by an order of magnitude while looking entirely normal.
 *
 * **Silently truncating a client's financial records is not acceptable; a
 * visible limit is.** This module makes the first case impossible and the
 * second loud.
 *
 * ## Why the fix is here and not "raise the limit"
 *
 * `limit` is capped at **100 by the contract** (`Limit` in `openapi.yaml`,
 * `minimum: 1, maximum: 100`), and the list envelopes are keyset-paginated with
 * an opaque cursor — deliberately, because offset pagination is forbidden by
 * Governance §3. There is no bigger number to ask for. The only honest read of
 * a long list is to follow the cursor to the end, which is what this does.
 *
 * ## The cap, and why there is one at all
 *
 * Following a cursor forever would let one client's history hold the app's
 * hydration open indefinitely — the practice-wide bank read is not scoped to
 * one business, so it is bounded by the whole firm's history rather than one
 * month of one client's. {@link MAX_PAGES} bounds it.
 *
 * ⚠ **Reaching the cap is REPORTED, never swallowed.** `truncated` rides back
 * to the caller, into `SliceStatus`, and onto the screen through
 * `DataSourceBadge`. That is the whole difference between this and the bug: a
 * limit the user can see is a limit; a limit they cannot see is a lie about how
 * much money moved.
 */

/**
 * The contract's own ceiling (`Limit.schema.maximum`). Asking for more is a
 * 400, so every page is asked for at exactly this size — fewer round trips for
 * the same rows.
 */
export const PAGE_LIMIT = 100;

/**
 * 50 pages — 5,000 rows at the contract's page size.
 *
 * Chosen against the case that produced the defect: 2,288 transactions is 23
 * pages, so a real client's full year loads complete with headroom to spare,
 * and the sequential round trips are a second or so of background hydration.
 * Beyond it the honest answer is to say so on screen and let the accountant
 * narrow the client or the period, rather than to spend a minute of a firm's
 * first paint discovering how much history it has.
 */
export const MAX_PAGES = 50;

/** What a list envelope carries. Read loosely — see {@link fetchAllPages}. */
interface LoosePageInfo {
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface AllPages {
  /** Each page's RAW body, in order, for the caller's own Zod parse. */
  readonly bodies: readonly unknown[];
  /** True when {@link MAX_PAGES} was reached and the server still had more. */
  readonly truncated: boolean;
}

/**
 * Follow `pageInfo.nextCursor` until the server says there is no more.
 *
 * `fetchPage` is the generated plain function for the endpoint — never the
 * generated *hook*, which fetches exactly one page and is the machinery this
 * replaces (it is also the cheaper import: the hook drags its query-key and
 * options builders onto the bundle floor, per the reachability rule in
 * `apps/web/CLAUDE.md`).
 *
 * ⚠ **`pageInfo` is read LOOSELY here and strictly by the caller, and the split
 * is deliberate.** This function decides only whether to ask for another page —
 * it renders nothing and trusts nothing. Every page's body still goes through
 * the endpoint's generated Zod schema in the hook above it, so a drift in the
 * ROWS is caught exactly as before. Parsing strictly here as well would mean a
 * schema mismatch on page 7 discarding the six good pages before it.
 *
 * A page that returns `hasMore: true` with no cursor STOPS rather than looping:
 * a server that cannot say where the next page starts has not got one, and an
 * unbounded retry of the same page is how a browser tab pins a CPU.
 */
export async function fetchAllPages(
  fetchPage: (cursor: string | undefined) => Promise<unknown>,
  maxPages: number = MAX_PAGES,
): Promise<AllPages> {
  const bodies: unknown[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const body = unwrapBody(await fetchPage(cursor));
    bodies.push(body);

    const info = (body as { pageInfo?: LoosePageInfo } | null)?.pageInfo;
    const next = typeof info?.nextCursor === 'string' && info.nextCursor.length > 0 ? info.nextCursor : undefined;
    if (info?.hasMore !== true || next === undefined) return { bodies, truncated: false };
    cursor = next;
  }

  // The cap, reached. The caller reports it; nothing here hides it.
  return { bodies, truncated: true };
}
