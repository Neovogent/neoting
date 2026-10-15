import { HttpStatus } from '@nestjs/common';
import { Prisma, type Obligation as ObligationRow } from '@prisma/client';
import type { z } from 'zod';

import type {
  createObligationBody,
  listObligationsQueryParams,
  replaceTaxProfileBody,
} from '@neoting/contracts/zod';
import type { CapitalisationPolicy, Obligation, TaxProfile } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { dateField, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { readVatNumberCheck, type VatNumberCheck } from '../../common/tax/vat-number.js';
import type { VatNumberChecker } from '../../common/tax/vat-number-checker.js';
import { PLATFORM_DEFAULT_CAPITALISATION_POLICY } from '../rules-suggestions/index.js';
import {
  addDays,
  computeObligations,
  DUE_SOON_DAYS,
  iso,
  LOOKBACK_DAYS,
  type ObligationInputs,
  parseIsoDate,
  readLegalStructure,
  readVatFrequency,
  statusFor,
} from './obligations.js';

type TaxProfileBody = z.infer<typeof replaceTaxProfileBody>;
type CreateObligationBody = z.infer<typeof createObligationBody>;
type ListQuery = z.infer<typeof listObligationsQueryParams>;

/** Today as a London calendar date — a deadline is a UK date, not a UTC instant. */
export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const toDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const toIso = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10));

const notFound = (): AppException =>
  new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No client with that id is visible to you.');

const BUSINESS_PROFILE_SELECT = {
  id: true,
  practiceId: true,
  name: true,
  companyNumber: true,
  legalStructure: true,
  vatRegistered: true,
  vatNumber: true,
  vatFrequency: true,
  vatPeriodStart: true,
  yearEndMonth: true,
  yearEndDay: true,
  contextQuestionnaire: true,
  taxProfile: true,
} as const satisfies Prisma.BusinessSelect;

type BusinessProfileRow = Prisma.BusinessGetPayload<{ select: typeof BUSINESS_PROFILE_SELECT }>;

function questionnaireEmployees(value: Prisma.JsonValue): boolean | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const flag = (value as Record<string, unknown>).hasEmployees;
  return typeof flag === 'boolean' ? flag : null;
}

function inputsFor(row: BusinessProfileRow): ObligationInputs {
  const tp = row.taxProfile;
  return {
    legalStructure: readLegalStructure(row.legalStructure),
    vatRegistered: row.vatRegistered,
    vatFrequency: readVatFrequency(row.vatFrequency),
    vatPeriodStart: toIso(row.vatPeriodStart),
    hasEmployees: tp?.hasEmployees ?? questionnaireEmployees(row.contextQuestionnaire),
    yearEndMonth: row.yearEndMonth,
    yearEndDay: row.yearEndDay,
    incorporatedOn: toIso(tp?.incorporatedOn ?? null),
    accountsNextDue: toIso(tp?.accountsNextDue ?? null),
    confirmationStatementNextDue: toIso(tp?.confirmationStatementNextDue ?? null),
  };
}

function toTaxProfile(row: BusinessProfileRow): TaxProfile {
  const inputs = inputsFor(row);
  return {
    businessId: row.id,
    legalStructure: inputs.legalStructure,
    companyNumber: row.companyNumber,
    incorporatedOn: inputs.incorporatedOn,
    yearEndMonth: row.yearEndMonth,
    yearEndDay: row.yearEndDay,
    vatRegistered: row.vatRegistered,
    vatNumber: row.vatNumber,
    vatFrequency: inputs.vatFrequency,
    vatPeriodStart: inputs.vatPeriodStart,
    hasEmployees: inputs.hasEmployees,
    accountsNextDue: inputs.accountsNextDue,
    confirmationStatementNextDue: inputs.confirmationStatementNextDue,
    companyStatus: row.taxProfile?.companyStatus ?? null,
    sicCodes: row.taxProfile?.sicCodes ?? [],
    vatNumberCheck: readVatNumberCheck(row.taxProfile?.vatNumberCheck ?? null),
  };
}

type ObligationWithBusiness = ObligationRow & { business: { name: string } };

function toObligation(row: ObligationWithBusiness, today: string): Obligation {
  const dueDate = toIso(row.dueDate) as string;
  return {
    id: row.id,
    businessId: row.businessId,
    businessName: row.business.name,
    kind: row.kind,
    source: row.source,
    title: row.title,
    periodStart: toIso(row.periodStart),
    periodEnd: toIso(row.periodEnd),
    dueDate,
    status: statusFor(dueDate, row.doneAt !== null, today),
    notes: row.notes,
    doneAt: row.doneAt === null ? null : row.doneAt.toISOString(),
  };
}

