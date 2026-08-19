import type { z } from 'zod';

import type { Prisma, Publish as PublishRow } from '@prisma/client';

import type { Publish } from '@neoting/contracts/model';
import type { listPublishesQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { dateField, type Page, type PageRequest, pageQuery, type SortField, toPage } from '../../common/pagination/cursor.js';
import { toPublish } from './publish-projection.js';

type ListQuery = z.infer<typeof listPublishesQueryParams>;

/**
 * **Newest first, and it is not a parameter.** `listPublishes` declares no
 * `sort` and no `order` in the contract — the description says "Publish
 * history, newest first" and that is the whole ordering surface. So the sort is
 * fixed here rather than read off a query the caller cannot set: an
 * accidentally-configurable sort would be an API the spec does not have.
 *
 * `createdAt` and not `completedAt`, deliberately. A QUEUED row has no
 * `completedAt` at all, and an attempt still in flight is the single most
 * interesting row on this list — sorting on the nullable column would file
 * every in-flight publish at the bottom (nulls last) behind history nobody is
 * waiting on. `createdAt` is `@default(now())` and NOT NULL, so `nullable` is
 * `false`: `common/pagination/cursor.ts` documents why that flag is
 * load-bearing — Prisma throws at runtime on `orderBy: { col: { sort, nulls } }`
 * for a required column.
 *
 * The `id` tie-break comes from `pageQuery`, and it matters more here than on
 * most lists: a batch fans out to one row per item, all written inside ONE
 * transaction, so a 40-item publish is 40 rows sharing a `createdAt` to the
 * microsecond. Without the tie-break those rows have no total order and a page
 * boundary landing inside the batch would skip and repeat rows.
 */
const CREATED_AT: SortField<PublishRow> = dateField<PublishRow>('createdAt', (row) => row.createdAt, false);

/**
 * `GET /v1/publishes` — the publish read surface (METH Stage 10, SoT §4 Stage
 * 10).
 *
 * **One method, and it reads.** `x-nt-side-effect: none` on the operation, and
 * structurally so: there is no mutating method on this class, so there is no
 * side-effect path outside Review → Approve for one to hide in (Governance
 * §10). Publishing is a `publish.batch` proposal; retrying a failed item is a
 * NEW proposal over that item, never a `POST /publishes/{id}/retry` here and
 * never a replay of the old attempt.
 *
 * **Tenancy is RLS, with no second mechanism.** The query runs inside
 * `scopedDb`, which sets the GUCs `publishes_tenant` reads
 * (`app_can_access_business(business_id)`, `prisma/sql/rls.sql`). Nothing below
 * adds a `practiceId` clause to *enforce* scope — a hand-written filter that
 * disagreed with the policy would be the more permissive of the two exactly
 * when it mattered. The `businessId` clause is a user-facing FILTER over an
 * already-scoped set.
 *
 * **There is no 404 on this surface at all**, which is the same rule as
 * documents stated the other way round: a list of rows RLS cannot see is an
 * empty page. A `businessId` the caller cannot reach returns `{ data: [] }` —
 * not 404, not 403 — because the rows were already invisible and the filter
 * simply matches none of them. Any other answer confirms whether that business
 * exists.
 */
export class PublishesService {
  constructor(private readonly prisma: PrismaClient) {}

  /** `GET /publishes` — publish attempts, newest first, keyset-paginated. */
  async listPublishes(ctx: ScopeContext, query: ListQuery): Promise<Page<Publish>> {
    const request: PageRequest<PublishRow> = {
      sort: CREATED_AT,
      order: 'desc',
      limit: query.limit,
      cursor: query.cursor,
      // The parsed query MINUS the cursor. `cursor: undefined` is load-bearing,
      // not tidiness: the fingerprint has to cover what identifies the LIST, and
      // the caller's position in it is not part of that. Folding the cursor into
      // the digest means the fingerprint sealed into page 1's cursor can never
      // match the one recomputed when that cursor comes back, and every page-2
      // request 400s with "issued for a different set of filters". That shipped
      // once on `GET /documents` (see modules/documents/CLAUDE.md); the
      // regression test below is a genuine two-page round trip, which is the
      // only shape that catches it.
      query: { ...query, cursor: undefined },
    };
    const seek = pageQuery(request);
    const filters = buildFilters(query);

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.publish.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.PublishOrderByWithRelationInput[],
        // `limit + 1`. The probe row is the whole `hasMore` mechanism — a
        // `COUNT(*)` over the same filters would double the work per page and
        // still be stale by the time it serialised.
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toPublish), pageInfo: page.pageInfo };
  }
}

/**
 * The two user-facing filters, applied ON TOP of what RLS already narrowed to.
 *
 * **Nothing in this function is a security boundary**, `businessId` included —
 * read that before adding anything here. It narrows a set the database has
 * already decided the caller may see.
 *
 * **An omitted `state` means EVERY state**, and that is the contract's own
 * words ("Repeat to widen. Omitted means every state."), deliberately unlike
 * `GET /documents`, where an omitted `state` excludes ARCHIVED. The asymmetry
 * is right: a document list is a working queue that would otherwise grow
 * forever, while publish history is an audit trail — hiding a state from it by
 * default would mean a failed publish quietly missing from the record of what
 * was attempted. So no default clause is added, and the no-filter `where` is
 * genuinely `{}`.
 *
 * A repeated `state` widens because the array becomes one `IN` — `?state=QUEUED
 * &state=FAILED` is "in flight or broken", the pair a human watching a batch
 * land actually wants, and it is one query rather than two round trips.
 */
function buildFilters(query: ListQuery): Prisma.PublishWhereInput {
  return {
    ...(query.businessId !== undefined ? { businessId: query.businessId } : {}),
    ...(query.state !== undefined && query.state.length > 0 ? { state: { in: query.state } } : {}),
  };
}
