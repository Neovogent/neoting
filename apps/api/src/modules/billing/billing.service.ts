import { HttpStatus, Logger } from '@nestjs/common';
import type { z } from 'zod';

import type { HostedBillingSession, SubscriptionStatus } from '@neoting/contracts/model';
import type { createBillingPortalSessionBody, createCheckoutSessionBody } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { assertAllowedReturnUrl } from './return-url.js';
import type { StripeClient } from './stripe-client.js';

export type CheckoutRequest = z.infer<typeof createCheckoutSessionBody>;
export type PortalRequest = z.infer<typeof createBillingPortalSessionBody>;

export interface BillingConfig {
  /** Parsed from `BILLING_RETURN_ORIGINS` once, at composition time. */
  readonly allowedReturnOrigins: ReadonlySet<string>;
}

/**
 * Statuses that mean a subscription object already exists at Stripe, so a
 * SECOND checkout would create a second one and charge the client twice.
 *
 * `INCOMPLETE` and `INCOMPLETE_EXPIRED` are deliberately absent: those are a
 * checkout that was started and never paid, and the right answer to a client
 * coming back is another checkout, not a portal with nothing in it. `CANCELED`
 * is absent for the same reason — resubscribing is a new subscription.
 */
const LIVE_AT_STRIPE: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'PAUSED',
  'UNPAID',
]);

