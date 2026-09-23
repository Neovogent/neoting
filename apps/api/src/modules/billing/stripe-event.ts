import { z } from 'zod';

/**
 * The Stripe event envelope, parsed at the boundary against the shapes the
 * handler actually reads (contract: "this contract does not own Stripe's
 * schema and a pinned copy of it would rot").
 *
 * `.passthrough()` throughout, deliberately: Stripe adds fields constantly and
 * a `.strict()` parse here would turn every one of those additions into a
 * rejected webhook, a retry storm and a stale entitlement. What is pinned is
 * the handful of fields a subscription decision depends on.
 */

/**
 * Stripe's own statuses, upper-cased into the Prisma enum.
 *
 * ⚠ An unknown value THROWS rather than degrading to something safe-looking.
 * The contract is explicit about why: a status the enum does not admit must be
 * a failed write — loud, retried by Stripe, and visible in their event log —
 * rather than a silently stale entitlement that nobody discovers until a
 * client complains about being locked out or, worse, nobody discovers at all
 * because the client is being served for free.
 */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;

const StripeStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

/** Stripe's lower_snake status → the Prisma `SubscriptionStatus` value. */
export function toPrismaStatus(status: z.infer<typeof StripeStatusSchema>): string {
  return status.toUpperCase();
}

/**
 * A subscription, as much of one as we read.
 *
 * ⚠ `current_period_end` lives in TWO places depending on the API version the
 * webhook endpoint is configured with. Stripe moved it from the subscription
 * onto each subscription ITEM in `2025-03-31.basil`. Both are parsed and the
 * item wins, because an endpoint pinned to an older version still sends the
 * top-level field and an endpoint on a current one sends only the item. Read
 * one and the renewal date is silently null on half of all deployments — and a
 * null period end is what the out-of-order guard uses to decide an event is
 * safe to apply.
 */
export const SubscriptionObjectSchema = z
  .object({
    id: z.string().min(1),
    customer: z.string().min(1),
    status: StripeStatusSchema,
    current_period_end: z.number().int().positive().nullish(),
    items: z
      .object({
        data: z
          .array(
            z
              .object({
                current_period_end: z.number().int().positive().nullish(),
                price: z.object({ id: z.string().min(1) }).passthrough().nullish(),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type SubscriptionObject = z.infer<typeof SubscriptionObjectSchema>;

/** A completed Checkout Session — read only to CHECK the customer↔business binding, never to write state. */
export const CheckoutSessionObjectSchema = z
  .object({
    id: z.string().min(1),
    // Null when Checkout is configured not to create a customer. We always pass
    // one, so a null here is a real anomaly and the handler says so.
    customer: z.string().min(1).nullish(),
    client_reference_id: z.string().min(1).nullish(),
  })
  .passthrough();

export const StripeEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    /** Stripe's own creation time, seconds. Logged, never used to order writes — see `stripe-webhook.service.ts`. */
    created: z.number().int().nonnegative().optional(),
    data: z.object({ object: z.unknown() }).passthrough(),
  })
  .passthrough();

export type StripeEvent = z.infer<typeof StripeEventSchema>;

/**
 * The end of the period this subscription is paid up to, in ms, or null.
 *
 * Takes the item's value first (current API versions), falls back to the
 * subscription's (older ones). With more than one item it takes the LATEST —
 * ID sells exactly one price per business, so more than one item means
 * something we did not create, and the later date is the conservative answer
 * to "until when is this workspace entitled".
 */
export function currentPeriodEndMs(subscription: SubscriptionObject): number | null {
  const itemEnds = (subscription.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number');
  const seconds = itemEnds.length > 0 ? Math.max(...itemEnds) : (subscription.current_period_end ?? null);
  return seconds === null || seconds === undefined ? null : seconds * 1000;
}

/**
 * The Stripe price id this subscription is on — what `businesses.plan` stores.
 *
 * ⚠ **`items.data[0]` was right until 21 Sep 2026 and is now a coin toss.** The
 * Document Vault add-on (D51) is a SECOND item on the same subscription, and
 * Stripe does not promise the order of that array. Taking the first element
 * would have written `price_…vault` into `plan` for some clients and the base
 * price for others, from the same event, depending on nothing anyone could see.
 *
 * So the add-on price is named and excluded, and the base is whatever is left.
 * With no add-on configured this is the old behaviour exactly.
 */
export function planOf(subscription: SubscriptionObject, addOnPriceIds: readonly string[] = []): string | null {
  const ids = (subscription.items?.data ?? [])
    .map((item) => item.price?.id)
    .filter((id): id is string => typeof id === 'string');
  // The fallback matters: a subscription carrying ONLY the add-on price is not
  // a shape we create, but reporting `null` for it would read as "never been
  // through checkout", which is a different and wrong story.
  return ids.find((id) => !addOnPriceIds.includes(id)) ?? ids[0] ?? null;
}

/**
 * Whether the Document Vault add-on is on this subscription (D51).
 *
 * ⚠ **Presence of the PRICE, not of a flag we set.** Stripe is the source of
 * truth for what a client pays for, and the only honest way to answer "have
 * they bought the vault" is to look at what is on the subscription. A client
 * who removes the add-on in Stripe's own portal — which they can, and which we
 * host precisely so they can — produces a `customer.subscription.updated` with
 * one item, and this returns false without anything else having to notice.
 *
 * An unconfigured price id (`''`) answers false rather than throwing: a
 * deployment that does not sell the add-on is a valid deployment, and every
 * client on it simply has no vault.
 */
export function hasVaultAddOn(subscription: SubscriptionObject, vaultPriceId: string): boolean {
  if (vaultPriceId === '') return false;
  return (subscription.items?.data ?? []).some((item) => item.price?.id === vaultPriceId);
}
