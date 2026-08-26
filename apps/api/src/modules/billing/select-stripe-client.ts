import type { Env } from '../../config/env.js';
import type { Clock } from './clock.js';
import { DemoStripeClient } from './demo-stripe-client.js';
import { HttpStripeClient } from './http-stripe-client.js';
import type { StripeClient } from './stripe-client.js';

/**
 * The `BILLING` switch, resolved once at composition time.
 *
 * Config, not import — the same rule as `selectExtractor`, `selectDocumentStore`
 * and `selectEmailSource`. `BillingService` is identical either way, so the
 * lane a test exercises is the lane staging runs.
 *
 * ⚠ There is no fallback from `stripe` to `demo`. `select-extractor.ts` spells
 * out why its own seam has none, and the argument is the same one here with
 * money on it: degrading a failed Stripe call to a fixture would hand a client
 * a checkout link that cannot take payment, and record nothing about it. A
 * Stripe outage is a 500 the client can retry, not a fake success.
 */
export function selectStripeClient(env: Env, clock?: Clock): StripeClient {
  if (env.BILLING === 'demo') return new DemoStripeClient(clock);
  return new HttpStripeClient({
    secretKey: env.STRIPE_SECRET_KEY,
    priceId: env.STRIPE_PRICE_ID,
    taxMode: env.STRIPE_TAX,
    taxRateId: env.STRIPE_TAX_RATE_ID,
  });
}
