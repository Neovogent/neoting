import { expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { Clock } from './clock.js';
import { InMemoryStripeEventReplayStore } from './stripe-event-replay-store.js';
import { StripeWebhookService } from './stripe-webhook.service.js';

const PERIOD_END_S = 1_774_000_000;
const clock: Clock = { now: () => 1_772_000_000_000 };

interface Row {
  id: string;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: Date | null;
}

interface Calls {
  membershipFindFirst: unknown[];
  businessFindMany: Array<{ where?: unknown }>;
  update: Array<{ where?: unknown; data?: Record<string, unknown> }>;
  guc: Array<unknown>;
}

function harness(options: { rows?: Row[]; systemActor?: string | null } = {}) {
  const calls: Calls = { membershipFindFirst: [], businessFindMany: [], update: [], guc: [] };
  const rows = options.rows ?? [{ id: 'biz_1', subscriptionStatus: null, subscriptionCurrentPeriodEnd: null }];

  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      calls.guc.push(args);
      return 0;
    },
    business: {
      findMany: async (args: { where?: unknown }) => {
        calls.businessFindMany.push(args);
        return rows;
      },
      update: async (args: { where?: unknown; data?: Record<string, unknown> }) => {
        calls.update.push(args);
        return rows[0];
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    membership: {
      findFirst: async (args: unknown) => {
        calls.membershipFindFirst.push(args);
        const userId = options.systemActor === undefined ? 'usr_system' : options.systemActor;
        return userId === null ? null : { userId };
      },
    },
  } as unknown as PrismaClient;

  return { calls, service: new StripeWebhookService(prisma, new InMemoryStripeEventReplayStore(clock)) };
}

function subscriptionEvent(over: Record<string, unknown> = {}, type = 'customer.subscription.updated', id = 'evt_1') {
  return {
    id,
    type,
    created: 1_772_000_000,
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        metadata: { businessId: 'biz_1', practiceId: 'prac_1' },
        items: { data: [{ current_period_end: PERIOD_END_S, price: { id: 'price_neo' } }] },
        ...over,
      },
    },
  };
}

test('a subscription event writes status, plan and the renewal date', async () => {
  const { calls, service } = harness();
  expect(await service.handle(subscriptionEvent())).toBe('applied');
  expect(calls.update[0]?.where).toEqual({ id: 'biz_1' });
  expect(calls.update[0]?.data).toEqual({
    subscriptionStatus: 'ACTIVE',
    plan: 'price_neo',
    subscriptionCurrentPeriodEnd: new Date(PERIOD_END_S * 1000),
  });
});

test('THE TENANT IS RESOLVED BY STRIPE CUSTOMER ID, inside a scope, never from metadata directly', async () => {
  // The metadata supplies the SCOPE to open; the customer id is what identifies
  // the tenant inside it. Metadata naming the wrong practice cannot cause a
  // wrong write — the scoped query simply returns nothing.
  const { calls, service } = harness();
  await service.handle(subscriptionEvent());
  expect(calls.businessFindMany[0]?.where).toEqual({ stripeCustomerId: 'cus_1' });
  // And the scope really was opened: `scopedDb` sets the five GUCs first.
  expect(calls.guc.length).toBeGreaterThan(0);
});

test('a customer matching no visible business REFUSES rather than writing nothing quietly', async () => {
  // RLS fails closed and silent, so "zero rows" is exactly what a wrong-tenant
  // read looks like. Throwing makes Stripe retry and an operator see it.
  const { calls, service } = harness({ rows: [] });
  await expect(service.handle(subscriptionEvent())).rejects.toThrow(/matched 0 businesses/);
  expect(calls.update).toHaveLength(0);
});

test('a customer matching more than one business refuses too', async () => {
  const rows = [
    { id: 'biz_1', subscriptionStatus: null, subscriptionCurrentPeriodEnd: null },
    { id: 'biz_2', subscriptionStatus: null, subscriptionCurrentPeriodEnd: null },
  ];
  const { service } = harness({ rows });
  await expect(service.handle(subscriptionEvent())).rejects.toThrow(/matched 2 businesses/);
});

test('an event with no practiceId in its metadata is refused, not guessed at', async () => {
  const { calls, service } = harness();
  await expect(service.handle(subscriptionEvent({ metadata: { businessId: 'biz_1' } }))).rejects.toThrow(/no practiceId/);
  expect(calls.businessFindMany).toHaveLength(0);
});

