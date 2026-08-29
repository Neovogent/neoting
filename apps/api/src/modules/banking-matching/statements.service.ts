import { Injectable } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';

/**
 * `GET /v1/statements` — where a client's bank data came from, and what the
 * completeness gate could prove about it (D40/D41).
 *
 * ## Why this endpoint had to exist
 *
 * ⚠ **A verdict nobody can see is not a gate.** The import lane has written
 * `assurance` since the day it shipped, and nothing could read it: the
 * accountant's Statements tab was seed data, so a statement the product had
 * *proven* incomplete looked exactly like one it had proven whole. The first
 * real statement through the pipeline imported 1,144 transactions and reported
 * `incomplete` — correctly — and that verdict reached nobody.
 *
 * D41 is a claim about what the product can demonstrate. Demonstrating it needs
 * a surface, and this is it.
 *
 * ## It is provenance, not rows
 *
 * The transactions are `GET /bank-transactions`. This answers "which file did
 * these come from, for what period, and what did we fail to prove about it" —
 * which is also D43's resolvable link from an exported line back to its source
 * document.
 */

/** The shape `completeness.ts` writes into `Statement.gapAnalysis`. */
interface StoredGapAnalysis {
  readonly assurance?: unknown;
  readonly provenBy?: unknown;
  readonly findings?: unknown;
}

export interface StatementFindingView {
  readonly kind: string;
  readonly detail: string;
  readonly sourceLine: number | null;
  readonly amountPence: number | null;
}

export interface StatementView {
  readonly id: string;
  readonly businessId: string;
  readonly documentId: string | null;
  readonly fileName: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly openingBalancePence: number | null;
  readonly closingBalancePence: number | null;
  readonly rowCount: number;
  readonly assurance: 'complete' | 'reduced' | 'incomplete';
  readonly provenBy: string | null;
  readonly findings: readonly StatementFindingView[];
  readonly createdAt: string;
}

/** `YYYY-MM-DD` in UTC — the storage instant, rendered as the date it is. */
function toIsoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * Read the verdict off the stored blob, defensively.
 *
 * ⚠ `gapAnalysis` is a `Json?` column, so a row written by an older build — or
 * by a future one — may carry anything at all. An unrecognised shape reports
 * **`reduced`**, never `complete`: the one thing this must never do is claim a
 * statement was proven whole because its analysis was unreadable.
 */
function readAssurance(value: unknown): 'complete' | 'reduced' | 'incomplete' {
  const stored = (value as StoredGapAnalysis | null)?.assurance;
  return stored === 'complete' || stored === 'incomplete' ? stored : 'reduced';
}

function readFindings(value: unknown): StatementFindingView[] {
  const raw = (value as StoredGapAnalysis | null)?.findings;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const kind = typeof row['kind'] === 'string' ? row['kind'] : typeof row['reason'] === 'string' ? row['reason'] : null;
    if (kind === null) return [];
    return [
      {
        kind,
        // The finding's own words where it has them, the kind otherwise — an
        // accountant must never be shown a bare enum value.
        detail: typeof row['detail'] === 'string' ? row['detail'] : kind,
        sourceLine: typeof row['sourceLine'] === 'number' ? row['sourceLine'] : null,
        amountPence: typeof row['amountPence'] === 'number' ? row['amountPence'] : null,
      },
    ];
  });
}

@Injectable()
export class StatementsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Newest period first, then newest import — a client who uploads the same
   * month twice sees the latest attempt at the top.
   *
   * ⚠ The `businessId` filter NARROWS a set RLS has already bounded; it does not
   * enforce scope. A business outside the caller's reach matches nothing and
   * yields an empty page, which is the same answer as "that client has no
   * statements" and never confirms whether the business exists.
   */
  async listStatements(ctx: ScopeContext, businessId?: string): Promise<StatementView[]> {
    const rows = await scopedDb(this.prisma, ctx, (db) =>
      db.statement.findMany({
        where: businessId === undefined ? {} : { businessId },
        orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          businessId: true,
          documentId: true,
          periodStart: true,
          periodEnd: true,
          openingBalancePence: true,
          closingBalancePence: true,
          rowCount: true,
          gapAnalysis: true,
          createdAt: true,
        },
      }),
    );

    // The filename lives on the document, and a statement is worth recognising
    // by the file it came from. One query for the batch rather than one each.
    const documentIds = rows.flatMap((row) => (row.documentId === null ? [] : [row.documentId]));
    const names =
      documentIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await scopedDb(this.prisma, ctx, (db) =>
                db.document.findMany({
                  where: { id: { in: documentIds } },
                  select: { id: true, originalFilename: true },
                }),
              )
            ).map((doc) => [doc.id, doc.originalFilename]),
          );

    return rows.map((row) => ({
      id: row.id,
      businessId: row.businessId,
      documentId: row.documentId,
      fileName: row.documentId === null ? null : (names.get(row.documentId) ?? null),
      periodStart: toIsoDate(row.periodStart),
      periodEnd: toIsoDate(row.periodEnd),
      openingBalancePence: row.openingBalancePence,
      closingBalancePence: row.closingBalancePence,
      rowCount: row.rowCount ?? 0,
      assurance: readAssurance(row.gapAnalysis),
      provenBy:
        typeof (row.gapAnalysis as StoredGapAnalysis | null)?.provenBy === 'string'
          ? ((row.gapAnalysis as StoredGapAnalysis).provenBy as string)
          : null,
      findings: readFindings(row.gapAnalysis),
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
