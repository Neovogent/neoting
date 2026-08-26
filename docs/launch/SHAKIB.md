# Shakib — infra, money, config, deploy

Read `docs/launch/PLAN.md` first. It holds the rules, the dependency order and what "done"
means. This file holds your stages.

**To run one:** attach the codebase and this file, then say *"Finish stage S2."*

**Your other job is review.** Two people are blocked on your merges and on your S0
approval. A PR sitting for an hour costs more than any stage in this file.

---

## Start these now — they are external clocks, not engineering

- **Stripe live-mode activation.** A UK account goes live only after company and director
  verification. Days, not hours.
- **ICO data-protection fee.** £40–60/year, registered online. `docs/Kickoff_Requirements.md`
  §1.2 marks it blocking *before any real customer data*.
- **A mailbox that is not a personal Gmail.** Support currently forwards to a free consumer
  Google account, which has no Art. 28 processor contract. Client financial records will
  pass through it.

---

## S0 · The LAW batch

**Needs:** nothing. **Owns:** `packages/contracts/openapi.yaml`, `prisma/`.
**Everything waits on this.** One issue, one approval, one migration — or three people
block on you four separate times.

```
Read docs/launch/PLAN.md, then packages/contracts/CLAUDE.md and prisma/CLAUDE.md.

Open ONE contract-change issue covering everything below, so it is approved once. These
are LAW paths (G7): they change via an approved issue BEFORE a PR opens.

OPENAPI SURFACES:
1. Practice signup      POST /v1/practices            create a practice + first admin
2. Export               POST /v1/exports -> file, GET /v1/exports
3. Capability URL       GET /d/{token}                unauthenticated, streams a document
4. Client intake & team POST/GET /v1/clients, POST /v1/clients/{id}/members
5. Billing              POST /v1/billing/checkout-sessions -> {url},
                        POST /v1/webhooks/stripe
6. Portal onboarding    an OTP session that is NOT tied to a chase (see below)

PRISMA — ADDITIVE ONLY, expand-contract (Governance §5.3):
a. `businesses` += stripe_customer_id, subscription_status, plan,
   subscription_current_period_end. Reuses the existing businesses_tenant RLS policy, so
   there is no new policy to get wrong.
b. `Export` model: id, businessId, target, rowCount, createdBy, createdAt.
c. `IntegrationKind` += VT and MANUAL.
   ⚠ THIS ONE IS A BLOCKER AND IT IS NOT OBVIOUS. publish-batch.ts refuses with "this
   client has no active ledger connection", resolveIntegration is the only door, and the
   enum is {XERO, QUICKBOOKS, SAGE, FREEAGENT}. Without a VT or MANUAL value NOTHING CAN
   EVER REACH PUBLISHED, so the VT export has nothing to export and §24.7 cannot run.
d. `OtpSession.businessId` becomes NULLABLE, and OtpSessionScope.ONBOARDING gets used.
   Today an OTP row REQUIRES a businessId, so an accountant-level or pre-client OTP has
   nowhere to live.
e. `users`: make password_hash and totp_secret_ref writable at runtime — today only
   prisma/seed.ts ever sets them.

Write the issue with the reasoning above, not just the list. Then implement it in ONE
migration and ONE contracts PR. Do not scatter it.

Full gate. PR.
```

---

## S1 · Secrets and boot gates

**Needs:** S0. **Owns:** `apps/api/src/config/env.ts`, `infra/envs/staging/services.tf`.

```
Read apps/api/src/config/env.ts. Several defaults are fine for a demo and dangerous live.

1. SESSION_SECRET, PORTAL_LINK_SECRET and PORTAL_SESSION_SECRET all `.default('')`, with a
   comment recording a deliberate decision not to gate them. That decision was right for a
   demo and is wrong now: an empty signing secret means forgeable sessions and forgeable
   portal links. Add them to the production superRefine block so a production boot with any
   of them empty REFUSES TO START.

2. EXTRACTOR has no production gate at all. The superRefine covers AUTH_MODE and AI_CHAT
   but not this. A production boot with EXTRACTOR=demo must refuse — DemoExtractor
   fabricates supplier, date and total from a filename hash and marks them Ready, which is
   the single worst thing this system can do to a paying customer.

3. OTP_MODE admits only 'demo', which accepts the literal code 000000. Extend the enum to
   ['demo','totp'] and refuse 'demo' in production. (A2 implements the real path.)

4. IMAGE_NORMALISER defaults to `fixture`, which env.ts itself says REFUSES HEIC. DOCUMENT_GUARD
   defaults to `fixture` too. Both must be their real implementations in staging/production.

5. AI_DAILY_BUDGET_PENCE defaults to 500 — £5/day per practice, described in the file as a
   demo-scale number. Raise it to something a real practice will not hit on day one, and
   say what you chose and why.

The pattern already exists in that file — follow it exactly rather than inventing a new
one. A config-shaped mistake must fail LOUDLY at boot, never quietly at the first receipt.

Update infra/envs/staging/services.tf to match.

Full gate. PR.
```

