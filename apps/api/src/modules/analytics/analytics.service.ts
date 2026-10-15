import { HttpStatus } from '@nestjs/common';
import type { AnalyticsReport } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { buildAnalyticsReport, reportToCsv } from './analytics-report.js';

export const ANALYTICS_SERVICE = Symbol('ANALYTICS_SERVICE');

const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 366;

export interface PeriodQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** `from`/`to` → UTC midnights. Default: the last 30 days ending today. */
export function resolvePeriod(query: PeriodQuery, now: Date): { from: Date; to: Date } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = query.to === undefined ? today : new Date(`${query.to}T00:00:00.000Z`);
  const from = query.from === undefined ? new Date(to.getTime() - 29 * DAY_MS) : new Date(`${query.from}T00:00:00.000Z`);
  if (from > to || (to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_SPAN_DAYS) {
    throw new AppException(
      'NT-VAL-001',
      HttpStatus.BAD_REQUEST,
      'Invalid period',
      `The period must run forwards and span at most ${MAX_SPAN_DAYS} days.`,
    );
  }
  return { from, to };
}

/** SoT §11 pipeline analytics. Read-only; every query through `scopedDb`. */
export class AnalyticsService {
  constructor(private readonly prisma: PrismaClient) {}

  async report(ctx: ScopeContext, businessId: string | null, query: PeriodQuery): Promise<AnalyticsReport> {
    const now = new Date();
    const { from, to } = resolvePeriod(query, now);
    return scopedDb(
      this.prisma,
      ctx,
      async (db) => {
        if (businessId !== null) {
          // RLS decides visibility; an id the caller cannot see is a 404, never a 403.
          const visible = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
          if (visible === null) {
            throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'The requested record does not exist.');
          }
        }
        return buildAnalyticsReport(db, { businessId, from, to, now });
      },
      { timeoutMs: 20_000 },
    );
  }

  async csv(ctx: ScopeContext, businessId: string | null, query: PeriodQuery): Promise<string> {
    return reportToCsv(await this.report(ctx, businessId, query));
  }
}
