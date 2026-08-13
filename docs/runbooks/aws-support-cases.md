# Open AWS support cases — status and draft replies

**As of 13 August 2026.** Three cases are open and **all three are "Pending customer action"** — AWS is waiting on us, not the other way round. Nothing here resolves by waiting.

> ⚠ **`sesv2 get-account` reports `ReviewDetails.Status = "DENIED"` for the SES case.** That is not a refusal. SES marks production access denied while the review is open; the case itself is pending our reply. Anyone reading only the API concludes there is nothing to do, and the opposite is true.

| Case | Subject | Status | Blocks |
|---|---|---|---|
| `178662887400793` | SES production access, eu-west-2 | Pending customer action | All outbound email |
| `178662889700456` | Textract `AnalyzeExpense` TPS 1 → 10 | Pending customer action | Extraction throughput at pilot |
| `178662889900075` | Textract `StartExpenseAnalysis` TPS 1 → 10 | Pending customer action | Async extraction (300-page statements) |

**Numbers marked 🔶 are estimates and need Shakib's confirmation before sending.** They are derived below rather than guessed, but no pilot data exists yet and AWS holds you to what you tell them.

---

## Deriving the volume figure (used by both Textract replies)

No document-per-day figure exists in the source-of-truth pair, so it is built from what is stated:

| Input | Value | Source |
|---|---|---|
| Pilot size | 10 practices / businesses | SoT §19.3 (W12–14) |
| Client businesses per practice | **50** | Shakib, 13 Aug |
| Documents per client per month | **50** | Shakib, 13 Aug |
| → Documents per practice per month | 2,500 | |
| → **Pilot total per month** | **25,000** | |
| → Average per calendar day | ~830 | |
| → Average per *working* day (22) | ~1,140 | |

### Why 10 TPS, argued from the SLO rather than from headroom

Average throughput is a weak argument — 830 documents spread over 24 hours is 0.01 TPS and would justify nothing. The quota exists for the burst, and the burst is bounded by a published commitment:

**Governance §13.3 sets extraction p95 < 5 minutes for digital PDFs**, and SoT §4 Stage 2 repeats it as a product promise. That is the number the quota has to satisfy.

- Neoting auto-splits multi-document PDFs as standard (SoT Stage 1). One accountant uploading a month-end batch scan produces **30–100 extraction calls in seconds**, from a single user action.
- Month-end is when this happens, across firms at once. Governance §15.6 sizes the load test as an **ingestion soak at 10× expected volume**.
- A realistic month-end concentration — one practice clearing ~1,000 documents — takes **~17 minutes at the default 1 TPS**, which breaches the 5-minute p95 by more than 3×. At **10 TPS it clears in ~100 seconds**, inside the SLO with room for the other nine firms.

So 10 TPS is not padding: 1 TPS makes the product's own latency commitment unmeetable at pilot scale, and the request is sized to the SLO rather than to the average.

### Cross-check against the approved envelope

Worth running the number back through Appendix B, because it does not come out free.

- Appendix B.1 budgets **~$1,300–1,500/month** for Dec–Feb, "pilot running, real document volume, Bedrock/Textract/SMS meters live", and leaves **~$1,700 (21%) headroom** on the $8,000 pot.
- Prod infrastructure at that stage (Multi-AZ RDS, a real NAT, interface endpoints, more Fargate) is roughly $700–900/month, leaving of the order of **$400–600/month for the metered services**.
- D28's guardrail is **< £0.02 blended AI cost per document**. At 25,000 documents/month that is **£500/month ≈ $640** — **at or slightly above the top of that band.**

**⚠ This is worth knowing before pilot, not after the first invoice.** At 50 clients × 50 documents, metered spend runs roughly $140/month over the modelled figure, which across Dec–Feb eats about **$420 of the $1,700 headroom — a quarter of it** — and that is *if* the £0.02 guardrail holds. It is not a reason to quote AWS a smaller number; it is a reason the guardrail stops being an abstraction. Appendix B says so in its own words: at pilot volume £0.02/document "is the difference between the pot lasting six months and four".

