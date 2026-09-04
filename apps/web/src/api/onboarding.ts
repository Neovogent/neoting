import { z } from 'zod';
import {
  createBillingPortalSession,
  createCheckoutSession,
  createPortalOnboardingSession,
  createPortalSignInCode,
  getPortalContext,
  listPortalDocuments,
} from '@neoting/contracts/client';
import {
  createBillingPortalSessionBody,
  createCheckoutSessionBody,
  createPortalOnboardingSessionBody,
  createPortalSignInCodeBody,
  listPortalDocumentsResponse,
} from '@neoting/contracts/zod';
import type { PortalDocumentStatus, SubscriptionStatus } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';
import { fromIsoDate, fromPence } from './documents';

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
export async function requestSignInCode(email: string, setupToken?: string): Promise<void> {
  // ⚠ The token is OPTIONAL, and its absence is the whole business portal.
  // While it was required, the only way in was the emailed invite — which
  // expires after seven days — so a client who onboarded, subscribed and came
  // back a fortnight later was locked out of their own workspace. Omitted, the
  // address alone names the workspace, which the server permits only when it
  // names exactly one.
  // ⚠ Built as a UNION OF TWO LITERALS and validated in place, rather than
  // passing the parse's own output on. Zod types an optional field's output as
  // `setupToken?: string | undefined`, which under `exactOptionalPropertyTypes`
  // is not assignable to the generated `setupToken?: string`. Same boundary,
  // same check — the parse still throws on drift — and no cast.
  const request = setupToken === undefined ? { email } : { email, setupToken };
  createPortalSignInCodeBody.parse(request);
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
  /**
   * The subscription status at open (5 Sep 2026) — `ACTIVE`/`TRIALING` lets
   * the journey skip the subscribe step instead of walking an already-paying
   * client back to the £8.50 screen. Null until the server sends it (an older
   * server, or a business that has never been through checkout); the checkout
   * call's `NT-BIL-002` refusal remains the guard either way.
   */
  subscriptionStatus: string | null;
}

/**
 * ✅ `businessId` IS CONTRACTED, as of change #205 (28 Aug 2026), and the
 * subscribe step works because of it. `POST /billing/checkout-sessions`
 * requires a `businessId`, and an onboarding session had no way to learn its
 * own — the chase portal reads `GET /portal/context`, which needs a chase an
 * invited client does not have. So the step reported "could not open the
 * checkout, nothing has been charged" for every client, every time.
 *
 * It stays `.nullish()` and the shape stays NON-strict, and that is not
 * leftover caution: the field is optional in the contract because a CHASE
 * session deliberately omits it (its business is not its holder's to act on),
 * and this same shape parses both. A hard requirement here would break the
 * chase portal the day it shares this parser.
 *
 * ⚠ The server does not trust what it sends back either. Checkout re-derives
 * the business from the session and answers 404 to a body naming a different
 * one, so this field is a convenience for the caller and never the thing that
 * decides whose subscription is paid for.
 */
const onboardingSessionShape = z.object({
  token: z.string().min(1),
  expiresAt: z.string(),
  businessId: z.string().min(1).nullish(),
  // Same stance as businessId: optional in the contract (a chase session never
  // carries it), tolerant here so an older server still parses.
  subscriptionStatus: z.string().min(1).nullish(),
});

/**
 * Exchange the setup link, the registered address and the emailed code for a
 * session. Every verification failure — unknown link, expired link, wrong
 * address, wrong code — is the same `401 NT-OTP-001`, deliberately.
 */
