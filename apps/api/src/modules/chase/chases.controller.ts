import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Query } from '@nestjs/common';

import { getChaseParams, listChasesQueryParams, listSmsOutboxQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { ChasesService } from './chases.service.js';
import { CHASES_SERVICE } from './tokens.js';

/**
 * The chase read surface (METH Stage 8, SoT §4 Stage 8).
 *
 * Three GETs, all `x-nt-side-effect: none`, so **no `Idempotency-Key` on any of
 * them** — the contract requires that header only on non-GET side-effecting
 * operations, and a read that demanded one would be cargo-culting the write
 * surface (the documents-controller rule).
 *
 * Thin by design (apps/api/CLAUDE.md, 200-line cap): coerce the query (Express
 * gives every value as a string; the generated schema types `limit` as a number
 * and `state` as an array), parse with the generated schema, resolve the request
 * context inside Nest's pipeline so a bad one is a 401 problem+json, call ONE
 * service method, return it. `/chases`, `/chases/{id}` and `/sms-outbox` are one
 * controller because they are one read surface; the demo `x-demo` outbox path is
 * a read like the others, gated by `SMS_SENDER=demo` at write time, not here.
 */
@Controller()
export class ChasesController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(CHASES_SERVICE) private readonly service: ChasesService,
  ) {}

  @Get('chases')
  @HttpCode(HttpStatus.OK)
  async listChases(@Query() query: unknown) {
    const parsed = parseBoundary(listChasesQueryParams, coerceQuery(listChasesQueryParams, query), 'query parameters');
    return this.service.listChases(await this.context.require(), parsed);
  }

  @Get('chases/:chaseId')
  @HttpCode(HttpStatus.OK)
  async getChase(@Param('chaseId') chaseId: string) {
    const params = parseBoundary(getChaseParams, { chaseId }, 'chaseId');
    return this.service.getChase(await this.context.require(), params.chaseId);
  }

  @Get('sms-outbox')
  @HttpCode(HttpStatus.OK)
  async listSmsOutbox(@Query() query: unknown) {
    const parsed = parseBoundary(listSmsOutboxQueryParams, coerceQuery(listSmsOutboxQueryParams, query), 'query parameters');
    return this.service.listSmsOutbox(await this.context.require(), parsed);
  }
}
