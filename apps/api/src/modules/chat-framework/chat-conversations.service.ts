import { HttpStatus } from '@nestjs/common';
import type { Prisma, ChatConversation as ChatConversationRow } from '@prisma/client';
import { z } from 'zod';

import type { ChatConversationDetail, ChatConversationSummary, ChatStoredMessage } from '@neoting/contracts/model';
import type { listChatConversationsQueryParams, saveChatConversationBody } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';

type ListQuery = z.infer<typeof listChatConversationsQueryParams>;
type UpsertBody = z.infer<typeof saveChatConversationBody>;

/**
 * Saved workspace-chat conversations — the server half of "full regular task
 * and chat system" (review item 9, 5 Sep 2026). Until this, the drawer's
 * conversations were React state: a reload lost every transcript the
 * accountant had.
 *
 * ## What this deliberately is NOT
 *
 * Not part of the AI runtime. `POST /chat/turns` stays `x-nt-side-effect:
 * none` and never writes here — persistence is the CALLER's own act (the web
 * client PUTs the whole conversation after each turn), so the governance
 * property "the chat surface is structurally incapable of changing state"
 * survives untouched. Nothing in this class calls a model, and nothing ever
 * re-interprets a stored message: text + intent name in, text + intent name
 * out, untrusted both ways (§9.6).
 *
 * ## Tenancy, and the boundary INSIDE the practice
 *
 * Every query runs inside `scopedDb`; `chat_conversations_tenant` is the
 * anchor-pair policy (rls.sql), so RLS bounds rows to the caller's reach. WHO
 * within the practice may see a transcript is narrower: a conversation is one
 * member's working note, so **every query here filters
 * `createdByUserId: ctx.actorId`** — `whereOwn()` is the single place that is
 * spelled, the portal-documents discipline. That is an application guarantee,
 * stated rather than overclaimed. A colleague's conversation is ABSENT (404 /
 * missing from the list), never forbidden.
 */
export class ChatConversationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async list(ctx: ScopeContext, query: ListQuery): Promise<Page<ChatConversationSummary>> {
    const filters = whereOwn(ctx);
    const request: PageRequest<ChatConversationRow> = {
      // Newest activity first, and no other sort — the drawer's order. Pinned
      // grouping is the DISPLAY's job (the pin travels on the row).
      sort: UPDATED_AT,
      order: 'desc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      // Fingerprint covers what identifies the LIST — the caller — never the
      // position in it (`cursor: undefined` is load-bearing; the
      // portal-documents lesson).
      query: { actorId: ctx.actorId, limit: query.limit, cursor: undefined },
    };
    const seek = pageQuery(request);

