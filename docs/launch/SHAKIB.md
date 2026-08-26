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

### ✅ Done — issue #164, PR #165 (26 Aug 2026)

One migration `20260826120000_id_law_batch`, one contracts pass, twelve
operations. **Everything downstream of S0 is unblocked.** Three things worth
knowing before you run the next stage:

1. **`POST /v1/businesses`, not `/v1/clients`.** Same resource `GET
   /v1/businesses` already served. A11 and M7 build against `businesses`.
2. **(e) needed no migration.** `users.password_hash` and `totp_secret_ref` were
   always writable — `users` carries no RLS. The blocker is
   `demo-credentials.ts`, which is A1's.
3. **The `Export` model already existed and was extended, not replaced**, and
   `document_links` + a `document.revoke-link` ProposalKind were added beyond the
   brief so A8's capability URL has somewhere to live. Both flagged on #164.

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

### ✅ Done — PR #169 (26 Aug 2026)

Eight variables gated, all keyed on `NODE_ENV=production` so they follow the
AUTH_MODE / AI_CHAT / UPLOAD_URL_SECRET pattern already in the file rather than
inventing a second one. **Staging runs `NODE_ENV=production`** (build parity,
and it is the launch target), so every gate bites staging — which is the point,
and which is why the Terraform half of this stage is not optional.

Four things worth knowing before you run the next stage:

1. **Nobody can sign in to staging until A2 merges.** Staging is on
   `OTP_MODE=totp`, and both verifiers still read `mode === 'demo' && code ===
   <fixed>`, so every second factor returns false. Fail-CLOSED and deliberate —
   `demo` was one fixed six-digit code on every account in every practice — but
   it blocks A1's and M6's staging testing, so **A2 is the stage to run next**.

2. **PDFs on staging now fail with NT-EXT-003 until A4 merges.** Staging is on
   `EXTRACTOR=bedrock` and BedrockExtractor is images-only, with no fallback by
   design. That is the trade S1 chose: a loud, retryable FAILED document instead
   of a quiet, confident, fabricated one.

3. **S5's flip is already done — its other three items are not.** Staging is on
   `bedrock`, so S5 is now "verify the FAILED path end to end, add the cost
   ceiling, measure £/document". Item 3 got MORE urgent: BedrockExtractor
   constructs AnthropicBedrock directly and never touches the AI budget, so
   staging now has UNMETERED extraction spend on a live environment.

4. **`infra/envs/prod/services.tf` was already unbootable and still is.** It
   sets no `AI_CHAT`, so it failed the existing gate before this stage touched
   anything. Deliberately left alone: prod was destroyed on 25 Aug and its
   rebuild has to reconcile more than S1. Do not read it as a working example.

Also in the diff: `qpdf` is installed in `apps/api/Dockerfile` (the gate and
the binary are two halves of one change), `AI_DAILY_BUDGET_PENCE` is £25/day
with the arithmetic written down, and the stale "qpdf is not in the image"
strings in `check.yml` and the module `CLAUDE.md`s are corrected.

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

### ✅ Done — PR #168 (26 Aug 2026)

`apps/api/src/modules/notifications/` is a config-selected transport with three
composed messages. **Every downstream consumer is unblocked**: A1/A11 call
`sendClientInvite`, A2 calls `sendSignInCode`, A14 calls `sendDocumentRequest`.
Read the module's `CLAUDE.md` before wiring one. Five things worth knowing:

1. **Proven with a real send, not a terraform apply.** Three messages to a real
   Gmail address *through the code*: SES `Send 3 · Delivery 3 · Bounce 0 ·
   Reject 0`, suppression list empty. DKIM, SPF-aligned MAIL FROM and DMARC all
   verified live.
2. **The `ses:FromAddress` grant was pinned to `doc@`, and that was a bug.**
   `doc@` is the *inbound* intake address — mail arriving there is filed as a
   client document, so sending from it would ingest every client reply as
   paperwork. Now `no-reply@`, with `Reply-To: support@neovogent.com`.
3. **Three boot gates, and `services.tf` was updated in the same commit** so the
   next staging deploy cannot crash-loop. `EMAIL_SENDER=demo` refuses in
   production — it is the one stand-in whose failure is invisible from every
   screen.
4. **It adds `@aws-sdk/client-sesv2`** (+6 packages, pinned to `client-s3`'s
   version). A dependency, so it is flagged on the PR rather than assumed.
