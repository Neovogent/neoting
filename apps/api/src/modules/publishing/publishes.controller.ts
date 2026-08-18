import { Controller, Get, HttpCode, HttpStatus, Inject, Query } from '@nestjs/common';

import { listPublishesQueryParams } from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { PublishesService } from './publishes.service.js';
import { PUBLISHES_SERVICE } from './tokens.js';

/**
 * The publish read surface (METH Stage 10, SoT §4 Stage 10).
 *
 * One GET. **No `Idempotency-Key`, and that is the contract's rule rather than
 * an omission**: `check-contract.mjs` requires the header only where the method
 * is not GET and the side effect is not `none`, and `listPublishes` is
 * `x-nt-side-effect: none`. A read demanding an idempotency key would be
 * cargo-culting the write surface.
 *
 * Thin by design (apps/api/CLAUDE.md, 200-line cap): parse with the generated
 * schema, take the request context, call ONE service method, return it. No
 * filtering, no projection and no tenancy decision happens in this file.
 */
@Controller('publishes')
export class PublishesController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(PUBLISHES_SERVICE) private readonly service: PublishesService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    // `coerceQuery` first. Express delivers every query value as a string, and
    // a repeatable parameter given ONCE arrives bare — `?state=FAILED` is the
    // string `'FAILED'`, while the generated schema types `state` as an array
    // (`style: form, explode: true`) and `limit` as a number. Parsed raw, the
    // single-state filter that the Rejected/Failed surface sends would be a
    // 400. The helper is schema-driven, so it cannot drift from the contract.
    const parsed = parseBoundary(
      listPublishesQueryParams,
      coerceQuery(listPublishesQueryParams, query),
      'query parameters',
    );
    // `require()` resolves the context here, inside Nest's pipeline, so an
    // un-establishable one leaves as a 401 problem+json rather than an
    // Express-level crash (#75).
    return this.service.listPublishes(await this.context.require(), parsed);
  }
}