---

## S2 · Email that arrives

**Needs:** S0. **Owns:** `apps/api/src/modules/notifications/`, SES infra.
**This is a blocker.** Nothing in the repo sends an email, and with SMS cut the client has
no delivery channel at all.

```
Read apps/api/src/modules/notifications/CLAUDE.md — it is the only file in that module.

A repo-wide grep for SESClient, sendEmail, nodemailer, SendEmailCommand and smtp returns
ZERO hits. Only inbound mail exists. The journey needs at least three outbound emails and
none can be sent today.

BUILD the notifications module as a transport with a seam, matching the house pattern
(selectEmailSender, config not import, a demo sender that writes an outbox row and a real
SES sender). SES is already production-approved in eu-west-2 — 50,000/day, 14/sec, domain
identity in place — so no support case is needed.

THREE MESSAGES:
1. Client invite — the accountant adds a client, the client gets a link.
2. Sign-in code — six digits, short expiry, single use.
3. Document request — the chase, by email instead of SMS.

RULES THAT MATTER MORE THAN THE FEATURE:
- Plain text. No images, no tracking pixel, no marketing chrome. A transactional email
  that looks like a campaign lands in spam, and a sign-in code in a spam folder means the
  client cannot sign in at all.
- The code is a CREDENTIAL. Never log it, never put it in a URL, never return it in an API
  response or an error, not even in development.
- Rate-limit per address AND per IP.
- Confirm SPF, DKIM and DMARC are published for the sending domain.

PROVE IT: send to a real Gmail address and a real Outlook address and confirm both land in
the inbox, not spam. Do not mark this done on a Terraform apply.

Separately, confirm support@neovogent.com still forwards correctly through Cloudflare —
one test message, then leave it alone.

Full gate. PR.
```

---

## S3 · The frontend moves to AWS

**Needs:** S0. **Owns:** `infra/envs/staging/edge.tf`, deploy workflow.

```
Read infra/envs/staging/edge.tf and docs/runbooks/vercel-web.md.

edge.tf ALREADY has a CloudFront distribution with an ALB origin and an ACM cert. You are
extending it, not building one.

Target: one distribution for neoacc.neovogent.com.
- default behaviour -> a new PRIVATE S3 bucket holding the built SPA, via Origin Access
  Control. Not a public bucket — runbook §6.5 is explicit that public origins bypassing
  CloudFront are the thing to avoid.
- /v1/* -> the EXISTING ALB origin, so the session cookie stays first-party and no CORS
  surface has to exist. This is the same trick Vercel was doing server-side. Keep it.
- 403/404 from S3 rewrite to /index.html so client-side routing works.

Routing: landing page at /, app at /app. The API stays on api.neoting.neovogent.com — it
is live, users never see it, and renaming a live endpoint mid-launch buys nothing.

Add a deploy step that builds apps/web, syncs to the bucket and invalidates.

⚠ VERIFY BEFORE YOU DESIGN: the plan assumes the staging ALB is up. AWS prod was destroyed
on 25 Aug. Confirm what actually exists before wiring an origin to it.

Terraform fmt and validate must pass. PR — do not apply by hand.
```

---

## S4 · Stripe, and the VAT that S2 forgot

**Needs:** S0, S3. **Owns:** `apps/api/src/modules/billing/`, Stripe dashboard.