test('a practice with no SYSTEM actor fails loudly rather than writing unscoped', async () => {
  const { service } = harness({ systemActor: null });
  await expect(service.handle(subscriptionEvent())).rejects.toThrow(/SYSTEM actor/);
});

test('the same event id twice does the work once', async () => {
  const { calls, service } = harness();
  expect(await service.handle(subscriptionEvent())).toBe('applied');
  expect(await service.handle(subscriptionEvent())).toBe('duplicate');
  expect(calls.update).toHaveLength(1);
});

test('an out-of-order update ending BEFORE the stored period is discarded', async () => {
  const stored = new Date(PERIOD_END_S * 1000);
  const { calls, service } = harness({ rows: [{ id: 'biz_1', subscriptionStatus: 'ACTIVE', subscriptionCurrentPeriodEnd: stored }] });
  const late = subscriptionEvent({
    status: 'past_due',
    items: { data: [{ current_period_end: PERIOD_END_S - 86_400, price: { id: 'price_neo' } }] },
  });
  expect(await service.handle(late)).toBe('stale');
  expect(calls.update).toHaveLength(0);
});

test('an update for the SAME period still applies — several arrive per period and each carries a status', async () => {
  const stored = new Date(PERIOD_END_S * 1000);
  const { calls, service } = harness({ rows: [{ id: 'biz_1', subscriptionStatus: 'ACTIVE', subscriptionCurrentPeriodEnd: stored }] });
  expect(await service.handle(subscriptionEvent({ status: 'past_due' }))).toBe('applied');
  expect(calls.update[0]?.data?.['subscriptionStatus']).toBe('PAST_DUE');
});

test('a cancellation ALWAYS applies, even out of order', async () => {
  // Terminal. Exempting it is what stops a late renewal event resurrecting a
  // subscription the client ended.
  const stored = new Date(PERIOD_END_S * 1000);
  const { calls, service } = harness({ rows: [{ id: 'biz_1', subscriptionStatus: 'ACTIVE', subscriptionCurrentPeriodEnd: stored }] });
  const deleted = subscriptionEvent(
    { status: 'canceled', items: { data: [{ current_period_end: PERIOD_END_S - 999_999, price: { id: 'price_neo' } }] } },
    'customer.subscription.deleted',
  );
  expect(await service.handle(deleted)).toBe('applied');
  expect(calls.update[0]?.data?.['subscriptionStatus']).toBe('CANCELED');
});

test('an event type we do not handle is acknowledged and changes nothing', async () => {
  const { calls, service } = harness();
  // `invoice.paid` and `invoice.payment_failed` reach us as the
  // `customer.subscription.updated` Stripe emits alongside them, so subscription
  // state keeps exactly one writer.
  for (const type of ['invoice.paid', 'invoice.payment_failed', 'customer.updated', 'ping']) {
    expect(await service.handle({ id: `evt_${type}`, type, data: { object: {} } })).toBe('ignored');
  }
  expect(calls.update).toHaveLength(0);
});

test('checkout.session.completed verifies the binding and writes nothing', async () => {
  const { calls, service } = harness();
  const outcome = await service.handle({
    id: 'evt_cs',
    type: 'checkout.session.completed',
    data: {
      object: { id: 'cs_1', customer: 'cus_1', client_reference_id: 'biz_1', metadata: { businessId: 'biz_1', practiceId: 'prac_1' } },
    },
  });
  expect(outcome).toBe('applied');
  expect(calls.update).toHaveLength(0);
});

test('a checkout session naming a different business is reported, not applied and not retried', async () => {
  // A disagreement here would mean a client paid and a DIFFERENT tenant became
  // entitled — the one failure in this lane that is otherwise silent. Throwing
  // would make Stripe retry an event that can never succeed.
  const { service } = harness();
  const outcome = await service.handle({
    id: 'evt_cs2',
    type: 'checkout.session.completed',
    data: {
      object: { id: 'cs_2', customer: 'cus_1', client_reference_id: 'biz_OTHER', metadata: { practiceId: 'prac_1' } },
    },
  });
  expect(outcome).toBe('ignored');
});

test('an envelope that is not a Stripe event at all is rejected at the boundary', async () => {
  const { service } = harness();
  await expect(service.handle({ hello: 'world' })).rejects.toThrow();
});
