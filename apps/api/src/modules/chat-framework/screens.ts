import type { ChatDisplayBlock } from '@neoting/contracts/model';
import type { Prisma } from '@prisma/client';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';
import { buildAnalyticsReport } from '../analytics/index.js';
import type { ChatScreen, ModelTurn } from './prompts/output-schema.js';

/**
 * Chat reach (15 Oct 2026): every SHOW_* intent answers with a table the
 * SERVER composes from RLS-scoped rows — the `display.ts` posture. The model
 * chose an intent and some filters (words and dates); every cell below is read
 * from the database after the fact, so there is no field a model-invented
 * figure could travel in. Pence travel as digits; the web renders money.
 *
 * With no client in scope the read spans the practice (RLS is the ceiling) and
 * the table gains a Client column.
 */

export type ScreenIntent =
  | 'SHOW_INBOX'
  | 'SHOW_BANK'
  | 'SHOW_SUPPLIER_STATEMENTS'
  | 'SHOW_DUPLICATES'
  | 'SHOW_APPROVALS'
  | 'SHOW_EXPORTS'
  | 'SHOW_TASKS'
  | 'SHOW_TEAM'
  | 'SHOW_ANALYTICS'
  | 'SHOW_DEADLINES';

export const SCREEN_INTENTS: readonly string[] = [
  'SHOW_INBOX',
  'SHOW_BANK',
  'SHOW_SUPPLIER_STATEMENTS',
  'SHOW_DUPLICATES',
  'SHOW_APPROVALS',
  'SHOW_EXPORTS',
  'SHOW_TASKS',
  'SHOW_TEAM',
  'SHOW_ANALYTICS',
  'SHOW_DEADLINES',
];

export type ScreenFilters = NonNullable<ModelTurn['navigation']>;

const ROW_LIMIT = 40;
const DAY_MS = 86_400_000;

const day = (value: Date | null | undefined): string => (value == null ? '' : value.toISOString().slice(0, 10));
const digits = (value: number | null | undefined): string => (value == null ? '' : String(value));

/** The screen a SHOW_* intent opens when the model named none. */
export function defaultScreen(intent: string, hasClient: boolean): ChatScreen | undefined {
  switch (intent) {
    case 'SHOW_INBOX':
    case 'SHOW_DUPLICATES':
      return hasClient ? 'client-costs' : 'inboxes';
    case 'SHOW_BANK':
    case 'REQUEST_STATEMENT':
    case 'DRAFT_CONFIRM_MATCH':
      return hasClient ? 'client-bank' : undefined;
    case 'SHOW_STATEMENTS':
      return hasClient ? 'client-statements' : undefined;
    case 'SHOW_SUPPLIER_STATEMENTS':
      return hasClient ? 'client-supplier-statements' : undefined;
    case 'SHOW_APPROVALS':
      return hasClient ? 'client-approvals' : 'approvals';
    case 'SHOW_EXPORTS':
      return 'export';
    case 'SHOW_TASKS':
      return hasClient ? 'client-tasks' : 'clients';
    case 'SHOW_TEAM':
    case 'INVITE_MEMBER':
      return 'team';
    case 'SHOW_ANALYTICS':
      return 'analytics';
    case 'SHOW_DEADLINES':
      return 'clients';
    case 'LIVE_MISSING':
    case 'LIVE_CHASE':
      return hasClient ? 'client-chases' : 'chases';
    case 'LIVE_PUBLISH':
      return 'approvals';
    default:
      return undefined;
  }
}

/** UTC day bounds for an inclusive `from`..`to` the accountant said. */
function range(filters: ScreenFilters): { gte?: Date; lt?: Date } | undefined {
  if (filters.from === undefined && filters.to === undefined) return undefined;
  return {
    ...(filters.from === undefined ? {} : { gte: new Date(`${filters.from}T00:00:00.000Z`) }),
    ...(filters.to === undefined ? {} : { lt: new Date(new Date(`${filters.to}T00:00:00.000Z`).getTime() + DAY_MS) }),
  };
}

const STATUS_TO_WHERE: Record<string, Prisma.DocumentWhereInput> = {
  review: { state: 'TO_REVIEW' },
  ready: { state: 'READY' },
  published: { state: 'PUBLISHED' },
  failed: { state: { in: ['FAILED', 'REJECTED'] } },
  processing: { state: { in: ['RECEIVED', 'PROCESSING'] } },
  unrouted: { inbox: 'UNROUTED' },
};

