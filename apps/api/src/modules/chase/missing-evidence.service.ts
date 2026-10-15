import { HttpStatus } from '@nestjs/common';
import type { MissingEvidence as MissingEvidenceRow, Prisma } from '@prisma/client';
import type { z } from 'zod';

import type { ChaseSuppressionSettings, MissingEvidenceItem } from '@neoting/contracts/model';
import type {
  dismissMissingEvidenceBody,
  listMissingEvidenceQueryParams,
  replaceChaseSuppressionBody,
} from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { type ScopedClient, scopedDb } from '../../common/db/scoped-db.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { detectMissingEvidenceForBusiness, type DetectionResult, type LedgerUnattachedReader } from './missing-evidence.js';
import { DEFAULT_CLIENT_SUPPRESSION_KEYWORDS, loadClientSuppression, supplierKey } from './suppression.js';

type ListQuery = z.infer<typeof listMissingEvidenceQueryParams>;
type DismissBody = z.infer<typeof dismissMissingEvidenceBody>;
type SuppressionBody = z.infer<typeof replaceChaseSuppressionBody>;

const SORT = dateField<MissingEvidenceRow>('createdAt', (row) => row.createdAt, false);

/**
 * The accountant's half of detection: read findings, dismiss one ("no receipt
 * exists" teaches the client's suppression), run detection now, and edit the
 * client's suppression list. Every query through `scopedDb`; RLS decides reach.
 * None of it changes accounting state or messages a client.
 */
export class MissingEvidenceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger?: LedgerUnattachedReader,
  ) {}

  async list(ctx: ScopeContext, query: ListQuery): Promise<Page<MissingEvidenceItem>> {
    const request: PageRequest<MissingEvidenceRow> = {
      sort: SORT,
      order: 'desc',
      limit: query.limit,
      cursor: query.cursor,
      query: { businessId: query.businessId, state: query.state },
    };
    const seek = pageQuery(request);
    const filters: Prisma.MissingEvidenceWhereInput = {
      state: { in: query.state ?? ['OPEN'] },
      ...(query.businessId === undefined ? {} : { businessId: query.businessId }),
    };
    const rows = await scopedDb(this.prisma, ctx, (db) =>
      db.missingEvidence.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.MissingEvidenceOrderByWithRelationInput[],
        take: seek.take,
      }),
    );
    const page = toPage(rows, request);
    return { data: page.data.map(toItem), pageInfo: page.pageInfo };
  }

  async scan(ctx: ScopeContext, businessId: string): Promise<DetectionResult> {
    await scopedDb(this.prisma, ctx, (db) => requireBusiness(db, businessId));
    return detectMissingEvidenceForBusiness(this.prisma, ctx, businessId, this.ledger === undefined ? {} : { ledger: this.ledger });
  }

  async dismiss(ctx: ScopeContext, itemId: string, body: DismissBody): Promise<void> {
    await scopedDb(this.prisma, ctx, async (db) => {
      const item = await db.missingEvidence.findUnique({ where: { id: itemId } });
      if (item === null) throw notFound('No finding with that id.');
      const now = new Date();
      await db.missingEvidence.updateMany({
        where: { id: itemId, state: 'OPEN' },
        data: { state: 'SUPPRESSED', resolvedReason: body.reason, resolvedAt: now },
      });

      const key = item.supplierName === null ? '' : supplierKey(item.supplierName);
      if (body.reason !== 'no-receipt' || body.rememberSupplier === false || key === '') return;
      const current = await loadClientSuppression(db, item.businessId);
      if (!current.noReceiptSuppliers.includes(key)) {
        const noReceiptSuppliers = [...current.noReceiptSuppliers, key];
        await db.chaseSuppressionSetting.upsert({
          where: { businessId: item.businessId },
          create: { businessId: item.businessId, keywords: [...current.keywords], noReceiptSuppliers },
          update: { noReceiptSuppliers },
        });
      }
      // The same supplier's other open findings were answered by this one.
      const siblings = await db.missingEvidence.findMany({
        where: { businessId: item.businessId, state: 'OPEN', supplierName: { not: null } },
        select: { id: true, supplierName: true },
      });
      const ids = siblings.filter((s) => s.supplierName !== null && supplierKey(s.supplierName) === key).map((s) => s.id);
      if (ids.length > 0) {
        await db.missingEvidence.updateMany({
          where: { id: { in: ids }, state: 'OPEN' },
          data: { state: 'SUPPRESSED', resolvedReason: 'no-receipt-learned', resolvedAt: now },
        });
      }
    });
  }

  async getSuppression(ctx: ScopeContext, businessId: string): Promise<ChaseSuppressionSettings> {
    return scopedDb(this.prisma, ctx, async (db) => {
      await requireBusiness(db, businessId);
      return toSettings(businessId, await loadClientSuppression(db, businessId));
    });
  }

  async replaceSuppression(ctx: ScopeContext, businessId: string, body: SuppressionBody): Promise<ChaseSuppressionSettings> {
    const keywords = body.keywords === null ? null : unique(body.keywords.map((k) => k.trim().toUpperCase()));
    const noReceiptSuppliers = unique(body.noReceiptSuppliers.map(supplierKey));
    return scopedDb(this.prisma, ctx, async (db) => {
      await requireBusiness(db, businessId);
      if (keywords === null && noReceiptSuppliers.length === 0) {
        await db.chaseSuppressionSetting.deleteMany({ where: { businessId } });
      } else {
        const data = { keywords: keywords ?? [...DEFAULT_CLIENT_SUPPRESSION_KEYWORDS], noReceiptSuppliers };
        await db.chaseSuppressionSetting.upsert({ where: { businessId }, create: { businessId, ...data }, update: data });
      }
      return toSettings(businessId, await loadClientSuppression(db, businessId));
    });
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v !== ''))];
}

function toSettings(
  businessId: string,
  s: { keywords: readonly string[]; noReceiptSuppliers: readonly string[]; isDefault: boolean },
): ChaseSuppressionSettings {
  return {
    businessId,
    keywords: [...s.keywords],
    defaultKeywords: [...DEFAULT_CLIENT_SUPPRESSION_KEYWORDS],
    isDefault: s.isDefault,
    noReceiptSuppliers: [...s.noReceiptSuppliers],
  };
}

function toItem(row: MissingEvidenceRow): MissingEvidenceItem {
  return {
    id: row.id,
    businessId: row.businessId,
    engine: row.engine,
    state: row.state,
    supplierName: row.supplierName,
    amountPence: row.amountPence,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    period: row.period,
    description: row.description,
    transactionId: row.transactionId,
    resolvedReason: row.resolvedReason,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireBusiness(db: ScopedClient, businessId: string): Promise<void> {
  const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
  if (business === null) throw notFound('No client with that id.');
}

function notFound(detail: string): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', detail);
}
