import { Body, Controller, HttpCode, HttpStatus, Inject, Get, Post, Query } from '@nestjs/common';

import { createChatTurnBody, getChatSuggestionsQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import type { ChatService } from './chat.service.js';
import type { SuggestionsService } from './suggestions.service.js';
import { CHAT_SERVICE, SUGGESTIONS_SERVICE } from './tokens.js';

/**
 * `POST /v1/chat/turns` — the AI workspace's one operation.
 *
 * Thin, like every controller here (200-line cap): parse the boundary with the
 * generated schema, resolve the request context inside Nest's pipeline so a bad
 * one is a 401 problem+json, call ONE service method, return it.
 *
 * **No `Idempotency-Key`, deliberately.** The contract declares this operation
 * `x-nt-side-effect: none`, and `check-contract.mjs` only requires the header
 * on operations that mutate. Demanding one here would cargo-cult the write
 * surface onto a read — and worse, it would imply this endpoint changes
 * something, which is the one thing it must never be understood to do.
 */
@Controller()
export class ChatController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(CHAT_SERVICE) private readonly service: ChatService,
    @Inject(SUGGESTIONS_SERVICE) private readonly suggestions: SuggestionsService,
  ) {}

  @Post('chat/turns')
  @HttpCode(HttpStatus.OK)
  async createTurn(@Body() body: unknown) {
    const parsed = parseBoundary(createChatTurnBody, body, 'request body');
    return this.service.createTurn(await this.context.require(), {
      utterance: parsed.utterance,
      businessId: parsed.businessId,
      history: parsed.history,
    });
  }

  /**
   * The chat box's briefing. Read-only like the turn above, and additionally
   * never a 5xx for a model problem — the service degrades to the derived
   * ranking and says so in `source` (the operation's own contract prose).
   */
  @Get('chat/suggestions')
  async getSuggestions(@Query() query: unknown) {
    const parsed = parseBoundary(getChatSuggestionsQueryParams, query, 'query parameters');
    return this.suggestions.getSuggestions(await this.context.require(), parsed.businessId);
  }
}
