# modules/billing — subscription (D48), launch stage S4

Two endpoints, one webhook, one rule. Everything a subscription business
normally builds — the invoice, the receipt, the dunning email, the card-update
screen, the cancellation flow, the plan-change UI — is a page Stripe hosts and
none of it is in this directory. **Buy, do not build** is a shape, not a
slogan: `stripe-client.ts` is what the shape costs, and it is three calls.

| File | What it is |
|---|---|
| `billing.controller.ts` / `billing.service.ts` | `POST /v1/billing/checkout-sessions`, `POST /v1/billing/portal-sessions` |
| `stripe-webhook.controller.ts` / `stripe-webhook.service.ts` | `POST /v1/webhooks/stripe` — the only writer of subscription state |
| `stripe-client.ts` + `http-` / `demo-` / `select-` | The Stripe seam, config-selected on `BILLING` |
| `stripe-signature.ts` / `.guard.ts` | The HMAC that is the whole authorisation for the webhook |
| `stripe-event.ts` | Zod at the boundary, over the fields a subscription decision reads |
| `entitlement.ts` + `index.ts` | The public seam: what a business that is not paying may still do |
| `return-url.ts` | The open-redirect guard on three caller-supplied URLs |

## ⚠ Checkout has two principals (contract change #205, 28 Aug 2026)

`openapi.yaml` now puts `portalSession` beside `workspaceSession` on
`createCheckoutSession`, and `PortalSession` carries an optional `businessId`.
Both are additive, both were approved before the PR opened, and the reason is
that **D48 says the CLIENT pays** — and a client holds a portal bearer, not a
workspace cookie. Until this, the subscribe step at the end of the invited
client's own onboarding could not be called at all: the session had no way to
learn its own business, so `apps/web` reported "could not open the checkout" to
every client, every time.

`billing.controller.ts#principalFor` is the whole of the choice. A bearer means
the portal and is judged as a portal session on its own merits
(`resolveOnboarding`, which refuses a chase session, an unverified row and an
expired one); no header at all is the accountant, unchanged.

⚠ **The 404 in that method is the entire tenancy check on the portal path.**
`systemScopeFor` yields the practice SYSTEM context, which can see every business
in the practice, so RLS narrows nothing here — the session row does. A body
naming a different business is **404, never 403**, because a 403 confirms the
other business exists. The upload path dodges this by giving
`PortalUploadRequest` no `businessId` at all; checkout cannot, because the
contract shares one request schema with the accountant. `billing.controller.test.ts`
pins all five branches, including that nothing reaches Stripe on a mismatch.

## ⚠ The customer portal gained it too (2 Sep 2026)

This section said the opposite — *"the customer-portal operation deliberately
did NOT gain the second principal: it is card changes, invoices and cancellation
on an already-subscribed business, reached from that client's own settings,
behind a session that has been through more than a setup link"* — and that was
right about #205's scope and wrong about the product. D48 makes the **client**
the payer and D49 gives them a Settings tab; *"that client's own settings"* IS
the portal session. Stripe's hosted portal is the only surface in this product
for changing a card, reading an invoice or cancelling, and the only door to it
was a workspace cookie no client holds. A subscription its payer cannot leave is
not one they consented to.

⚠ **`BillingPortalSessionRequest` had none of checkout's businessId guard**,
because until now no session that could name a different business could reach
the operation. Adding the principal without the guard would have let a client
holding one workspace's bearer open ANOTHER's billing portal: every invoice, the
card, and cancellation. So the principal and the guard arrived in the same edit,
and both handlers call the SAME `principalFor` — a copy would be a second place
for the rule to be right, and one of the two would eventually not be.

`billing.controller.test.ts` pins all five branches on this door as well
(cookie, blank header, own business, mismatched business → 404 with nothing
reaching Stripe, refused bearer → 401), and
`modules/portal/portal-client-surface.integration.test.ts` proves the 404
through the REAL resolver over a REAL `otp_sessions` row.

## Staging is REAL Stripe now, against a sandbox

**Staging runs `BILLING=stripe` against a SANDBOX since 28 Aug 2026.** It ran
`demo` until then, and that was not merely a weaker environment: `subscription_status`
is written ONLY by the Stripe webhook, so on `demo` it stayed null, `mayIngest(null)`
was false, and every upload 402'd — the walkthrough died at the step after
sign-in. The "no card can be charged" guarantee moved rather than went away: it
is now the ACCOUNT, not the adapter, and `4242 4242 4242 4242` is the only card
that works. See `docs/runbooks/stripe-billing.md` §7 and
`infra/envs/staging/services.tf`.

The key is **restricted** (`rk_test_`), with Write on Customers, Checkout
Sessions and Customer Portal and nothing else — the same three the live-mode
rule asks for. §4's VAT probe was re-run against it on the deployed
configuration and still reads **850 / 170 / 1020**, which is also the check that
the key belongs to the account owning the price: the account has a second
sandbox whose keys look identical and fail with "No such price" at the moment a
client presses Subscribe.

## The four things worth knowing before you change anything here

### 1. Entitlement is in the service layer, and moving it is a data-loss bug

**Reading and exporting survive a lapse; new uploads do not.**