/**
 * The two billing endpoints (D48, launch stage S4).
 *
 * Both do the same three things: resolve the business through RLS, make sure
 * there is a Stripe customer bound to it, and hand back a URL Stripe hosts.
 * There is no plan-change screen, no cancellation flow and no invoice
 * renderer, because those are three things Stripe already does correctly and
 * three more things that could be wrong on our side.
 *
 * **The Stripe customer is created BEFORE checkout, not discovered after it.**
 * That ordering is the whole reason the webhook can work at all: it runs with
 * no session and resolves its tenant purely from the Stripe customer id, so
 * the binding has to exist before any subscription event can arrive. Letting
 * Checkout mint the customer would leave a window in which
 * `customer.subscription.created` names a customer no row points at — and
 * events arrive out of order, so that window is not theoretical.
 */
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly stripe: StripeClient,
    private readonly idempotency: IdempotencyStore,
    private readonly config: BillingConfig,
  ) {}

  async createCheckoutSession(
    ctx: ScopeContext,
    request: CheckoutRequest,
    idempotencyKey: string,
  ): Promise<HostedBillingSession> {
    const replay = await this.replayed<HostedBillingSession>('checkout', request.businessId, idempotencyKey, request);
    if (replay !== null) return replay;

    // Validated BEFORE anything is created at Stripe. An open redirect that
    // only fires after a customer exists is still an open redirect, and the
    // orphaned customer is a second problem to clean up.
    assertAllowedReturnUrl(request.successUrl, this.config.allowedReturnOrigins, 'successUrl');
    assertAllowedReturnUrl(request.cancelUrl, this.config.allowedReturnOrigins, 'cancelUrl');

    const business = await this.reachableBusiness(ctx, request.businessId);
    if (LIVE_AT_STRIPE.has(business.subscriptionStatus as SubscriptionStatus)) {
      throw new AppException(
        'NT-BIL-002',
        HttpStatus.CONFLICT,
        'Already subscribed',
        'This client business already has a subscription. Card changes, invoices and cancellation are in the customer portal.',
      );
    }

    const customerId = await this.ensureCustomer(ctx, business);
    const session = await this.stripe.createCheckoutSession({
      customerId,
      businessId: business.id,
      practiceId: business.practiceId,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
      idempotencyKey: `neoting-checkout-${idempotencyKey}`,
    });

    const response: HostedBillingSession = { url: session.url, expiresAt: session.expiresAt };
    await this.remember('checkout', request.businessId, idempotencyKey, request, response);
    return response;
  }

  async createPortalSession(
    ctx: ScopeContext,
    request: PortalRequest,
    idempotencyKey: string,
  ): Promise<HostedBillingSession> {
    const replay = await this.replayed<HostedBillingSession>('portal', request.businessId, idempotencyKey, request);
    if (replay !== null) return replay;

    assertAllowedReturnUrl(request.returnUrl, this.config.allowedReturnOrigins, 'returnUrl');

    const business = await this.reachableBusiness(ctx, request.businessId);
    if (business.stripeCustomerId === null) {
      // Never been through checkout, so there is no portal to open — there is
      // no card on file, no invoice and nothing to cancel. 404 rather than the
      // 402 the upload path returns: this operation's own contract declares no
      // 402, and the honest reading is that the portal session does not exist
      // rather than that money is owed.
      throw new AppException(
        'NT-BIL-001',
        HttpStatus.NOT_FOUND,
        'No subscription to manage',
        'This client business has never been through checkout, so there is no billing portal for it yet.',
      );
    }

    const session = await this.stripe.createPortalSession({
      customerId: business.stripeCustomerId,
      returnUrl: request.returnUrl,
      idempotencyKey: `neoting-portal-${idempotencyKey}`,
    });

    const response: HostedBillingSession = { url: session.url, expiresAt: session.expiresAt };
    await this.remember('portal', request.businessId, idempotencyKey, request, response);
    return response;
  }

  /**
   * The business, or 404 — and the 404 is doing the tenancy work.
   *
   * `businesses_tenant` makes this `findUnique` return null for a business the
   * caller cannot reach, so a foreign `businessId` in the request body is
   * indistinguishable from one that does not exist. 404 and never 403: a 403
   * would confirm the record exists (`packages/contracts/CLAUDE.md`).
   */
  private async reachableBusiness(ctx: ScopeContext, businessId: string) {
    const business = await scopedDb(this.prisma, ctx, (db) =>
      db.business.findUnique({
        where: { id: businessId },
        select: {
          id: true,
          name: true,
          // ⚠ Read so it can be stamped into Stripe metadata — the webhook has
          // no session and this is what lets it open a tenant scope at all
          // (`stripe-webhook.service.ts`). Not decoration.
          practiceId: true,
          stripeCustomerId: true,
          subscriptionStatus: true,
          // The primary contact's address, for the Stripe customer. `take: 1`
          // rather than a join over every contact — this is the only field
          // needed and a client business can have many.
          contacts: {
            where: { isPrimary: true },
            select: { email: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      }),
    );
    if (business === null) {
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'No such business', 'No business with that id is reachable.');
    }
    return business;
  }

  /**
   * Bind a Stripe customer to this business, exactly once.
   *
   * ⚠ Two clients pressing Subscribe at the same moment is the case this is
   * shaped around. The write is a CONDITIONAL update — `where: { id,
   * stripeCustomerId: null }` — so only one of them can win, and the loser
   * re-reads rather than overwriting a binding the webhook may already be
   * resolving against. Overwriting it would strand every future event for the
   * old customer id with no row to match, which `businesses.stripe_customer_id`
   * being UNIQUE turns into a loud failure rather than a silent misroute, but
   * loud failures on someone's billing are still an incident.
   *
   * Stripe's own idempotency key is derived from the BUSINESS id, not from the
   * caller's per-attempt one, so the losing racer gets handed the same customer
   * back instead of orphaning a second one in the dashboard.
   */
  private async ensureCustomer(
    ctx: ScopeContext,
    business: {
      id: string;
      name: string;
      practiceId: string | null;
      stripeCustomerId: string | null;
      contacts: Array<{ email: string | null }>;
    },
  ): Promise<string> {
    if (business.stripeCustomerId !== null) return business.stripeCustomerId;

    const customer = await this.stripe.createCustomer({
      businessId: business.id,
      practiceId: business.practiceId,
      name: business.name,
      email: business.contacts[0]?.email ?? null,
      idempotencyKey: `neoting-customer-${business.id}`,
    });

    const bound = await scopedDb(this.prisma, ctx, (db) =>
      db.business.updateMany({
        where: { id: business.id, stripeCustomerId: null },
        data: { stripeCustomerId: customer.id },
      }),
    );
    if (bound.count === 1) return customer.id;

    // Someone else bound one first. Read theirs and use it.
    const existing = await scopedDb(this.prisma, ctx, (db) =>
      db.business.findUnique({ where: { id: business.id }, select: { stripeCustomerId: true } }),
    );
    if (existing?.stripeCustomerId != null) {
      this.logger.warn(`Concurrent checkout for business ${business.id}; keeping the customer already bound`);
      return existing.stripeCustomerId;
    }
    // Neither branch bound anything, which means the UPDATE was refused rather
    // than raced — an RLS write the caller's context does not permit. Fail
    // loudly instead of handing back a customer id nothing points at.
    throw new AppException(
      'NT-SRV-001',
      HttpStatus.INTERNAL_SERVER_ERROR,
      'Could not start checkout',
      'The subscription could not be attached to this client business.',
    );
  }

  /**
   * Replay namespace is the BUSINESS, not the caller. `Idempotency-Key` is a
   * client-generated UUID over one shared map, and two practices must never be
   * able to collide into each other's hosted-session URL — a checkout URL is a
   * credential for a payment page bound to someone else's customer.
   */
  private async replayed<T>(op: Operation, businessId: string, idempotencyKey: string, request: unknown): Promise<T | null> {
    const record = await this.idempotency.get(storeKey(op, businessId, idempotencyKey));
    if (record === null) return null;
    if (record.requestHash !== fingerprint(request)) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as T;
  }

  private async remember(op: Operation, businessId: string, idempotencyKey: string, request: unknown, response: unknown): Promise<void> {
    await this.idempotency.put(storeKey(op, businessId, idempotencyKey), { requestHash: fingerprint(request), response });
  }
}

/**
 * The two operations share one store, so the key names which one it was. The
 * contract makes `Idempotency-Key` a caller-generated UUID and nothing stops a
 * client reusing the same one for checkout and then for the portal — without
 * the prefix the second call would replay the first one's URL, and a checkout
 * URL returned where a portal URL was asked for is a client being sent to pay
 * again for something they already have.
 */
type Operation = 'checkout' | 'portal';

function storeKey(op: Operation, businessId: string, idempotencyKey: string): string {
  return `billing:${op}:${businessId}:${idempotencyKey}`;
}
