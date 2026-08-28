import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import type { ScopeContext } from '../../common/db/scope-context.js';
import type { RequestContext } from '../../common/context/request-context.js';
import type { AppException } from '../../common/problem/problem.js';
import type { PortalSessionContextResolver, PortalSessionFacts } from '../portal/index.js';
import { portalSessionRequired } from '../portal/index.js';
import { BillingController } from './billing.controller.js';
import type { BillingService } from './billing.service.js';

/**
 * Which principal is asking, and what stops the second one reaching further
 * than its own business.
 *
 * `createCheckoutSession` carries TWO security schemes since contract-change
 * #205 — the accountant's `workspaceSession` cookie and the invited client's
 * `portalSession` bearer, because D48 says the client pays and a client has no
 * cookie. These are the tests for the choice between them, and they exist
 * because **the handler is the whole of the tenancy check on the portal path**:
 * `systemScopeFor` sees the entire practice, so RLS narrows nothing here and the
 * session row is the only thing that does.
 */

// Generated, not a literal — the house convention in every other controller
// suite here, and the reason is mechanical: gitleaks' `generic-api-key` rule
// fires on a high-entropy literal assigned to a name containing "key", so a
// hard-coded UUID fails the security stage as a leaked credential.
const KEY = randomUUID();
const COOKIE_CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const BODY = {
  businessId: 'biz_1',
  successUrl: 'https://app.example/ok',
  cancelUrl: 'https://app.example/no',
};

function facts(over: Partial<PortalSessionFacts> = {}): PortalSessionFacts {
  return {
    otpSessionId: 'otp_1',
    businessId: 'biz_1',
    practiceId: 'prac_1',
    systemUserId: 'usr_system_1',
    actorId: 'usr_system_1',
    chaseId: null,
    grantedItemIds: [],
    expiresAt: new Date('2026-08-28T12:00:00Z'),
    ...over,
  };
}

function harness(over: { onboarding?: () => Promise<PortalSessionFacts> } = {}) {
  const seen: ScopeContext[] = [];

  const context = { require: async () => COOKIE_CTX } as RequestContext;

  const service = {
    createCheckoutSession: async (ctx: ScopeContext) => {
      seen.push(ctx);
      return { url: 'https://checkout.stripe.com/c/pay/cs_test_1', expiresAt: '2026-08-28T12:00:00Z' };
    },
  } as unknown as BillingService;

  const portal = {
    resolveOnboarding: over.onboarding ?? (async () => facts()),
  } as unknown as PortalSessionContextResolver;

  return { controller: new BillingController(context, service, portal), seen };
}

const grab = async (run: () => Promise<unknown>): Promise<AppException> => {
  try {
    await run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
};

test('no Authorization header is the accountant — the cookie path is untouched', async () => {
  const { controller, seen } = harness();
  await controller.checkout(BODY, KEY, undefined);
  expect(seen).toEqual([COOKIE_CTX]);
});

test('an empty Authorization header is not a bearer — it falls to the cookie', async () => {
  // A browser that sends `Authorization: ` (or a proxy that adds the header
  // blank) must not be routed down a path whose only tenancy check is a
  // comparison against a session that does not exist.
  const { controller, seen } = harness();
  await controller.checkout(BODY, KEY, '   ');
  expect(seen).toEqual([COOKIE_CTX]);
});

test('a bearer is the invited client, and the scope it gets is the practice SYSTEM one', async () => {
  const { controller, seen } = harness();
  const result = await controller.checkout(BODY, KEY, 'Bearer portal.bearer');

  expect(result.url).toContain('checkout.stripe.com');
  expect(seen).toHaveLength(1);
  // NOT the cookie context, and not a delegated one — an onboarding session has
  // an empty grant, so a delegated context cannot be built from it at all.
  // `sessionScope` is 'user' and the ACTOR is the practice's SYSTEM user â that is
  // is what "the practice SYSTEM context" means here (`systemContext`), and it
  // is why this context sees every business in prac_1 and RLS narrows nothing.
  expect(seen[0]).toEqual({
    actorId: 'usr_system_1',
    practiceId: 'prac_1',
    sessionScope: 'user',
    grantedItemIds: [],
  });
});

test('⚠ a bearer naming ANOTHER business is 404 — never 403, and never charged', async () => {
  const { controller, seen } = harness({ onboarding: async () => facts({ businessId: 'biz_someone_else' }) });

  const error = await grab(() => controller.checkout(BODY, KEY, 'Bearer portal.bearer'));

  // 404 and not 403: a 403 would confirm that `biz_1` exists, and a client
  // holding a forwarded setup link does not get to enumerate a practice.
  expect(error.getStatus()).toBe(404);
  expect(error.code).toBe('NT-VAL-001');
  // And nothing reached Stripe. The refusal is BEFORE the service, so no
  // customer is created and no session is minted for the wrong business.
  expect(seen).toEqual([]);
});

test('a bearer the portal refuses never reaches billing at all', async () => {
  const { controller, seen } = harness({
    onboarding: async () => {
      throw portalSessionRequired('missing or invalid portal session');
    },
  });

  const error = await grab(() => controller.checkout(BODY, KEY, 'Bearer forged'));
  expect(error.code).toBe('NT-OTP-002');
  expect(error.getStatus()).toBe(401);
  expect(seen).toEqual([]);
});

test('the customer portal did NOT gain the second principal', async () => {
  // `createBillingPortalSession` keeps one security scheme in `openapi.yaml`:
  // it is card changes, invoices and cancellation on a business that is already
  // subscribed, reached from that client's own settings. The handler takes no
  // `authorization` argument, and this is what says so if one is added without
  // the contract moving first.
  const { controller } = harness();
  expect(controller.portal.length).toBe(2);
  expect(controller.checkout.length).toBe(3);
});
