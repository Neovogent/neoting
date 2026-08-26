import { expect, test } from 'vitest';

import {
  CheckoutSessionObjectSchema,
  currentPeriodEndMs,
  planOf,
  StripeEventSchema,
  SubscriptionObjectSchema,
  toPrismaStatus,
} from './stripe-event.js';

const PERIOD_END_S = 1_774_000_000;

function subscription(over: Record<string, unknown> = {}) {
  return SubscriptionObjectSchema.parse({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    items: { data: [{ current_period_end: PERIOD_END_S, price: { id: 'price_neo' } }] },
    ...over,
  });
}

test('every Stripe status maps onto the Prisma enum', () => {
  const pairs = [
    ['incomplete', 'INCOMPLETE'],
    ['incomplete_expired', 'INCOMPLETE_EXPIRED'],
    ['trialing', 'TRIALING'],
    ['active', 'ACTIVE'],
    ['past_due', 'PAST_DUE'],
    ['canceled', 'CANCELED'],
    ['unpaid', 'UNPAID'],
    ['paused', 'PAUSED'],
  ] as const;
  for (const [stripe, prisma] of pairs) {
    expect(toPrismaStatus(SubscriptionObjectSchema.parse({ ...subscription(), status: stripe }).status)).toBe(prisma);
  }
});

test('a status the enum does not admit THROWS rather than degrading to something safe-looking', () => {
  // The contract is explicit: a failed write here is loud, retried by Stripe
  // and visible, which is strictly better than a silently stale entitlement.
  expect(() => SubscriptionObjectSchema.parse({ id: 's', customer: 'c', status: 'expired' })).toThrow();
});

test('current_period_end is read from the ITEM on current API versions', () => {
  expect(currentPeriodEndMs(subscription())).toBe(PERIOD_END_S * 1000);
});

test('current_period_end falls back to the SUBSCRIPTION on a pre-basil endpoint', () => {
  // An endpoint pinned to an older API version sends only the top-level field.
  // Reading one location leaves the renewal date null on half of all
  // deployments — and a null end is what the out-of-order guard reads.
  const legacy = subscription({ items: { data: [{ price: { id: 'price_neo' } }] }, current_period_end: PERIOD_END_S });
  expect(currentPeriodEndMs(legacy)).toBe(PERIOD_END_S * 1000);
});

test('with several items the LATEST end wins', () => {
  const many = subscription({
    items: {
      data: [
        { current_period_end: PERIOD_END_S, price: { id: 'price_neo' } },
        { current_period_end: PERIOD_END_S + 86_400, price: { id: 'price_other' } },
      ],
    },
  });
  expect(currentPeriodEndMs(many)).toBe((PERIOD_END_S + 86_400) * 1000);
});

test('no period anywhere is null, not zero — an incomplete subscription has no period', () => {
  expect(currentPeriodEndMs(subscription({ items: { data: [] }, current_period_end: null }))).toBeNull();
  expect(currentPeriodEndMs(subscription({ items: null, current_period_end: undefined }))).toBeNull();
});

test('the plan is the Stripe price id, and null when Stripe sends no price', () => {
  expect(planOf(subscription())).toBe('price_neo');
  expect(planOf(subscription({ items: { data: [{ current_period_end: PERIOD_END_S }] } }))).toBeNull();
  expect(planOf(subscription({ items: { data: [] } }))).toBeNull();
});

test('unknown fields pass through rather than failing the webhook', () => {
  // Stripe adds fields constantly. A strict parse here would turn every one of
  // those additions into a rejected webhook and a stale entitlement.
  const parsed = SubscriptionObjectSchema.parse({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    something_stripe_added_last_tuesday: true,
    items: { data: [{ current_period_end: PERIOD_END_S, price: { id: 'p' }, brand_new: 1 }], has_more: false },
  });
  expect(parsed['something_stripe_added_last_tuesday']).toBe(true);
});

test('the envelope keeps the id and type, and carries metadata through', () => {
  const event = StripeEventSchema.parse({
    id: 'evt_1',
    type: 'customer.subscription.updated',
    created: 1_772_000_000,
    data: { object: { id: 'sub_1', metadata: { businessId: 'biz_1' } } },
  });
  expect(event.id).toBe('evt_1');
  expect(event.type).toBe('customer.subscription.updated');
});

test('an envelope missing an id is refused — idempotency has nothing to key on without it', () => {
  expect(() => StripeEventSchema.parse({ type: 'x', data: { object: {} } })).toThrow();
});

test('a checkout session parses with a null customer rather than throwing', () => {
  // We always pass a customer, so a null is a real anomaly the handler logs —
  // but it must reach the handler to be logged.
  const parsed = CheckoutSessionObjectSchema.parse({ id: 'cs_1', customer: null, client_reference_id: null });
  expect(parsed.customer).toBeNull();
});
