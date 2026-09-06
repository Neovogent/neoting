import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import type { ScopeContext } from '../../common/db/scope-context.js';
import type { RequestContext } from '../../common/context/request-context.js';
import type { AppException } from '../../common/problem/problem.js';
import type { Actor } from '../approvals/index.js';
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
    contactId: null,
    chaseId: null,
    grantedItemIds: [],
    expiresAt: new Date('2026-08-28T12:00:00Z'),
    ...over,
  };
}

function harness(over: { onboarding?: () => Promise<PortalSessionFacts>; actor?: () => Promise<Actor> } = {}) {
  const seen: ScopeContext[] = [];

  const context = { require: async () => COOKIE_CTX } as RequestContext;

  const service = {
    createCheckoutSession: async (ctx: ScopeContext) => {
      seen.push(ctx);
      return { url: 'https://checkout.stripe.com/c/pay/cs_test_1', expiresAt: '2026-08-28T12:00:00Z' };
    },
    // The customer portal, which took the second principal on 2 Sep 2026. It
    // records through the SAME `seen` list as checkout, because the question
    // both sets of tests ask is the same one: which scope reached the service,
    // and did anything reach it at all on a refusal.
    createPortalSession: async (ctx: ScopeContext) => {
      seen.push(ctx);
      return { url: 'https://billing.stripe.com/p/session/bps_test_1', expiresAt: null };
    },
  } as unknown as BillingService;

  const portal = {
    resolveOnboarding: over.onboarding ?? (async () => facts()),
    // ⚠ WHO is asking, added with the authority guard (review item 44). The
    // default is the business OWNER, so every test above this line keeps asking
    // the question it was written to ask — which principal, and whose business
    // — rather than being silently rewritten into a permission test.
    resolveActor: over.actor ?? (async () => OWNER),
  } as unknown as PortalSessionContextResolver;

  return { controller: new BillingController(context, service, portal), seen };
}

/**
 * The three portal actors that matter here. `assertCan` reads `role` and
 * nothing else, and `business.billing.manage` is `BUSINESS_ADMIN` only.
 */
const PORTAL_BODY = { businessId: 'biz_1', returnUrl: 'https://app.example/back' };

const OWNER: Actor = { actorId: 'con_owner', role: 'BUSINESS_ADMIN', isOwner: true };
const USER_ADMIN: Actor = { actorId: 'con_hr', role: 'USER_ADMIN', isOwner: false };
const MEMBER: Actor = { actorId: 'con_staff', role: 'BUSINESS_STANDARD', isOwner: false };
/** A chase session's `contact_id` is deliberately NULL — nobody, and nobody pays. */
const NOBODY: Actor = { actorId: '', role: null, isOwner: false };

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

/* ── the customer portal, which gained the second principal on 2 Sep 2026 ──── */

test('the customer portal takes the same two principals as checkout', async () => {
  // ⚠ This test asserted the OPPOSITE until 2 Sep 2026 — "the customer portal
  // did NOT gain the second principal" — and it was right about #205's scope
  // and wrong about the product. D48 makes the client the payer and D49 gives
  // them a Settings tab; Stripe's hosted portal is the ONLY surface in the
  // product for changing a card, reading an invoice or cancelling; and the only
  // door to it was a workspace cookie no client holds. A subscription its payer
  // cannot leave is not one they consented to.
  //
  // The arity check stays, inverted: both handlers now take the header, and
  // dropping it from either would silently return this door to one principal.
  const { controller } = harness();
  expect(controller.portal.length).toBe(3);
  expect(controller.checkout.length).toBe(3);
});

test('no Authorization header on the customer portal is still the accountant', async () => {
  const { controller, seen } = harness();
  await controller.portal({ businessId: 'biz_1', returnUrl: 'https://app.example/back' }, KEY, undefined);
  expect(seen).toEqual([COOKIE_CTX]);
});

