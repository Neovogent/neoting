import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

import type { Prisma, Chase as ChaseRow, SmsLog as SmsLogRow } from '@prisma/client';

import type { Chase, ChaseSummary, SmsOutboxMessage } from '@neoting/contracts/model';
import type { listChasesQueryParams, listSmsOutboxQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import {
  dateField,
  type Page,
  type PageRequest,
  pageQuery,
  type SortField,
  toPage,
} from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { toChaseDetail, toChaseSummary, toSmsOutboxMessage } from './chase-projection.js';

type ListChasesQuery = z.infer<typeof listChasesQueryParams>;
type ListOutboxQuery = z.infer<typeof listSmsOutboxQueryParams>;

/**
 * The chase read surface (METH Stage 8, SoT §4 Stage 8): three GETs and nothing
 * else — the Chases workspace list, one chase in full, and the demo SMS outbox.
 *
 * **There is no write on this service, and that is structural.** A chase is
 * created only by the approved `chase.send` executor on the Review → Approve
 * spine (Governance §10); nothing here mutates, so there is no side-effect path
 * outside that spine for one to hide in. All three operations are
 * `x-nt-side-effect: none` in `openapi.yaml`.
 *
 * **Tenancy is RLS, everywhere, with no second mechanism.** Every query runs
 * inside `scopedDb`, which sets the GUCs the `chases_tenant` / `sms_log_tenant`
 * policies read; the one `businessId` clause is a user-facing FILTER on an
 * already-scoped set, never a guard — a hand-written tenancy filter that
 * disagreed with a policy would be the more permissive of the two exactly when
 * it mattered (the documents-surface rule, applied here).
 *
 * **404, never 403.** A chase outside the caller's scope is invisible to
 * `findUnique` under RLS, so it returns `null` and `getChase` raises 404 with the
 * house `NT-VAL-001` fallback (no `NT-NOT-001` exists). There is no ownership
 * check that could raise 403, because a 403 confirms the record exists.
 */
export class ChasesService {
  constructor(private readonly prisma: PrismaClient) {}

  /** `GET /chases` — the Chases workspace list, newest first, keyset-paginated. */
  async listChases(ctx: ScopeContext, query: ListChasesQuery): Promise<Page<ChaseSummary>> {
    const request: PageRequest<ChaseRow> = {
      sort: CHASE_SORT,
      order: 'desc',
      limit: query.limit,
      cursor: query.cursor,
      // The fingerprint covers what identifies the LIST (its filters), not the
      // caller's position in it — so `cursor: undefined`, the shape the documents
      // surface proved (its page-2 regression). `limit` is excluded for the same
      // reason a client may change page size mid-scroll without invalidating a
      // live cursor.
      query: { businessId: query.businessId, state: query.state },
    };
    const seek = pageQuery(request);
    const filters = buildChaseFilters(query);

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.chase.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.ChaseOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toChaseSummary), pageInfo: page.pageInfo };
  }

  /** `GET /chases/{chaseId}` — the full record: chased items, messages, closure. */
  async getChase(ctx: ScopeContext, chaseId: string): Promise<Chase> {
    return scopedDb(this.prisma, ctx, async (db) => {
      const row = await db.chase.findUnique({
        where: { id: chaseId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
      if (row === null) throw notFound();

      // The items are the chased transactions. Fetch them by the chase's stored
      // refs IN THE SAME transaction and under the SAME scope — a transaction the
      // caller cannot see is simply absent from the result and the projection
      // drops it, never faking an item for a row RLS withheld. The convenience
      // `transactionId` column backstops a chase whose `itemRefs` is empty.
      const refs = itemRefsOf(row);
      const transactions =
        refs.length === 0
          ? []
          : await db.bankTransaction.findMany({ where: { id: { in: refs } } });

      return toChaseDetail(row, transactions, row.messages);
    });
  }

  /**
   * `GET /sms-outbox` — the demo "client's phone", newest first.
   *
   * Reads `sms_log`, the same rows the real Twilio sender will write (only its
   * audience changes when the mock is un-faked). `x-demo: true` in the contract:
   * with `SMS_SENDER=demo` nothing ever left the machine, and this list is how a
   * demo shows the phone. RLS scopes it like everything else.
   */
  async listSmsOutbox(ctx: ScopeContext, query: ListOutboxQuery): Promise<Page<SmsOutboxMessage>> {
    const request: PageRequest<SmsLogRow> = {
      sort: SMS_SORT,
      order: 'desc',
      limit: query.limit,
      cursor: query.cursor,
      query: { businessId: query.businessId },
    };
    const seek = pageQuery(request);
    const filters = buildOutboxFilters(query);

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.smsLog.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.SmsLogOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toSmsOutboxMessage), pageInfo: page.pageInfo };
  }
}

/**
 * Chases sort newest-first on `createdAt` (the contract's "newest first"). The
 * column is required (`@default(now())`), so it is NOT nullable — the same
 * distinction `receivedAt` carries on documents, and getting it wrong 500s the
 * list (Prisma rejects `nulls` on a required column). The unique id is the
 * tie-break the cursor helper appends.
 */
const CHASE_SORT: SortField<ChaseRow> = dateField<ChaseRow>('createdAt', (r) => r.createdAt, false);

/** The outbox sorts newest-first on `sentAt` — required (`@default(now())`), so not nullable. */
const SMS_SORT: SortField<SmsLogRow> = dateField<SmsLogRow>('sentAt', (r) => r.sentAt, false);

/**
 * The user-facing chase filters, applied ON TOP of what RLS already narrowed to.
 *
 * Nothing here is a security boundary, including `businessId`: a caller passing a
 * `businessId` they cannot reach gets an EMPTY page, not a 404 and not a 403 —
 * the rows were already invisible, and the filter matches none of them. That is
 * the contract's parameter description and the only answer that does not confirm
 * whether the business exists. `state` is the contract's repeatable widen filter;
 * unlike documents there is no default exclusion — a chase's terminal states are
 * part of its history and the Chases workspace shows them.
 */
function buildChaseFilters(query: ListChasesQuery): Prisma.ChaseWhereInput {
  return {
    ...(query.businessId !== undefined ? { businessId: query.businessId } : {}),
    ...(query.state !== undefined && query.state.length > 0 ? { state: { in: query.state } } : {}),
  };
}

/** The outbox has one optional filter — `businessId`, the same non-boundary filter. */
function buildOutboxFilters(query: ListOutboxQuery): Prisma.SmsLogWhereInput {
  return {
    ...(query.businessId !== undefined ? { businessId: query.businessId } : {}),
  };
}

/**
 * The stored `itemRefs` as a string array, for the item fetch. Mirrors the
 * projection's own narrowing (a bare `Json` column may hold anything): keep the
 * strings, fall back to the single-transaction column, never trust the shape.
 */
function itemRefsOf(row: ChaseRow): string[] {
  const raw = row.itemRefs;
  const refs = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  if (refs.length > 0) return refs;
  return row.transactionId === null ? [] : [row.transactionId];
}

/**
 * The only failure this surface raises for a chase it cannot see.
 *
 * `NT-VAL-001`, not `NT-NOT-001`: the latter does not exist in the `ErrorCode`
 * enum, and `NT-VAL-001` is the house fallback for an otherwise-uncoded 4xx —
 * the same choice the documents surface and web-upload made. The detail names no
 * id and distinguishes "does not exist" from "not yours" nowhere.
 */
function notFound(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Chase not found', 'No chase with that id.');
}
