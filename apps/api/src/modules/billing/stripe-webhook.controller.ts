import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post, UseGuards } from '@nestjs/common';

import type { StripeWebhookService } from './stripe-webhook.service.js';
import { StripeSignatureGuard } from './stripe-signature.guard.js';
import { STRIPE_WEBHOOK_SERVICE } from './tokens.js';

/**
 * `POST /v1/webhooks/stripe` — the inbound Stripe event (D48).
 *
 * **Under `/v1`, unlike Meta's**, and that is not an oversight. The WhatsApp
 * webhook is excluded from the global prefix because Meta holds that URL in
 * its own configuration and does not follow redirects (`config/routing.ts`).
 * Stripe's endpoint URL is ours to choose and is set once in the Stripe
 * dashboard against whatever we tell it, so it goes where the contract puts it
 * — `/v1/webhooks/stripe`, which is what `openapi.yaml` declares and what
 * `docs/runbooks/stripe-billing.md` says to register.
 *
 * **200 for everything the signature admits**, including event types this
 * handler ignores and duplicates it has already seen. Stripe retries anything
 * else with backoff for days, and a retry storm caused by our own 500 on an
 * event we never wanted is strictly worse than a no-op. The one thing that
 * genuinely fails — a tenant that cannot be resolved — throws, and *should*
 * be retried, because it is usually a race we lose once and win a second later.
 */
@Controller('webhooks/stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(@Inject(STRIPE_WEBHOOK_SERVICE) private readonly service: StripeWebhookService) {}

  @Post()
  @UseGuards(StripeSignatureGuard)
  @HttpCode(HttpStatus.OK)
  async receive(@Body() body: unknown): Promise<void> {
    // The guard has already verified the signature against `req.rawBody`. This
    // parameter is the parsed copy, which is safe to read only BECAUSE that
    // happened first — never verify against it.
    const outcome = await this.service.handle(body);
    this.logger.debug(`Stripe webhook: ${outcome}`);
    // 200 with no body (contract): acknowledged.
  }
}
