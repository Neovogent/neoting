import { createHash } from 'node:crypto';

import { type Clock, systemClock } from './clock.js';
import type {
  CreateCheckoutSessionRequest,
  CreateCustomerRequest,
  CreatePortalSessionRequest,
  HostedSession,
  StripeClient,
} from './stripe-client.js';

/**
 * The offline stand-in (`BILLING=demo`) — the default, so a fresh clone, CI and
 * a laptop with no Stripe account all run the whole billing lane.
 *
 * **Every URL it mints is on `.invalid`**, the TLD RFC 2606 reserves as
 * guaranteed-never-to-resolve. That is the entire design of this class: a demo
 * checkout link must be *provably* incapable of reaching a payment page, so
 * that if one ever escapes into a real environment it fails immediately and
 * visibly rather than looking plausible. A `https://checkout.stripe.com/…`
 * shaped fake would be indistinguishable from the real thing right up until a
 * client clicked it.
 *
 * Deterministic — ids are a hash of the input — so an integration test can
 * assert an exact URL, and a replayed idempotency key produces the same answer
 * without a store behind it.
 *
 * ⚠ It does NOT make anything free. Entitlement is read from
 * `businesses.subscription_status` regardless of which client is wired, so a
 * demo environment still refuses uploads for a business with no subscription;
 * the seed is what makes the demo businesses entitled.
 */
export class DemoStripeClient implements StripeClient {
  constructor(private readonly clock: Clock = systemClock) {}

  async createCustomer(request: CreateCustomerRequest): Promise<{ readonly id: string }> {
    return { id: `cus_demo_${digest(request.businessId)}` };
  }

  async createCheckoutSession(request: CreateCheckoutSessionRequest): Promise<HostedSession> {
    return {
      url: `https://billing.invalid/demo/checkout/cs_demo_${digest(`${request.customerId}:${request.idempotencyKey}`)}`,
      // Stripe's own checkout sessions expire in 24 hours. Mirrored so a caller
      // rendering "this link expires at…" is exercised in demo too.
      expiresAt: new Date(this.clock.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async createPortalSession(request: CreatePortalSessionRequest): Promise<HostedSession> {
    return {
      url: `https://billing.invalid/demo/portal/bps_demo_${digest(request.customerId)}`,
      // Portal sessions carry no expiry, in demo as in Stripe.
      expiresAt: null,
    };
  }
}

function digest(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 24);
}
