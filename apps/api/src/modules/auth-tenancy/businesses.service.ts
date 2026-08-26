import type { z } from 'zod';

import type { BusinessSummary } from '@neoting/contracts/model';
import type { listBusinessesQueryParams } from '@neoting/contracts/zod';
import type { Business as BusinessRow, DocumentState, Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { type Page, type PageRequest, pageQuery, scalarField, toPage } from '../../common/pagination/cursor.js';
import { toBusinessSubscription } from '../billing/index.js';

type ListQuery = z.infer<typeof listBusinessesQueryParams>;

/**
 * The one sort order this endpoint has. The contract fixes it in prose
 * ("A page of workspaces, alphabetical") and declares no `sort` parameter, so
 * it is a constant, not a lookup table. `name` is required in the schema, so
 * `nullable: false` — Prisma throws on the `{ sort, nulls }` shape for a
 * required column (the trap `common/pagination/cursor.ts` documents).
 */
const NAME = scalarField<BusinessRow>('name', (row) => row.name, false);

/**
 * The document states the header badges count, and where each lands. The
 * contract's `BusinessSummary.counts` groups exactly three ways: `toReview`,
 * `ready`, and `failed` — "REJECTED and FAILED together", its own words —
 * so the fold is a table, not arithmetic scattered over branches.
 */
const COUNTED: Partial<Record<DocumentState, keyof BusinessSummary['counts']>> = {
  TO_REVIEW: 'toReview',
  READY: 'ready',
  REJECTED: 'failed',
  FAILED: 'failed',
};

/**
 * The businesses read surface (METH Stage 6; contracted in Stage 2 #120).
 *
 * `GET /me` answers "who am I"; this answers "what is waiting where" — the
 * context header, the client switcher and the Clients list all render from it.
 *
 * **One GET, no write anywhere on this class.** Businesses are created by
 * onboarding (post-demo surface), never here — `x-nt-side-effect: none`.
 *
 * **Tenancy is RLS and nothing else.** Both queries run inside one `scopedDb`
 * transaction: the page of businesses is whatever the policies make visible
 * (exactly the same set `/me` reports, because it is the same context), and
 * the counts aggregate can only ever count documents the caller could list
 * anyway. No hand-written practice/business clause narrows or widens it.
 *
 * **One cheap aggregate, not N queries.** The counts come from a single
 * `groupBy (businessId, state)` over the page's ids — the "one cheap
 * aggregate" the contract description promises. Unrouted documents have no
 * `businessId` and are excluded by the `in` filter, which is also the
 * contract's wording: "counted nowhere here".
 */
export class BusinessesService {
  constructor(private readonly prisma: PrismaClient) {}

  async listBusinesses(ctx: ScopeContext, query: ListQuery): Promise<Page<BusinessSummary>> {
    const request: PageRequest<BusinessRow> = {
      sort: NAME,
      order: 'asc',
      limit: query.limit,
      cursor: query.cursor,
      // The parsed query MINUS the cursor — the fingerprint identifies the
      // LIST, not the caller's position in it (see modules/documents/CLAUDE.md).
      query: { ...query, cursor: undefined },
    };
    const seek = pageQuery(request);

    const { rows, grouped } = await scopedDb(this.prisma, ctx, async (db) => {
      const rows = await db.business.findMany({
        // Spread, not `where: seek.where` — under exactOptionalPropertyTypes
        // an explicit `undefined` is not the same as an absent key, and there
        // are no caller filters here to AND it with (the endpoint takes none).
        ...(seek.where === undefined ? {} : { where: seek.where as Prisma.BusinessWhereInput }),
        orderBy: seek.orderBy as Prisma.BusinessOrderByWithRelationInput[],
        take: seek.take,
      });
      // Grouped over the fetched ids (at most limit + 1 — the extra row's
      // counts are computed and discarded, which is cheaper than a second
      // round-trip after the trim).
      const grouped = await db.document.groupBy({
        by: ['businessId', 'state'],
        where: {
          businessId: { in: rows.map((row) => row.id) },
          state: { in: Object.keys(COUNTED) as DocumentState[] },
        },
        _count: { _all: true },
      });
      return { rows, grouped };
    });

    const counts = foldCounts(grouped);
    const page = toPage(rows, request);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        name: row.name,
        tradingName: row.tradingName,
        counts: counts.get(row.id) ?? { toReview: 0, ready: 0, failed: 0 },
        // The D48 projection, from the four columns already on the row — no
        // second query and no second round-trip. `error-codes.md` asks for it
        // by name under NT-BIL-002: the subscribe call-to-action must not
        // render for a business that already has a subscription, and a lapsed
        // client should show in the switcher rather than being discovered at
        // the next upload. Null for a business that has never been to
        // checkout, which is what the contract says the field means.
        subscription: toBusinessSubscription(row),
      })),
      pageInfo: page.pageInfo,
    };
  }
}

/** The groupBy rows folded into per-business badge counts. Exported for its test. */
export function foldCounts(
  grouped: ReadonlyArray<{ businessId: string | null; state: DocumentState; _count: { _all: number } }>,
): Map<string, BusinessSummary['counts']> {
  const byBusiness = new Map<string, BusinessSummary['counts']>();
  for (const row of grouped) {
    const bucket = COUNTED[row.state];
    if (row.businessId === null || bucket === undefined) continue;
    const counts = byBusiness.get(row.businessId) ?? { toReview: 0, ready: 0, failed: 0 };
    counts[bucket] += row._count._all;
    byBusiness.set(row.businessId, counts);
  }
  return byBusiness;
}