function table(
  title: string,
  columns: { name: string; cellType: 'text' | 'pence' | 'date' | 'count' }[],
  rows: string[][],
): ChatDisplayBlock | null {
  if (rows.length === 0) return null;
  return { kind: 'table', title: title.slice(0, 120), columns, rows: rows.map((r) => r.map((c) => c.slice(0, 200))) };
}

/** Adds the Client column when the read spans the practice. */
function withClient(
  businessId: string | null,
  columns: { name: string; cellType: 'text' | 'pence' | 'date' | 'count' }[],
  rows: { row: string[]; client: string | null | undefined }[],
): [typeof columns, string[][]] {
  if (businessId !== null) return [columns, rows.map((r) => r.row)];
  return [[...columns, { name: 'Client', cellType: 'text' }], rows.map((r) => [...r.row, r.client ?? ''])];
}

const userName = (u: { firstName: string | null; lastName: string | null; email: string | null } | undefined): string =>
  u === undefined ? '' : [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.email ?? '');

/**
 * Compose the table for one SHOW_* intent. `null` when there is nothing to
 * show — the reply then stands alone, which is honest.
 */
export async function composeScreen(
  db: ScopedClient,
  scope: { businessId: string | null; practiceId: string | null; actorId: string },
  intent: ScreenIntent,
  filters: ScreenFilters,
  now: Date = new Date(),
): Promise<ChatDisplayBlock | null> {
  const { businessId } = scope;
  const biz = businessId === null ? {} : { businessId };
  const dates = range(filters);
  const supplier = filters.supplier === undefined ? undefined : { contains: filters.supplier, mode: 'insensitive' as const };

  switch (intent) {
    case 'SHOW_INBOX': {
      const rows = await db.document.findMany({
        where: {
          ...biz,
          archivedAt: null,
          ...notDeleted(),
          ...(filters.statusFilter === undefined ? {} : STATUS_TO_WHERE[filters.statusFilter]),
          ...(supplier === undefined ? {} : { supplierName: supplier }),
          ...(dates === undefined
            ? {}
            : { OR: [{ documentDate: dates }, { documentDate: null, receivedAt: dates }] }),
        },
        orderBy: { receivedAt: 'desc' },
        take: ROW_LIMIT,
        select: {
          supplierName: true,
          documentDate: true,
          totalPence: true,
          state: true,
          categoryCode: true,
          business: { select: { name: true } },
        },
      });
      const [columns, cells] = withClient(
        businessId,
        [
          { name: 'Supplier', cellType: 'text' },
          { name: 'Date', cellType: 'date' },
          { name: 'Total', cellType: 'pence' },
          { name: 'State', cellType: 'text' },
          { name: 'Category', cellType: 'text' },
        ],
        rows.map((r) => ({
          row: [r.supplierName ?? '', day(r.documentDate), digits(r.totalPence), r.state, r.categoryCode ?? ''],
          client: r.business?.name,
        })),
      );
      return table('Documents', columns, cells);
    }

    case 'SHOW_BANK': {
      const rows = await db.bankTransaction.findMany({
        where: {
          ...biz,
          ...(filters.unmatchedOnly === true ? { matchState: 'UNMATCHED' } : {}),
          ...(dates === undefined ? {} : { bookedAt: dates }),
          ...(supplier === undefined ? {} : { OR: [{ merchantName: supplier }, { descriptionRaw: supplier }] }),
        },
        orderBy: { bookedAt: 'desc' },
        take: ROW_LIMIT,
        select: {
          descriptionRaw: true,
          merchantName: true,
          amountPence: true,
          bookedAt: true,
          matchState: true,
          business: { select: { name: true } },
        },
      });
      const [columns, cells] = withClient(
        businessId,
        [
          { name: 'Description', cellType: 'text' },
          { name: 'Booked', cellType: 'date' },
          { name: 'Amount', cellType: 'pence' },
          { name: 'Match', cellType: 'text' },
        ],
        rows.map((r) => ({
          row: [r.merchantName ?? r.descriptionRaw, day(r.bookedAt), digits(r.amountPence), r.matchState],
          client: r.business.name,
        })),
      );
      return table(filters.unmatchedOnly === true ? 'Unmatched bank lines' : 'Bank transactions', columns, cells);
    }

    case 'SHOW_SUPPLIER_STATEMENTS': {
      const rows = await db.supplierStatement.findMany({
        where: { ...biz, ...(supplier === undefined ? {} : { supplierName: supplier }) },
        orderBy: { createdAt: 'desc' },
        take: ROW_LIMIT,
        select: {
          supplierName: true,
          statementEndDate: true,
          outstandingBalancePence: true,
          business: { select: { name: true } },
          _count: { select: { lines: true } },
          lines: { where: { status: 'MISSING' }, select: { id: true } },
        },
      });
      const [columns, cells] = withClient(
        businessId,
        [
          { name: 'Supplier', cellType: 'text' },
          { name: 'Statement date', cellType: 'date' },
          { name: 'Balance', cellType: 'pence' },
          { name: 'Lines', cellType: 'count' },
          { name: 'Missing', cellType: 'count' },
        ],
        rows.map((r) => ({
          row: [
            r.supplierName,
            day(r.statementEndDate),
            digits(r.outstandingBalancePence),
            digits(r._count.lines),
            digits(r.lines.length),
          ],
          client: r.business.name,
        })),
      );
      return table('Supplier statements', columns, cells);
    }

    case 'SHOW_DUPLICATES': {
      const rows = await db.duplicate.findMany({
        where: { ...biz, verdict: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: ROW_LIMIT,
        select: {
          score: true,
          createdAt: true,
          documentA: { select: { supplierName: true, totalPence: true, business: { select: { name: true } } } },
          documentB: { select: { supplierName: true } },
        },
      });
      const [columns, cells] = withClient(
        businessId,
        [
          { name: 'Document', cellType: 'text' },
          { name: 'Suspected copy of', cellType: 'text' },
          { name: 'Total', cellType: 'pence' },
          { name: 'Similarity', cellType: 'text' },
          { name: 'Flagged', cellType: 'date' },
        ],
        rows.map((r) => ({
          row: [
            r.documentB.supplierName ?? '',
            r.documentA.supplierName ?? '',
            digits(r.documentA.totalPence),
            `${Math.round(r.score * 100)}%`,
            day(r.createdAt),
          ],
          client: r.documentA.business?.name,
        })),
      );
      return table('Suspected duplicates', columns, cells);
    }

    case 'SHOW_APPROVALS': {
      const rows = await db.actionProposal.findMany({
        where: { ...biz, state: { in: ['CREATED', 'REVIEWED'] } },
        orderBy: { createdAt: 'asc' },
        take: ROW_LIMIT,
        select: { kind: true, createdAt: true, business: { select: { name: true } } },
      });
      const [columns, cells] = withClient(
        businessId,
        [
          { name: 'Action', cellType: 'text' },
          { name: 'Raised', cellType: 'date' },
          { name: 'Days waiting', cellType: 'count' },
        ],
        rows.map((r) => ({
          row: [r.kind, day(r.createdAt), digits(Math.max(0, Math.floor((now.getTime() - r.createdAt.getTime()) / DAY_MS)))],
          client: r.business?.name,
        })),
      );
      return table('Waiting for approval, oldest first', columns, cells);
    }

    case 'SHOW_EXPORTS': {
      const rows = await db.export.findMany({
        where: biz,
        orderBy: { createdAt: 'desc' },
        take: ROW_LIMIT,
        select: {
          target: true,
          format: true,
          periodStart: true,
          periodEnd: true,
          rowCount: true,
          state: true,
          createdAt: true,
          business: { select: { name: true } },
        },
      });
      const [columns, cells] = withClient(
        businessId,
        [
          { name: 'Target', cellType: 'text' },
          { name: 'Period from', cellType: 'date' },
          { name: 'Period to', cellType: 'date' },
          { name: 'Rows', cellType: 'count' },
          { name: 'State', cellType: 'text' },
          { name: 'Created', cellType: 'date' },
        ],
        rows.map((r) => ({
          row: [r.target ?? r.format, day(r.periodStart), day(r.periodEnd), digits(r.rowCount), r.state, day(r.createdAt)],
          client: r.business.name,
        })),
      );
      return table('Exports', columns, cells);
    }

    case 'SHOW_TASKS': {
      const rows = await db.task.findMany({
        where: { ...biz, status: 'open' },
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
        take: ROW_LIMIT,
        select: { title: true, ownerUserId: true, dueAt: true, status: true, business: { select: { name: true } } },
      });
      const ownerIds = [...new Set(rows.map((r) => r.ownerUserId).filter((id): id is string => id !== null))];
      const owners =
        ownerIds.length === 0
          ? []
          : await db.user.findMany({
              where: { id: { in: ownerIds } },
              select: { id: true, firstName: true, lastName: true, email: true },
            });
      const byId = new Map(owners.map((o) => [o.id, o]));
      const [columns, cells] = withClient(
        businessId,
        [
          { name: 'Task', cellType: 'text' },
          { name: 'Owner', cellType: 'text' },
          { name: 'Due', cellType: 'date' },
          { name: 'Status', cellType: 'text' },
        ],
        rows.map((r) => ({
          row: [r.title, r.ownerUserId === null ? '' : userName(byId.get(r.ownerUserId)), day(r.dueAt), r.status],
          client: r.business.name,
        })),
      );
      return table('Open tasks', columns, cells);
    }

    case 'SHOW_TEAM': {
      // `memberships` carries no RLS, so the practice bound is spelled here —
      // and only for a caller who holds a practice-wide membership themselves
      // (a client-scoped colleague is not shown the firm's staff list, the
      // Team tab's own rule).
      if (scope.practiceId === null) return null;
      const own = await db.membership.findFirst({
        where: { userId: scope.actorId, practiceId: scope.practiceId },
        select: { id: true },
      });
      if (own === null) return null;
      const rows = await db.membership.findMany({
        where: {
          OR: [{ practiceId: scope.practiceId }, { business: { practiceId: scope.practiceId } }],
          user: { kind: 'HUMAN', deactivatedAt: null },
        },
        orderBy: { createdAt: 'asc' },
        take: ROW_LIMIT,
        select: { role: true, userId: true, user: { select: { firstName: true, lastName: true, email: true } } },
      });
      const seen = new Set<string>();
      const unique = rows.filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)));
      return table(
        'Team',
        [
          { name: 'Name', cellType: 'text' },
          { name: 'Email', cellType: 'text' },
          { name: 'Role', cellType: 'text' },
        ],
        unique.map((r) => [userName(r.user), r.user.email ?? '', r.role]),
      );
    }

    case 'SHOW_ANALYTICS': {
      const to = filters.to === undefined ? now : new Date(`${filters.to}T00:00:00.000Z`);
      const from = filters.from === undefined ? new Date(to.getTime() - 29 * DAY_MS) : new Date(`${filters.from}T00:00:00.000Z`);
      if (from.getTime() > to.getTime()) return null;
      const report = await buildAnalyticsReport(db, { businessId, from, to, now });
      const unit = (u: string) => (u === 'percent' ? '%' : u === 'count' ? '' : ` ${u}`);
      return table(
        `Pipeline metrics, ${report.from} to ${report.to}`,
        [
          { name: 'Metric', cellType: 'text' },
          { name: 'Value', cellType: 'text' },
        ],
        report.metrics.map((m) => [m.label, m.value === null ? 'Not measurable' : `${m.value}${unit(m.unit)}`]),
      );
    }

    case 'SHOW_DEADLINES': {
      const rows = await db.business.findMany({
        where: { ...(businessId === null ? {} : { id: businessId }), isActive: true, nextDeadline: { not: null } },
        orderBy: { nextDeadline: 'asc' },
        take: ROW_LIMIT,
        select: { name: true, nextDeadline: true },
      });
      return table(
        'Upcoming deadlines',
        [
          { name: 'Client', cellType: 'text' },
          { name: 'Deadline', cellType: 'date' },
          { name: 'Days left', cellType: 'text' },
        ],
        rows.map((r) => [
          r.name,
          day(r.nextDeadline),
          r.nextDeadline === null ? '' : String(Math.ceil((r.nextDeadline.getTime() - now.getTime()) / DAY_MS)),
        ]),
      );
    }
  }
}
