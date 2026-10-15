import { Controller, Get, Header, HttpCode, HttpStatus, Inject, Param, Query } from '@nestjs/common';
import { getBusinessAnalyticsParams, getPracticeAnalyticsQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import { ANALYTICS_SERVICE, type AnalyticsService } from './analytics.service.js';

/** `/v1/analytics` — SoT §11 pipeline metrics, JSON and CSV. Read-only. */
@Controller('analytics')
export class AnalyticsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(ANALYTICS_SERVICE) private readonly service: AnalyticsService,
  ) {}

  private period(query: unknown) {
    // All four operations take the same `from`/`to`, so one generated schema parses them.
    return parseBoundary(getPracticeAnalyticsQueryParams, coerceQuery(getPracticeAnalyticsQueryParams, query), 'query parameters');
  }

  private businessId(businessId: string) {
    return parseBoundary(getBusinessAnalyticsParams, { businessId }, 'businessId').businessId;
  }

  @Get('practice')
  @HttpCode(HttpStatus.OK)
  async practice(@Query() query: unknown) {
    return this.service.report(await this.context.require(), null, this.period(query));
  }

  @Get('practice/csv')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="neoting-analytics.csv"')
  async practiceCsv(@Query() query: unknown) {
    return this.service.csv(await this.context.require(), null, this.period(query));
  }

  @Get('businesses/:businessId')
  @HttpCode(HttpStatus.OK)
  async business(@Param('businessId') businessId: string, @Query() query: unknown) {
    return this.service.report(await this.context.require(), this.businessId(businessId), this.period(query));
  }

  @Get('businesses/:businessId/csv')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="neoting-client-analytics.csv"')
  async businessCsv(@Param('businessId') businessId: string, @Query() query: unknown) {
    return this.service.csv(await this.context.require(), this.businessId(businessId), this.period(query));
  }
}
