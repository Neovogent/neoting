import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';

import type { NotificationItem } from '@neoting/contracts/model';
import type { listNotificationsQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';

type ListQuery = z.infer<typeof listNotificationsQueryParams>;

/** The row plus the one join the projection needs. */
type NotificationRow = Prisma.NotificationGetPayload<{ include: { business: { select: { name: true } } } }>;

/**
 * The in-app notification inbox — `GET /v1/notifications` and
 * `POST /v1/notifications/read-receipts` (review item 12, 5 Sep 2026).
 *
 * The `notifications` table has been WRITTEN since METH Stage 8/9 — the portal
 * notifier's `portal.upload`, auto-close's `chase.closed`, and now the sink's
 * `document.received` — and read by nothing: a client's upload landed and the
 * accountant's screen changed only when a poll happened to run. This is the
 * read half the writers were always waiting for ("the row IS the in-app
 * toast", portal-upload-notifier.ts).
 *
 * ## Tenancy
 *
 * Every query runs inside `scopedDb`; `notifications_tenant` goes through
 * `app_can_access_business(business_id)`, so RLS bounds the set to the
 * caller's reach and nothing here adds a second tenancy clause. There is no
 * `businessId` filter by design — the bell is a practice-wide surface.
 *
 * ## Read-state
 *
 * `readAt` existed unwritten since the schema landed; `markRead` is its first
 * writer. Set once, never rewritten: the `updateMany` is guarded on
 * `readAt: null`, so a replay or a second press cannot move the timestamp —
 * when something was FIRST seen is the only question it answers.
 */
export class NotificationsInboxService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async list(ctx: ScopeContext, query: ListQuery): Promise<{ page: Page<NotificationItem>; unreadCount: number }> {
    const filters: Prisma.NotificationWhereInput = query.unread === true ? { readAt: null } : {};
    const request: PageRequest<NotificationRow> = {
      // Newest first, and no other sort — the bell answers "what just
      // happened", and `createdAt` is NOT NULL so this is the non-nullable
      // `SortField` branch (Prisma throws on `{ sort, nulls }` for a required
      // column — common/pagination/cursor.ts).
      sort: CREATED_AT,
      order: 'desc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      // The fingerprint covers what identifies the LIST (the unread filter and
      // the page size), never the caller's position in it — `cursor: undefined`
      // is load-bearing, the portal-documents lesson (a fingerprint that folds
      // the cursor in 400s every page-2 request).
      query: { unread: query.unread === true, limit: query.limit, cursor: undefined },
    };
    const seek = pageQuery(request);

    return scopedDb(this.prisma, ctx, async (db) => {
      const rows = (await db.notification.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.NotificationOrderByWithRelationInput[],
        take: seek.take,
        include: { business: { select: { name: true } } },
      })) as NotificationRow[];

      // The badge's number, not the page's: the whole reach, in the same
      // transaction as the page so the two cannot disagree about a row that
      // was marked read between two queries.
      const unreadCount = await db.notification.count({ where: { readAt: null } });

      const page = toPage(rows, request);
      return { page: { data: page.data.map(toNotificationItem), pageInfo: page.pageInfo }, unreadCount };
    });
  }

  /**
   * Mark the named rows read — or EVERY unread row the caller can see when
   * `notificationIds` is omitted (the bell's "mark all read").
   *
   * Naturally idempotent at the row (`readAt: null` guard), so the
   * `Idempotency-Key` is honoured for the disclosure reason
   * `DocumentManagementService#replayed` documents: the store is process-wide
   * and keyed by a caller-chosen string, so without the actor in the
   * fingerprint one caller could replay another's response. Key reuse with a
   * different payload is `409 NT-IDM-001`, the store's documented rule.
   */
  async markRead(
    ctx: ScopeContext,
    idempotencyKey: string,
    notificationIds: readonly string[] | undefined,
  ): Promise<{ unreadCount: number }> {
    const request = { notificationIds: notificationIds ?? null };
    const replay = await this.replayed(ctx, idempotencyKey, request);
    if (replay !== null) return replay;

    const response = await scopedDb(this.prisma, ctx, async (db) => {
      await db.notification.updateMany({
        where: {
          readAt: null,
          ...(notificationIds === undefined ? {} : { id: { in: [...notificationIds] } }),
        },
        data: { readAt: new Date() },
      });
      // Server truth after the write — the badge renders this, not a guess.
      const unreadCount = await db.notification.count({ where: { readAt: null } });
      return { unreadCount };
    });

    await this.idempotency.put(idempotencyKey, {
      requestHash: fingerprint({ actorId: ctx.actorId, request }),
      response,
    });
    return response;
  }

  private async replayed(
    ctx: ScopeContext,
    idempotencyKey: string,
    request: unknown,
  ): Promise<{ unreadCount: number } | null> {
    const record = await this.idempotency.get(idempotencyKey);
    if (record === null) return null;
    if (record.requestHash !== fingerprint({ actorId: ctx.actorId, request })) {
      throw new AppException(
        'NT-IDM-001',
        HttpStatus.CONFLICT,
        'This Idempotency-Key was already used with a different payload',
        'Use a fresh Idempotency-Key for a different request.',
      );
    }
    return record.response as { unreadCount: number };
  }
}

/** `createdAt` is NOT NULL on `notifications`, so this is the non-nullable branch. */
const CREATED_AT = dateField<NotificationRow>('createdAt', (row) => row.createdAt, false);

/**
 * Row → the contract's `NotificationItem`.
 *
 * `documentId`/`chaseId` are read DEFENSIVELY off the `payload` Json — the
 * column is `Json?` and each writer shapes it itself, so a non-string value or
 * a missing key is `null`, never a throw: an old row with an unexpected shape
 * must not take the bell down. Nothing else from the payload crosses — the
 * payload carries writer detail (otpSessionId, traceId, reasons), and the bell
 * needs only enough to navigate.
 */
function toNotificationItem(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    event: row.event,
    businessId: row.businessId,
    businessName: row.business.name,
    documentId: payloadString(row.payload, 'documentId'),
    chaseId: payloadString(row.payload, 'chaseId'),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
  };
}

function payloadString(payload: Prisma.JsonValue | null, key: string): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