test('a bearer opens the customer portal for the session\'s OWN business, under the practice SYSTEM scope', async () => {
  const { controller, seen } = harness();
  const result = await controller.portal(
    { businessId: 'biz_1', returnUrl: 'https://app.example/back' },
    KEY,
    'Bearer portal.bearer',
  );
  expect(result.url).toContain('billing.stripe.com');
  expect(seen).toEqual([{ actorId: 'usr_system_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] }]);
});

test('⚠ a bearer naming ANOTHER business gets 404 from the customer portal, and nothing reaches Stripe', async () => {
  // The guard `BillingPortalSessionRequest` never had, added in the same edit as
  // the principal. Without it, a client holding one workspace's portal bearer
  // could open ANOTHER workspace's billing portal: every invoice, the card, and
  // cancellation. `systemScopeFor` sees the whole practice, so RLS narrows
  // nothing — this comparison is the entire boundary.
  //
  // 404 and never 403, for the reason checkout gives: a 403 confirms the other
  // business exists.
  const { controller, seen } = harness({ onboarding: async () => facts({ businessId: 'biz_someone_else' }) });
  const error = await grab(() =>
    controller.portal({ businessId: 'biz_1', returnUrl: 'https://app.example/back' }, KEY, 'Bearer portal.bearer'),
  );
  expect(error.getStatus()).toBe(404);
  expect(error.code).toBe('NT-VAL-001');
  expect(seen).toEqual([]);
});

test('a bearer the portal refuses never reaches the customer portal either', async () => {
  const { controller, seen } = harness({
    onboarding: async () => {
      throw portalSessionRequired('missing or invalid portal session');
    },
  });
  const error = await grab(() =>
    controller.portal({ businessId: 'biz_1', returnUrl: 'https://app.example/back' }, KEY, 'Bearer forged'),
  );
  expect(error.code).toBe('NT-OTP-002');
  expect(error.getStatus()).toBe(401);
  expect(seen).toEqual([]);
});

/**
 * **⚠ REVIEW ITEM 44 — the authority half, which did not exist.**
 *
 * Everything above these tests is TENANCY: the session's business must be the
 * body's. That was the whole of the portal-path guard, and it is the right
 * answer to *whose subscription is this* and no answer at all to *may THIS
 * PERSON touch it*. So every contact of the business holding a portal bearer —
 * a `BUSINESS_STANDARD` added to photograph receipts included — could mint a
 * Stripe customer-portal session and reach the card, every invoice and
 * cancellation. It was reported as a UI complaint (*"the team member of a
 * client don't need to see the plan subscribed"*); the button was live.
 *
 * Both doors are tested, because starting a subscription and cancelling one are
 * the same authority seen from two ends, and `principalFor` is shared precisely
 * so a future change cannot land on one and miss the other.
 *
 * ⚠ `seen` staying empty is the assertion that matters on every refusal: it
 * proves nothing reached the service, so nothing reached Stripe.
 */
const REFUSED = [
  ['a plain member', MEMBER],
  ['a user administrator, who manages people and nothing else', USER_ADMIN],
  ['a session that resolves to nobody at all', NOBODY],
] as const;

for (const [who, actor] of REFUSED) {
  test(`⚠ item 44 — the customer portal refuses ${who}, and nothing reaches Stripe`, async () => {
    const { controller, seen } = harness({ actor: async () => actor });
    const error = await grab(() => controller.portal(PORTAL_BODY, KEY, 'Bearer portal.bearer'));

    expect(error.code).toBe('NT-PRM-001');
    expect(error.getStatus()).toBe(403);
    expect(seen).toEqual([]);
  });

  test(`⚠ item 44 — checkout refuses ${who} too — one authority, both doors`, async () => {
    const { controller, seen } = harness({ actor: async () => actor });
    const error = await grab(() => controller.checkout(BODY, KEY, 'Bearer portal.bearer'));

    expect(error.code).toBe('NT-PRM-001');
    expect(seen).toEqual([]);
  });
}

test('⚠ item 44 — the owner still reaches both doors', async () => {
  // The guard must not be the outage. D48 makes the client the payer, and a
  // subscription its payer cannot leave is not one they consented to.
  const { controller, seen } = harness({ actor: async () => OWNER });
  await controller.portal(PORTAL_BODY, KEY, 'Bearer portal.bearer');
  await controller.checkout(BODY, KEY, 'Bearer portal.bearer');
  expect(seen).toHaveLength(2);
});

test('⚠ item 44 — the ACCOUNTANT is unaffected: no bearer, no portal actor read', async () => {
  // The cookie path never resolves a portal actor, so a practice user opening a
  // client's billing is decided by the workspace session exactly as before.
  let asked = 0;
  const { controller, seen } = harness({
    actor: async () => {
      asked += 1;
      return MEMBER;
    },
  });
  await controller.portal(PORTAL_BODY, KEY, undefined);
  expect(seen).toEqual([COOKIE_CTX]);
  expect(asked).toBe(0);
});

test('⚠ item 44 — the wrong-business 404 still comes FIRST', async () => {
  // Ordering, and it is deliberate: a caller naming somebody else's business
  // gets the answer that confirms nothing, and only a caller asking about their
  // own workspace learns that authority is what they lack.
  const { controller, seen } = harness({
    onboarding: async () => facts({ businessId: 'biz_someone_else' }),
    actor: async () => MEMBER,
  });
  const error = await grab(() => controller.portal(PORTAL_BODY, KEY, 'Bearer portal.bearer'));

  expect(error.code).toBe('NT-VAL-001');
  expect(error.getStatus()).toBe(404);
  expect(seen).toEqual([]);
});
