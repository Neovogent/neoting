/**
 * The Stripe seam (D48, launch stage S4).
 *
 * Three calls, and deliberately only three: create a customer, mint a hosted
 * Checkout session, mint a hosted customer-portal session. Everything a
 * subscription business normally builds — the invoice, the receipt, the
 * dunning email, the card-update screen, the cancellation flow — is a page
 * Stripe already hosts and none of it appears here. "Buy, do not build" is a
 * shape, not a slogan: the surface below is what the shape costs.
 *
 * Behind an interface for the same reason every other external call in this
 * repo is: `DemoStripeClient` lets `pnpm test` and a laptop with no Stripe
 * account exercise the whole billing lane offline, while staging and
 * production run the identical service code against `HttpStripeClient`.
 * Selected by CONFIG (`BILLING`), never by import.
 */

/** A Stripe-hosted URL and when it stops working — the contract's `HostedBillingSession`. */
export interface HostedSession {
  readonly url: string;
  /** ISO 8601, or null when the session does not expire (the customer portal). */
  readonly expiresAt: string | null;
}

export interface CreateCustomerRequest {
  /** Stamped into `metadata.businessId`, so a human reading the Stripe dashboard can find the tenant. */
  readonly businessId: string;
  /**
   * ⚠ Stamped into `metadata.practiceId`, and it is LOAD-BEARING rather than
   * decorative — see `stripe-webhook.service.ts`. The webhook has no session,
   * `businesses` is behind RLS, and RLS needs an actor before it will return a
   * single row. The practice is what lets the handler open a SYSTEM scope and
   * ask the database the question; the Stripe customer id is still what
   * identifies the tenant inside it.
   *
   * Null for a standalone business with no practice above it. The webhook
   * refuses such an event loudly rather than guessing.
   */
  readonly practiceId: string | null;
  readonly name: string;
  /**
   * The primary contact's address, when the business has one. Null is fine:
   * hosted Checkout collects an email for a customer that has none, and an
   * invented placeholder would put a fake address on a real VAT invoice.
   */
  readonly email: string | null;
  /**
   * Stripe's own `Idempotency-Key`. Derived from ours, so a client that
   * double-taps Subscribe cannot end up with two Stripe customers — which,
   * because `businesses.stripe_customer_id` is UNIQUE, would otherwise be a
   * tenant the webhook cannot resolve.
   */
  readonly idempotencyKey: string;
}

export interface CreateCheckoutSessionRequest {
  readonly customerId: string;
  /** Carried as `client_reference_id` and in the metadata of both the session and the subscription it creates. */
  readonly businessId: string;
  /** Carried in the same metadata, for the reason {@link CreateCustomerRequest.practiceId} gives. */
  readonly practiceId: string | null;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}

export interface CreatePortalSessionRequest {
  readonly customerId: string;
  readonly returnUrl: string;
  readonly idempotencyKey: string;
}

export interface StripeClient {
  createCustomer(request: CreateCustomerRequest): Promise<{ readonly id: string }>;
  createCheckoutSession(request: CreateCheckoutSessionRequest): Promise<HostedSession>;
  createPortalSession(request: CreatePortalSessionRequest): Promise<HostedSession>;
}
