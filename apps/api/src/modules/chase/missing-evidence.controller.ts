import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Put, Query } from '@nestjs/common';

import {
  dismissMissingEvidenceBody,
  dismissMissingEvidenceHeader,
  dismissMissingEvidenceParams,
  getChaseSuppressionParams,
  listMissingEvidenceQueryParams,
  replaceChaseSuppressionBody,
  replaceChaseSuppressionHeader,
  replaceChaseSuppressionParams,
  scanMissingEvidenceBody,
  scanMissingEvidenceHeader,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { MissingEvidenceService } from './missing-evidence.service.js';
import { MISSING_EVIDENCE_SERVICE } from './tokens.js';

/** Thin: parse with the generated Zod, resolve the context, one service call. */
@Controller()
export class MissingEvidenceController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(MISSING_EVIDENCE_SERVICE) private readonly service: MissingEvidenceService,
  ) {}

  @Get('missing-evidence')
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(listMissingEvidenceQueryParams, coerceQuery(listMissingEvidenceQueryParams, query), 'query parameters');
    return this.service.list(await this.context.require(), parsed);
  }

  @Post('missing-evidence/scans')
  @HttpCode(HttpStatus.OK)
  async scan(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    const parsed = parseBoundary(scanMissingEvidenceBody, body, 'body');
    parseIdempotencyKey(scanMissingEvidenceHeader, key);
    return this.service.scan(await this.context.require(), parsed.businessId);
  }

  @Post('missing-evidence/:itemId/dismissal')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(@Param('itemId') itemId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    const params = parseBoundary(dismissMissingEvidenceParams, { itemId }, 'itemId');
    const parsed = parseBoundary(dismissMissingEvidenceBody, body, 'body');
    parseIdempotencyKey(dismissMissingEvidenceHeader, key);
    await this.service.dismiss(await this.context.require(), params.itemId, parsed);
  }

  @Get('businesses/:businessId/chase-suppression')
  @HttpCode(HttpStatus.OK)
  async getSuppression(@Param('businessId') businessId: string) {
    const params = parseBoundary(getChaseSuppressionParams, { businessId }, 'businessId');
    return this.service.getSuppression(await this.context.require(), params.businessId);
  }

  @Put('businesses/:businessId/chase-suppression')
  @HttpCode(HttpStatus.OK)
  async replaceSuppression(
    @Param('businessId') businessId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    const params = parseBoundary(replaceChaseSuppressionParams, { businessId }, 'businessId');
    const parsed = parseBoundary(replaceChaseSuppressionBody, body, 'body');
    parseIdempotencyKey(replaceChaseSuppressionHeader, key);
    return this.service.replaceSuppression(await this.context.require(), params.businessId, parsed);
  }
}