/** The date predicate a status filter means today — status is derived, so the filter is too. */
function statusWhere(status: ListQuery['status'], today: string): Prisma.ObligationWhereInput {
  if (status === undefined) return {};
  if (status === 'DONE') return { doneAt: { not: null } };
  const now = parseIsoDate(today);
  const soonEnd = now === null ? today : iso(addDays(now, DUE_SOON_DAYS - 1));
  if (status === 'OVERDUE') return { doneAt: null, dueDate: { lt: toDate(today) } };
  if (status === 'DUE') return { doneAt: null, dueDate: { gte: toDate(today), lte: toDate(soonEnd) } };
  return { doneAt: null, dueDate: { gt: toDate(soonEnd) } };
}

const OBLIGATION_DUE = dateField<ObligationRow>('dueDate', (row) => row.dueDate, false);

/**
 * Recompute one business's COMPUTED obligations, inside the caller's
 * transaction. Ticked rows keep their tick; manual rows are never touched; a
 * computed row the profile no longer implies is removed only while unticked
 * and inside the window (an old overdue row outside it is left as history).
 */
export async function regenerateBusinessObligations(db: ScopedClient, row: BusinessProfileRow, today: string): Promise<number> {
  const computed = computeObligations(inputsFor(row), today);
  for (const c of computed) {
    const data = {
      kind: c.kind,
      title: c.title,
      periodStart: c.periodStart === null ? null : toDate(c.periodStart),
      periodEnd: c.periodEnd === null ? null : toDate(c.periodEnd),
      dueDate: toDate(c.dueDate),
    };
    await db.obligation.upsert({
      where: { businessId_computeKey: { businessId: row.id, computeKey: c.computeKey } },
      create: { ...data, businessId: row.id, practiceId: row.practiceId, source: 'COMPUTED', computeKey: c.computeKey, status: statusFor(c.dueDate, false, today) },
      update: data,
    });
  }
  const windowStart = parseIsoDate(today);
  await db.obligation.deleteMany({
    where: {
      businessId: row.id,
      source: 'COMPUTED',
      doneAt: null,
      computeKey: { notIn: computed.map((c) => c.computeKey) },
      ...(windowStart === null ? {} : { dueDate: { gte: toDate(iso(addDays(windowStart, -LOOKBACK_DAYS))) } }),
    },
  });
  await refreshStatuses(db, { businessId: row.id }, today);
  return computed.length;
}

/** Keep the stored status column in step with today (reads derive it anyway). */
export async function refreshStatuses(db: ScopedClient, scope: Prisma.ObligationWhereInput, today: string): Promise<void> {
  for (const status of ['OVERDUE', 'DUE', 'UPCOMING'] as const) {
    await db.obligation.updateMany({ where: { ...scope, ...statusWhere(status, today), status: { not: status } }, data: { status } });
  }
  await db.obligation.updateMany({ where: { ...scope, doneAt: { not: null }, status: { not: 'DONE' } }, data: { status: 'DONE' } });
}

