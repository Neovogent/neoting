import { Controller, Get, HttpCode, HttpStatus, Inject, Query } from '@nestjs/common';

import { listSupplierStatementsQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../../common/context/context.module.js';
import type { RequestContext } from '../../../common/context/request-context.js';
import { parseBoundary } from '../../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../../common/validation/query-coercion.js';
import { SupplierStatementsService } from './supplier-statements.service.js';

/**
 * `GET /v1/supplier-statements` — a client's supplier statements, reconciled
 * against the documents on file (issue #318).
 *
 * One GET, no `Idempotency-Key`: `x-nt-side-effect: none`. Thin by design
 * (`apps/api/CLAUDE.md`, 200-line cap): parse the query with the generated
 * schema, take the request context, call ONE service method, return it. The
 * shape mirrors `statements.controller.ts` — the bank-statement sibling — so
 * the two reads a client's Statements and Supplier Statements tabs make cannot
 * drift apart in posture.
 *
 * There is no POST here and none may be added: nothing in this API creates a
 * supplier statement yet, and when something does it will be an upload lane
 * with its own contract, not a write door on the read surface.
 */
@Controller('supplier-statements')
export class SupplierStatementsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    // Explicit token: tsx emits no design:paramtypes, so a bare class parameter
    // is `undefined` under `pnpm dev` — the lesson `statements.controller.ts`
    // learned on 31 Aug 2026.
    @Inject(SupplierStatementsService) private readonly service: SupplierStatementsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(
      listSupplierStatementsQueryParams,
      coerceQuery(listSupplierStatementsQueryParams, query),
      'query parameters',
    );
    const ctx = await this.context.require();
    const items = await this.service.listSupplierStatements(
      ctx,
      ...(parsed.businessId === undefined ? [] : ([parsed.businessId] as const)),
    );
    return { items };
  }
}