```
Read D48 and docs/launch/PLAN.md. BUY, DO NOT BUILD.

Stripe Checkout in HOSTED mode, subscription mode. Not Payment Element, not Payment Links.
Zero client-side bundle so the 250 KB route budget never notices, no card data near our
origin, and Stripe hosts the invoice, receipt, dunning and card-update flows.

ONE PRODUCT, ONE PRICE: "Neo Accounting", GBP 8.50/month recurring, per client business.
No tiers, no add-ons, no coupon.

⚠ VAT, AND THIS IS THE PART THAT IS EASY TO GET WRONG. A price of 8.50 with no tax
behaviour set is treated by HMRC as VAT-INCLUSIVE — meaning you absorb the VAT and receive
£7.08. The price must be created as TAX-EXCLUSIVE, with either Stripe Tax enabled or an
explicit 20% GB tax rate via default_tax_rates. Also set: the account tax ID
(GB 9286810564), a required billing address at checkout, and invoice PDFs on.

TWO ENDPOINTS:
- POST /v1/billing/checkout-sessions (authenticated) -> { url }
- POST /v1/webhooks/stripe -> verify signature, update the business

PERSISTENCE: the four additive columns from S0. Do NOT create a subscriptions table.

⚠ THE WEBHOOK RUNS WITH NO SESSION and RLS fails CLOSED AND SILENT — an unscoped read
returns nothing rather than erroring. Resolve the tenant from the Stripe customer id
explicitly and assert you matched exactly one. A subscription written to the wrong tenant
would be invisible.

⚠ ENTITLEMENT MUST ACTUALLY BE ENFORCED. Adding the columns is not enough — nothing reads
them today. Put the check in the SERVICE LAYER, never in scopedDb or an RLS policy:
entitlement inside RLS would break D32's export-at-cancellation promise invisibly, because
the tenant would simply see an empty workspace. Decide and document what an unsubscribed
business can still do — reading and exporting their own data should survive; new uploads
should not.

Also wire the Stripe CUSTOMER PORTAL for card changes and cancellation. Do not build a
plan-change UI, a cancellation flow or an invoice renderer.

Full gate. PR.
```

---

## S5 · Real extraction, on

**Needs:** S1, A4 (formats), A3 (sanitisation). **Owns:** `infra/envs/*/services.tf`.
**Do not run this before A3 and A4 are merged** — see below.

```
Turn on real document reading.

Today EXTRACTOR=demo, pinned in infra/envs/staging/services.tf, and DemoExtractor invents
supplier, date, total, VAT number and category from a filename hash at 0.8 confidence —
which makes resolveProcessedState return READY. A fabricated invoice is presented as ready
to post.

The flip itself is one Terraform value. The IAM grant already exists (compute.tf covers
anthropic.claude-sonnet-4-6, which is what TASKS.extractionVisionFirst resolves to), and
the worker already passes the DocumentStore.

⚠ IT IS UNSAFE UNTIL A3 AND A4 ARE MERGED. BedrockExtractor accepts only
png/jpeg/webp/gif while ingestion accepts PDF, HEIC and docx, and select-extractor.ts
deliberately has no fallback — so flipping early turns "fabricated data" into "most real
documents FAIL". Confirm both are on main first.

Then:
1. Flip staging to EXTRACTOR=bedrock.
2. Verify end to end that a Bedrock failure lands the document in FAILED with a visible
   reason and is retryable.
3. Add a cost ceiling. BedrockExtractor constructs AnthropicBedrock directly and never
   touches the AI budget the chat runtime uses, so extraction spend is currently
   unbounded. Wire it to the same budget or give it its own.
4. Measure the real cost per document and report it against the £0.02 guardrail.

Full gate. PR.
```

---

## S6 · Publish the legal pack

**Needs:** nothing. **Owns:** `docs/legal/`.

```
Four documents are drafted in docs/legal/: terms of service, privacy notice, data
processing terms, refund and cancellation.

They are a DRAFTING AID, not legal advice. Read them properly — they were written from the
product's own documented behaviour, so anything they promise is something the code must
actually do.

YOU MUST SUPPLY:
- The company number (Companies House).
- The registered office address as it appears on the register.
- A decision on the Gmail forwarding. support@neovogent.com currently forwards to a free
  consumer Google account, which has no Art. 28 processor contract. Client financial
  records will pass through it. Either move to a business mailbox with proper terms, or
  record the decision and its reasoning.
- Confirmation of the retention periods the privacy notice states, since D32 commits to
  export and erasure but not to a number of days.

Every [PLACEHOLDER] must be resolved before these go live. Grep for it.

Then hand them to Mubasshir for M4, which renders them as pages.
```

---

## S7 · Deploy and the walkthrough

**Needs:** everything. **Owns:** nothing — you are running the product, not changing it.

```
1. Merge everything outstanding. Full gate on main. Deploy. Confirm neoacc.neovogent.com
   actually serves, and that /app reaches the API.

2. Run the walkthrough in docs/launch/PLAN.md, "What done means", as a real user, on a real
   phone, with a real card. All three of you, together. Do not divide it up — the value is
   in one person feeling the whole journey.

3. Fix only what the walkthrough breaks. No refactors. No "while I'm here".

4. Before you take a customer:
   - Stripe in live mode, with a real card charged and refunded once.
   - ICO registration confirmed.
   - Legal pages reachable from the landing page and the portal.
   - support@ forwarding proven with a real send from outside.
   - The rota written down: who is on for which hours across the first week.

5. Prune the branch estate. There were 36 local branches, 13 remote and 23 worktrees.
   `git worktree prune`, delete merged branches, and keep future worktrees OUTSIDE the
   repo — that is what caused the b5c0b11 incident.
```