5. **The env block lives in S1's file**, written as one self-contained additive
   block so your S1 pass merges over it rather than into it.

**Two things still need you, and neither is code:**

- **Confirm inbox-vs-spam placement**, and give me an Outlook address — SES can
  prove delivery to Gmail's MX, only a human proves the inbox, and no Outlook
  address was available.
- **Subscribe someone to `nt-staging-ses-events`.** Zero subscribers today, so
  bounces and complaints publish into a void: account-side suppression still
  works, but nobody is *told*. `observability.tf` forbids declaring it in
  Terraform (it would be created `PendingConfirmation` and look wired while
  delivering nothing), so this is out of band and the confirmation is the proof.

`support@neovogent.com` MX resolves to Cloudflare email routing with a matching
SPF record; the live forwarding test is still yours to run from outside.

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

### ✅ Done — `infra/envs/staging/web.tf`, `.github/workflows/deploy-web.yml` (26 Aug 2026)

The ⚠ paid off: **the staging ALB is up**, and so is everything else the origin
needs. Verified against AWS, not against the code —
`nt-staging-alb` (active, internet-facing), the `nt-staging` ECS cluster with
all four services, distribution `E2SUZ6X0H1I02U` serving `api.` and `staging.`,
and the six `nt-staging-*` buckets. **Only prod was destroyed on 25 Aug; staging
is untouched.**

`terraform plan` reports **14 to add, 0 to change, 0 to destroy** — the `api.`
distribution, the ALB, the WAF and every alarm are left exactly as they are.

**Three things to know before the next stage:**

1. **The app is at `app.neoting.neovogent.com`, not `neoacc.neovogent.com`** —
   for now. `neovogent.com` is on Cloudflare, only `neoting.neovogent.com` is
   delegated to Route 53, and the wildcard cert does not cover a `neoacc.`
   label. **You asked to delegate it; the exact Cloudflare steps are in
   `docs/runbooks/web-cloudfront.md`** — four NS records, three phases, and the
   two `web_public_zone_*` variables that gate it so a half-done delegation
   cannot hang CI's apply. Update PLAN.md's walkthrough when it is live.
2. **SPA routing is a CloudFront Function, not `custom_error_response`.** The
   usual 403/404 → `index.html` recipe is distribution-wide, so it would have
   turned every API 404 into an HTML 200 — including `GET /d/{revoked-token}`
   reporting success. Do not "simplify" it back.
3. **`/d/*` has its own cache behaviour** pointing at the ALB. Without it, A8's
   capability URLs — step 9 of the walkthrough, the acceptance test for the
   whole product — would return the app shell instead of the document.

Deploy is `.github/workflows/deploy-web.yml`: push to `main` touching
`apps/web/**` or the contract packages, or `workflow_dispatch` for a rollback.
It smoke-tests `/`, `/healthz` and `/app` after every publish and fails the job
if any of the three is wrong.

**Not applied.** The PR carries the plan; CI applies on merge if
`TERRAFORM_AUTO_APPLY` is set, otherwise run terraform from the Actions tab.
`deploy-web` will fail until the apply has created the two SSM parameters —
that ordering is deliberate and the error message says so.

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
the UK VAT registration number, a required billing address at checkout, and invoice
PDFs on.
   ⚠ 9286810564 is the company TAX ID, not the VAT registration number. Stripe's tax-ID
   field for a UK business expects a `gb_vat` value — the nine-digit VAT registration
   reference. Putting the tax ID there produces invoices with the wrong number on them.
   Get the VAT registration number before switching to live mode.

TWO ENDPOINTS:
- POST /v1/billing/checkout-sessions (authenticated) -> { url }
- POST /v1/webhooks/stripe -> verify signature, update the business

ALREADY DONE, do not redo: the Stripe CLI is installed and logged in, against the
Exambinary account acct_1RQtbxGMdHp4NCWv. `stripe login` is not a step you need.

⚠ THE SIGNING SECRET FROM `stripe listen` IS NOT THE ONE IN THE DASHBOARD. They are
different values for the same account, and this is the single most common hour lost in a
Stripe integration. `stripe listen --forward-to localhost:3000/v1/webhooks/stripe` prints
its own `whsec_...` on startup; that is the one STRIPE_WEBHOOK_SECRET must hold LOCALLY.
The dashboard endpoint's `whsec_...` is the one staging must hold. Cross them and every
event fails signature verification with a 400 that says nothing useful, while the Stripe
dashboard cheerfully shows the event as sent.