Putting the check in `scopedDb` or an RLS policy would break D32's
export-at-cancellation promise *invisibly*: a lapsed tenant would not see a
billing message, they would see an **empty workspace**, and their own financial
records would appear to have been deleted. The contract says so on the webhook
operation, `docs/runbooks/error-codes.md` says it again under `NT-BIL-001`, and
`entitlement.ts` says it a third time — because it is the one decision here
that cannot be recovered by reading the code afterwards.

Entitled = `ACTIVE` or `TRIALING`. Not `PAST_DUE` (that grace belongs to
Stripe's dunning, which has already emailed the client) and not `null` (in ID
the client subscribes at the end of their own onboarding, so no subscription
means an unfinished signup). `entitlement.test.ts` pins all nine cases.

Enforced at both intent paths: `web-upload.service.ts#createUpload` and
`portal-upload.service.ts#createPortalUpload`. ✅ **The contract drift is
closed (2 Sep 2026):** `createPortalUpload` now declares its `402`, which it did
not while `createDocumentUpload` did — so a client generated from the spec had
no branch for the single most likely refusal on the main ID intake path, and the
only one the client themselves can fix. The behaviour was always contracted
(`docs/runbooks/error-codes.md` puts `NT-BIL-001` at 402 on "any
entitlement-gated operation", and the webhook's own description says new uploads
stop at a lapse); only the response line was missing, and it stayed missing
because the G7 ceremony made a one-line spec addition a process. That ceremony
was retired on 1 Sep 2026.

The portal reads `PortalSummary.subscriptionActive` first, precisely so this
status is almost never the way a client finds out — and since 2 Sep the same
summary carries `subscription` (status, plan, renewal date) so the Settings tab
can say which lapse it is.

### 2. The webhook has no session, and `businesses` is behind RLS

This is the subtle one, and the obvious implementation is broken.

RLS **fails closed and silent** — every policy branch begins
`app_actor_id() IS NOT NULL`, so an unscoped read of `businesses` does not
error and does not return everything: it returns **nothing**. "Look the
business up by Stripe customer id" is therefore a function that always finds
zero rows and a subscription that never activates.

The way out is three steps, all load-bearing:

1. `businessId` and `practiceId` are stamped into Stripe metadata when the
   customer and the checkout session are created, at a moment when we
   legitimately know both. The event is signature-verified before it reaches
   the handler, so that metadata is our own data coming back.
2. The practice **opens a scope** and is never the answer —
   `resolveSystemActor` + `systemContext`, the same scope the workers write
   under.
3. The tenant is resolved **inside** that scope, by Stripe customer id, and the
   handler asserts it matched **exactly one** row.
   `businesses.stripe_customer_id` is UNIQUE, so that is structural.

Metadata naming the wrong practice cannot cause a wrong write — the scoped
query returns zero rows and the handler throws.

### 3. The customer is created BEFORE checkout, deliberately

Letting Checkout mint the customer would leave a window in which
`customer.subscription.created` names a customer no row points at. Events
arrive out of order, so that window is not theoretical. The binding write is a
conditional `updateMany` (`where: { id, stripeCustomerId: null }`) so two
simultaneous Subscribe presses cannot both win.

### 4. VAT is the thing that goes wrong quietly

The price is **tax-exclusive**. A price with no tax behaviour set is treated as
VAT-*inclusive*, which means absorbing the VAT and receiving £7.08 instead of
£8.50 — with no error anywhere.

`STRIPE_TAX=rate` (the default) attaches an explicit 20% GB rate.
`STRIPE_TAX=automatic` uses Stripe Tax, which **collects nothing and reports no
error** until there is an active UK registration in the dashboard. `env.ts`
refuses to boot `rate` with no rate id, because that combination charges the
net price with no VAT on it.

Verified against the live API, not by reading: subtotal 850, tax 170, total
1020. `docs/runbooks/stripe-billing.md` has the full setup and the check.

## Traps already paid for

- **`tax_id_collection` requires `customer_update[name]='auto'`** when the
  customer already exists. Nothing in the parameter names suggests they are
  coupled; the API refuses the whole request. Found against the real API.
- **`current_period_end` lives in two places.** Stripe moved it from the
  subscription onto each subscription *item* in `2025-03-31.basil`. The webhook
  endpoint's configured API version decides which one arrives, so
  `stripe-event.ts` reads both. Reading one leaves the renewal date silently
  null on half of all deployments — and a null period end is what the
  out-of-order guard reads.
- **Ordering is guarded on `current_period_end`, not on a timestamp.** There is
  no `last_event_at` column (`prisma/` is LAW; the ID batch added four columns,
  not five). `customer.subscription.deleted` is exempt and always applies, or a
  late renewal would resurrect a subscription the client ended.
- **The replay store is per-process.** Two API tasks behind the ALB each keep
  their own Map. It removes duplicate *work*; correctness does not depend on it,
  which is why the handler is independently idempotent.
- **Origin equality, not `startsWith`.**
  `https://app.neoting.neovogent.com.attacker.example` prefixes our own origin
  and reads fine in review.

## Definition of done for a change here

Everything in `apps/api/CLAUDE.md`, plus: if you touch the checkout parameters,
**re-run the probe in `docs/runbooks/stripe-billing.md` §4** and confirm
subtotal/tax/total are still 850/170/1020. The unit tests pin the request
shape; only the API can tell you the shape is *accepted*.