    const rows = await scopedDb(this.prisma, ctx, (db) =>
      db.chatConversation.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.ChatConversationOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toSummary), pageInfo: page.pageInfo };
  }

  async get(ctx: ScopeContext, conversationId: string): Promise<ChatConversationDetail> {
    const row = await scopedDb(this.prisma, ctx, (db) =>
      db.chatConversation.findFirst({ where: { ...whereOwn(ctx), clientKey: conversationId } }),
    );
    // RLS plus the owner filter already removed everything that is not the
    // caller's own, so null means "not yours" and "does not exist"
    // indistinguishably — 404, never 403, detail never echoing the id.
    if (row === null) throw notFound();
    return { ...toSummary(row), messages: storedMessages(row.messages) };
  }

  /**
   * `PUT /chat/conversations/{id}` — create or replace, whole conversation.
   *
   * Naturally idempotent (a retry saves the same bytes); the replay guard is
   * the house 409-on-key-reuse-with-a-different-payload rule, actor-scoped for
   * the `DocumentManagementService#replayed` reason.
   */
  async save(ctx: ScopeContext, conversationId: string, body: UpsertBody, idempotencyKey: string): Promise<void> {
    const practiceId = requirePractice(ctx);
    await this.replayed(ctx, idempotencyKey, { conversationId, body });

    await scopedDb(this.prisma, ctx, async (db) => {
      // The businessId is display metadata, not authority — but the RLS WITH
      // CHECK's business branch requires the caller to reach it, so a business
      // the caller cannot see (a stale id, a forged one) would fail the write
      // as a 500. Verified first, under the same scoped transaction: invisible
      // means it is stored as NO scope, which narrows and never confirms
      // whether the id names anything.
      let businessId: string | null = body.businessId ?? null;
      if (businessId !== null) {
        const visible = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
        if (visible === null) businessId = null;
      }

      const data = {
        businessId,
        title: body.title,
        pinned: body.pinned ?? false,
        messages: body.messages as unknown as Prisma.InputJsonValue,
      };
      await db.chatConversation.upsert({
        where: {
          practiceId_createdByUserId_clientKey: {
            practiceId,
            createdByUserId: ctx.actorId,
            clientKey: conversationId,
          },
        },
        create: { practiceId, createdByUserId: ctx.actorId, clientKey: conversationId, ...data },
        update: data,
      });
    });

    await this.idempotency.put(idempotencyKey, {
      requestHash: fingerprint({ actorId: ctx.actorId, request: { conversationId, body } }),
      response: null,
    });
  }

  /**
   * Hard delete, idempotent: deleting a conversation that does not exist —
   * or that is somebody else's, which looks identical from here — is the same
   * `deleteMany` matching zero rows, and the same 204.
   */
  async delete(ctx: ScopeContext, conversationId: string, idempotencyKey: string): Promise<void> {
    await this.replayed(ctx, idempotencyKey, { delete: conversationId });
    await scopedDb(this.prisma, ctx, (db) =>
      db.chatConversation.deleteMany({ where: { ...whereOwn(ctx), clientKey: conversationId } }),
    );
    await this.idempotency.put(idempotencyKey, {
      requestHash: fingerprint({ actorId: ctx.actorId, request: { delete: conversationId } }),
      response: null,
    });
  }

  /** The 409-on-reuse guard. Both mutations here answer 204, so there is nothing to replay back — only the misuse to refuse. */
  private async replayed(ctx: ScopeContext, idempotencyKey: string, request: unknown): Promise<void> {
    const record = await this.idempotency.get(idempotencyKey);
    if (record === null) return;
    if (record.requestHash !== fingerprint({ actorId: ctx.actorId, request })) {
      throw new AppException(
        'NT-IDM-001',
        HttpStatus.CONFLICT,
        'This Idempotency-Key was already used with a different payload',
        'Use a fresh Idempotency-Key for a different request.',
      );
    }
  }
}

/**
 * The one place the owner filter is spelled (the `whereFor` discipline from
 * portal-documents): every query in this class goes through it, so there is no
 * second query on this surface that could be written without it.
 */
function whereOwn(ctx: ScopeContext): Prisma.ChatConversationWhereInput {
  return { createdByUserId: ctx.actorId };
}

/** `updatedAt` is NOT NULL, so this is the non-nullable `SortField` branch. */
const UPDATED_AT = dateField<ChatConversationRow>('updatedAt', (row) => row.updatedAt, false);

function toSummary(row: ChatConversationRow): ChatConversationSummary {
  return {
    id: row.clientKey,
    title: row.title,
    pinned: row.pinned,
    businessId: row.businessId,
    messageCount: storedMessages(row.messages).length,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The stored-message shape, re-checked ON THE WAY OUT. The column is `Json`,
 * so a row written by an older build may carry anything; a malformed entry is
 * DROPPED rather than felling the whole drawer — the `readVerdict` posture
 * from grounding.ts, one lane over. Never throws.
 */
const StoredMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(4000),
  intent: z.string().max(40).optional(),
  at: z.string().datetime(),
});

function storedMessages(value: Prisma.JsonValue): ChatStoredMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatStoredMessage[] = [];
  for (const entry of value) {
    const parsed = StoredMessage.safeParse(entry);
    if (!parsed.success) continue;
    const { role, content, at, intent } = parsed.data;
    // Spread the optional in conditionally: the generated model type has a
    // plain `intent?: string` and this repo compiles with
    // `exactOptionalPropertyTypes`, so an explicit `undefined` is not the same
    // as an absent key.
    out.push({ role, content, at, ...(intent === undefined ? {} : { intent }) });
  }
  return out;
}

function requirePractice(ctx: ScopeContext): string {
  if (ctx.practiceId === undefined) {
    // A business-scoped session can CHAT (the budget falls back to the actor)
    // but has no practice row to anchor a conversation on, and inventing one
    // would be a tenancy decision made by a storage layer. Honest refusal.
    throw new AppException(
      'NT-VAL-001',
      HttpStatus.BAD_REQUEST,
      'Conversations need a practice workspace',
      'Saved conversations are available to practice-workspace sessions only.',
    );
  }
  return ctx.practiceId;
}

function notFound(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Conversation not found', 'No conversation with that id.');
}
