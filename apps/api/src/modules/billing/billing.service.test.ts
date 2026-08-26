import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { BillingService } from './billing.service.js';
import { parseAllowedOrigins } from './return-url.js';
import type {
  CreateCheckoutSessionRequest,
  CreateCustomerRequest,
  CreatePortalSessionRequest,
  HostedSession,
  StripeClient,
} from './stripe-client.js';

const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const ORIGINS = parseAllowedOrigins('https://app.example');
const OK_URLS = { successUrl: 'https://app.example/ok', cancelUrl: 'https://app.example/no' };

interface BusinessRow {
  id: string;
  name: string;
  practiceId: string | null;
  stripeCustomerId: string | null;
  subscriptionStatus: string | null;
  contacts: Array<{ email: string | null }>;
}

function business(over: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: 'biz_1',
    name: 'Sparkle Cleaning Ltd',
    practiceId: 'prac_1',
    stripeCustomerId: null,
    subscriptionStatus: null,
    contacts: [{ email: 'owner@sparkle.example' }],
    ...over,
  };
}

interface Calls {
  createCustomer: CreateCustomerRequest[];
  createCheckout: CreateCheckoutSessionRequest[];
  createPortal: CreatePortalSessionRequest[];
  updateMany: Array<{ where?: unknown; data?: unknown }>;
}

/**
 * A fake Prisma that records what it was asked for, in the shape
 * `documents.service.test.ts` established. The assertions are about the
 * `where` clauses and the ORDER of the calls, not about Prisma working.
 */
function harness(
  options: {
    row?: BusinessRow | null;
    /** Simulates losing the customer-binding race: the conditional update matches nothing. */
    bindingRaceWinner?: string | null;
    stripe?: Partial<StripeClient>;
  } = {},
) {
  const calls: Calls = { createCustomer: [], createCheckout: [], createPortal: [], updateMany: [] };
  const row = options.row === undefined ? business() : options.row;
  let bound: string | null = row?.stripeCustomerId ?? null;

  const tx = {
    $executeRaw: async () => 0,
    business: {
      findUnique: async (args: { select?: Record<string, unknown> }) => {
        if (row === null) return null;
        // The second read in the race path asks only for the customer id.
        if (args.select && Object.keys(args.select).length === 1) return { stripeCustomerId: options.bindingRaceWinner ?? bound };
        return { ...row, stripeCustomerId: bound };
      },
      updateMany: async (args: { where?: unknown; data?: { stripeCustomerId?: string } }) => {
        calls.updateMany.push(args);
        if (options.bindingRaceWinner !== undefined) return { count: 0 };
        bound = args.data?.stripeCustomerId ?? bound;
        return { count: 1 };
      },
    },
  };

  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;

  const stripe: StripeClient = {
    createCustomer: async (request) => {
      calls.createCustomer.push(request);
      return { id: 'cus_new' };
    },
    createCheckoutSession: async (request): Promise<HostedSession> => {
      calls.createCheckout.push(request);
      return { url: 'https://checkout.stripe.com/c/pay/cs_1', expiresAt: '2026-08-28T09:00:00.000Z' };
    },
    createPortalSession: async (request): Promise<HostedSession> => {
      calls.createPortal.push(request);
      return { url: 'https://billing.stripe.com/p/session/x', expiresAt: null };
    },
    ...options.stripe,
  };

  return {
    calls,
    service: new BillingService(prisma, stripe, new InMemoryIdempotencyStore(), { allowedReturnOrigins: ORIGINS }),
  };
}

test('checkout creates the customer, binds it, and returns Stripe’s hosted URL', async () => {
  const { calls, service } = harness();
  const session = await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');

  expect(session).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1', expiresAt: '2026-08-28T09:00:00.000Z' });
  expect(calls.createCustomer[0]).toMatchObject({ businessId: 'biz_1', practiceId: 'prac_1', email: 'owner@sparkle.example' });
  expect(calls.createCheckout[0]).toMatchObject({ customerId: 'cus_new', businessId: 'biz_1', practiceId: 'prac_1' });
});

test('THE ORDERING THAT MAKES THE WEBHOOK WORK: the customer is bound before checkout is created', async () => {
  // The webhook resolves its tenant purely from the Stripe customer id and has
  // no session to fall back on. If checkout minted the customer instead, there
  // would be a window in which `customer.subscription.created` names a customer
  // no row points at — and events arrive out of order, so it is not theoretical.
  const { calls, service } = harness();
  await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');
  expect(calls.updateMany).toHaveLength(1);
  expect(calls.updateMany[0]?.where).toEqual({ id: 'biz_1', stripeCustomerId: null });
  expect(calls.createCheckout).toHaveLength(1);
});

test('an existing customer is reused rather than duplicated', async () => {
  const { calls, service } = harness({ row: business({ stripeCustomerId: 'cus_existing', subscriptionStatus: 'CANCELED' }) });
  await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');
  expect(calls.createCustomer).toHaveLength(0);
  expect(calls.createCheckout[0]?.customerId).toBe('cus_existing');
});

