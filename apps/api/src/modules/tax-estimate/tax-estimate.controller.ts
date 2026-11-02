import { Controller, Get, Headers, HttpCode, HttpStatus, Inject, Query } from '@nestjs/common';
import type { TaxEstimateView } from '@neoting/contracts/model';
import { getPortalTaxEstimateQueryParams, getTaxEstimateQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import { PORTAL_SESSION_CONTEXT, type PortalSessionContextResolver } from '../portal/index.js';
import type { TaxEstimateService } from './tax-estimate.service.js';
import { TAX_ESTIMATE_SERVICE } from './tokens.js';

/**
 * `GET /v1/tax-estimates` — the accountant's view of a client's estimate (D52).
 * Thin: parse, resolve the caller, call one service method.
 */
@Controller('tax-estimates')
export class TaxEstimateController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(TAX_ESTIMATE_SERVICE) private readonly service: TaxEstimateService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async get(@Query() query: unknown): Promise<TaxEstimateView> {
    const parsed = parseBoundary(getTaxEstimateQueryParams, coerceQuery(getTaxEstimateQueryParams, query), 'query parameters');
    const ctx = await this.context.require();
    const { businessId, ...rest } = parsed;
    return this.service.forPractice(ctx, businessId, rest);
  }
}

/**
 * `GET /v1/portal/tax-estimate` — the client's own estimate. Authenticates
 * BEFORE it validates, like every portal route.
 */
@Controller('portal/tax-estimate')
export class PortalTaxEstimateController {
  constructor(
    @Inject(PORTAL_SESSION_CONTEXT)
    private readonly resolver: PortalSessionContextResolver,
    @Inject(TAX_ESTIMATE_SERVICE) private readonly service: TaxEstimateService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async get(@Headers('authorization') authorization: string | undefined, @Query() query: unknown): Promise<TaxEstimateView> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const parsed = parseBoundary(getPortalTaxEstimateQueryParams, coerceQuery(getPortalTaxEstimateQueryParams, query), 'query parameters');
    return this.service.forPortal(facts, parsed);
  }
}