Test the webhook with `stripe trigger`, not with a card. You need at least:
  stripe trigger checkout.session.completed      → subscription becomes active
  stripe trigger customer.subscription.deleted   → cancellation, and D32 still lets them export
  stripe trigger invoice.payment_failed          → dunning; Stripe retries, we do not

Both keys are secrets. STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are new env vars, so
they are yours to add — follow S1's pattern and gate BOTH in the production superRefine
block. An empty webhook secret does not fail loudly; it accepts unsigned events, which
means anyone who can reach the endpoint can mark any business subscribed.

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

### ✅ Done — `apps/api/src/modules/billing/`, `docs/runbooks/stripe-billing.md` (27 Aug 2026)

Two endpoints, one webhook, one entitlement rule. **No new dependency** —
the surface is three form-encoded `POST`s and one HMAC, so it is `fetch` and
`node:crypto` rather than the Stripe SDK (`CLAUDE.md`: adding a dependency is a
human decision, and this one did not need to be made).

**The VAT is proved, not asserted.** Product, price and a 20% GB rate were
created through the Stripe CLI, and the checkout session was posted against the
real API: **subtotal 850, tax 170, total 1020** — £8.50 net, £1.70 VAT, £10.20
gross. `docs/runbooks/stripe-billing.md` §4 is that probe, written down so it
can be re-run after any change to the price or the parameters.

**Five things to know before the next stage:**

1. **The Stripe CLI here is signed in to a personal account**
   (`mubasshirkhan231@gmail.com`, `acct_1RQtbxGMdHp4NCWv`) that already holds
   another project's products — and it has a **live** context. The objects
   above are in its sandbox, which is fine for proving the integration and
   wrong for launch: live mode needs the Neoting company account, because that
   is what the company verification, the VAT registration number and the payout
   details attach to. Runbook §0.
2. **`GET /v1/tax/registrations` is EMPTY, so `STRIPE_TAX` defaults to `rate`**
   (an explicit 20% GB rate), not to Stripe Tax. Stripe Tax collects nothing
   and reports no error until a registration is active — it looks exactly like
   a working integration while the VAT line reads £0.00. Flip to `automatic`
   only once that call shows GB collecting.
3. **Entitlement is enforced, and it bites.** `ACTIVE` or `TRIALING` may upload;
   `PAST_DUE`, `CANCELED` and *never subscribed* may not — 402 `NT-BIL-001` on
   both `POST /v1/document-uploads` and `POST /v1/portal/uploads`. Reading,
   reviewing, approving and **exporting** are untouched (D32). The three seeded
   client businesses gained `subscriptionStatus: 'ACTIVE'` so the demo still
   works; that is the one `prisma/` edit in this stage and you approved it.
4. **Staging stays on `BILLING=demo`, stated explicitly in `services.tf`.**
   Demo hosted-session URLs are on the reserved `.invalid` TLD, so no card can
   be charged from staging and a leaked link provably resolves to nothing.
   `BILLING=stripe` refuses to boot without all four secrets — which cannot
   crash-loop staging precisely because staging is not on it.
