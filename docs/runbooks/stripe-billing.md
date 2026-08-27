# Stripe billing — setup, the VAT trap, and going live

**Scope:** D48, launch stage S4. One product, one price, GBP 8.50/month per
client business, paid by the client. No tiers, no add-ons, no coupon.

The code is `apps/api/src/modules/billing/` — read its `CLAUDE.md` before
changing anything. This file is the part that lives in the Stripe dashboard and
in an operator's hands.

---

## 0. Which account this must be in

⚠ **The Stripe CLI on this machine is currently signed in to a personal
account (`mubasshirkhan231@gmail.com`, `acct_1RQtbxGMdHp4NCWv`) that already
holds products from an unrelated project.** The objects in §2 were created in
that account's **sandbox**, which is fine for proving the integration and is
where the ids below point.

It is **not** where launch goes. Live mode needs the Neoting company account,
because that is the account the company verification, the UK VAT registration
number and the bank payout details attach to. Creating the live-mode price in a
personal account puts someone else's name on a client's VAT invoice.

Check before doing anything: `stripe whoami`.

---

## 1. Prerequisites, in order

| # | Thing | Blocking what |
|---|---|---|
| 1 | A Neoting company Stripe account | Everything below, in live mode |
| 2 | Company + director verification (days, not hours) | Live mode at all |
| 3 | **The UK VAT registration number** | The VAT number on invoices |
| 4 | A head-office address in Tax → Settings | Adding any tax registration |

⚠ **`9286810564` is the company TAX ID, not the VAT registration number.**
Stripe's tax-ID field for a UK business expects a `gb_vat` value — the
nine-digit VAT registration reference. Putting the tax ID there produces
invoices with the wrong number on them.

---

## 2. The catalogue — one product, one price, one rate

Created 27 Aug 2026 in the sandbox above:

| Object | Id | What matters |
|---|---|---|
| Product | `prod_V93PDav82VR5QJ` | `tax_code=txcd_10103001` (SaaS, business use) |
| Price | `price_1U8lIsGMdHp4NCWvxj03BBuc` | `unit_amount=850` GBP, monthly, **`tax_behavior=exclusive`** |
| Tax rate | `txr_1U8lIuGMdHp4NCWvqQoFEvmQ` | 20%, `country=GB`, `tax_type=vat`, **`inclusive=false`** |

To recreate them in another account:

```bash
stripe post /v1/products \
  -d name="Neo Accounting" \
  -d description="Document-to-bookkeeping for one client business. Billed monthly." \
  -d tax_code=txcd_10103001 \
  -d "metadata[neoting_release]=ID"

stripe post /v1/prices \
  -d product=<prod_…> \
  -d currency=gbp \
  -d unit_amount=850 \
  -d "recurring[interval]=month" \
  -d tax_behavior=exclusive \
  -d nickname="Neo Accounting monthly (net of VAT)"

stripe post /v1/tax_rates \
  -d display_name=VAT -d description="UK VAT at the standard rate" \
  -d jurisdiction=GB -d percentage=20 -d inclusive=false \
  -d country=GB -d tax_type=vat
```

`unit_amount` is in **pence**, which happens to agree with the repo's own rule
that money is an integer of the minor unit.

**Do not use the Dashboard's "quick create" for the price.** It sets no tax
behaviour, and the default is inferred by currency — which for GBP is the
inclusive reading.

---

## 3. VAT: `rate` or `automatic`, and why the default is `rate`

`STRIPE_TAX=rate` attaches the explicit 20% GB rate through
`subscription_data[default_tax_rates][]`. It works with **no** Stripe Tax
registration and no VAT number.

`STRIPE_TAX=automatic` uses Stripe Tax, and is the better answer *once
registered*: it handles reverse charge, EU clients and rate changes on its own.

⚠ **Stripe Tax collects nothing, and reports no error, until there is an
ACTIVE registration in the customer's jurisdiction.** It is the single most
common Stripe Tax mistake and it looks exactly like a working integration —
checkout succeeds, the invoice renders, the VAT line is £0.00. Checked on
27 Aug 2026: `GET /v1/tax/registrations` returned an **empty list**. So
`automatic` today would silently mean absorbing the VAT.

