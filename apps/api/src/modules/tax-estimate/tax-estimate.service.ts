import { HttpStatus } from '@nestjs/common';
import type { TaxEstimate, TaxEstimateView } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';
import { AppException } from '../../common/problem/problem.js';
import { mayUseTaxEstimate } from '../billing/index.js';
import { type PortalSessionFacts, systemScopeFor } from '../portal/index.js';
import { accountCatalogue } from '../rules-suggestions/index.js';
import {
  type AccountFacts,
  type BankFacts,
  type EstimateDocument,
  type EstimateKind,
  estimate,
  periodDays,
  type VatScheme,
} from './estimate.js';

export interface EstimateQuery {
  readonly kind: EstimateKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly vatScheme?: VatScheme | undefined;
  readonly flatRateBasisPoints?: number | undefined;
}

/** Documents a person or the pipeline has finished reading; RECEIVED/PROCESSING/REJECTED/FAILED say nothing yet. */
const COUNTED_STATES = ['TO_REVIEW', 'READY', 'PUBLISHED'] as const;
const REVIEWED = new Set<string>(['READY', 'PUBLISHED']);
const MAX_PERIOD_DAYS = 400;
/**
 * Payments to or from the tax authority are not purchases: a VAT payment to
 * HMRC carries no input VAT, and counting it as "a payment with no receipt"
 * would widen the range by a sixth of the client's own VAT bill.
 */
const TAX_AUTHORITY = /\b(HMRC|ATO|AUSTRALIAN TAXATION OFFICE)\b/i;

/**
 * The tax estimate add-on (D52, SoT §25) — gathers one client's documents,
 * bank lines and statement coverage for a period and hands them to the pure
 * `estimate()`. Reads only; there is nothing here that writes.
 */
export class TaxEstimateService {
  constructor(private readonly prisma: PrismaClient) {}

  async forPractice(ctx: ScopeContext, businessId: string, query: EstimateQuery): Promise<TaxEstimateView> {
    return scopedDb(this.prisma, ctx, (db) => this.compute(db, businessId, query));
  }

  /**
   * ⚠ The portal path runs in the practice SYSTEM scope, which can see every
   * business in the practice — so the business is ALWAYS `facts.businessId`,
   * never anything a caller sent.
   */
  async forPortal(facts: PortalSessionFacts, query: EstimateQuery): Promise<TaxEstimateView> {
    return scopedDb(this.prisma, systemScopeFor(facts), (db) => this.compute(db, facts.businessId, query));
  }

  private async compute(db: ScopedClient, businessId: string, query: EstimateQuery): Promise<TaxEstimateView> {
    const business = await db.business.findUnique({
      where: { id: businessId },
      select: {
        countryCode: true,
        baseCurrency: true,
        vatRegistered: true,
        vatScheme: true,
        legalStructure: true,
        subscriptionStatus: true,
        taxEstimateAddon: true,
      },
    });
    if (business === null) {
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No such client business.');
    }
    if (!mayUseTaxEstimate(business)) return { active: false, estimate: null };

    assertPeriod(query);
    const country = business.countryCode === 'AU' ? 'AU' : 'GB';
    const scheme: VatScheme =
      query.vatScheme ?? (business.vatScheme === 'FLAT_RATE' && query.flatRateBasisPoints !== undefined ? 'FLAT_RATE' : 'STANDARD');
    if (scheme === 'FLAT_RATE' && query.flatRateBasisPoints === undefined) {
      throw new AppException(
        'NT-VAL-001',
        HttpStatus.BAD_REQUEST,
        'Flat rate needed',
        'The Flat Rate Scheme needs its percentage (flatRateBasisPoints).',
      );
    }

    const start = new Date(`${query.periodStart}T00:00:00Z`);
    const endExclusive = new Date(Date.parse(`${query.periodEnd}T00:00:00Z`) + 86_400_000);
    const inWorkflow = {
      businessId,
      ...notDeleted(),
      archivedAt: null,
      state: { in: [...COUNTED_STATES] },
      inbox: { in: ['SALES' as const, 'COSTS' as const] },
      OR: [{ docType: null }, { docType: { not: 'STATEMENT' as const } }],
    };

    // One after another, not Promise.all: they share one interactive transaction.
    const rows = await db.document.findMany({
      where: { ...inWorkflow, documentDate: { gte: start, lt: endExclusive } },
      select: {
        id: true,
        supplierName: true,
        customerName: true,
        originalFilename: true,
        documentDate: true,
        inbox: true,
        docType: true,
        totalPence: true,
        taxPence: true,
        currency: true,
        categoryCode: true,
        state: true,
      },
      orderBy: { documentDate: 'asc' },
    });
    const undated = await db.document.count({
      where: {
        ...inWorkflow,
        documentDate: null,
        receivedAt: { gte: start, lt: endExclusive },
      },
    });
    const transactions = await db.bankTransaction.findMany({
      where: { businessId, bookedAt: { gte: start, lt: endExclusive } },
      select: {
        amountPence: true,
        matchState: true,
        chaseSuppressed: true,
        descriptionRaw: true,
        bookedAt: true,
      },
    });
    const statements = await db.statement.findMany({
      where: {
        businessId,
        periodStart: { lt: endExclusive },
        periodEnd: { gte: start },
      },
      select: { periodStart: true, periodEnd: true },
    });

    const accounts = new Map<string, AccountFacts>(accountCatalogue().map((a) => [a.code, a]));
    const home = country === 'AU' ? 'AUD' : 'GBP';
    let otherCurrency = 0;
    const documents: EstimateDocument[] = [];
    for (const row of rows) {
      if (row.totalPence === null || row.documentDate === null) continue;
      if (row.currency !== null && row.currency.toUpperCase() !== home) {
        otherCurrency += 1;
        continue;
      }
      const inbox = row.inbox === 'SALES' ? 'SALES' : 'COSTS';
      documents.push({
        id: row.id,
        label: (inbox === 'SALES' ? row.customerName : row.supplierName) ?? row.originalFilename,
        date: row.documentDate.toISOString().slice(0, 10),
        inbox,
        creditNote: row.docType === 'CREDIT_NOTE',
        totalPence: row.totalPence,
        taxPence: row.taxPence,
        reviewed: REVIEWED.has(row.state),
        account: row.categoryCode === null ? null : (accounts.get(row.categoryCode) ?? null),
      });
    }

    const result = estimate({
      country,
      kind: query.kind,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
      vatRegistered: business.vatRegistered,
      vatScheme: country === 'AU' ? 'STANDARD' : scheme,
      flatRateBasisPoints: query.flatRateBasisPoints ?? null,
      legalStructure: business.legalStructure,
      documents,
      bank: bankFacts(transactions, statements, query),
      skipped: { otherCurrency, undated },
    });
    return { active: true, estimate: toContract(result) };
  }
}