5. **One contract drift, flagged not hidden:** `createPortalUpload` declares no
   `402` while `createDocumentUpload` does. The behaviour is contracted (the
   webhook's own text says new uploads stop at a lapse); the missing response
   needs a contract-change issue. LAW, so not edited here.

Proved end to end against real Stripe events (`stripe listen` + a real
subscription): signature verified, unhandled types 200-ignored, an event with
no tenant metadata **refused** rather than guessed, and
`biz_burger → INCOMPLETE → INCOMPLETE_EXPIRED` written through `scopedDb`. The
local database was reverted afterwards.

**Still yours before a real card:** the company Stripe account, live-mode
activation, and the **VAT registration number** — `9286810564` is the company
tax ID, not that. Runbook §8 is the checklist.

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

### ✅ Done — `common/ai-budget.ts`, `extraction/`, `scripts/measure/` (27 Aug 2026)

Item 1 was already done by S1. The other three are, and **two of them were live
defects on staging, not tidying** — real extraction had been reading documents
since S1 with no spend ceiling and no handling for a throw.

**Item 3 — extraction is metered.** `BedrockExtractor` built its own
`AnthropicBedrock` and consulted no budget, so staging had unbounded model spend.
It now checks and records against the **same per-practice daily ledger the chat
runtime has always used**, which meant moving `budget.ts` out of `chat-framework`
into `common/ai-budget.ts`: two modules share it now, the boundary lint forbids
extraction reaching into chat's internals, and re-exporting a Redis-backed ledger
through chat's seam would have broken that seam's own written rule (it carries
configuration, not behaviour). The budget is a **required** constructor argument
and `selectExtractor` throws without one — a missing store fails loudly on the
first document, a missing ceiling fails silently for ever, so the unmetered
object is now impossible to construct.

**Item 2 — the FAILED path did not exist, and that is the more serious find.**
`messages.create` was unguarded. A throttle, an expired credential, a socket
reset or a 400 on an over-long PDF travelled out to BullMQ; the retries ran, the
job dead-lettered, and the document **stayed PROCESSING for ever** — no failure
code, nothing on the Rejected/Failed view, and `document.reprocess` refuses a
processing document, so no Retry either. Now: the extractor classifies terminal
rejections (400 → `NT-EXT-009`, the PDF page-ceiling case a module TODO had open;
413 → `NT-EXT-007`), everything else rethrows for the retry ladder, and the
pipeline lands the document FAILED with `NT-EXT-010` on the job's **last**
attempt and rethrows anyway — so the client gets a visible retryable document and
you still get the DLQ entry. Proven against a real database, both branches.

**Item 4 — measured, and repeatable rather than quoted.**
`pnpm tsx scripts/measure/extraction-cost.ts` runs the real extractor against a
1568 px receipt JPEG and a born-digital PDF invoice. On the pinned
`anthropic.claude-sonnet-4-6`: **1.24–1.34p/document, 5–10 s**, every field
correct including UK d/m/y → ISO and integer pence. The old "~7 s / ~$0.016" in
the module doc was taken on a different, unpinned model and is replaced.

**Five things to know before the next stage:**

1. **⚠ THE £0.02 GUARDRAIL IS BLENDED AND WE ARE MEASURING ONE RUNG.** §16's
   stated composition is Textract ~0.8p/page + Nova Lite triage + a Sonnet coding
   call + amortised Opus. **None of those four exists.** D20 commits to Textract
   as the *committed primary* with Claude vision as the fallback lane; what runs
   is the vision rung used directly. That gap predates this stage and is a
   tracked TODO, but the honest reading is that today's blend has one component,
   so 1.3p is the whole AI cost of a document — and **adding Textract in front
   pushes the blend to ~2.1p if nearly everything escalates**, which is over the
   ceiling. That escalation rate is exactly what W2 calibration was for, and D28
   already conditions the middle rung on it. Worth a decision before anyone
   quotes 1.3p as the product's cost.
2. **One meter, two spenders — a deliberate coupling with a visible cost.** A
   practice that exhausts the ceiling in chat will see that day's documents land
   FAILED (`NT-EXT-008`, retryable tomorrow), and a document flood makes chat
   return its budget error. §9.7 defines a per-*firm* budget and a firm must get
   one number. Say so if it ever surprises someone; separating them is a second
   key segment, not a second implementation.
3. **The meter charges 2p for a 1.3p read.** `costPence` rounds UP per call and
   at ~3,500 tokens the rounding is about half the number, so £25/day is ~1,250
   documents metered against ~1,900 actual. Safe direction for a ceiling —
   but quote the per-100 figure in any pricing conversation, never the per-call.
4. **`scripts/measure/` is neither typechecked nor linted**, because there is no
   root tsconfig and `scripts/` belongs to no package — the same gap
   `scripts/demo/*.ts` has. This one imports `apps/api` internals, so a change to
   `BedrockExtractorDeps` breaks it silently until someone runs it. It runs
   correctly today; giving `scripts/` a tsconfig would fix the class, and that is
   a repo-wide call rather than this stage's.
5. **The simulated 2–4 s Processing delay is now fixture-only.** It existed to
   make PROCESSING render for instant fixture data; on staging it was adding
   2–4 s to every real read. The module doc had flagged it as owed "when
   `bedrock` becomes the default", which the S1 flip made true.

Full gate green: typecheck, lint, 1,637 API tests + 30 web files, build,
`terraform fmt`. `infra/envs/staging/services.tf` is comment-only in this diff —
`EXTRACTOR=bedrock` was already set by S1, and its two ⚠ blocks now describe what
is true rather than what was pending.

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
