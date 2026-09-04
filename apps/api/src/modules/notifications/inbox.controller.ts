import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, Query } from '@nestjs/common';

import {
  listNotificationsQueryParams,
  markNotificationsReadBody,
  markNotificationsReadHeader,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { NotificationsInboxService } from './inbox.service.js';
import { NOTIFICATIONS_INBOX_SERVICE } from './tokens.js';

/**
 * The bell — `GET /v1/notifications` + `POST /v1/notifications/read-receipts`
 * (review item 12, 5 Sep 2026). The first controller in this module, which
 * until now existed only to be injected; the "No controller" note in
 * `notifications.module.ts` was true while `openapi.yaml` published no
 * notifications endpoint, and the contract moving first is what retires it.
 *
 * Thin by design (`apps/api/CLAUDE.md`, 200-line cap): coerce + parse with the
 * generated schemas, take the request context, call ONE service method, return
 * it. `coerceQuery` first — Express delivers `limit` as a string and `unread`
 * as the string `'true'`, while the schema types them number and boolean.
 */
@Controller('notifications')
export class NotificationsInboxController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    // Explicit token, not parameter-type metadata: tsx emits no
    // design:paramtypes, the house rule on every controller.
    @Inject(NOTIFICATIONS_INBOX_SERVICE) private readonly service: NotificationsInboxService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(
      listNotificationsQueryParams,
      coerceQuery(listNotificationsQueryParams, query),
      'query parameters',
    );
    const ctx = await this.context.require();
    const { page, unreadCount } = await this.service.list(ctx, parsed);
    return { data: page.data, pageInfo: page.pageInfo, unreadCount };
  }

  @Post('read-receipts')
  @HttpCode(HttpStatus.OK)
  async markRead(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    // The contract's requestBody is OPTIONAL — omitted means "everything
    // unread" — and Express parses an absent JSON body to `undefined` or `{}`
    // depending on the client. Both mean the same thing here.
    const parsed = parseBoundary(markNotificationsReadBody, body ?? {}, 'body');
    const key = parseIdempotencyKey(markNotificationsReadHeader, idempotencyKey);
    const ctx = await this.context.require();
    return this.service.markRead(ctx, key, parsed.notificationIds);
  }
}
