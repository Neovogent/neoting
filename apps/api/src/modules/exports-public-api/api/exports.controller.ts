import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, Query } from '@nestjs/common';

import type { Export } from '@neoting/contracts/model';
import { createExportBody, createExportHeader, listExportsQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../../common/context/context.module.js';
import type { RequestContext } from '../../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../../common/validation/query-coercion.js';

import type { ExportsService } from './exports.service.js';
import { EXPORTS_SERVICE } from './tokens.js';

/**
 * `GET /v1/exports` and `POST /v1/exports` — the export surface (stage A9).
 *
 * **"Export for VT". Nothing is sent anywhere** (D42). The POST returns bytes
 * behind a short-lived link; there is no ledger, no vendor and no outbound call
 * on this route, and *Published* is an internal state meaning approved and
 * released for export. The contract says so on the operation itself.
 *
 * Thin by design (`apps/api/CLAUDE.md`, 200-line cap): parse with the generated
 * schemas, take the request context, call ONE service method, return it. No
 * filtering, no projection and no tenancy decision happens in this file.
 *
 * `Idempotency-Key` is `required: true` on the POST only. `check-contract.mjs`
 * demands the header wherever the method is not GET and the side effect is not
 * `none`, and `listExports` is `x-nt-side-effect: none` — a read demanding one
 * would be cargo-culting the write surface.
 */
@Controller('exports')
export class ExportsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(EXPORTS_SERVICE) private readonly service: ExportsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    // `coerceQuery` first. Express delivers every query value as a string while
    // the generated schema types `limit` as a number, so `?limit=25` — the exact
    // shape apps/web sends — is a 400 without it. Schema-driven, so it cannot
    // drift from the contract.
    const parsed = parseBoundary(
      listExportsQueryParams,
      coerceQuery(listExportsQueryParams, query),
      'query parameters',
    );
    // `require()` resolves the context here, inside Nest's pipeline, so an
    // un-establishable one leaves as a 401 problem+json rather than an
    // Express-level crash (#75).
    return this.service.listExports(await this.context.require(), parsed);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Export> {
    const key = parseIdempotencyKey(createExportHeader, idempotencyKey);
    const parsed = parseBoundary(createExportBody, body, 'request body');
    return this.service.createExport(await this.context.require(), parsed, key);
  }
}