function assertPeriod(query: EstimateQuery): void {
  const valid = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (!valid(query.periodStart) || !valid(query.periodEnd) || query.periodEnd < query.periodStart) {
    throw new AppException(
      'NT-VAL-001',
      HttpStatus.BAD_REQUEST,
      'Invalid period',
      'The period must be two real dates, the end on or after the start.',
    );
  }
  if (periodDays(query.periodStart, query.periodEnd) > MAX_PERIOD_DAYS) {
    throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Period too long', `An estimate covers at most ${MAX_PERIOD_DAYS} days.`);
  }
}

interface TransactionRow {
  readonly amountPence: number;
  readonly matchState: string;
  readonly chaseSuppressed: boolean;
  readonly descriptionRaw: string;
  readonly bookedAt: Date;
}

/**
 * The bank side of the estimate: how much of the period the statements cover,
 * and how much of the money in and out has a document behind it.
 *
 * Left out: EXCLUDED lines (a person said no document is needed), payments to
 * or from the tax authority, and chase-suppressed PAYMENTS OUT — the suppression
 * list is bank charges, interest, wages and HMRC, none of which carries VAT.
 * ⚠ Chase suppression is NOT applied to money IN: every credit is suppressed
 * automatically (nobody chases a client for money received), and card takings
 * (Square, SumUp, Stripe payouts) are exactly the sales most likely to have no
 * invoice. SUGGESTED counts as evidenced: a document that fits already exists.
 */
export function bankFacts(
  transactions: readonly TransactionRow[],
  statements: readonly { periodStart: Date | null; periodEnd: Date | null }[],
  query: Pick<EstimateQuery, 'periodStart' | 'periodEnd'>,
): BankFacts | null {
  const ranges = statements
    .filter((s): s is { periodStart: Date; periodEnd: Date } => s.periodStart !== null && s.periodEnd !== null)
    .map((s) => [s.periodStart.toISOString().slice(0, 10), s.periodEnd.toISOString().slice(0, 10)] as const);
  if (ranges.length === 0 && transactions.length > 0) {
    // No dated statement row: the lines themselves are the only evidence of coverage.
    const days = transactions.map((t) => t.bookedAt.toISOString().slice(0, 10)).sort();
    ranges.push([days[0] as string, days[days.length - 1] as string]);
  }
  if (ranges.length === 0) return null;

  let debits = 0;
  let credits = 0;
  let unevidencedDebits = 0;
  let unevidencedCredits = 0;
  for (const t of transactions) {
    if (t.matchState === 'EXCLUDED' || TAX_AUTHORITY.test(t.descriptionRaw)) continue;
    if (t.amountPence < 0 && t.chaseSuppressed) continue;
    const amount = Math.abs(t.amountPence);
    const evidenced = t.matchState === 'SUGGESTED' || t.matchState === 'CONFIRMED';
    if (t.amountPence < 0) {
      debits += amount;
      if (!evidenced) unevidencedDebits += amount;
    } else {
      credits += amount;
      if (!evidenced) unevidencedCredits += amount;
    }
  }

  return {
    coveredDays: coveredDays(ranges, query.periodStart, query.periodEnd),
    debitsPence: debits,
    creditsPence: credits,
    unevidencedDebitsPence: unevidencedDebits,
    unevidencedCreditsPence: unevidencedCredits,
  };
}

/** Days of [start, end] inside the union of the statement ranges. Dates are `YYYY-MM-DD`. */
export function coveredDays(ranges: readonly (readonly [string, string])[], start: string, end: string): number {
  const clipped = ranges
    .map(([a, b]) => [a < start ? start : a, b > end ? end : b] as const)
    .filter(([a, b]) => a <= b)
    .sort((x, y) => (x[0] < y[0] ? -1 : 1));
  let total = 0;
  let cursor: string | null = null; // last day already counted
  for (const [a, b] of clipped) {
    const from = cursor !== null && cursor >= a ? nextDay(cursor) : a;
    if (from > b) continue;
    total += periodDays(from, b);
    cursor = b;
  }
  return total;
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function toContract(e: ReturnType<typeof estimate>): TaxEstimate {
  return {
    ...e,
    figures: e.figures.map((f) => ({ ...f })),
    result: { ...e.result },
    completeness: { ...e.completeness },
    notes: [...e.notes],
    assumptions: [...e.assumptions],
    lines: e.lines.map((l) => ({ ...l })),
  };
}