Flip to `automatic` only after `stripe get /v1/tax/registrations` shows a GB
registration as collecting — and note that past transactions **cannot** be
retroactively corrected through Stripe.

The two are mutually exclusive; Stripe rejects a request carrying both.
`http-stripe-client.ts` sends one or the other, never a merge.

---

## 4. The probe — prove the VAT before believing it

This is the check the whole VAT section exists for. Run it after any change to
the price, the tax rate, or the checkout parameters.

```bash
stripe post /v1/customers -d name="Probe Ltd" \
  -d "metadata[businessId]=biz_probe" -d "metadata[practiceId]=prac_probe"

stripe post /v1/checkout/sessions --stripe-version 2026-07-29.dahlia \
  -d mode=subscription \
  -d customer=<cus_…> \
  -d "line_items[0][price]=<price_…>" -d "line_items[0][quantity]=1" \
  -d success_url="https://app.neoting.neovogent.com/app/ok" \
  -d cancel_url="https://app.neoting.neovogent.com/app/no" \
  -d client_reference_id=biz_probe \
  -d "metadata[businessId]=biz_probe" -d "metadata[practiceId]=prac_probe" \
  -d billing_address_collection=required \
  -d "customer_update[address]=auto" -d "customer_update[name]=auto" \
  -d "tax_id_collection[enabled]=true" \
  -d "subscription_data[metadata][businessId]=biz_probe" \
  -d "subscription_data[metadata][practiceId]=prac_probe" \
  -d "subscription_data[default_tax_rates][0]=<txr_…>" \
  -d integration_identifier="neoting-id-subscription-qhrvmzbt"
```

**The three numbers that have to come back:**

```
"amount_subtotal": 850      £8.50 net
"amount_tax":      170      £1.70 VAT at 20%
"amount_total":   1020      £10.20 gross
```

A subtotal of 850 with a total of 850 means the price is being read as
VAT-inclusive: the price object is wrong, not the code. Fix it in §2 and run
this again. Verified 27 Aug 2026 — 850 / 170 / 1020.

**Trap already paid for:** `tax_id_collection[enabled]=true` on an *existing*
customer needs `customer_update[name]=auto` as well as `[address]=auto`, or the
whole request is refused with *"Tax ID collection requires updating business
name on the customer"*. Nothing in the parameter names suggests they are
coupled.

---

## 5. The customer portal

Configure it once, in Dashboard → Settings → Billing → Customer portal:

- **On:** update payment method, view invoice history, cancel subscription.
- **Off:** switch plan (there is one plan), update quantity (one per business).
- Set the return URL, the terms link and the privacy link — the portal is a
  page a client will read as ours.

There is deliberately no plan-change screen, cancellation flow or invoice
renderer in the codebase. Those are three things Stripe does correctly and
three more things that could be wrong on our side.

---

## 6. The webhook

**Registered in the sandbox on 28 Aug 2026: `we_1U9BfsGMdHp4NCWvglaIH4Ap`**, at
`https://api.neoting.neovogent.com/v1/webhooks/stripe`, with the four events
below. Its signing secret is in Secrets Manager at `/neoting/staging/stripe`
under `webhook_secret` and nowhere else — Stripe reveals it once, at creation.

`api_version` on it is **null**, i.e. it follows the account default, and that is
a recorded fact rather than a choice: Stripe rejects `api_version` on an UPDATE
(`Received unknown parameter`), so it can only be pinned at creation and this one
was not. It is safe today because `stripe-event.ts` reads `current_period_end`
from both places. Pin it on the live-mode endpoint, where the account default is
someone else's to move.

To recreate one, register `https://api.neoting.neovogent.com/v1/webhooks/stripe`
subscribed to:

```
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
checkout.session.completed
```

