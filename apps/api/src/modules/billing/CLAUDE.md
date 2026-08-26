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
`portal-upload.service.ts#createPortalUpload`. **Known contract drift:**
`createPortalUpload` declares no `402` in `openapi.yaml` while
`createDocumentUpload` does. The behaviour is contracted (the webhook's own
description says new uploads stop at a lapse); the missing response belongs in
a contract-change issue, and LAW paths are not edited from here.

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