export async function openOnboardingSession(
  email: string,
  otp: string,
  setupToken?: string,
): Promise<OnboardingSession> {
  // The token must match how the code was requested — see `requestSignInCode`.
  // A union of two literals, validated in place — see `requestSignInCode`.
  const request = setupToken === undefined ? { email, otp } : { email, otp, setupToken };
  createPortalOnboardingSessionBody.parse(request);
  const body = onboardingSessionShape.parse(unwrapBody(await createPortalOnboardingSession(request)));
  return {
    token: body.token,
    expiresAt: body.expiresAt,
    businessId: body.businessId ?? null,
    subscriptionStatus: body.subscriptionStatus ?? null,
  };
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
 *
 * ⚠ THE PATH IS THE CALLER'S, and that is not a tidy-up. It was hard-coded to
 * `/app/setup`, which is the address of the ONE-TIME setup journey: a client
 * who restarted a lapsed subscription from inside their own portal was
 * returned to a setup link they no longer hold, i.e. to a dead end, having
 * just paid. Every caller passes the address it wants to be brought back to;
 * the setup journey passes its own and is unchanged.
 */
function checkoutReturnUrl(returnPath: string, outcome: 'success' | 'cancelled'): string {
  const separator = returnPath.includes('?') ? '&' : '?';
  return `${window.location.origin}${returnPath}${separator}checkout=${outcome}`;
}

/** The setup journey's return address — its own screens read `?checkout=`. */
export const SETUP_RETURN_PATH = '/app/setup';

/**
 * Mint the Stripe-hosted checkout and hand back its URL. The caller redirects
 * the whole tab — Stripe shows the VAT and the gross total before the client
 * commits (§24.5), and no card detail ever touches our origin.
 *
 * A `409 NT-BIL-002` means the business is already subscribed; card changes
 * and cancellation live in the customer portal, not in a second checkout.
 */
export async function startSubscriptionCheckout(
  sessionToken: string,
  businessId: string,
  returnPath: string = SETUP_RETURN_PATH,
): Promise<string> {
  const request = createCheckoutSessionBody.parse({
    businessId,
    successUrl: checkoutReturnUrl(returnPath, 'success'),
    cancelUrl: checkoutReturnUrl(returnPath, 'cancelled'),
  });
  const body = hostedSessionShape.parse(unwrapBody(await createCheckoutSession(request, bearer(sessionToken))));
  return body.url;
}

/**
 * Mint a Stripe customer-portal session — card changes, invoices and
 * cancellation are all Stripe's pages, deliberately the whole of our billing
 * UI beyond the settings Plan section (launch stage M6, D48).
 *
 * ⚠ `sessionToken` is OPTIONAL and its presence decides WHO is asking. Omitted,
 * the workspace cookie authenticates and this is practice staff opening a
 * client's billing page. Passed, it is the client themselves from inside their
 * own portal — which the contract permits as of 2 Sep 2026, and without which
 * the person D48 makes the PAYER could not change a card, read an invoice or
 * cancel. Under the bearer the server refuses a `businessId` that is not the
 * session's own with a **404**, never a 403: a 403 would confirm the other
 * business exists.
 */
export async function openBillingPortal(businessId: string, sessionToken?: string): Promise<string> {
  const request = createBillingPortalSessionBody.parse({
    businessId,
    returnUrl: `${window.location.origin}${window.location.pathname}`,
  });
  const response =
    sessionToken === undefined
      ? await createBillingPortalSession(request)
      : await createBillingPortalSession(request, bearer(sessionToken));
  const body = hostedSessionShape.parse(unwrapBody(response));
  return body.url;
}


/* ── The client's own portal (D47, §24.5) ─────────────────────────────────── */

/**
 * What a signed-in client sees of their own workspace.
 *
 * ⚠ Deliberately NOT the accountant's `BusinessSummary`. A client has no
 * business seeing how many of their documents sit in the practice's review
 * queue, or what its approval backlog looks like — that is the firm's working
 * state. This is their own side of the same pipeline: what they have sent,
 * what is still being asked of them, and whether they may send more.
 */
/** One outstanding ask, in the shape the portal home renders. */
export interface BusinessPortalAsk {
  readonly transactionId: string;
  readonly label: string | null;
  /** Pounds, signed as the feed records it. */
  readonly amount: number;
  readonly date: string;
  readonly received: boolean;
}

/**
 * The client's own plan, as the server projects it from Stripe.
 *
 * Null until the client has been through checkout at all — and a plan panel
 * that cannot say which of the eight statuses applies has to say so rather
 * than assume the friendly one.
 */
export interface BusinessPortalPlan {
  readonly status: SubscriptionStatus;
  readonly plan: string | null;
  /** ISO instant. The renewal date a settings screen shows. */
  readonly currentPeriodEnd: string | null;
}

export interface BusinessPortalHome {
  readonly businessName: string;
  readonly businessId: string | null;
  readonly documentsSent: number;
  readonly awaitingYou: number;
  readonly subscriptionActive: boolean;
  readonly lastDocumentAt: string | null;
  /** The itemised asks (Phase 5) — what "waiting for N documents" actually names. */
  readonly items: readonly BusinessPortalAsk[];
  readonly statementRequests: readonly { period: string; received: boolean }[];
  /**
   * The plan behind `subscriptionActive`, when the server sends one.
   *
   * ⚠ Null means "not stated", NOT "no subscription" — an older server omits
   * the field entirely (the parse is deliberately tolerant), and a Settings
   * panel that read absence as "you are not subscribed" would tell a paying
   * client they had never paid. `subscriptionActive` is the entitlement
   * question and stays the only thing gating the upload button.
   */
  readonly plan: BusinessPortalPlan | null;
  /** The session's own expiry, ISO. The bearer stops working at this instant. */
  readonly expiresAt: string | null;
}

/**
 * The parse is deliberately narrow and NOT `.strict()`.
 *
 * One `PortalContext` serves two jobs — a chase being answered and a client
 * signed into their own workspace — so this shape reads the half it needs and
 * ignores `items`, which belong to the other job. Parsing the whole thing here
 * would couple the client's home screen to a chase list it never renders.
 */
const portalHomeShape = z.object({
  businessName: z.string().min(1),
  businessId: z.string().nullish(),
  // The itemised asks (Phase 5): every outstanding chased line and statement
  // request on the workspace, so "waiting for 3 documents" can name them.
  // Tolerant (`nullish`, defaults) because an older server sends neither.
  items: z
    .array(
      z.object({
        transactionId: z.string(),
        merchantName: z.string().nullish(),
        descriptionRaw: z.string().nullish(),
        amountPence: z.number().int(),
        bookedAt: z.string(),
        received: z.boolean(),
      }),
    )
    .nullish(),
  statementRequests: z.array(z.object({ period: z.string(), received: z.boolean() })).nullish(),
  expiresAt: z.string().nullish(),
  summary: z
    .object({
      documentsSent: z.number().int().min(0),
      awaitingYou: z.number().int().min(0),
      subscriptionActive: z.boolean(),
      lastDocumentAt: z.string().nullish(),
      // The plan (contract change, 2 Sep 2026). `nullish` twice over on
      // purpose: absent means an older server, null means a client who has
      // never been through checkout, and the Settings panel says something
      // different for each.
      subscription: z
        .object({
          status: z.enum([
            'INCOMPLETE',
            'INCOMPLETE_EXPIRED',
            'TRIALING',
            'ACTIVE',
            'PAST_DUE',
            'CANCELED',
            'UNPAID',
            'PAUSED',
          ]),
          plan: z.string().nullish(),
          currentPeriodEnd: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/**
 * The client's portal home, read with the session bearer they already hold.
 *
 * Before the server grew this branch, `GET /portal/context` answered a flat
 * `401` for a session with no chase — which is every invited client who has
 * just signed in to their own workspace. So the one credential they can hold
 * had nowhere to land, and the portal existed only on seed data.
 *
 * Returns null when the session carries no summary. That is the CHASE case, and
 * it is not an error: a chase portal is answering a request, not browsing a
 * workspace, and it must not be handed one.
 */
export async function fetchBusinessPortalHome(sessionToken: string): Promise<BusinessPortalHome | null> {
  const body = portalHomeShape.parse(unwrapBody(await getPortalContext(bearer(sessionToken))));
  if (body.summary === null || body.summary === undefined) return null;
  return {
    businessName: body.businessName,
    businessId: body.businessId ?? null,
    documentsSent: body.summary.documentsSent,
    awaitingYou: body.summary.awaitingYou,
    subscriptionActive: body.summary.subscriptionActive,
    lastDocumentAt: body.summary.lastDocumentAt ?? null,
    items: (body.items ?? []).map((item) => ({
      transactionId: item.transactionId,
      label: item.merchantName ?? item.descriptionRaw ?? null,
      amount: fromPence(item.amountPence),
      date: fromIsoDate(item.bookedAt),
      received: item.received,
    })),
    statementRequests: (body.statementRequests ?? []).map((r) => ({ period: r.period, received: r.received })),
    plan:
      body.summary.subscription === null || body.summary.subscription === undefined
        ? null
        : {
            status: body.summary.subscription.status,
            plan: body.summary.subscription.plan ?? null,
            currentPeriodEnd: body.summary.subscription.currentPeriodEnd ?? null,
          },
    expiresAt: body.expiresAt ?? null,
  };
}

/* ── What the client has sent ─────────────────────────────────────────────── */

/**
 * One document, as the person who sent it may see it.
 *
 * ⚠ `status` is the SERVER'S word, from a five-value enum that is deliberately
 * not `DocumentState`. The mapping is made server-side so the five cannot fork
 * between clients — this module carries the enum through untouched and the
 * view puts each value through the catalogue. Nothing here derives a
 * client-facing status from a pipeline state, and nothing may start to.
 *
 * ⚠ `supplier` is UNTRUSTED CONTENT — read off a scanned page by a model. It
 * is rendered as text and never interpolated into anything that executes.
 */
export interface PortalSentDocument {
  readonly id: string;
  readonly supplier: string | null;
  /** "09 Aug 2026", or null until extraction has read a date. */
  readonly date: string | null;
  /** Pounds, or null when nothing has been read off it yet. */
  readonly total: number | null;
  readonly currency: string | null;
  readonly channel: string;
  readonly status: PortalDocumentStatus;
  /** ISO instant — when it reached us. The list's sort key, newest first. */
  readonly receivedAt: string;
}

/**
 * A page of the client's own documents.
 *
 * ⚠ `hasMore` is carried through and NOT dropped, because the portal home
 * derives two of its four counters from these rows. A count over a truncated
 * page presented as a total is the quiet kind of lie this product exists to
 * stop telling; the screen says which figures are "of your most recent N".
 */
export interface PortalSentPage {
  readonly rows: readonly PortalSentDocument[];
  readonly hasMore: boolean;
}

/**
 * `GET /portal/documents` — the client's own list, newest first.
 *
 * Parsed by the contract's own generated schema rather than a hand-written
 * shape, because it has one (unlike the 201s elsewhere in this module): a
 * status value the enum does not admit fails here rather than rendering as a
 * blank pill three components deep.
 */
export async function fetchPortalDocuments(sessionToken: string, limit = 50): Promise<PortalSentPage> {
  const body = listPortalDocumentsResponse.parse(
    unwrapBody(await listPortalDocuments({ limit }, bearer(sessionToken))),
  );
  return {
    rows: body.data.map((row) => ({
      id: row.id,
      supplier: row.supplierName ?? null,
      date: row.documentDate === null || row.documentDate === undefined ? null : fromIsoDate(row.documentDate),
      // The one pence→pounds boundary for this list, as everywhere else.
      total: row.totalPence === null || row.totalPence === undefined ? null : fromPence(row.totalPence),
      currency: row.currency ?? null,
      channel: row.channel,
      status: row.status,
      receivedAt: row.receivedAt,
    })),
    hasMore: body.pageInfo.hasMore,
  };
}