Anything else is acknowledged with a 200 and ignored — `invoice.paid` and
`invoice.payment_failed` reach us as the `customer.subscription.updated` Stripe
emits alongside them, so subscription state keeps exactly one writer.

Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`.

**Locally**, do not use the dashboard's secret:

```bash
stripe listen --forward-to localhost:3000/v1/webhooks/stripe
# prints: Ready! Your webhook signing secret is whsec_…
stripe trigger customer.subscription.updated
```

⚠ Set the endpoint's **API version** deliberately. `current_period_end` moved
from the subscription onto each subscription *item* in `2025-03-31.basil`, and
the endpoint's version decides which one arrives. The handler reads both, so
either works — but if you ever simplify it to one, this is the line that
decides which deployments silently lose the renewal date.

---

## 7. Configuration

| Variable | Staging since 28 Aug 2026 | Live |
|---|---|---|
| `BILLING` | **`stripe`** | `stripe` |
| `STRIPE_SECRET_KEY` | a sandbox key, from Secrets Manager | a **restricted** key (`rk_…`), not `sk_…` |
| `STRIPE_WEBHOOK_SECRET` | `we_1U9Bfs…`'s signing secret | the endpoint's signing secret |
| `STRIPE_PRICE_ID` | `price_1U8lIsGMdHp4NCWvxj03BBuc` | the live-mode `price_…` |
| `STRIPE_TAX` | `rate` | `rate` until registered, then `automatic` |
| `STRIPE_TAX_RATE_ID` | `txr_1U8lIuGMdHp4NCWvqQoFEvmQ` | the live-mode `txr_…` |
| `BILLING_RETURN_ORIGINS` | both app origins | the app origin |

⚠ **A restricted key is the LIVE-mode rule, and staging knowingly does not
follow it.** Stripe has no API for minting one, so a restricted key is a
dashboard action; in a sandbox the blast radius of a full key is a sandbox, and
paying a manual step per rebuild to narrow a permission set over fake data is
not a trade worth making. Live mode is the opposite: mint the `rk_` with exactly
**Customers**, **Checkout Sessions** and **Billing Portal Sessions** write, and
nothing else.

⚠ **Both web origins are listed, because both are live.**
`neoacc.neovogent.com` is the address the launch plan and the signup emails use;
`app.neoting.neovogent.com` is the one the CloudFront distribution has always
answered on, and the one a walkthrough is usually driven from. `successUrl` is
built from `window.location.origin`, so a checkout started on either has to be
allowed to come back or it is refused at the door.

The restricted key needs exactly three write permissions: **Customers**,
**Checkout Sessions**, **Billing Portal Sessions**. Nothing else. A full secret
key grants far more than the blast radius needs.

Secrets go in **Secrets Manager**, injected as an ECS `secrets` entry — never
in a task-definition `environment` block, never in a committed file.

`BILLING=stripe` refuses to boot with any of the four missing. That cannot
crash-loop staging, because staging stays on `demo` until the secrets exist.

---

## 8. Before the first real card

- [ ] Live mode active on the **company** account (§0).
- [ ] VAT registration number in Dashboard → Settings → Business → Tax IDs, as `gb_vat`.
- [ ] Invoice PDFs on, and the invoice template carrying the VAT number.
- [ ] §4's probe run in **live** mode: 850 / 170 / 1020.
- [ ] One real card charged and refunded once.
- [ ] Customer portal configured (§5) with terms and privacy links that resolve.
- [ ] Webhook endpoint registered and showing successful deliveries.
- [ ] The sandbox probe objects archived, so nobody mistakes them for live ones.

---

## 9. When something is wrong

`docs/runbooks/error-codes.md` carries `NT-BIL-001` (no active subscription),
`NT-BIL-002` (already subscribed) and the note that a Stripe signature failure
is `NT-INT-001`, not a billing code.

The one thing worth repeating here: **`businesses` is a projection, and Stripe
is the source of truth.** A disagreement means a webhook was missed, not that
the client is unsubscribed. Check Stripe's event log for failed deliveries
before telling anyone their card declined.
