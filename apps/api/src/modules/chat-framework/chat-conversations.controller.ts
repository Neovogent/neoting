import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Put, Query } from '@nestjs/common';

import {
  deleteChatConversationHeader,
  deleteChatConversationParams,
  getChatConversationParams,
  listChatConversationsQueryParams,
  saveChatConversationBody,
  saveChatConversationHeader,
  saveChatConversationParams,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { ChatConversationsService } from './chat-conversations.service.js';
import { CHAT_CONVERSATIONS_SERVICE } from './tokens.js';

/**
 * Saved conversations — the four contracted operations behind the drawer
 * (review item 9, 5 Sep 2026). A SECOND controller beside `chat.controller.ts`
 * deliberately: that one is the AI runtime's single side-effect-free operation
 * and its file says so structurally; these four are ordinary CRUD over the
 * caller's own rows and no model is ever on their path.
 *
 * Thin (200-line cap): coerce + parse with the generated schemas, one service
 * call each.
 */
@Controller('chat/conversations')
export class ChatConversationsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(CHAT_CONVERSATIONS_SERVICE) private readonly service: ChatConversationsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(
      listChatConversationsQueryParams,
      coerceQuery(listChatConversationsQueryParams, query),
      'query parameters',
    );
    const ctx = await this.context.require();
    return this.service.list(ctx, parsed);
  }

  @Get(':conversationId')
  @HttpCode(HttpStatus.OK)
  async get(@Param('conversationId') conversationId: string) {
    const params = parseBoundary(getChatConversationParams, { conversationId }, 'conversationId');
    const ctx = await this.context.require();
    return this.service.get(ctx, params.conversationId);
  }

  @Put(':conversationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async save(
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const params = parseBoundary(saveChatConversationParams, { conversationId }, 'conversationId');
    const parsedBody = parseBoundary(saveChatConversationBody, body, 'body');
    const key = parseIdempotencyKey(saveChatConversationHeader, idempotencyKey);
    const ctx = await this.context.require();
    await this.service.save(ctx, params.conversationId, parsedBody, key);
  }

  @Post(':conversationId/deletion')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const params = parseBoundary(deleteChatConversationParams, { conversationId }, 'conversationId');
    const key = parseIdempotencyKey(deleteChatConversationHeader, idempotencyKey);
    const ctx = await this.context.require();
    await this.service.delete(ctx, params.conversationId, key);
  }
}
