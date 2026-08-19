import { Controller, Get, HttpCode, HttpStatus, Inject, Query } from '@nestjs/common';

import { listBusinessesQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { BusinessesService } from './businesses.service.js';
import { BUSINESSES_SERVICE } from './tokens.js';

/**
 * `GET /v1/businesses` — the caller's client workspaces with waiting-work
 * counts (contracted METH Stage 2 #120; built with Stage 6, whose context
 * header and businesses slice read it).
 *
 * One GET, no `Idempotency-Key`: `x-nt-side-effect: none`. Thin by design
 * (`apps/api/CLAUDE.md`, 200-line cap): parse with the generated schema, take
 * the request context, call ONE service method, return it. There is no POST,
 * PATCH or DELETE here and none may be added — a business is created by
 * onboarding, which is post-demo surface, and would go through Review →
 * Approve like every other state change (Governance §10).
 */
@Controller('businesses')
export class BusinessesController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(BUSINESSES_SERVICE) private readonly service: BusinessesService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    // `coerceQuery` first: Express delivers `limit` as a string while the
    // generated schema types it as a number. Schema-driven, so it cannot
    // drift from the contract.
    const parsed = parseBoundary(
      listBusinessesQueryParams,
      coerceQuery(listBusinessesQueryParams, query),
      'query parameters',
    );
    // `require()` resolves the context inside Nest's pipeline, so a bad one
    // leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.service.listBusinesses(await this.context.require(), parsed);
  }
}