test('losing the binding race keeps the winner’s customer instead of overwriting it', async () => {
  // Overwriting would strand every future event for the old customer id.
  const { calls, service } = harness({ bindingRaceWinner: 'cus_theirs' });
  await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');
  expect(calls.createCheckout[0]?.customerId).toBe('cus_theirs');
});

test('a binding that neither wins nor finds a winner fails loudly', async () => {
  // Neither branch bound anything, so the UPDATE was refused rather than raced
  // — an RLS write this context does not permit. Handing back a customer id
  // nothing points at would be the silent version of this.
  const { service } = harness({ bindingRaceWinner: null });
  await expect(service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1')).rejects.toMatchObject({
    code: 'NT-SRV-001',
  });
});

test.each(['ACTIVE', 'TRIALING', 'PAST_DUE', 'PAUSED', 'UNPAID'])(
  'a %s subscription refuses a second checkout with NT-BIL-002',
  async (status) => {
    const { calls, service } = harness({ row: business({ stripeCustomerId: 'cus_1', subscriptionStatus: status }) });
    let thrown: AppException | undefined;
    try {
      await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');
    } catch (error) {
      thrown = error as AppException;
    }
    expect(thrown?.code).toBe('NT-BIL-002');
    expect(thrown?.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(calls.createCheckout).toHaveLength(0);
  },
);

test.each([null, 'INCOMPLETE', 'INCOMPLETE_EXPIRED', 'CANCELED'])(
  'a %s subscription may start checkout again — there is nothing at Stripe to manage',
  async (status) => {
    const { calls, service } = harness({ row: business({ stripeCustomerId: 'cus_1', subscriptionStatus: status }) });
    await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');
    expect(calls.createCheckout).toHaveLength(1);
  },
);

test('a business RLS does not reach is a 404, and Stripe is never called', async () => {
  const { calls, service } = harness({ row: null });
  let thrown: AppException | undefined;
  try {
    await service.createCheckoutSession(CTX, { businessId: 'biz_other', ...OK_URLS }, 'idem-1');
  } catch (error) {
    thrown = error as AppException;
  }
  // 404 and never 403: a 403 would confirm the record exists.
  expect(thrown?.getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect(calls.createCustomer).toHaveLength(0);
});

test('a return URL off our origins is refused BEFORE a customer is created', async () => {
  const { calls, service } = harness();
  await expect(
    service.createCheckoutSession(CTX, { businessId: 'biz_1', successUrl: 'https://evil.example/', cancelUrl: OK_URLS.cancelUrl }, 'idem-1'),
  ).rejects.toMatchObject({ code: 'NT-VAL-001' });
  // An orphaned Stripe customer is a second problem to clean up.
  expect(calls.createCustomer).toHaveLength(0);
});

test('a replayed Idempotency-Key returns the original URL and calls Stripe once', async () => {
  const { calls, service } = harness();
  const first = await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');
  const second = await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');
  expect(second).toEqual(first);
  expect(calls.createCheckout).toHaveLength(1);
});

test('the same key with a different payload is NT-IDM-001, not a quiet second charge', async () => {
  const { service } = harness();
  await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'idem-1');
  await expect(
    service.createCheckoutSession(CTX, { businessId: 'biz_1', successUrl: 'https://app.example/other', cancelUrl: OK_URLS.cancelUrl }, 'idem-1'),
  ).rejects.toMatchObject({ code: 'NT-IDM-001' });
});

test('one key reused across the two operations does not replay the wrong URL', async () => {
  // A checkout URL returned where a portal URL was asked for sends a client to
  // pay again for something they already have.
  const { service } = harness({ row: business({ stripeCustomerId: 'cus_1', subscriptionStatus: 'CANCELED' }) });
  const checkout = await service.createCheckoutSession(CTX, { businessId: 'biz_1', ...OK_URLS }, 'shared-key');
  const portal = await service.createPortalSession(CTX, { businessId: 'biz_1', returnUrl: 'https://app.example/settings' }, 'shared-key');
  expect(portal.url).not.toBe(checkout.url);
  expect(portal.url).toContain('billing.stripe.com');
});

test('the portal opens for a business that has a customer', async () => {
  const { calls, service } = harness({ row: business({ stripeCustomerId: 'cus_1', subscriptionStatus: 'ACTIVE' }) });
  const session = await service.createPortalSession(CTX, { businessId: 'biz_1', returnUrl: 'https://app.example/settings' }, 'idem-2');
  expect(session).toEqual({ url: 'https://billing.stripe.com/p/session/x', expiresAt: null });
  expect(calls.createPortal[0]).toMatchObject({ customerId: 'cus_1', returnUrl: 'https://app.example/settings' });
});

test('the portal 404s with NT-BIL-001 when the client has never been to checkout', async () => {
  const { calls, service } = harness({ row: business({ stripeCustomerId: null }) });
  let thrown: AppException | undefined;
  try {
    await service.createPortalSession(CTX, { businessId: 'biz_1', returnUrl: 'https://app.example/settings' }, 'idem-2');
  } catch (error) {
    thrown = error as AppException;
  }
  expect(thrown?.code).toBe('NT-BIL-001');
  // This operation declares no 402, and the honest reading is that the portal
  // session does not exist rather than that money is owed.
  expect(thrown?.getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect(calls.createPortal).toHaveLength(0);
});
