import { NtProblemError } from '@neoting/contracts';
import { afterEach, expect, test, vi } from 'vitest';

import { openBillingPortal, openOnboardingSession, requestSignInCode, startSubscriptionCheckout } from './onboarding';

/**
 * The onboarding boundary (launch stage M6).
 *
 * Offline by construction, the `portal.test.ts` pattern: `globalThis.fetch`
 * is a recorder, so every assertion is about what this module SENT and what
 * it did with the answer. The parts worth pinning are the ones a screen
 * cannot see going wrong — the bearer on the checkout call, the same-origin
 * return URLs (the server refuses anything else, so building them wrong is a
 * checkout that never opens), and the contract's own six-digit gate firing
 * BEFORE the network.
 */

interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(replies: { body: unknown; status?: number; contentType?: string }[]): Recorded[] {
  const calls: Recorded[] = [];
  let index = 0;
  vi.stubGlobal('fetch', (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies[index++] ?? { body: {} };
    return Promise.resolve(
      reply.body === null
        ? new Response(null, { status: reply.status ?? 202 })
        : new Response(JSON.stringify(reply.body), {
            status: reply.status ?? 200,
            headers: { 'content-type': reply.contentType ?? 'application/json' },
          }),
    );
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const header = (init: RequestInit, name: string): string | null => new Headers(init.headers).get(name);

/* ── the code request ─────────────────────────────────────────────────────── */

test('requestSignInCode posts the token and the address, and survives the empty 202', async () => {
  // The 202 is contractually empty — whether the address is registered is not
  // an answer an unauthenticated caller gets. No body, no content-type.
  const calls = stubFetch([{ body: null, status: 202 }]);

  await requestSignInCode('maria@anandagroup.co.uk', 'setup-tok');

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toContain('/v1/portal/sign-in-codes');
  expect(header(calls[0]!.init, 'Idempotency-Key')).not.toBeNull();
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
    setupToken: 'setup-tok',
    email: 'maria@anandagroup.co.uk',
  });
});

/* ── the session ──────────────────────────────────────────────────────────── */

test('openOnboardingSession refuses a short code before any request is made', async () => {
  const calls = stubFetch([]);
  await expect(openOnboardingSession('maria@anandagroup.co.uk', '12345', 'setup-tok')).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test('openOnboardingSession returns the bearer, and businessId/subscriptionStatus only when the server sends them', async () => {
  const calls = stubFetch([
    { body: { token: 'bearer-1', expiresAt: '2026-08-27T12:00:00.000Z' }, status: 201 },
    {
      body: { token: 'bearer-2', expiresAt: '2026-08-27T12:00:00.000Z', businessId: 'biz_clean', subscriptionStatus: 'ACTIVE' },
      status: 201,
    },
  ]);

  // An older server (or a business that never reached checkout) sends neither
  // optional field; both fold to null rather than failing the parse.
  const bare = await openOnboardingSession('maria@anandagroup.co.uk', '123456', 'setup-tok');
  expect(bare).toEqual({
    token: 'bearer-1',
    expiresAt: '2026-08-27T12:00:00.000Z',
    businessId: null,
    subscriptionStatus: null,
  });

  const named = await openOnboardingSession('maria@anandagroup.co.uk', '123456', 'setup-tok');
  expect(named.businessId).toBe('biz_clean');
  // What lets the journey skip the £8.50 screen for an already-paying client.
  expect(named.subscriptionStatus).toBe('ACTIVE');

  expect(calls[0]!.url).toContain('/v1/portal/onboarding-sessions');
});

/* ── the checkout ─────────────────────────────────────────────────────────── */

test('startSubscriptionCheckout carries the bearer and same-origin return URLs, and hands back the Stripe URL', async () => {
  const calls = stubFetch([{ body: { url: 'https://checkout.stripe.com/c/pay_123', expiresAt: null }, status: 201 }]);

  const url = await startSubscriptionCheckout('bearer-1', 'biz_clean');
  expect(url).toBe('https://checkout.stripe.com/c/pay_123');

  expect(calls[0]!.url).toContain('/v1/billing/checkout-sessions');
  expect(header(calls[0]!.init, 'Authorization')).toBe('Bearer bearer-1');

  const body = JSON.parse(String(calls[0]!.init.body)) as { businessId: string; successUrl: string; cancelUrl: string };
  expect(body.businessId).toBe('biz_clean');
  // The server allowlists our own origins; anything else is refused as an
  // open redirect, so this being wrong is a checkout that never opens.
  expect(body.successUrl).toBe(`${window.location.origin}/app/setup?checkout=success`);
  expect(body.cancelUrl).toBe(`${window.location.origin}/app/setup?checkout=cancelled`);
});

test('an NT-BIL-002 refusal surfaces as the typed problem, code intact', async () => {
  stubFetch([
    {
      body: { status: 409, code: 'NT-BIL-002', title: 'Already subscribed' },
      status: 409,
      contentType: 'application/problem+json',
    },
  ]);

  const failure = await startSubscriptionCheckout('bearer-1', 'biz_clean').catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(NtProblemError);
  expect((failure as NtProblemError).code).toBe('NT-BIL-002');
});

/* ── the customer portal ──────────────────────────────────────────────────── */

test('openBillingPortal sends the business and a same-origin return address', async () => {
  const calls = stubFetch([{ body: { url: 'https://billing.stripe.com/p/session_123' }, status: 201 }]);

  const url = await openBillingPortal('biz_clean');
  expect(url).toBe('https://billing.stripe.com/p/session_123');

  expect(calls[0]!.url).toContain('/v1/billing/portal-sessions');
  const body = JSON.parse(String(calls[0]!.init.body)) as { businessId: string; returnUrl: string };
  expect(body.businessId).toBe('biz_clean');
  expect(body.returnUrl.startsWith(window.location.origin)).toBe(true);
});
