import { Controller, Get, HttpCode, HttpStatus, Inject, Query } from '@nestjs/common';

import { listDuplicatesQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { DuplicatesService } from './duplicates.service.js';
import { DUPLICATES_SERVICE } from './tokens.js';

/**
 * The duplicates read surface (review item 49). One GET,
 * `x-nt-side-effect: none`, so no `Idempotency-Key` — reads never carry one
 * (the chases-controller rule). The WRITE is `document.resolve-duplicate` on
 * the Review → Approve spine, executed by the registry, never reachable from
 * here — this module's own #81 discipline.
 */
@Controller()
export class DuplicatesController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(DUPLICATES_SERVICE) private readonly service: DuplicatesService,
  ) {}

  @Get('duplicates')
  @HttpCode(HttpStatus.OK)
  async listDuplicates(@Query() query: unknown) {
    const parsed = parseBoundary(
      listDuplicatesQueryParams,
      coerceQuery(listDuplicatesQueryParams, query),
      'query parameters',
    );
    return this.service.listDuplicates(await this.context.require(), parsed);
  }
}
