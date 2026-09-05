import type { z } from 'zod';

import type { DuplicateRecord } from '@neoting/contracts/model';
import type { listDuplicatesQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';

type ListDuplicatesQuery = z.infer<typeof listDuplicatesQueryParams>;

/**
 * `GET /v1/duplicates` — the recorded duplicate rulings (review item 49).
 *
 * One read, nothing else. The web derives its suspected-duplicate flags
 * client-side from the document list; this is what lets a pair a human RULED
 * on (`document.resolve-duplicate`, the Review → Approve spine) stay ruled
 * across reloads and colleagues instead of re-flagging on every visit.
 *
 * Tenancy is RLS and nothing else: `duplicates` is in the policy loop, so the
 * query runs inside `scopedDb` and the `businessId` clause below is a user
 * FILTER on an already-scoped set, never a guard (the chases-surface rule). A
 * business outside the caller's scope yields an empty list — the rows were
 * already invisible, and the answer never confirms the business exists.
 *
 * Not paginated, per the contract's own words: rulings number in the dozens
 * and the 500 `take` is the unbounded-load guard (Governance §5.1), not a
 * paging scheme. Newest decision first; undecided (PENDING) detector rows ride
 * along so a future surface can show them — the web filters by verdict.
 */
export class DuplicatesService {
  constructor(private readonly prisma: PrismaClient) {}

  async listDuplicates(ctx: ScopeContext, query: ListDuplicatesQuery): Promise<{ items: DuplicateRecord[] }> {
    const rows = await scopedDb(this.prisma, ctx, (db) =>
      db.duplicate.findMany({
        ...(query.businessId === undefined ? {} : { where: { businessId: query.businessId } }),
        orderBy: [{ decidedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: 500,
        select: { id: true, businessId: true, documentAId: true, documentBId: true, verdict: true, decidedAt: true },
      }),
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        businessId: row.businessId,
        documentAId: row.documentAId,
        documentBId: row.documentBId,
        verdict: row.verdict,
        decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
      })),
    };
  }
}