Two consequences, neither of which blocks these replies:
1. The Step 10 cost dashboards need wiring **before** the meters turn on. That is already the runbook's instruction and is now load-bearing.
2. Textract alone is ~25,000 pages/month ≈ **$250/month** at $0.01/page, which matches Appendix B.4 calling it "the dominant per-document cost". The W2 decision on whether the Sonnet-vision middle rung earns its place is worth real money at this volume.

Pages per document is **1** for `AnalyzeExpense` (synchronous, and AWS's own question 3 says so). Bank statements go through `StartExpenseAnalysis`/`StartDocumentAnalysis` asynchronously at up to 300 pages (SoT §4 Stage 2), which is why both quotas were raised together.

---

## Reply 1 — Textract `AnalyzeExpense` (case `178662889700456`)

```
Question 1. Brief description of your use case (e.g., real-time user application, ingestion workflow, batch processing):
Answer 1: Ingestion workflow with an interactive component. Neoting is a document-to-bookkeeping
platform for UK accounting practices. Financial documents (invoices, receipts, credit notes) arrive
by web upload, email, WhatsApp and a mobile upload portal, and are queued for extraction.
AnalyzeExpense is called once per document to extract header fields and line items. Users see a
per-item status while it runs, so latency matters, but the call itself is queue-driven rather than
issued directly from a user request.

Question 2. What is the forecasted number of documents you expect to process each day (24 hours)?
Answer 2: Approximately 830 per 24 hours on average across our initial 10-customer pilot (about
25,000 documents per month; roughly 1,140 per working day). Each customer is an accounting practice
handling around 50 client businesses, each submitting around 50 documents a month.

Volume is heavily concentrated rather than steady. It peaks on the last and first working days of
each month, when practices process their clients' month-end paperwork, and it arrives in bursts
because our product auto-splits multi-document PDFs: one accountant uploading a batch scan can
produce 30-100 extraction calls within seconds.

Question 3. What is the estimated or average number of pages per document sent to Textract?
Answer 3: 1. AnalyzeExpense is used synchronously for single-page invoices and receipts. Multi-page
PDFs are split into single documents before extraction, and multi-page bank statements go through
the asynchronous StartExpenseAnalysis / StartDocumentAnalysis path instead (covered by our separate
case for that quota).

Question 4. What is your forecasted general traffic pattern?
Answer 4: (b) Spiky or Bursty Traffic. Baseline load is low and steady, with pronounced month-end
bursts and intraday spikes when a practice bulk-uploads a batch of scanned documents (our product
auto-splits multi-document PDFs, so one upload can produce 30-100 extraction calls in quick
succession).

Question 5. How long do you need the new service limit value?
Answer 5: (f) Indefinite. This is a production platform, not a migration or backfill.

Question 6. Have you experienced throttling? (Yes / No)
Answer 6: No — we are requesting ahead of launch rather than in response to an incident.

Our own service level for extraction is a p95 under 5 minutes for digital PDFs, which is a published
commitment to our customers. At the default 1 TPS, a single practice clearing a ~1,000-document
month-end batch would take about 17 minutes, breaching that by more than threefold, and a throttled
extraction surfaces to an accountant as a document stuck in processing with no explanation. At 10 TPS
the same batch clears in under two minutes, leaving capacity for the other nine customers.

I ACKNOWLEDGE THAT I AM REQUESTING A QUOTA INCREASE AND THAT THE INFORMATION PROVIDED ABOVE IS ACCURATE.
```

## Reply 2 — Textract `StartExpenseAnalysis` (case `178662889900075`)

Identical except answers 1 and 3:

```
Answer 1: Asynchronous ingestion workflow. Same platform as our AnalyzeExpense request. This quota
covers multi-page documents — principally bank statements and supplier statements — which are
submitted asynchronously and polled for completion.

Answer 3: Bank statements average approximately 🔶 8-12 pages, with an upper bound of 300 pages
(our product's documented limit). Supplier statements are typically 1-5 pages.
```

---

## Reply 3 — SES production access (case `178662887400793`)

AWS asked specifically about sending frequency, recipient-list maintenance, and bounce, complaint and unsubscribe handling.

> ⚠ **One correction to make before sending.** The original submission listed *"client onboarding invitations"* as an email type. That is wrong and worth fixing rather than repeating: client onboarding is **SMS-only** (SoT §6, D16 — clients receive an SMS with an OTP link and never need an app or an email account). Emailing a claim that is inaccurate to a reviewer whose whole job is assessing whether you understand your own sending is a bad trade for one bullet point.

```
Thank you — further detail below.

WHO WE SEND TO, AND HOW THEY GET ON THE LIST

Neoting is operated by NEOVOGENT AI SOLUTIONS UK LTD (UK company 15946429). We send only to two
groups, and neither is ever imported from a purchased or third-party list:

1. Our own registered users — staff at the UK accounting practices that subscribe to the product.
   They are added by an authenticated administrator inside the product and verify their address
   before receiving anything other than their initial invitation.
2. Suppliers nominated by those customers. When a customer's supplier statement shows a missing
   invoice, the product emails that supplier to request the paperwork. The address comes from the
   customer's own accounting records, entered or confirmed by the customer.

We do not send to consumers, and we do not send to any address a customer has not supplied.

WHAT WE SEND, AND HOW OFTEN

All transactional, no marketing of any kind:
 - Supplier paperwork requests (a specific missing invoice, named)
 - Processing and publish-failure notifications to the accountant who owns the item
 - Team invitations and security notifications (sign-in, permission change)

Frequency is driven entirely by customer activity and concentrated around month-end. For scale: the
10-customer pilot processes roughly 25,000 financial documents a month, and only a small fraction of
those generate an email — a failure to notify about, or a supplier who needs chasing for a missing
invoice. Expected volume is comfortably under 1,000 messages per day, and we would rather be held to
that ceiling than to an optimistic one.

Worth stating explicitly: our client-chasing feature is SMS-only by design, not email. That is the
highest-volume messaging path in the product and it does not touch SES.

BOUNCES, COMPLAINTS AND UNSUBSCRIBES

 - A configuration set (nt-staging-default) is attached to the sending identity with an SNS event
   destination for BOUNCE, COMPLAINT, REJECT, RENDERING_FAILURE and DELIVERY_DELAY.
 - Account-level and configuration-set suppression are enabled for BOUNCE and COMPLAINT, so a
   bounced or complained-about address is suppressed automatically and not retried.
 - Complaints are treated as a stop signal for that recipient and are reviewed by us, not just
   suppressed silently.
 - Every message identifies the sender, names the customer it is sent on behalf of, and carries a
   support contact. Recipients who do not want further messages are removed at their request, and
   suppliers can decline without contacting us by simply not responding — we do not re-send
   indefinitely.
 - Delivery is TLS-required (tls_policy = REQUIRE) and reputation metrics are enabled.

AUTHENTICATION

The sending domain is verified with DKIM (RSA 2048), a custom MAIL FROM subdomain so SPF aligns,
and a DMARC record. All of it is managed in Terraform rather than by hand.

Region is eu-west-2 (London); we are a UK company processing UK customers' data and our data
residency commitment is UK-only.
```

---

## After they are answered

- Update `infra/envs/staging/email.tf` — the status comment there is the thing engineers will read.
- Update `docs/adr/0002-*` consequence 5.
- Write **ADR 0003** (Textract quotas + per-page pricing at pilot volume). It is listed in runbook §12.2 and is blocked precisely on these cases closing — with the granted numbers in hand it becomes writable.
- Verification 8.4 closes when the quotas are actually granted, not when the case is replied to.
