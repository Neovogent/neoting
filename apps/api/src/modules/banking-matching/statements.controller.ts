import { Controller, Get, HttpCode, HttpStatus, Inject, Query } from '@nestjs/common';

import { listStatementsQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import { StatementsService } from './statements.service.js';

/**
 * `GET /v1/statements` — where a client's bank data came from, and what the
 * completeness gate could prove about it (D40/D41).
 *
 * One GET, no `Idempotency-Key`: `x-nt-side-effect: none`. Thin by design
 * (`apps/api/CLAUDE.md`, 200-line cap): parse with the generated schema, take
 * the request context, call ONE service method, return it.
 *
 * There is no POST here and none may be added. A statement is created by
 * UPLOADING one — the ingest lane writes it after extraction — so a write door
 * here would be a second way to create bank data, and the two would disagree.
 */
@Controller('statements')
export class StatementsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    // Explicit token, not parameter-type metadata: tsx (esbuild) emits no
    // design:paramtypes, so a bare class parameter is `undefined` under
    // `pnpm dev` while working fine in the tsc build — the same reason every
    // other controller injects by token.
    @Inject(StatementsService) private readonly service: StatementsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(
      listStatementsQueryParams,
      coerceQuery(listStatementsQueryParams, query),
      'query parameters',
    );
    const ctx = await this.context.require();
    const items = await this.service.listStatements(
      ctx,
      ...(parsed.businessId === undefined ? [] : ([parsed.businessId] as const)),
    );
    return { items };
  }
}