export class TaxComplianceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyStore,
    private readonly vat: VatNumberChecker,
    private readonly now: () => Date = () => new Date(),
  ) {}

  checkVatNumber(vatNumber: string): Promise<VatNumberCheck> {
    return this.vat.check(vatNumber);
  }

  // ── tax profile ──────────────────────────────────────────────────────

  async getTaxProfile(ctx: ScopeContext, businessId: string): Promise<TaxProfile> {
    const row = await scopedDb(this.prisma, ctx, (db) => db.business.findUnique({ where: { id: businessId }, select: BUSINESS_PROFILE_SELECT }));
    if (row === null) throw notFound();
    return toTaxProfile(row);
  }

  async replaceTaxProfile(ctx: ScopeContext, businessId: string, body: TaxProfileBody, idempotencyKey: string): Promise<TaxProfile> {
    const replay = await this.replayed<TaxProfile>(ctx, idempotencyKey, { businessId, body });
    if (replay !== null) return replay;

    // The network call happens BEFORE the transaction opens — never hold a
    // tenant transaction across somebody else's API.
    const vatCheck =
      body.vatNumber === undefined || body.vatNumber === null || body.vatNumber.trim() === ''
        ? undefined
        : await this.vat.check(body.vatNumber);
    const today = londonToday(this.now());

    const profile = await scopedDb(this.prisma, ctx, async (db) => {
      const exists = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
      if (exists === null) throw notFound();
      const has = <K extends keyof TaxProfileBody>(key: K): boolean => body[key] !== undefined;
      const dateOrNull = (value: string | null | undefined): Date | null => (value === null || value === undefined ? null : toDate(value));

      await db.business.update({
        where: { id: businessId },
        data: {
          ...(has('legalStructure') ? { legalStructure: body.legalStructure ?? null } : {}),
          ...(has('companyNumber') ? { companyNumber: body.companyNumber?.trim() || null } : {}),
          ...(has('yearEndMonth') ? { yearEndMonth: body.yearEndMonth ?? null } : {}),
          ...(has('yearEndDay') ? { yearEndDay: body.yearEndDay ?? null } : {}),
          ...(has('vatRegistered') ? { vatRegistered: body.vatRegistered ?? false } : {}),
          ...(has('vatNumber') ? { vatNumber: vatCheck?.vatNumber ?? null } : {}),
          ...(has('vatFrequency') ? { vatFrequency: body.vatFrequency ?? null } : {}),
          ...(has('vatPeriodStart') ? { vatPeriodStart: dateOrNull(body.vatPeriodStart) } : {}),
        },
      });

      const tp = {
        ...(has('incorporatedOn') ? { incorporatedOn: dateOrNull(body.incorporatedOn) } : {}),
        ...(has('hasEmployees') ? { hasEmployees: body.hasEmployees ?? null } : {}),
        ...(has('accountsNextDue') ? { accountsNextDue: dateOrNull(body.accountsNextDue) } : {}),
        ...(has('confirmationStatementNextDue') ? { confirmationStatementNextDue: dateOrNull(body.confirmationStatementNextDue) } : {}),
        ...(has('companyStatus') ? { companyStatus: body.companyStatus ?? null } : {}),
        ...(has('sicCodes') ? { sicCodes: body.sicCodes ?? [] } : {}),
        ...(has('vatNumber') ? { vatNumberCheck: vatCheck === undefined ? Prisma.DbNull : (vatCheck as unknown as Prisma.InputJsonValue) } : {}),
      };
      await db.taxProfile.upsert({ where: { businessId }, create: { businessId, ...tp }, update: tp });

      const row = await db.business.findUniqueOrThrow({ where: { id: businessId }, select: BUSINESS_PROFILE_SELECT });
      await regenerateBusinessObligations(db, row, today);
      return toTaxProfile(row);
    });

    await this.remember(ctx, idempotencyKey, { businessId, body }, profile);
    return profile;
  }

  // ── obligations ─────────────────────────────────────────────────────

  async listObligations(ctx: ScopeContext, query: ListQuery) {
    const today = londonToday(this.now());
    const filters: Prisma.ObligationWhereInput = {
      ...(query.businessId === undefined ? {} : { businessId: query.businessId }),
      ...statusWhere(query.status, today),
      business: { isActive: true },
    };
    const range: Prisma.ObligationWhereInput[] = [
      ...(query.from === undefined ? [] : [{ dueDate: { gte: toDate(query.from) } }]),
      ...(query.to === undefined ? [] : [{ dueDate: { lte: toDate(query.to) } }]),
    ];
    const request: PageRequest<ObligationRow> = {
      sort: OBLIGATION_DUE,
      order: 'asc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      query: { ...query, cursor: undefined, today },
    };
    const seek = pageQuery(request);
    const rows = await scopedDb(this.prisma, ctx, (db) =>
      db.obligation.findMany({
        where: { AND: [filters, ...range, ...(seek.where === undefined ? [] : [seek.where as Prisma.ObligationWhereInput])] },
        orderBy: seek.orderBy as Prisma.ObligationOrderByWithRelationInput[],
        take: seek.take,
        include: { business: { select: { name: true } } },
      }),
    );
    const page = toPage(rows, request);
    return { data: page.data.map((row) => toObligation(row, today)), pageInfo: page.pageInfo };
  }

  async createObligation(ctx: ScopeContext, body: CreateObligationBody, idempotencyKey: string): Promise<Obligation> {
    const replay = await this.replayed<Obligation>(ctx, idempotencyKey, { create: body });
    if (replay !== null) return replay;
    if (parseIsoDate(body.dueDate) === null) {
      throw new AppException('NT-VAL-001', HttpStatus.BAD_REQUEST, 'Validation failed', 'dueDate is not a real calendar date.');
    }
    const today = londonToday(this.now());
    const created = await scopedDb(this.prisma, ctx, async (db) => {
      const business = await db.business.findUnique({ where: { id: body.businessId }, select: { id: true, practiceId: true } });
      if (business === null) throw notFound();
      return db.obligation.create({
        data: {
          businessId: business.id,
          practiceId: business.practiceId,
          kind: 'MANUAL',
          source: 'MANUAL',
          title: body.title.trim(),
          dueDate: toDate(body.dueDate),
          notes: body.notes?.trim() || null,
          status: statusFor(body.dueDate, false, today),
        },
        include: { business: { select: { name: true } } },
      });
    });
    const obligation = toObligation(created, today);
    await this.remember(ctx, idempotencyKey, { create: body }, obligation);
    return obligation;
  }

  /** Naturally idempotent — the same tick twice is the same row. */
  async setCompletion(ctx: ScopeContext, obligationId: string, done: boolean): Promise<Obligation> {
    const today = londonToday(this.now());
    const row = await scopedDb(this.prisma, ctx, async (db) => {
      const existing = await db.obligation.findUnique({ where: { id: obligationId }, select: { id: true, doneAt: true, dueDate: true } });
      if (existing === null) {
        throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No deadline with that id is visible to you.');
      }
      const alreadyDone = existing.doneAt !== null;
      return db.obligation.update({
        where: { id: obligationId },
        data:
          done === alreadyDone
            ? {}
            : done
              ? { doneAt: this.now(), doneByUserId: ctx.actorId, status: 'DONE' }
              : { doneAt: null, doneByUserId: null, status: statusFor(toIso(existing.dueDate) as string, false, today) },
        include: { business: { select: { name: true } } },
      });
    });
    return toObligation(row, today);
  }

  async regenerate(ctx: ScopeContext, businessId: string | undefined): Promise<{ businesses: number; obligations: number }> {
    const today = londonToday(this.now());
    const ids = await scopedDb(this.prisma, ctx, (db) =>
      db.business.findMany({ where: { isActive: true, ...(businessId === undefined ? {} : { id: businessId }) }, select: { id: true } }),
    );
    if (businessId !== undefined && ids.length === 0) throw notFound();
    let obligations = 0;
    // One short transaction per client: a practice with two hundred clients
    // must not hold one transaction across all of them.
    for (const { id } of ids) {
      obligations += await scopedDb(this.prisma, ctx, async (db) => {
        const row = await db.business.findUniqueOrThrow({ where: { id }, select: BUSINESS_PROFILE_SELECT });
        return regenerateBusinessObligations(db, row, today);
      });
    }
    return { businesses: ids.length, obligations };
  }

  // ── capitalisation threshold ─────────────────────────────────────────

  async getCapitalisationPolicy(ctx: ScopeContext): Promise<CapitalisationPolicy> {
    const practiceId = requirePractice(ctx);
    const practice = await scopedDb(this.prisma, ctx, (db) =>
      db.practice.findUnique({ where: { id: practiceId }, select: { capitalisationThresholdPence: true } }),
    );
    return policyFor(practice?.capitalisationThresholdPence ?? null);
  }

  async replaceCapitalisationPolicy(ctx: ScopeContext, thresholdPence: number | null): Promise<CapitalisationPolicy> {
    const practiceId = requirePractice(ctx);
    return scopedDb(this.prisma, ctx, async (db) => {
      // `memberships` carries no RLS; the filter is the verified session's own
      // actor and practice, never a value off the wire.
      const admin = await db.membership.findFirst({
        where: { userId: ctx.actorId, practiceId, businessId: null, role: 'PRACTICE_ADMIN' },
        select: { id: true },
      });
      if (admin === null) {
        throw new AppException('NT-PRM-001', HttpStatus.FORBIDDEN, 'Not permitted', 'Only a practice admin can change the capitalisation threshold.');
      }
      const updated = await db.practice.update({
        where: { id: practiceId },
        data: { capitalisationThresholdPence: thresholdPence },
        select: { capitalisationThresholdPence: true },
      });
      return policyFor(updated.capitalisationThresholdPence);
    });
  }

  // ── idempotency (the tasks.service shape) ─────────────────────────────

  private async replayed<T>(ctx: ScopeContext, key: string, request: unknown): Promise<T | null> {
    const record = await this.idempotency.get(key);
    if (record === null) return null;
    if (record.requestHash !== fingerprint({ actorId: ctx.actorId, request })) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload', 'Use a fresh Idempotency-Key for a different request.');
    }
    return record.response as T;
  }

  private async remember(ctx: ScopeContext, key: string, request: unknown, response: unknown): Promise<void> {
    await this.idempotency.put(key, { requestHash: fingerprint({ actorId: ctx.actorId, request }), response: response as never });
  }
}

function requirePractice(ctx: ScopeContext): string {
  if (ctx.practiceId === undefined) {
    throw new AppException('NT-PRM-001', HttpStatus.FORBIDDEN, 'Not permitted', 'Your sign-in reaches only the clients it was given; practice settings belong to the practice.');
  }
  return ctx.practiceId;
}

export function policyFor(thresholdPence: number | null): CapitalisationPolicy {
  return thresholdPence === null
    ? { thresholdPence: PLATFORM_DEFAULT_CAPITALISATION_POLICY.thresholdPence, source: 'PLATFORM_DEFAULT' }
    : { thresholdPence, source: 'PRACTICE' };
}

export { BUSINESS_PROFILE_SELECT, type BusinessProfileRow };
