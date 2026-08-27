import { z } from 'zod';
import {
  createBillingPortalSession,
  createCheckoutSession,
  createPortalOnboardingSession,
  createPortalSignInCode,
} from '@neoting/contracts/client';
import {
  createBillingPortalSessionBody,
  createCheckoutSessionBody,
  createPortalOnboardingSessionBody,
  createPortalSignInCodeBody,
} from '@neoting/contracts/zod';
import { unwrapBody } from './envelope';

/**
 * The invited client's sign-in and subscription, read from the API (launch
 * stage M6).
 *
 * The journey these four calls serve (SoT §24.5, D45/D47/D48): the accountant
 * adds a client, the client is EMAILED a setup link — there is no SMS in this
 * release, and no copy anywhere on this path may say "text" — and the client
 * signs in with a six-digit code sent to the address they were registered
 * with. Then they subscribe: one price, £8.50 + VAT per month per client
 * business, paid by the client, with Stripe hosting the checkout, the invoice
 * and everything after it.
 *
 *   POST /portal/sign-in-codes          setupToken + email → 202, always
 *   POST /portal/onboarding-sessions    setupToken + email + otp → the bearer
 *   POST /billing/checkout-sessions     businessId → a Stripe-hosted URL
 *   POST /billing/portal-sessions       businessId → the customer portal URL
 *
 * ⚠ THE 202 IS UNIFORM ON PURPOSE. Whether an address is registered on a
 * workspace is not something an unauthenticated caller may learn (the
 * NT-AUTH-003 stance), so the response says nothing either way — the email is
 * the channel that distinguishes the outcomes. The screen's copy has to carry
 * that honesty: "if nothing arrives, check the address with your accountant",
 * never "we've found your account".
 *
 * ⚠ THE BEARER IS HELD IN REACT STATE AND NOWHERE ELSE, exactly as the chase
 * portal's is (`api/portal.ts` has the full argument). It dies with the tab.
 *
 * ⚠ THE SERVER HALF OF THE TWO PORTAL OPERATIONS IS CONTRACTED AND NOT YET
 * IMPLEMENTED (`apps/api/src/modules/portal/CLAUDE.md` records it), so against
 * today's API every live sign-in ends in the uniform `401 NT-OTP-001`. These
 * screens are built to the contract, which is the agreed shape (G7); they
 * light up when the controller lands, with nothing to change here.
 */

/** The contract's own pattern: `^[0-9]{6}$`. */
export const OTP_LENGTH = 6;

/**
 * `Authorization: Bearer …` for calls made inside an onboarding session. The
 * workspace cookie still travels (ntFetch always sends `credentials:
 * 'include'`), which is what authenticates the same calls when practice staff
 * make them — §24.5 step 3: either party completes setup.
 */
const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

/**
 * Ask for the six-digit code. Resolves on the 202 and returns nothing,
 * because the response carries nothing — see the module note on the uniform
 * 202. A thrown `NtProblemError` here is a 400 (malformed input) or a 429
 * (rate limit), never "that address is not registered".
 */
export async function requestSignInCode(setupToken: string, email: string): Promise<void> {
  const request = createPortalSignInCodeBody.parse({ setupToken, email });
  await createPortalSignInCode(request);
}

export interface OnboardingSession {
  /** Send as `Authorization: Bearer …` on every portal call. */
  token: string;
  expiresAt: string;
  /**
   * The business this session was opened for — null until the server sends
   * it. See the note on {@link onboardingSessionShape}.
   */
  businessId: string | null;
}

/**
 * The contract's `PortalSession` is `{token, expiresAt}` and nothing else.
 *
 * ⚠ `businessId` IS NOT CONTRACTED YET, AND THE SUBSCRIBE STEP IS BLOCKED ON
 * IT. `POST /billing/checkout-sessions` requires a `businessId`, and an
 * onboarding session has no contracted way to learn its own — the chase
 * portal reads `GET /portal/context`, which needs a chase this session does
 * not have. Growing `PortalSession` by an optional `businessId` is a
 * contract-change issue for Shakib (G7 — LAW is not edited from here); the
 * field is parsed as optional so the screens light up the moment it ships,
 * and `subscribe` degrades honestly while it is absent. Deliberately NOT
 * `.strict()`, for the same reason.
 */
const onboardingSessionShape = z.object({
  token: z.string().min(1),
  expiresAt: z.string(),
  businessId: z.string().min(1).nullish(),
});

/**
 * Exchange the setup link, the registered address and the emailed code for a
 * session. Every verification failure — unknown link, expired link, wrong
 * address, wrong code — is the same `401 NT-OTP-001`, deliberately.
 */
export async function openOnboardingSession(setupToken: string, email: string, otp: string): Promise<OnboardingSession> {
  const request = createPortalOnboardingSessionBody.parse({ setupToken, email, otp });
  const body = onboardingSessionShape.parse(unwrapBody(await createPortalOnboardingSession(request)));
  return { token: body.token, expiresAt: body.expiresAt, businessId: body.businessId ?? null };
}

/** A Stripe-hosted URL. One shape for checkout and the customer portal. */
const hostedSessionShape = z.object({
  url: z.string().min(1),
  expiresAt: z.string().nullish(),
});

/**
 * Where Stripe returns the client. Same-origin by construction — the server
 * validates both against an allowlist of our own origins, and a URL built
 * from anything but our own `location` would be refused there.
 *
 * ⚠ Reaching the success address is NOT proof of payment (the contract's own
 * words): the subscription is active when the webhook says so, and the return
 * screen's copy must claim nothing more than "Stripe is confirming".
 */
function checkoutReturnUrl(outcome: 'success' | 'cancelled'): string {
  return `${window.location.origin}/app/setup?checkout=${outcome}`;
}

/**
 * Mint the Stripe-hosted checkout and hand back its URL. The caller redirects
 * the whole tab — Stripe shows the VAT and the gross total before the client
 * commits (§24.5), and no card detail ever touches our origin.
 *
 * A `409 NT-BIL-002` means the business is already subscribed; card changes
 * and cancellation live in the customer portal, not in a second checkout.
 */
export async function startSubscriptionCheckout(sessionToken: string, businessId: string): Promise<string> {
  const request = createCheckoutSessionBody.parse({
    businessId,
    successUrl: checkoutReturnUrl('success'),
    cancelUrl: checkoutReturnUrl('cancelled'),
  });
  const body = hostedSessionShape.parse(unwrapBody(await createCheckoutSession(request, bearer(sessionToken))));
  return body.url;
}

/**
 * Mint a Stripe customer-portal session — card changes, invoices and
 * cancellation are all Stripe's pages, deliberately the whole of our billing
 * UI beyond the settings Plan section (launch stage M6, D48).
 */
export async function openBillingPortal(businessId: string): Promise<string> {
  const request = createBillingPortalSessionBody.parse({
    businessId,
    returnUrl: `${window.location.origin}${window.location.pathname}`,
  });
  const body = hostedSessionShape.parse(unwrapBody(await createBillingPortalSession(request)));
  return body.url;
}
