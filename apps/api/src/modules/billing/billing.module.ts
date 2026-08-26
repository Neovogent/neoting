import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { type IdempotencyStore, InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { type Clock, systemClock } from './clock.js';
import { parseAllowedOrigins } from './return-url.js';
import { selectStripeClient } from './select-stripe-client.js';
import type { StripeClient } from './stripe-client.js';
import { InMemoryStripeEventReplayStore, type StripeEventReplayStore } from './stripe-event-replay-store.js';
import { StripeSignatureGuard } from './stripe-signature.guard.js';
import { StripeWebhookController } from './stripe-webhook.controller.js';
import { StripeWebhookService } from './stripe-webhook.service.js';
import {
  BILLING_SERVICE,
  CLOCK,
  IDEMPOTENCY_STORE,
  PRISMA,
  STRIPE_CLIENT,
  STRIPE_EVENT_REPLAY_STORE,
  STRIPE_WEBHOOK_SERVICE,
} from './tokens.js';

/**
 * Billing (D48, launch stage S4).
 *
 * The Stripe client is config-selected (`BILLING`), never import-selected, so
 * `pnpm dev` and `pnpm test` run this lane against the offline stand-in while
 * staging and production run the identical service code against Stripe.
 *
 * The return-origin allowlist is parsed ONCE here rather than per request:
 * `BILLING_RETURN_ORIGINS` cannot change without a restart, and re-parsing a
 * string on the hot path of a payment endpoint is work with no upside.
 *
 * The Prisma client is the shared pooled one (Governance §5.1) and is
 * *received* by both services, never constructed inside them; it connects as
 * `nt_app`, so every query still has to go through `scopedDb` to see anything
 * at all — including the webhook's, which is the whole subject of
 * `stripe-webhook.service.ts`.
 *
 * Both controllers live in one module because they are one lane: the webhook
 * is the other half of what the checkout endpoint starts, and splitting them
 * would put the Stripe seam in two places.
 */
@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [
    StripeSignatureGuard,
    { provide: CLOCK, useValue: systemClock },
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: STRIPE_CLIENT,
      useFactory: (env: Env, clock: Clock) => selectStripeClient(env, clock),
      inject: [ENV, CLOCK],
    },
    { provide: IDEMPOTENCY_STORE, useFactory: () => new InMemoryIdempotencyStore() },
    {
      provide: STRIPE_EVENT_REPLAY_STORE,
      useFactory: (clock: Clock) => new InMemoryStripeEventReplayStore(clock),
      inject: [CLOCK],
    },
    {
      provide: BILLING_SERVICE,
      useFactory: (prisma: PrismaClient, stripe: StripeClient, idempotency: IdempotencyStore, env: Env) =>
        new BillingService(prisma, stripe, idempotency, {
          allowedReturnOrigins: parseAllowedOrigins(env.BILLING_RETURN_ORIGINS),
        }),
      inject: [PRISMA, STRIPE_CLIENT, IDEMPOTENCY_STORE, ENV],
    },
    {
      provide: STRIPE_WEBHOOK_SERVICE,
      useFactory: (prisma: PrismaClient, replay: StripeEventReplayStore) => new StripeWebhookService(prisma, replay),
      inject: [PRISMA, STRIPE_EVENT_REPLAY_STORE],
    },
  ],
})
export class BillingModule {}
