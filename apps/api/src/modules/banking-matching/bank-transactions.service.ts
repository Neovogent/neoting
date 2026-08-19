import type { z } from 'zod';

import type { BankTransaction } from '@neoting/contracts/model';
import { listBankTransactionsQueryParams } from '@neoting/contracts/zod';
import type { BankTransaction as BankTransactionRow, Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { toBankTransaction } from './bank-transaction-response.js';

type ListQuery = z.infer<typeof listBankTransactionsQueryParams>;

/**
 * The one sort order this endpoint has.
 *
 * `listBankTransactions` declares no `sort` or `order` parameter — the contract
 * fixes the answer in prose instead ("The normalised feed, newest first" /
 * "A page of transactions, newest booked first"). So the sort is a constant
 * here rather than a lookup table: there is no caller-supplied column to
 * validate, and offering one would be inventing contract surface.
 *
 * `nullable: false` because `booked_at` is required in the schema — Prisma
 * throws at runtime on `orderBy: { col: { sort, nulls } }` for a required
 * column, which is the trap `common/pagination/cursor.ts` documents.
 */
const BOOKED_AT = dateField<BankTransactionRow>('bookedAt', (row) => row.bookedAt, false);

/**
 * The bank read surface (METH Stage 11, SoT §4 Stage 7).
 *
 * **One GET, and no write anywhere on this class** — structurally, the way the
 * documents service has no write. Confirming a match is a `bank.confirm-match`
 * proposal on the Review → Approve spine (Governance §10); there is no
 * `PATCH /bank-transactions/{id}` and none may exist, so the absence of a
 * mutating method here is the enforcement rather than a promise in prose. The
 * contract says the same thing: `x-nt-side-effect: none`.
 *
 * **Tenancy is RLS and nothing else.** Every query runs inside `scopedDb`;
 * nothing here adds a `businessId` clause to *enforce* scope. The optional
 * `businessId` filter below narrows a set RLS has already bounded — a
 * hand-written tenancy filter alongside a policy is two mechanisms that can
 * disagree, and the more permissive one wins exactly when it matters. Asking
 * for a business the caller cannot reach returns an empty page: the rows were
 * already invisible, so the filter matches none of them, and the answer never
 * confirms whether that business exists (404-never-403, applied to a list).
 *
 * **The unmatched set this returns is the set chase detection reads.** Both
 * read `match_state` and `chase_suppressed` off the same rows, so the Bank
 * screen and the chase list cannot disagree — which is why the confirm-match
 * executor flips `match_state` rather than writing a `matches` row alone.
 */
export class BankTransactionsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listBankTransactions(ctx: ScopeContext, query: ListQuery): Promise<Page<BankTransaction>> {
    const request: PageRequest<BankTransactionRow> = {
      sort: BOOKED_AT,
      order: 'desc',
      limit: query.limit,
      cursor: query.cursor,
      // The parsed query MINUS the cursor. `cursor` is a field OF the query, so
      // folding it into the fingerprint would make every page-2 request 400 —
      // the bug `modules/documents/CLAUDE.md` records in full. The fingerprint
      // identifies the LIST; the caller's position in it is not part of that.
      query: { ...query, cursor: undefined },
    };
    const seek = pageQuery(request);
    const filters = buildFilters(query);

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.bankTransaction.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.BankTransactionOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toBankTransaction), pageInfo: page.pageInfo };
  }
}

/**
 * The caller's filters, and **not** a security boundary — RLS is. Every clause
 * here narrows what the policies already allow; none of them may widen it.
 *
 * All three are absent-means-everything, which is the contract's own wording:
 * `matchState` is "Repeat to widen. Omitted means every state." There is no
 * hidden default the way `GET /documents` excludes ARCHIVED — a bank feed has
 * no archive, and a transaction quietly missing from the Bank screen is a
 * reconciliation that silently never balances.
 */
function buildFilters(query: ListQuery): Prisma.BankTransactionWhereInput {
  return {
    ...(query.businessId !== undefined ? { businessId: query.businessId } : {}),
    ...(query.accountId !== undefined ? { accountId: query.accountId } : {}),
    // `length > 0` matters: an explicitly empty `matchState` array would
    // otherwise compile to `{ in: [] }`, which matches nothing and reads on
    // screen as "the feed is empty" rather than "you filtered everything out".
    ...(query.matchState !== undefined && query.matchState.length > 0
      ? { matchState: { in: query.matchState } }
      : {}),
  };
}
