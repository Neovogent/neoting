import { Logger } from '@nestjs/common';
import { z } from 'zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { resolveSystemActor } from '../../common/db/resolve-system-actor.js';
import { type ScopeContext, systemContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import {
  CheckoutSessionObjectSchema,
  currentPeriodEndMs,
  planOf,
  StripeEventSchema,
  SubscriptionObjectSchema,
  toPrismaStatus,
} from './stripe-event.js';
import type { StripeEventReplayStore } from './stripe-event-replay-store.js';

/**
 * The only thing that moves a business's subscription state (D48).
 *
 * Checkout completing, a renewal succeeding, a card failing, a cancellation:
 * all of it arrives here, and none of it is inferred from a redirect. A client
 * who closes the tab on Stripe's success page is still subscribed, because
 * Stripe said so on this endpoint and not because a browser came back.
 *
 * ## The tenancy problem this endpoint has, and how it is solved
 *
 * ⚠ **There is no session, so there is no actor — and `businesses` is behind
 * RLS that fails CLOSED AND SILENT.** An unscoped read of that table does not
 * error and does not return everything; it returns NOTHING, because every
 * policy branch begins `app_actor_id() IS NOT NULL`. So the obvious
 * implementation — "look up the business by Stripe customer id" — is a
 * function that always finds zero rows and a subscription that never activates.
 *
 * The way out has three parts, and all three are load-bearing:
 *
 * 1. **We stamp `businessId` and `practiceId` into Stripe metadata** when the
 *    customer and the checkout session are created (`http-stripe-client.ts`),
 *    at a moment when we legitimately know both. The event is
 *    signature-verified before it reaches here, so that metadata is our own
 *    data coming back, not a caller's claim.
 * 2. **The practice is used only to OPEN a scope**, never as the answer. A
 *    `systemContext` for that practice is exactly the scope the workers
 *    already write under — the same policies, no privileged side door, and
 *    `resolveSystemActor` reads only `users` and `memberships`, which carry no
 *    RLS.
 * 3. **The tenant is then resolved INSIDE that scope, by Stripe customer id**,
 *    and the handler asserts it matched exactly one row —
 *    `businesses.stripe_customer_id` is UNIQUE, so that assertion is
 *    structural rather than hopeful.
 *
 * What this buys: metadata naming the wrong practice cannot cause a wrong
 * write. The scoped query simply returns zero rows and the handler throws,
 * which Stripe retries and an operator sees. A subscription written to the
 * wrong tenant would be invisible to everyone, including us, so the design
 * makes it unreachable rather than unlikely.
 *
 * ## Ordering and repetition
 *
 * Events arrive out of order and more than once. Both are handled:
 *
 * - **More than once** — every event id is reserved before it is applied.
 * - **Out of order** — a subscription update that is OLDER than the one already
 *   stored is discarded rather than applied. There is no `last_event_at`
 *   column (`prisma/` is LAW and the ID batch added four columns, not five), so
 *   the comparison is on `current_period_end`, which only ever moves forward
 *   for a live subscription. `customer.subscription.deleted` is exempt: a
 *   cancellation is terminal and always applies, or a late renewal event would
 *   resurrect a subscription the client ended.
 */

/** What the handler tells the controller. Every branch is a 200 — see the controller. */
export type WebhookOutcome = 'applied' | 'ignored' | 'duplicate' | 'stale';

/** A Stripe event id stays reserved well past any retry window Stripe uses. */
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

/** The metadata we stamped, coming back. Parsed, not trusted, even though it is ours. */
const TenantMetadataSchema = z
  .object({
    businessId: z.string().min(1).optional(),
    practiceId: z.string().min(1).optional(),
  })
  .passthrough();

export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly replay: StripeEventReplayStore,
  ) {}

  async handle(rawEvent: unknown): Promise<WebhookOutcome> {
    // Zod at the boundary. The envelope is ours to insist on even though the
    // object inside it is Stripe's to change.
    const event = StripeEventSchema.parse(rawEvent);

    const fresh = await this.replay.reserve(event.id, REPLAY_TTL_MS);
    if (!fresh) {
      this.logger.debug(`Duplicate Stripe event ${event.id} (${event.type}) ignored`);
      return 'duplicate';
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.applySubscription(event.type, event.data.object);
      case 'checkout.session.completed':
        return this.checkBinding(event.data.object);
      default:
        // Acknowledged and ignored. Stripe retries anything else, and a retry
        // storm is worse than a no-op — including for `invoice.paid` and
        // `invoice.payment_failed`, whose consequences reach us as the
        // `customer.subscription.updated` that Stripe emits alongside them.
        // Subscription state has exactly one writer, above.
        this.logger.debug(`Stripe event type ${event.type} not handled (${event.id})`);
        return 'ignored';
    }
  }

  private async applySubscription(type: string, object: unknown): Promise<WebhookOutcome> {
    const subscription = SubscriptionObjectSchema.parse(object);
    const metadata = TenantMetadataSchema.parse(subscription['metadata'] ?? {});
    const ctx = await this.scopeFor(metadata.practiceId, subscription.customer);

    const status = toPrismaStatus(subscription.status);
    const periodEndMs = currentPeriodEndMs(subscription);
    const plan = planOf(subscription);
    const terminal = type === 'customer.subscription.deleted';

    const outcome = await scopedDb(this.prisma, ctx, async (db) => {
      // ⚠ Resolved by CUSTOMER ID, inside the scope, and asserted to be exactly
      // one. `findMany` rather than `findUnique` on purpose: the assertion is
      // the point, and `findUnique` on a unique column cannot distinguish "the
      // row is not visible in this scope" from "there is no such row".
      const rows = await db.business.findMany({
        where: { stripeCustomerId: subscription.customer },
        select: { id: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true },
      });
      if (rows.length !== 1) {
        throw new Error(
          `Stripe customer ${subscription.customer} matched ${rows.length} businesses in scope — refusing to write a subscription to an unknown or ambiguous tenant`,
        );
      }
      const business = rows[0]!;

      if (!terminal && isStale(business.subscriptionCurrentPeriodEnd, periodEndMs)) {
        this.logger.warn(
          `Discarding out-of-order ${type} for business ${business.id}: it ends before the period already stored`,
        );
        return 'stale' as const;
      }

      await db.business.update({
        where: { id: business.id },
        data: {
          // Cast at the one place the string meets Prisma's enum. The value
          // came from a Zod enum of exactly the eight Stripe statuses, which
          // `check-contract.mjs` pins against `SubscriptionStatus` in the
          // schema — so a drift between the two fails the build rather than
          // this line.
          subscriptionStatus: status as never,
          plan,
          subscriptionCurrentPeriodEnd: periodEndMs === null ? null : new Date(periodEndMs),
        },
      });
      this.logger.log(`Business ${business.id} subscription → ${status} (${type})`);
      return 'applied' as const;
    });

    return outcome;
  }

  /**
   * `checkout.session.completed` writes nothing.
   *
   * The customer was bound to the business before checkout ever opened, and
   * `customer.subscription.created` carries the authoritative status moments
   * later — so there is no state here that is not better taken from there.
   * What this DOES do is compare the two identities Stripe hands back
   * (`client_reference_id` and `customer`) against the binding in our own
   * database, because a disagreement between them is the one failure in this
   * lane that is otherwise completely silent: it would mean a client paid and
   * a different tenant became entitled.
   */
  private async checkBinding(object: unknown): Promise<WebhookOutcome> {
    const session = CheckoutSessionObjectSchema.parse(object);
    const metadata = TenantMetadataSchema.parse(session['metadata'] ?? {});
    const expectedBusinessId = session.client_reference_id ?? metadata.businessId ?? null;

    if (session.customer == null || expectedBusinessId === null) {
      this.logger.error(`Checkout session ${session.id} completed with no customer or no business reference — cannot verify the binding`);
      return 'ignored';
    }

    const ctx = await this.scopeFor(metadata.practiceId, session.customer);
    const bound = await scopedDb(this.prisma, ctx, (db) =>
      db.business.findMany({ where: { stripeCustomerId: session.customer as string }, select: { id: true } }),
    );

    if (bound.length !== 1 || bound[0]!.id !== expectedBusinessId) {
      // Loud, and deliberately not a throw: throwing would make Stripe retry an
      // event that will never succeed, and the subscription events that carry
      // the real state are unaffected by this check either way.
      this.logger.error(
        `Checkout session ${session.id}: Stripe customer ${session.customer} is bound to ${bound.map((row) => row.id).join(',') || '(nothing)'} but checkout named ${expectedBusinessId}`,
      );
      return 'ignored';
    }
    return 'applied';
  }

  /**
   * The SYSTEM scope this event is processed under.
   *
   * Refuses rather than guesses when the practice is absent. A standalone
   * business (no practice above it) has no SYSTEM actor to run as, and ID
   * creates every client business under a practice — so an event without one
   * is a customer created outside this code path, and inventing a scope for it
   * is how the wrong tenant gets written.
   */
  private async scopeFor(practiceId: string | undefined, customerId: string): Promise<ScopeContext> {
    if (practiceId === undefined) {
      throw new Error(
        `Stripe customer ${customerId} carries no practiceId in its metadata — cannot open a tenant scope, so the event is refused rather than guessed`,
      );
    }
    const systemUserId = await resolveSystemActor(this.prisma, practiceId);
    return systemContext(practiceId, systemUserId);
  }
}

/**
 * Is this event older than what is already stored?
 *
 * Only when BOTH ends are known. A stored null means we have never recorded a
 * period, so anything is news; an incoming null means Stripe sent a
 * subscription with no period (an incomplete one), and refusing to apply that
 * because it "has no end date" would strand the business on a stale status.
 * Equal ends apply — Stripe sends several updates within one period and each
 * carries a status the last one may not have.
 */
function isStale(stored: Date | null, incomingMs: number | null): boolean {
  if (stored === null || incomingMs === null) return false;
  return incomingMs < stored.getTime();
}
