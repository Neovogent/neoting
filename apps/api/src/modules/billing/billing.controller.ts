import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';

import type { HostedBillingSession } from '@neoting/contracts/model';
import {
  createBillingPortalSessionBody,
  createBillingPortalSessionHeader,
  createCheckoutSessionBody,
  createCheckoutSessionHeader,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import type { BillingService } from './billing.service.js';
import { BILLING_SERVICE } from './tokens.js';

/**
 * The billing surface (D48) — two POSTs, both of which hand back a URL Stripe
 * hosts and neither of which renders anything itself.
 *
 * Thin by design (`apps/api/CLAUDE.md`, 200-line cap): parse with the
 * generated schemas, take the request context, call ONE service method, return
 * it. `Idempotency-Key` is `required: true` on both operations
 * (`x-nt-side-effect: ingest`), so a missing one is a 400 here rather than a
 * silently non-idempotent call to a payment provider.
 */
@Controller('billing')
export class BillingController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(BILLING_SERVICE) private readonly service: BillingService,
  ) {}

  @Post('checkout-sessions')
  @HttpCode(HttpStatus.CREATED)
  async checkout(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<HostedBillingSession> {
    const key = parseIdempotencyKey(createCheckoutSessionHeader, idempotencyKey);
    const parsed = parseBoundary(createCheckoutSessionBody, body, 'request body');
    // `require()` resolves the context inside Nest's pipeline, so a bad one
    // leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.service.createCheckoutSession(await this.context.require(), parsed, key);
  }

  @Post('portal-sessions')
  @HttpCode(HttpStatus.CREATED)
  async portal(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<HostedBillingSession> {
    const key = parseIdempotencyKey(createBillingPortalSessionHeader, idempotencyKey);
    const parsed = parseBoundary(createBillingPortalSessionBody, body, 'request body');
    return this.service.createPortalSession(await this.context.require(), parsed, key);
  }
}
