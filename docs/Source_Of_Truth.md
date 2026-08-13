# NEOTING — Product & Technical Source of Truth

**Version 1.4 · 13 August 2026 · Confidential**
*Changelog v1.0 → v1.1: locked the AI vendor layer (D19–D22: Textract, Opus-led with effort map, Bedrock route, Transcribe), infrastructure hosting (D23), observability (D24), WhatsApp route (D25), billing deferral (D26), SMS allowance working default (D27); cost guardrail revised £0.02 → £0.05/document; W2 milestone changed from bake-off to calibration.*
*Changelog v1.1 → v1.2: D28 supersedes D21 — three-tier model strategy (Haiku mechanical · Sonnet workhorse · Opus judgment) with dynamic effort per task class; extraction vision escalation ladder; per-class tier flags; cost guardrail restored to £0.02/document (pipeline), chat under per-firm budgets.*
*Changelog v1.2 → v1.3: kickoff-review feedback (11–12 Aug) folded in — D29 locks kickoff = 13 Aug 2026 and ratifies the bootstrap G-log by reference; D30 UK-first data residency made explicit; D31 support & SLA framework; D32 self-serve offboarding incl. trial end; D33 central third-party cost & usage monitoring; new §13.3 orientation/transparency design mandates; §21 gains the surprise-bill risk row; §22 open decision #1 marked decided.*
*Changelog v1.3 → v1.4: W0 execution findings folded in (13 Aug, all measured in eu-west-2, not assumed) — **D28 model IDs amended** after Bedrock verification (judgment Opus 4.6, mechanical Nova Lite; tier structure, effort map and eval gates unchanged) so that **D30 survives intact**; **D30's SES fallback retired** — verification 8.2 found inbound receiving available in-region, leaving one named exception (the DR backup target); D34 legal entity named; D35 AWS spend envelope; D36 AWS account topology and its compensating controls; §15/§18 per-workspace-KMS wording corrected to what S3 can actually enforce; §16 model names and cost composition updated; §17.2 Bedrock row updated; §21 gains the shared-account risk row; §22 open decisions #2 and #4 marked decided.*
Product: **Neoting**, by Neovogent. Pre-launch domain `neoting.neovogent.com`; production domain `neoting.com` at publish.

---

## 0. Document authority

This document and its companion, **NEOTING-Engineering-Governance-v1.4.md**, are together the **only source of truth** for the product. They are self-contained: nothing outside this pair is required to build, review, or accept the product.

**Superseded documents** (retained for history only; where they conflict with this pair, this pair wins):
- *AI Accounting Operations Platform PRD v2 — Document Workflow Edition* (11 Aug 2026) — absorbed here as the product definition.
- *Neovogent PRD v1.0* (9 Aug 2026) — superseded. Its tech stack, design system, build model, and validator engineering are carried forward; its product scope (internal ledger, financial reports, payroll reimbursement, CRM, company-buyer model) is **not** in this product.
- *Technical Implementation Plan — Abdullah M. Nazif* (10 Aug 2026) — absorbed, minus the mobile app.
- The engineering docs pack (`CLAUDE.md`, `architecture.md`, `security.md`, `ai-runtime.md`, `compliance.md`, `operations.md`) — rewritten as the companion governance file.
- *Morphic Surface concept* — its calm-by-default and gated-approval principles survive inside the chat UI rules (§8); the rest is not adopted.

**Conflict rule within the pair:** this file wins on product scope and requirements; the governance file wins on engineering rules, security enforcement, and process.

## 0.1 Decision log (locked — do not re-open without a versioned amendment)

| # | Decision |
|---|---|
| D1 | Product = the Document Workflow Edition scope: a practice-first document-to-bookkeeping pipeline. The internal double-entry ledger, all financial statements/reports, and pricing design are **dropped**. The client's accounting software remains the ledger of record. |
| D2 | Stack = the NestJS modular-monolith plan (§15), minus the mobile app. |
| D3 | **Fully app-free.** No native mobile apps in v1. Accountant surface = responsive web (works in mobile browsers). Client surface = SMS + OTP links, WhatsApp inbound, email. Native apps are deferred, not planned. |
| D4 | Bank data: **TrueLayer only.** No second provider is planned. The integration sits behind a provider-agnostic interface as an engineering hedge, and statement upload (PDF/CSV/XLSX) is the universal fallback, but TrueLayer is the sole feed commitment. |
| D5 | Brand: product **Neoting**, company Neovogent. Domain `neoting.neovogent.com` now, `neoting.com` at publish. Platform intake address `doc@neoting.com` (production) / `doc@neoting.neovogent.com` (pre-launch); both route identically through the cutover. SMS sender ID: `Neoting`. Design system = the Neovogent identity (§14). |
| D6 | Ledger adapters: **Xero + QuickBooks Online in v1; Sage Accounting + FreeAgent in v1.1.** No further adapters planned; everything else reaches the product through export or the public API. |
| D7 | Auth: TOTP 2FA ships in v1 (mandatory for privileged roles); SSO (Microsoft Entra ID, Okta) ships in v1.1. |
| D8 | Vault cloud sync (Dropbox / Google Drive / OneDrive) ships in v1.1. Vault core ships in v1. |
| D9 | A public Zapier app is a v1.x fast-follow built on the v1 public API. |
| D10 | API: REST under `/v1`, RFC 7807 `problem+json` errors, stable `NT-` error codes, cursor pagination, `Idempotency-Key` on all mutations. |
| D11 | ORM: Prisma inside NestJS services. Postgres row-level security enforced via per-transaction session GUCs (governance §5). |
| D12 | Compliance frame: **UK GDPR primary** (ICO registration, DPIA before real data). AI transparency, human oversight, and record-keeping standards are enforced as design requirements regardless of jurisdiction. |
| D13 | Timeline is week-relative (W0–W14). Kickoff date is an open decision (§22); every milestone slides with it. |
| D14 | Voice: push-to-talk speech-to-text behind a provider interface; the visible transcript must be confirmed by the user before any command executes. Voice can never approve anything (§9). |
| D15 | Sprint-0 contracts treated as law: the OpenAPI spec, the DB schema + RLS policies, the design tokens, and the **chat component grammar** (including the Review → Approve primitive), plus a versioned deterministic-validator config. |
| D16 | Chasing **clients** is SMS-only. Chasing **suppliers** (statement gaps) is email. WhatsApp is inbound-only, always. Chasing is never done over WhatsApp or client email. |
| D17 | Line-item extraction is standard on every document — never a metered add-on. |
| D18 | Every state-changing action in the product passes the universal Review → Approve pattern (§8.2). Read-only queries execute instantly. |
| D19 | **No first-party AI training or fine-tuning in v1.** All models are third party under governance: no-training DPAs, UK/EU processing. The product's "learning loop" = deterministic per-supplier rules + guidance text + anonymised/synthetic eval data — never model weights. |
| D20 | Extraction = **Amazon Textract (eu-west-2)** — `AnalyzeExpense` for invoices/receipts (header + line items), `AnalyzeDocument` tables/queries for statements — as the committed primary, behind the retained `DocumentExtractor` interface, with a **Claude vision fallback lane** for below-threshold/messy documents. W2 becomes threshold **calibration** on the labelled corpus, not a vendor bake-off. |
| D21 | *(v1.1)* Opus 4.8 as sole primary LLM with Haiku triage; guardrail £0.05/document. **Superseded by D28 in v1.2.** |
| D22 | Model access route: **Claude via Amazon Bedrock, eu-west-2** (single cloud, IAM auth, residency). W0 verification: Opus 4.8 + effort parameter availability in eu-west-2 Bedrock; contingency = Anthropic API with EU processing terms, decision logged. **STT = Amazon Transcribe streaming (eu-west-2, en-GB).** **· Verification closed 13 Aug 2026:** the Bedrock route holds and the Anthropic-API contingency was not triggered; the models it named changed instead (D28 as amended). Also measured: **Opus 4.8 rejects the `temperature` parameter outright**, so "temperature 0" is a per-family instruction, not a universal one — governance §9.1 to be reworded accordingly. |
| D23 | Hosting: **ECS Fargate** (api, web, workers) behind **CloudFront + AWS WAF** (tightest rules on the public OTP portal); **ElastiCache Redis** (BullMQ + cache); RDS Postgres 16; S3/KMS; **self-hosted Unleash**; all eu-west-2, all Terraform. |
| D24 | Observability: OpenTelemetry → **Amazon Managed Prometheus + Managed Grafana**; CloudWatch logs; **Sentry (EU region)** for errors. |
| D25 | WhatsApp intake via **direct Meta Cloud API** (inbound service messages are free — fits inbound-only) on a **dedicated UK virtual number**; Twilio-hosted WhatsApp is contingency only if Meta verification stalls. |
| D26 | SaaS billing is **deferred**: the pilot is free/manually invoiced; Stripe (or equivalent) is evaluated when pricing lands. Nothing in v1 blocks on a billing system. |
| D27 | SMS allowance working default: **200 SMS/firm/month included, warn at 80%**, overage metered — a placeholder the pricing owner (CEO) confirms. |
| D28 | **Three-tier model strategy + dynamic effort (supersedes D21).** **Haiku 4.5** = mechanical tier: doc-type triage, addressee shortlisting, dedupe text-assist. **Sonnet 4.6** = volume workhorse: per-document coding suggestions (the cost lever), chase composition + validation, addressee escalation, vault summaries, first vision rung. **Opus 4.8** = judgment tier: the chat workspace (always — one model, one voice), NL rule parsing + conflict resolution, cross-client analysis, final vision rung. Effort/thinking budget set per task class where the model supports it; full task→(model, effort) map pinned in `models.ts`. **Extraction vision escalation ladder:** Textract → Sonnet-vision → Opus-vision → human, each rung firing only below threshold; the middle rung is kept only if W2 calibration proves it earns its cost. **Per-class tier flags** (up or down, blocked unless evals pass for that class-model pair) replace the single demotion flag; **judgment surfaces are exempt from cost-driven demotion**. Availability degradation walks one tier down and bottoms out in deterministic behaviour + human queues — never a worse guess. **Cost guardrail restored to < £0.02 blended per document (pipeline);** chat-workspace spend is governed by per-firm daily budgets, not the per-document figure. **· Model IDs amended 13 Aug 2026 (ADR 0001, verification 8.1):** measurement found Opus 4.8 and Haiku 4.5 reachable in eu-west-2 **only via `eu.*` cross-region inference profiles**, which process outside the UK and are not a D30 named fallback. The tiers are therefore **judgment = `anthropic.claude-opus-4-6-v1` · workhorse = `anthropic.claude-sonnet-4-6` · mechanical = `amazon.nova-lite-v1:0`**, all in-region on-demand. **Everything else in this decision stands unchanged** — three tiers, dynamic effort, per-class flags gated on evals, judgment surfaces exempt from cost-driven demotion, degradation to deterministic behaviour rather than a worse guess. Enforcement is structural: the application role may invoke only region-pinned eu-west-2 model ARNs and **no inference-profile ARN is granted**, so a cross-region call fails closed. Honest caveat: Opus 4.6 is a generation behind 4.8 and the chat workspace is where accountant trust is won — W2 measures it, and a shortfall reopens this decision rather than being absorbed silently. |
| D29 | **Kickoff = Thursday 13 August 2026** (resolves §22 open decision #1; folded from the Sprint 1 Execution Plan v1.0). All W0–W14 milestones restate from this date. The bootstrap **G-log (Team Engineering Guideline §0, G1–G10)** is ratified into this log by reference — bootstrap-phase rules that expire at Infra Week per G8. |
| D30 | **UK-first data residency.** All storage and processing in eu-west-2 (London). The UK is not the EU and is regulated in its own right (UK GDPR / ICO); EU regions are permitted only as **named fallbacks where no UK option exists** — currently two: SES inbound receiving in eu-west-1, only if W0 verification 8.2 requires it (receipt bucket stays eu-west-2), and the cross-region DR backup target (the UK has a single AWS region, so the second region is EU by necessity). Any further non-UK location is a versioned amendment, never a config change. **· Amended 13 Aug 2026 (verification 8.2):** SES inbound receiving **is** available in eu-west-2, so that fallback is **retired unused** — the entire email path stays in London. **One named exception remains: the cross-region DR backup target.** D28's model IDs were amended rather than this decision, because a residency promise to accountants handling their clients' financial records outranks a model version. |
| D31 | **Support & SLA framework.** Pilot: published severity response targets, UK-working-hours cover with SEV1 monitored out-of-hours, status page + `support@` inbox — all stated in the pilot agreement (working defaults in §18; CEO confirms before pilot agreements sign). GA: contractual SLA — 99.9% monthly availability with service credits, published maintenance windows, support tiers in the ToS — always set at or below the internal SLOs (governance §13.3). |
| D32 | **Self-serve offboarding, no tickets.** Whole-firm export (documents + data + index manifest) and erasure are in-product, self-serve actions — at any time, at trial end, and throughout the 90-day post-termination window — never gated on a support ticket. Extends D26: when billing/trials land, the trial-expiry screen leads with export/delete, not a paywall. |
| D33 | **Central third-party usage & cost monitoring.** Every metered service — Bedrock, Textract, Transcribe, Twilio, SES, TrueLayer, and the AWS accounts themselves — reports usage and computed spend to one telemetry surface with per-service budgets and alerts (enforcement: governance §13.5). No paid service goes live without a budget line, a usage metric, and an alert. |
| D34 | **Legal entity = NEOVOGENT AI SOLUTIONS UK LTD** (England & Wales, company no. **15946429**, incorporated 10 Sep 2024; registered office Suite 5, The Cloisters, 11–12 George Road, Edgbaston, Birmingham B15 1NP). This exact name signs every contract in the Kickoff list — AWS and its DPA, ICO registration, TrueLayer, Twilio, Meta, Sentry, and the pilot agreements — and appears on the AWS billing account. Being UK-incorporated, **no UK GDPR Art. 27 representative is required** (resolves §22 open decision #4). Housekeeping consequence: the confirmation statement is due 23 Sep 2026, and a lapsed filing surfaces in TrueLayer's compliance review. |
| D35 | **AWS spend envelope: $8,000 across six months** (13 Aug 2026 → ~13 Feb 2027), approved at kickoff — the money half of §22 open decision #2. The burn is deliberately uneven: staging alone runs ~$150/month through W8, and the squeeze is the pilot months when production carries real document volume. Enforced by AWS Budgets at org and per-account level (50/80/100% actual, 100% forecast) plus a cumulative tracker for the pot, all with credits **excluded** from the tracked figure so alerts fire on real consumption. Consequence for D28: the **< £0.02 per document** guardrail stops being an abstraction at pilot volume — it is the difference between the envelope lasting six months and four. |
| D36 | **AWS account topology: shared now, isolated when the payer allows.** Neoting runs inside the existing Neovogent account `252959251643`, a member of a **consolidated-billing** organisation whose management account belongs to the reseller (Cloudvisor). Two consequences follow and both are accepted knowingly: **(a) Service Control Policies are unavailable** in a consolidated-billing organisation, so D30's region guardrail is enforced by an IAM policy attached to every Neoting principal — real, but removable by an account admin, where an SCP would not be; **(b) the account also hosts unrelated Neovogent products**, so six other administrators exist alongside us. Compensating controls: dedicated KMS key and buckets whose policies carry an **explicit Deny** for any principal outside `role/nt-*`, an organisation CloudTrail and GuardDuty that did not previously exist in the account, and everything defined in Terraform so that moving to dedicated accounts is a variable change rather than a rebuild. **This is mitigation, not isolation — the DPIA must describe the account as shared** until dedicated `neoting-dev/staging/prod` accounts (requested from the payer at kickoff) are provisioned. |

---

## 1. What Neoting is

Neoting is a **chat-first document-to-bookkeeping platform** for accounting practices and businesses. It collects financial documents through every practical channel, extracts the data, applies rules and AI, detects duplicates, matches against bank transactions, chases clients for missing evidence, runs approvals, and publishes clean coded data — with the original document attached — into the client's accounting software (Xero, QuickBooks Online; Sage Accounting and FreeAgent in v1.1) or exports it. Every pipeline action can be driven from a conversational AI workspace that renders real interface components, with a conventional sidebar as the always-available fallback.

**The product boundary:** Neoting prepares high-quality accounting data and evidence, then publishes or exports it. The accounting software remains the ledger. Neoting does **not** generate financial statements, management accounts, P&L, balance sheets, trial balances, or any financial reports. It stores transactions, matches, and coding — never books of record.

**One breath:** a receipt arrives by photo, email, WhatsApp, or upload; Neoting reads it (header + line items + confidence per field), codes it against the client's own chart of accounts using rules and AI guidance, flags duplicates, matches it to the bank feed, notices what's *missing* and chases the client by SMS with a secure no-app upload link, routes it through approvals, and publishes it to Xero or QuickBooks with the source image attached — with the accountant driving all of it from chat, and nothing changing state without a human opening a review and pressing Approve.

**Differentiation (each grounded in verified competitor evidence):**
1. **Chat-first control.** Incumbent tooling is menu-diving with a dated GUI users call "complicated to remember where things are." Every pipeline action here is drivable from a chat box that renders forms, tables, and action cards — with the sidebar guaranteeing nothing is discoverable only by prompt.
2. **Chasing that needs no app.** The market leader can only send paperwork requests to users who installed its mobile app; otherwise the accountant exports a CSV list and chases by hand. Neoting chases by SMS with an OTP-secured upload link that works in any phone browser.
3. **Editable extraction at the point of upload.** Every extracted number and name in the secure-link portal is clickable and instantly correctable — bad photos get fixed in the same session instead of bouncing back.
4. **The competitor's own most-voted backlog, shipped** (§13.2): rejected-items visibility (337 votes), credit-note bank matching (266), multiple rules per supplier (262), mandatory fields before publishing (187), moving documents between entities (73), PDF auto-splitting (46), and more.

---

## 2. Scope

| ✅ IN SCOPE (v1 unless marked v1.1) | ❌ OUT — dropped or deferred |
|---|---|
| Document capture: web drag-drop, single platform email address, SMS secure link, WhatsApp inbound, mobile-web camera via the OTP portal, CSV/XLSX structured import | **Financial statement / report preparation of any kind — DROPPED.** No P&L, balance sheet, cash flow, trial balance, management accounts, or "generate any financial doc from a command." |
| Extraction: header + line items (standard); bank-statement extraction (PDF→rows); supplier-statement extraction | **Internal double-entry ledger as book of record — DROPPED.** We store transactions, matches, and coding; the ledger stays in the accounting software. |
| Costs & Sales inboxes with Processing / To Review / Ready states + a first-class Rejected/Failed view | **Pricing & packaging — omitted.** Owner: CEO, with pilot data. |
| Rules engine (four-tier priority) + auto-categorisation + AI suggestions with confidence & explanations | **E-commerce sales connections (Square/eBay/Etsy/Shopify/PayPal/WooCommerce/Amazon) — rejected, not deferred.** Online sellers' documents arrive through the normal channels. |
| Duplicate detection (field-rule parity + multi-signal) | Supplier portal fetch robots — **deferred** (design failure-transparency first when built). |
| Bank feeds (TrueLayer) + Bank Match + missing-paperwork detection | Payments / money movement — deferred. |
| Client chasing: SMS-only + OTP secure links, reminders, escalation, per-item messaging | HMRC MTD filing (VAT / Income Tax submissions) — deferred. |
| Approvals (parity + conditional branching) | Ledger-health / data-quality analytics — deferred; only document-pipeline analytics ship. |
| Publish to accounting software; export CSV / custom CSV / XLSX / PDF / ZIP; Archive | Mileage & GPS — deferred. |
| Client management, team & roles, Vault (core v1; cloud sync v1.1), operational analytics, settings | Native mobile apps — deferred (D3). |
| Chat-first UI + voice commands **for this workflow only** | Desktop-ledger bridges (Sage 50 desktop, QuickBooks Desktop) and enterprise ERP adapters (Dynamics, NetSuite, SAP) — deferred. |
| Public API + webhooks (v1); Zapier app (v1.x) | |

**The scope fence is the contract: a feature not listed in v1 is not in v1.**

---

## 3. Users and roles

### 3.1 Accounting practice
Registers with: practice name, logo, country of registration, base currency, language, registered address, VAT registration and tax-reporting details, year-end date. Manages many client businesses. Full team management (§7).

### 3.2 Standalone business
One company using the product directly: same pipeline, no clients/team layer. The AI runs the reminder and chasing schedule itself (e.g. "chase employees for missing receipts after 48 hours") using the same policy engine, self-configurable in chat.

### 3.3 Role model
Three tiers on each side:
- **Practice side:** Practice Admin (everything) · Client Admin (all clients, no practice-subscription control) · Standard User (assigned clients only; optional permissions: add clients).
- **Business side:** Business Admin · User Admin (documents + most settings, can manage the accountant connection) · Standard User (own items only; optional permissions: access all documents, publishing rights).
- Every account has an owner who cannot be deactivated. Roles are always set per account.

Beyond the tiers:
- **Per-permission toggles:** publish, approve, chase, connect bank, export, delete — grantable independently of tier.
- **Role-based field hiding** for non-finance submitters (they see their submission, not the coding).
- **Phone-number-only contacts:** client-side people who exist only as verified mobile numbers. They can receive chases and upload through OTP links without ever being provisioned as users. Durable identity is an internal immutable user ID (numbers change and get recycled); email + optional passkey are secondary factors.
- People without login access can still submit via email/WhatsApp and are recorded as Document Owners.

---

## 4. The core document pipeline

This is the product. Everything else in this document exists to serve these eleven stages:

**1 Ingest → 2 Process & Extract → 3 Rules & Automation → 4 AI Suggestions → 5 Validate → 6 Deduplicate → 7 Bank Match → 8 Detect Missing Evidence & Chase → 9 Approve → 10 Publish / Export → 11 Archive**

### Stage 1 — Ingest

**Channels (v1):**
1. **Web upload + drag-drop** with three modes — one document per file, one document per page, and **automatic multi-document splitting as standard** (competitors' users report "hours of staff time each week" splitting 30–100-page PDFs; auto-split had 46 backlog votes there).
2. **One single email address for the whole platform: `doc@neoting.com`** (pre-launch `doc@neoting.neovogent.com`). Clients, employees, and suppliers all forward documents to the same address. Routing happens server-side, in order:
   1. **Sender identity** — the from-address is matched against registered contacts (client users, employee submitters, practice staff, known supplier addresses per client). One match → routed straight to that client's inbox; sender recorded as Document Owner.
   2. **AI addressee detection** — if the sender maps to multiple companies or is unknown (e.g. a supplier emailing directly), the AI reads the document's bill-to/addressee name and matches it to a client workspace, with a confidence score.
   3. **Unrouted queue** — anything still ambiguous lands in a visible "Unrouted documents" queue (never silently dropped), where the accountant assigns it in one click and can teach the router ("always route this sender to American Burger").
   - Costs vs Sales needs no special address: AI document classification (purchase invoice vs sales invoice vs statement) routes items to the right inbox automatically. Email body text becomes the description. Multi-document attachments auto-split.
3. **SMS secure upload link** (Stage 8 / §6) — the channel no competitor has.
4. **WhatsApp intake** via the WhatsApp Business Platform. **Inbound-only by design:** the client sends a document to the registered Neoting WhatsApp number; the sender's number is auto-mapped to their client/user profile; multi-company senders get an in-chat "Which company?" prompt; the message caption becomes the description; the document runs the normal pipeline with the sender as Document Owner. We never chase over WhatsApp — this also sidesteps Meta's approved-template requirement and per-message fees for business-initiated messages entirely.
5. **CSV/XLSX structured import** (competitors cannot extract spreadsheets — 55 backlog votes; their users convert CSV invoices to PDF first).
6. A **web-upload description field** (160-vote gap: mobile parity for descriptions).

**File formats & size limits (asymmetric by design):** accepted everywhere — JPG, PNG, GIF, BMP, TIFF, HEIC, PDF, DOC/DOCX, ODT, RTF, ZIP — plus CSV/XLSX as structured imports. Password-protected files and link-only emails are rejected **with a visible reason** in the Rejected/Failed view, never silently.

| Channel | Per-file limit | Rationale |
|---|---|---|
| Client channels — chat upload, SMS secure link, WhatsApp, email to `doc@` | **25 MB** | Covers ~99% of client submissions; email caps near this anyway; fast on mobile data. Beats the incumbent's 6 MB cap that rejects modern phone photos. |
| Accountant web upload (batches, ZIP) | **100 MB** | Accountants own the 30–100-page batch scans; auto-split handles the contents. |
| Bank statements | **50 MB / 300 pages** | Market parity. |
| Vault | **100 MB** | Contracts and long agreements. |

Oversize handling is graceful: photos are **compressed client-side in the browser before upload** (a 15 MB photo becomes ~3 MB, so the 25 MB cap is effectively never hit by a camera); oversized PDFs get a clear message plus a pointer to web upload and auto-splitting; every rejection is visible with a reason.

**Ingest record (immutable, per document):** source channel, submitter identity, received-at (UTC + local), original filename, byte hash, client workspace, routing decision + confidence. Sanitisation before anything else: virus scan, MIME sniffing (never trust extensions), EXIF orientation + HEIC→JPEG normalisation, PDF safety (flatten JS, detach embedded files), ZIP explode with depth/size caps. Failures quarantine with an operator alert and a plain-language message to the submitter.

### Stage 2 — Process & Extract

**Field set (header):** document type (invoice / receipt / credit note / statement / other) · document date · due date · supplier (Costs) or customer (Sales) · currency · purchase-order number · total · tax amount · **VAT number, validated against HMRC's check-VAT-number API** (UK Costs) · invoice/reference number · payment method incl. last-4 card digits · category (via rules/AI) · project and description · **supplier bank details from invoices** (167-vote gap; also powers fraud checks).

**Line items are standard on every document (D17):** per-line description, total, tax amount, quantity. This is the #1 competitive displacement lever — accountants leave incumbents specifically because line items are a metered add-on there.

**Every extracted field carries confidence + provenance** (which pixels / which rule / which model produced it). This powers the editable-OCR overlay (Stage 8), review prioritisation, and the audit trail.

**Deterministic validators (non-AI, run on every extraction):**

| Check | Rule |
|---|---|
| VAT arithmetic | net + tax = gross within ±1p rounding; line items sum to totals; tax amount consistent with implied rate |
| VAT number | GB format + checksum, then HMRC check-VAT-number API |
| Dates | plausibility (not future, not >7 years old); UK d/m/y disambiguation; document date vs due date ordering |
| Currency | symbol vs ISO code agreement; **currency locked to document evidence with change-alerts** (fixes the "USD bill flips to GBP" failure class) |
| Payment | last-4 format |

**Bank-statement extraction:** PDF/TIFF ≤ 50 MB / ≤ 300 pages; digital PDFs in minutes, scans best-effort with a visible per-item ETA; rows land in Bank → Transactions; CSV download of extracted rows; **statement-gap detection** by comparing opening/closing balances and date continuity.

**Supplier-statement extraction:** header (supplier, statement end date, outstanding balance) + up to 2,000 lines; lines matched by supplier + document reference, falling back to amount + date + supplier; line statuses: *In ledger & Neoting / In ledger only / Neoting only / Missing / Not on statement*; "Request paperwork" **emails the supplier** for missing invoices (D16).

**Expected-recurring-document detection:** "Adobe invoices arrive monthly; August's is missing" — feeds Stage 8.

**Speed:** **p95 under 5 minutes for digital PDFs**, with a **manual-entry bypass** always available while OCR runs (incumbent users report 5- and 24-hour waits with no way to type the data themselves). Sales-side parsing must handle platform payout emails (Just Eat / Deliveroo / Uber Eats) that incumbents fail on.

### Stage 3 — Rules & Automation

**Four-tier priority when rules collide on the same field (battle-tested; accountants already reason in it):**
**1) User rules → 2) Payment-method rules → 3) Supplier/Customer rules → 4) Account defaults.**
Rules run after extraction and only affect items submitted after the rule exists, unless retro-applied.

- **Supplier/Customer rules** set: category, tax rate, payment method, currency, description, due date, paid/unpaid status, publish-to destination, auto-publish, workflow notes. Smart-split and line-item behaviour hang off supplier rules.
- **Payment-method rules** set: auto-publish, publish-to, bank account.
- **User rules** set: default payment method (always / if-blank / never) and project per uploader.
- Auto-categorisation (learned from the client's past coding, Costs) fills Category only when no higher rule set it; description/project suggestions never override rules. **Approval workflows and payment-method rules override every auto-publish setting.**

**Extensions beyond parity:**
- **Multiple conditional rules per supplier** (262-vote gap): e.g. "Amazon & total > £500 → flag for fixed-asset review; Amazon otherwise → Office Supplies." Conditions on amount, line-item keywords, document type, uploader, project.
- **Rules described in natural language — typed or spoken — and set up by the AI.** "Whenever Adobe arrives, code it Software, 20% VAT, auto-publish" (or several dictated at once). The AI parses the utterance into structured rule(s) — supplier/customer, conditions, fields set, priority tier — rendered as **rule cards following the universal Review → Approve pattern (§8.2)**. No rule ever activates from unconfirmed speech or an unopened review. Ambiguity triggers a clarifying question; conflicts with existing rules surface on the card ("this overlaps your existing Amazon rule — replace, keep both with conditions, or cancel?").
- Every accountant correction offers **one-tap rule creation** ("Apply this to future Google Ads items? Yes / only this client / no").
- **Retro-apply toggle** ("apply to all inbox items") at parity.

### Stage 4 — AI Suggestions

The guidance architecture, because this control model is what makes AI trustworthy to accountants:

- **Natural-language guidance rules** with per-rule **Manual-review or Auto-apply** modes, at two levels: per-account, and **practice-level Core/Shared guidance** distributed across clients. Guidance history logs who changed what.
- Suggests category, tax treatment, description, payment method; flags personal expenses and questionable VAT; creates, updates, groups, and splits line items; can auto-publish within guidance criteria (**approvals still override**); reads email bodies from email-in. Context-aware (fuel vs coffee from the same Shell).
- **Coverage includes the Bank workspace from day one** — matching, unexplained transactions, and missing-paperwork triage — exactly where the incumbent's AI is absent.
- Every suggestion carries **confidence, reasoning, evidence, and the guidance/rule that produced it** (visible marker + hover explanation; accept / dismiss / auto-apply).
- **Authority order is absolute: accountant rules → practice defaults → client context → learned history → AI inference.** The AI never silently overrides an explicit rule.
- **New-vendor cold start** (the industry's 20–25% correction band) is attacked with the business-context questionnaire from onboarding (§6) + web-lookup of unknown supplier names before guessing a category.

### Stage 5 — Validate: To Review / Ready

Three inbox states, plus the failure surface incumbents lack:

- **In Processing** — extraction running, per-item ETA shown, manual-entry bypass available.
- **To Review** — something missing or suspect: missing Category, Supplier, or Total; line-item discrepancies; suspected duplicates; validator failures; low-confidence fields (highlighted on the image for one-glance correction).
- **Ready** — all checks passed; requires at minimum **Total + Supplier + Category**. Green = good; **Yellow Ready = a previous publish failed** (retryable). Optional split of the inbox into separate To Review / Ready tabs. Items missing required fields cannot publish.

**Extensions:**
- **Configurable mandatory fields before publish** (187-vote gap, e.g. project/class/customer/VAT treatment required per client or per category — construction firms require vehicle/class; QBO users require Class).
- A first-class **Rejected / Failed items view** (337 votes — the incumbent's single most-requested feature): every publish failure, extraction failure, ingest rejection, and dismissed chase lands somewhere visible **with a reason and a retry action**, instead of vanishing.
- **Publish-failure and extraction-failure notifications** (failures are currently silent in the market).

**Confidence gating (config, per field, eval-calibrated — starting values):** ≥ 0.92 on all critical fields → Ready pre-filled; 0.65–0.92 or any validator failure → To Review with uncertain fields highlighted; < 0.65 on supplier/date/total → extraction-failed path (provenance kept, submitter asked to retake/re-send via their channel, manual transcription always possible and marked *keyed by [name]*). Thresholds are set from eval measurements, never from model self-reports (governance §9).

### Stage 6 — Deduplicate

**Baseline field rules (market parity):**
- Receipts: duplicate when **Supplier + Date + Total + Document Owner** all match.
- Invoices/credit notes: duplicate when **Supplier + Total + Document reference** all match.
- Bank-transaction duplicate check: Contact + Date ± 5 days (configurable ± 3–31) + Value.

**Three admin modes:** Automatic (remove on sight, recoverable) · Review (amber flag, side-by-side compare: delete / attach image to original / confirm-different) · Off.

**Multi-signal augmentation (fixes the known failure classes):**
- **File byte hash** (exact re-send) + **perceptual image hash** (same paper photographed twice, cropped or rotated) + **OCR-text similarity** + amount/date proximity — so a duplicate is still caught when a key field failed to extract on one copy.
- **Cross-document-type matching** — invoice ↔ receipt ↔ credit note recognised as the same transaction (120-vote merge gap).
- **Cross-uploader coverage** — two people submitting one dinner is caught.
- An explicit **"Keep both — intentional duplicate"** action (legitimate duplicates are currently impossible to force through).
- A **similarity score on every flag**.

### Stage 7 — Bank Match

**Feeds:** TrueLayer only (D4) — regulated read-only AIS; no screen-scraping; bank credentials never stored. ~98% UK coverage including business accounts. Historical import 12–24 months where the bank allows. **Consent lifecycle:** in-app reconfirmation every 90 days — one-tap prompt from day 80 (web + email), stale-feed banner on lapse, data access stops until reconfirmed. Every consent event (granted, reconfirmed, lapsed, revoked) is audit-logged and visible. The consent module is isolated so UK payments-law changes are config, not surgery. **Fallback that always works:** statement upload (PDF extraction, CSV/XLSX with saved mapping templates) — books never stall.

**Normalised transaction schema (provider-agnostic):** `transaction_id · account_id · timestamp (booked/pending) · amount (signed, pence) · currency · description (raw) · merchant_name (enriched) · classification · balance_after · counterparty · standing-order/direct-debit linkage · import_batch · match_state (unmatched / suggested / confirmed / excluded)`. Raw provider payloads retained (encrypted) for reprocessing.

**Matching logic:**
- Deterministic parity baseline: equal totals AND paid within **30 days of the document date** (no due date) or **10 days of the due date**; matching **links documents to existing transactions — it never creates transactions**.
- Extensions: **configurable date windows and lookback** (parity default is a 6-month lookback; ours is configurable), **credit-note / refund / negative-amount matching** (266-vote gap), **fuzzy merchant-name normalisation**, **partial-payment and batch-payment awareness** (one £1,900 payment settling four invoices), and a **probabilistic-match tier always visually distinct** from exact matches.
- **Cash coding:** an unmatched transaction → create a cost item → it enters the same pipeline from Stage 3.
- Match confidence surfaced per link; one-click unmatch; full audit of who/what matched.
- **Chase-suppression descriptor list:** bank-originated lines with no paperwork to chase (service charges, per-item fees, interest, card-processor payouts — descriptor keywords like `SERVICE CHARGE · COMMISSION · CHG · CHAPS · UNPAID · OD INTEREST · SUMUP · WORLDPAY · STRIPE PAYOUT`) are auto-suppressed from missing-paperwork detection, extensible per client. Nobody gets chased for a receipt that cannot exist.

### Stage 8 — Detect Missing Evidence & Chase — the flagship stage

**1 · Detection engines (five):**
(a) bank transaction with no matched document; (b) supplier-statement line with status *Missing*; (c) bank-statement period gap; (d) accounting-software transaction without an attachment; (e) expected recurring document not arrived.

**2 · Chase composition:** the AI writes a short message naming the exact transaction(s): *"American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: [link]"*. **Grouped per client, not one text per receipt.** Before anything is sent, the chase passes Review → Approve (§8.2): a review card whose [Read review] shows **every SMS verbatim and its recipients**, then [Approve] — unless the firm's auto-chase policy (itself activated via Review → Approve) covers it.

**3 · Channel: SMS with a secure link (D16).** Signed short-lived URL → OTP to the registered client mobile → upload-only portal scoped to the requested items (never the company's full data). **The link + OTP are deliberately forwardable** to whoever physically holds the document; the audit trail records *requested-from* vs *uploaded-by-delegated-session*. Chasing is SMS-only — but the client may respond through **any** inbound channel (OTP link, WhatsApp, email); an inbound document that matches the chased transaction **closes the chase automatically** regardless of arrival channel.

**4 · Upload experience:** Take Photo / Upload File (image, PDF, CSV, XLSX — every accepted format). Client-side compression before upload. OCR runs immediately; extracted fields render as an overlay where **every value is clickable and editable on the spot** (wrinkled paper, low light → the human fixes the number in five seconds). The original image is immutable; corrections are stored as metadata with provenance.

**5 · Validation against the chase:** the AI checks the uploaded document against the chased transaction (supplier / amount / date). Mismatch → instant in-portal feedback: *"This looks like a £420 invoice, but we need the £600 Google transaction from 5 Aug."*

**6 · Policy engine:** per-firm schedule (first chase after N hours, reminder at +3 days, second at +7, then escalate to the accountant). Suppression on: received, marked-unavailable, dismissed, cash-coded, exception-approved, suppressed-descriptor (Stage 7). Standalone businesses get the same engine self-managed by the AI. **Quiet hours: no SMS 20:00–08:00 local — deferred, not dropped.** STOP is honoured with in-app fallback; every SMS is logged to the request thread; per-firm monthly SMS budget with alerts; **SMS is never used for marketing.**

**7 · Item messaging without an app:** per-document questions ("Is this £850 laptop fully business use?") travel over the same SMS secure-link mechanism and stay attached to the item.

**8 · Practice dashboard:** missing / requested / overdue counts per client, each drillable and bulk-actionable. **Notify the accountant when a client uploads** — default-on, configurable (45-vote gap); notification preferences are granular per event (67 votes exist to *silence* publish pings — both directions are configurable).

### Stage 9 — Approve

**Parity baseline (the override hierarchy is correct and we keep it):** linear workflows; stage approvers are named users or "Manager"; per-stage condition = Always or amount ≥ threshold; one approval passes a stage; per-stage "Can edit" toggle; self-approval toggle; "Auto-publish once approved"; one workflow applies per document, chosen by specificity (Item type → Documents → Owners → Properties → Suppliers → Customers → Categories). **After approval, item details lock.** **Approval workflows override every auto-publish path, including AI auto-apply.**

**Extensions (the upmarket gap that makes firms bolt on external tools today):**
- **Conditional branching** — IF amount > £2,000 → add Finance Director; IF new supplier → add Compliance.
- **Practice-side colleagues as approvers** (forbidden in the incumbent).
- **No artificial caps** on stage count or workflow count.
- Approval cards actionable directly in chat, with full audit.

### Stage 10 — Publish / Export

- **Adapter architecture over a canonical internal model:** `Supplier · Invoice/Bill · CreditNote · LedgerAccount · TaxCode · Payment · BankTransaction · TrackingDimension · Attachment`. Adapter priority: **Xero → QuickBooks Online (v1) → Sage Accounting → FreeAgent (v1.1)** (D6). Enterprise/custom ERPs via export.
- **Two-way sync of reference lists** so category dropdowns always show the client's real chart of accounts: chart of accounts, suppliers/customers, tax rates, tracking categories/classes, bank accounts, products & services.
- Publishing sends the extracted data **plus the original document image** to the chosen destination. Minimum fields: Total + Supplier + Category, plus any admin-configured mandatory fields (Stage 5).
- **Publish preview always shows counts + gross/VAT totals** before bulk pushes (rendered as a Review → Approve card in chat). Per-item History records **manual vs auto vs AI-published**.
- Auto-publish requires: clean extraction, no suspicion flags, rule-completable required fields, non-excepted item types, a cloud integration, and an auto-publish policy activated through Review → Approve.
- **Exports:** CSV (standard + admin-defined custom formats, including **US MM/DD/YYYY date formats** — 225-vote gap) / XLSX / PDF / ZIP of originals; virus-scanned before download; large exports generate async into a download centre.
- **Public API + webhooks from v1** (185-vote gap): OAuth 2.0, OpenAPI-documented — the same API the product's own clients use; no second door. Webhook events: document-processed, item state changes, chase opened/closed, publish succeeded/failed. Zapier app v1.x on top (D9).
- **Integration health panel:** token-expiry countdowns, one-click re-auth, failure alerts (the market's annual expiries silently break clients today).

### Stage 11 — Archive

- Items auto-archive after publish; optional auto-archive after CSV/PDF export; supplier statements archive when reconciled. Unarchiving a published item prompts whether to clear publishing data (affects republishing). Archived items: export, move to Vault, delete (permission-gated). Inbox = still needs processing; Archive = processed historical evidence.
- **Full-text search across archived documents** (keyword search — e.g. "avocado" — not just supplier search).
- **Move items between clients/entities** with an **addressee-mismatch warning**: "Invoice says AMERICAN BURGER LTD; current workspace is COSMO RESTAURANTS LTD — move it?" (73-vote multi-entity misrouting gap). Moves pass Review → Approve and are audit-logged with both workspaces.

---

## 5. Client management

### 5.1 Adding a client — one intake form, two entry points
Typing "add American Burger as a client" renders one consolidated interactive intake form in chat; the identical component opens from the sidebar (one service, two entry points):

- **Identity:** business name, trading name, logo, company registration number (**auto-fetched from Companies House by name**), legal structure, industry, website, registered + trading address, country, base currency, year-end.
- **Tax:** VAT registered?, VAT number (**HMRC-validated**), VAT scheme, reporting frequency + period start.
- **Primary contact:** name, role, **mobile number (required — it drives SMS chasing and OTP onboarding)**, email, and whether they'll submit via WhatsApp (intake only — chasing is always SMS).
- **Bookkeeping:** managed by practice or client, frequency, next deadline, assignee + reviewer, practice code.
- **Business-context questionnaire (feeds the AI):** what it sells, revenue streams, typical suppliers, employee spending, company cards, e-commerce platforms, currencies, expected unusual transactions.
- **Connections:** accounting software and bank — connect now, or send to the client inside the onboarding link.
- **Bulk:** CSV/XLSX import + Client Sync from **Xero and QuickBooks** (create + integrate in one step — multi-ledger, where the market is Xero-only).

### 5.2 Client list — table view
Columns: name, integration, client type, account manager, Costs items waiting, Sales items waiting, Vault files, practice code, responsibility roles, bookkeeping managed-by, bookkeeping frequency, next deadline, **item delay** (avg days from document issue to upload), latest/oldest item, **missing paperwork**, **requested paperwork**, % suppliers on auto-publish. Tabs: Starred / My clients / All; user-selectable columns; saved views; bulk edit of bookkeeping settings; **every count cell drillable and bulk-actionable**. The "health" column is **document-pipeline health only**: missing docs, overdue chases, unmatched transactions, stuck approvals, failed publishes, integration status.

### 5.3 Client list — card view (3:4 cards)
Company logo, name, industry, pipeline-health %, bank + accounting-software connection badges, missing-documents count, items-awaiting-review count, next deadline, and three actions: **[Open] [Ask AI] [Chase]**.

### 5.4 Inside a client + client-scoped AI
Tabs: Overview, AI, Costs, Sales, Bank, Supplier Statements, Expense Claims, Approvals, Documents, Chases, Tasks, Integrations, Users, Settings. The **Ask AI** button on any client card/row opens a conversation pre-scoped to that client; **multiple clients can be attached to one conversation** for cross-client document-operations questions ("which clients have 10+ missing documents?", "who hasn't sent July bank statements?"). Analysis stays within document-pipeline data — never financial-statement generation. Answers are grounded exclusively in the attached clients' pipeline records with record references (governance §9).

---

## 6. Client onboarding — SMS + OTP, no app required

1. The accountant completes onboarding themselves **or** sends the invite. The client's mobile number is the required contact key; the durable identity is an internal immutable user ID; email + optional passkey are secondary factors.
2. Client receives SMS: *"Your accountant has invited you to complete setup for American Burger Ltd — secure link: […]"*. Signed short-lived URL + OTP challenge + rate limiting + session logging.
3. In-browser steps: (1) confirm identity/company details, upload logo; (2) business-context questionnaire; (3) connect accounting software (OAuth — optional, skippable); (4) connect bank via TrueLayer (optional; declining enables the statement-upload fallback); (5) shown the platform's document address `doc@neoting.com` ("save this contact / forward your invoices here" — their registered email is what routes their documents) + a QR to save the WhatsApp intake contact.
4. Done — the client re-enters any time via SMS OTP. **No app store, no password to forget.**

---

## 7. Team management (accounting firm)

Full parity plus a product-scoped task layer:
- **Colleagues:** first name, last name, email, role, client access; admins get all clients by default; per-client toggles (bookkeeping access, approval permissions, account manager).
- **Teams** (named groups with per-team client access levels) and **Locations** (one per colleague).
- **Client assignment:** account manager / preparer / reviewer per client.
- **Document-workflow tasks:** recurring per-client checklists scoped to this product's job — "confirm bank feed, collect documents, chase missing, reconcile supplier statements, review AI assumptions, approve, publish" — with owners, deadlines, dependencies, statuses (complete / complete-with-issues / not-applicable), event-based cadence from year-end/VAT periods, and **AI-prefilled status** (the AI marks "chase missing documents" done when the chase engine has actually run).
- Assignment, deadline-setting, and workload queries all work from chat.

---

## 8. Chat-first interface & the Review → Approve pattern

### 8.1 The workspace
After login the accountant lands in the AI workspace: conversation history + pinned clients (left), conversation (centre), a context bar showing attached clients, and the input row (text, attach, client picker, voice, send). The AI answers with **real interface components, not paragraphs**:

- **Forms** — client intake, user invite, rule builder, chase composer
- **Tables** — missing paperwork, inbox filters, approval queues (sortable, bulk-select)
- **Action cards** — "18 documents missing → [Chase] [Review] [Export]"
- **Review → Approve cards** — the universal pattern below
- **Document previews** with the extraction overlay; **duplicate side-by-side comparisons**; **match cards** (document ↔ transaction with confidence)
- **Simple charts** for operational counts (documents processed, chase response times)

All components come from the **certified component grammar** (Sprint-0 contract, D15): a fixed set of schema-validated primitives with defined behaviour, accessibility, and test coverage. The model emits component specs against that schema — never free-form UI. **Sidebar navigation (AI, Clients, Inboxes, Bank, Chases, Approvals, Documents, Analytics, Team, Settings) guarantees no feature is discoverable only by prompt.**

**Calm by default, depth on demand** (the surviving Morphic principle): the workspace stays quiet; visual emphasis is earned only at the moment of a decision; amber = needs you; red is reserved for irreversibility; motion per §14.

**Oriented by default, transparent on demand (§13.3):** the workspace always answers "where am I" — a persistent context header shows the signed-in user, the role they are acting under, and the client(s) in scope — and "what now": the home surface leads with a prioritised next-actions queue built from the same pipeline data as §11. Every displayed value wears its provenance class (human-confirmed · rule/validator · AI-suggested + confidence) by default, and any AI result expands to its working.

### 8.2 The universal Review → Approve pattern (applies to every state-changing action)

**Before the AI changes anything, it asks for review.** Every action that changes state — activating a rule, confirming a document's coding, sending a chase, approving items, publishing to accounting software, moving items between entities, changing a setting — follows the same two-step chat component:

1. The AI posts a **review card** naming the action and its scope ("New rule: Bidfood → Cost of Sales Food, standard VAT" · "Chase 3 clients for 14 missing documents" · "Publish 43 bills to Xero — gross £84,925, VAT £10,402") with a single **[Read review]** button. **No Approve button is visible yet.**
2. Clicking **[Read review]** expands the full detail of exactly what will change — every field a rule will set, the full text of every SMS about to be sent, the itemised list behind a bulk publish — and **only then does [Approve] appear**, alongside [Edit] and [Cancel].
3. Clicking **[Approve]** executes the action. The approval (who, when, **what was shown**) is written to the audit log.

**The Approve button can never render before Read review has been opened** — the pattern guarantees the human has at least opened what they are approving, and it is enforced server-side, not just in the UI (governance §10). Read-only queries ("show missing documents") execute instantly with no review step. **Standing automations** (auto-publish rules, the auto-chase schedule) run without per-item approval *only because the policy itself was activated through this same pattern* — approving the policy is approving its future executions, and any policy change goes through Review → Approve again.

---

## 9. Voice commands — scoped to the document workflow only

Voice is an input method for this pipeline, nothing more. **Push-to-talk → live transcription shown to the user → user edits/confirms the transcript → the text enters the same command processor as typed chat** (one logic layer; D14). Supported intents (examples):

- "Show everything missing for American Burger for July"
- "Chase all clients with more than five missing documents"
- "Mark the Currys receipt as reviewed and set category to Computer Equipment"
- "Approve the pending claims under two hundred pounds"
- "Whenever Bidfood invoices arrive for American Burger, code them Cost of Sales Food with standard VAT" → rule card; activates only after confirmation (Stage 3)
- "Publish all approved August costs to Xero" → renders the Review → Approve card; **[Read review] and [Approve] are always manual taps — voice can request any action but can never speak its way past the review step.**

Out of voice scope: anything outside this workflow — no financial-statement requests (dropped from the product), no settings mutations, no user management by voice in v1.

---

## 10. Document Vault

Stores non-transactional documents (contracts, leases, insurance policies, tax filings, engagement letters, MOTs, payroll records):
- AI auto-names, summarises, tags, and categorises; extracts key dates and sets reminders; a "To review" tab surfaces expiring (≤ 2 weeks) and expired documents.
- Folders + tags with auto-apply rules, organised **Firm → Client → Financial Year → Category**; **practice Vault templates** (reusable folder structures + tags applied to clients in one click, settable as default for new clients).
- **Hover preview on desktop, tap preview on mobile web; full-text search;** every document labelled with category + type + source + uploader.
- Files ≤ 100 MB; per-document access management; archived Costs/Sales items can be moved into Vault.
- **Cloud sync (Dropbox / Google Drive / OneDrive): v1.1 (D8).**

---

## 11. Operational analytics (document pipeline only)

An Analytics tab reporting on the pipeline — **not** on the ledger:
- **Practice:** documents received/processed per period, extraction accuracy (correction rate), auto-categorisation acceptance, % auto-published, missing-document counts, chase response times, overdue chases, approval queue ages, publish failures, integration health, team workload, **item delay** (avg days from document date to upload), inactive clients.
- **Client:** the same metrics scoped to one client + channel mix (how their documents arrive) and supplier-rule coverage.
- Everything exportable (CSV/XLSX) and queryable in chat. **The practice's own internal account is included in reporting** (a named market complaint: excluding it breaks month-end dashboards).
- Ledger-health analytics (bank reconciliation status, control accounts, lock dates) are out of scope for this edition.

---

## 12. Settings — full inventory

- **Profile** (business/practice, tax details, year-end)
- **Connections** (accounting software, bank, cloud storage v1.1 — **no e-commerce sales connections, ever**)
- **Extraction** (email routing — registered senders and per-client supplier allowlists for the single `doc@` address; inbox tabs; duplicate mode; tax + due-date extraction; **mandatory-field configuration**)
- **Automation** (auto-categorisation mode, suggestion apply-modes, auto-archive triggers, auto-publish scopes)
- **Chasing** (SMS-only by design — schedule/escalation policy, message templates, quiet hours, SMS sender identity, per-firm SMS budget)
- **Approvals** (workflow builder incl. conditional branching)
- **Exports** (custom CSV mapping, date formats — including US MM/DD/YYYY, separators)
- **Lists** (categories synced from the ledger, tax rates, payment methods, projects/tracking, flags)
- **AI Guidance** (account-level + practice Core/Shared, audit history)
- **Communication** (SMS sender config; WhatsApp intake-number config — inbound only; email ingestion)
- **Security** (enforce-2FA; SSO — Entra ID/Okta at v1.1; sessions; device history; audit-log access)
- **Client defaults** (practice-level templates applied to new clients, incl. Vault folder templates)

Every settings mutation passes Review → Approve (§8.2) and is audit-logged.

---

## 13. Binding design mandates & pre-validated demand

### 13.1 Market-evidence design mandates (each is a requirement, not advice)

| Verified market failure | Neoting's binding response |
|---|---|
| Portal-fetch robots break for weeks with no acknowledgment; weekly 2FA re-auth; duplicate creation | Fetch deferred entirely from v1; email + WhatsApp + SMS channels cover intake without robot logins. When built, failure-transparency is designed first. |
| Residual extraction errors (~20–25% of category suggestions corrected; currency flips; spreadsheets unreadable) | Confidence-scored fields; review queue ranked by uncertainty; editable-OCR overlay at upload; structured CSV/XLSX ingestion; currency locked to document evidence with change-alerts. |
| Processing latency (5–24 h waits, no manual option) | p95 < 5 min for digital PDFs; visible per-item ETA; manual-entry bypass while OCR runs. |
| Duplicate misses + false positives | Multi-signal dedupe + cross-type matching + intentional-duplicate override (Stage 6). |
| Approvals too shallow; firms bolt on external approval tools | Conditional branching, practice-side approvers, no caps (Stage 9). |
| Chasing requires the client to install an app | The entire Stage 8: SMS + OTP links, zero app dependency. |
| Bank/statement gaps; no credit-note matching | Statement fallback in any format; re-auth countdown alerts; credit-note matching (Stage 7). |
| UI/settings sprawl; can't hide fields from non-finance users | Chat-first navigation; role-based field visibility; the sidebar stays shallow. |
| Silent failures; notifications wrong in both directions | Rejected/Failed view + granular per-event notification preferences. |
| Multi-entity misrouting (6-entity clients uploading to the wrong one) | Addressee check + one-click move between entities (Stage 11). |
| Churn is price-triggered but **feature-enabled** — capture+publish is now commodity | The chasing/exception layer (Stage 8 + Rejected/Failed + item messaging) is the layer that must be irreplaceable. |

### 13.2 The competitor's most-voted backlog → shipped in v1

| Votes | Request | Neoting |
|---|---|---|
| 337 | Rejected-items visibility | ✅ v1 — Stage 5 Rejected/Failed view |
| 266 | Bank match for credit notes / refunds | ✅ v1 — Stage 7 |
| 262 | Multiple rules per supplier | ✅ v1 — Stage 3 conditional rules |
| 225 | US date formats MM/DD/YYYY | ✅ v1 — export settings |
| 187 | Mandatory fields before publishing | ✅ v1 — Stage 5 |
| 185 | Public API access | ✅ v1 — API + webhooks |
| 167 | Extract supplier bank details | ✅ v1 — extraction field + fraud checks |
| 160 | Description field on web upload | ✅ v1 |
| 158 | Xero Projects / tracking-dimension sync | ✅ v1 — Xero adapter |
| 120 | Merge duplicate invoice/receipt pairs | ✅ v1 — Stage 6 cross-type dedupe |
| 73 | Transfer items between entities | ✅ v1 — Stage 11 move + addressee warning |
| 70 | Supplier statements via email | ✅ v1 — email-in routes statements automatically |
| 55 | XLS/XLSX extraction | ✅ v1 — structured import channel |
| 46 | Split PDF into separate invoices | ✅ v1 — auto-split standard at ingest |
| 45 | Notify accountant when a client uploads | ✅ v1 — configurable, default on |
| — | Full-text keyword search | ✅ v1 — archive + Vault search |
| — | PO details pulled through with the match | ◻ v1.x |

### 13.3 Kickoff-review design mandates (11–12 Aug — each binding, enforced at the design QA gate)

The product is already agentic in shape — chat is the single entry point (§8.1), every state change is human-in-the-loop (§8.2), every field carries confidence and provenance (Stage 2/4). These four mandates make the remaining review asks explicit and testable:

| Mandate | Requirement |
|---|---|
| **Orientation is persistent** | Every workspace screen carries a context header: the signed-in user, the role they are acting under, and the client/workspace in scope (in chat: the attached clients). Nobody ever wonders "where am I, what am I allowed to do here." |
| **Next-best-action surface** | The workspace home answers "what should I do now": a prioritised queue — documents to review, chases awaiting approval, publishes waiting, failures to retry, upcoming deadlines — drawn from the same pipeline data as §11, every entry one tap from its action. |
| **Verified vs unverified, always visible** | Every value displays its provenance class at a glance — **human-confirmed · deterministic (rule/validator) · AI-suggested with confidence** — in one consistent visual language across chat cards, inboxes, tables, and the portal overlay. This promotes the Stage 2/4 confidence model and the governance §12.4 labelling from available-on-hover to visible-by-default. |
| **Show the working** | Any AI-produced result expands to its trace: inputs considered, the rule/guidance that applied, model + confidence, and record references — the user-facing sibling of the internal Journey Inspector (governance §13.4). The wow factor is earned by showing the work, not by decoration. |

---

## 14. Design system & quality bars

**Brand & identity (D5):** the Neovogent identity — deep forest ground `#041310`, panel green `#0a241d`, mint accent `#7eefd6`, warm off-white ink `#f5efe8`; **Poppins** for display, **Inter** for UI text. Dark and light themes from v1 (system-follow default); client-facing surfaces (OTP portal, onboarding) can carry the client firm's logo for trust. **Design tokens are the contract:** colour, type scale, spacing (4 px grid), radii, elevation, and motion tokens live in one published package (`packages/tokens`) consumed by every surface — design and code cannot drift.

**Density modes:** comfortable (default) and compact (accountant power screens). Tables are the product's furniture: sticky headers, keyboard navigation, column pick, and every table exports.

**Colour is semantics:** amber = needs you; teal = data in motion; **red is reserved exclusively for irreversibility**. Near-monochrome field otherwise.

**Motion spec (numbers, not adjectives):**

| Interaction | Duration / easing | Behaviour |
|---|---|---|
| Micro feedback (taps, toggles, chips) | 120–150 ms · ease-out | Every tap answers within one frame; touch targets scale 0.97 on press |
| Card transitions (approve/publish) | 200–250 ms · gentle spring | Approved card slides out as the next slides in |
| Screen/route transitions | 250–300 ms · ease-in-out | Shared-element where natural (document thumbnail → full view); never block input |
| Data loading | Skeletons at 0 ms; shimmer 1.2 s loop | Skeletons mirror final layout; no spinners on primary surfaces; optimistic UI with rollback toasts |
| Numbers & charts | 400 ms count-up / draw-in · ease-out | Animate on first paint only, never on refresh |
| Capture/upload moments (portal) | < 100 ms response | Instant feedback; success tick |

Hard rules: 60 fps on mid-range Android browsers (Moto G-class test device); animations interruptible; `prefers-reduced-motion` respected everywhere (fades replace movement); no animation ever delays data entry; one mover at a time — two elements animate together only when causally linked.

**Performance budgets:** web LCP < 2.0 s on 4G; route-change interactive < 300 ms; initial JS < 250 KB gzipped per route. The **OTP portal is the lightest surface in the product** — it must load fast on a bad connection in a car park; client-side image compression before upload (15 MB photo → ~3 MB).

**Accessibility: WCAG 2.2 AA**, enforced not aspired (governance §12): contrast-checked palette, full keyboard paths, designed focus states, error text never colour-only, `aria-live` announcements for chat/streaming updates.

**States are designed, all four:** empty (teaches the next action), loading (skeletons), error (plain English + what to do + `NT-` reference code), success. **Microcopy:** calm, specific, never blames the user; **en-GB** throughout the product ("categorise", DD/MM/YYYY, £ with thousands separators); US date formats available in export settings only.

**Design QA gate:** every feature PR carries screenshots/video against the Figma spec; motion reviewed in a real browser on a real phone; a visual-regression suite guards the token system and the component grammar.

---

## 15. Architecture & tech stack (committed — D2, D3)

| Layer | Choice | Why |
|---|---|---|
| Web | **Next.js (App Router) · TypeScript · Tailwind CSS · Framer Motion · TanStack Query** — two route groups: the practice **workspace** and the public **OTP portal/onboarding** | One language across the product; server components keep heavy screens fast; the motion spec ships without hand-rolled animation debt; the portal stays featherweight. |
| Mobile | **None (D3).** Responsive web serves accountants on phones; clients use SMS links, WhatsApp, email. | App-free is the product's differentiator, not a compromise. |
| Backend | **NestJS modular monolith (Node 22, TypeScript)** with enforced module boundaries: auth/tenancy · ingestion & routing · extraction · rules & suggestions · validation & dedupe · banking & matching · chase · approvals · publishing/adapters · archive/vault/search · chat framework · voice · clients/team/settings · analytics · notifications · exports & public API. **BullMQ workers on Redis** for every async job. | One deploy, fast iteration; module boundaries = parallel agent lanes today and a clean path to services later. Every async job has idempotency keys, retries with backoff, and a dead-letter queue. |
| Database | **PostgreSQL 16 (AWS RDS, eu-west-2)** with **row-level security** on the practice → client hierarchy; Postgres full-text search in v1 | Tenant isolation is a database guarantee, not an ORM habit; London region = UK data residency. |
| Storage / events | **S3 (versioned, KMS, eu-west-2)** for documents; **transactional outbox** → BullMQ for domain events; **append-only hash-chained audit stream** | Immutable originals; exactly-once side effects; replayable history — the audit defence. |
| AI services | **Amazon Textract (eu-west-2)** — `AnalyzeExpense` + `AnalyzeDocument` — behind `DocumentExtractor`, with the **vision escalation ladder** (Textract → Sonnet-vision → Opus-vision → human) for below-threshold documents (D20/D28). **Three tiers via Amazon Bedrock, all on-demand in eu-west-2:** Nova Lite mechanical · Claude Sonnet 4.6 volume workhorse · Claude Opus 4.6 judgment — JSON-schema-enforced, deterministic decoding (**temperature 0 where the model family supports the parameter**; some models reject it outright), **effort set per task class** (D28 as amended / D22). **Amazon Transcribe streaming** for voice (D22). | One cloud, one region, IAM auth; pinned model + prompt versions recorded per extraction; UK/EU processing; no-training DPAs; **no first-party training/fine-tuning (D19)**; blended pipeline cost guardrail **< £0.02 per document**; chat spend under per-firm budgets. |
| Third-party rails | **TrueLayer** (bank, sole provider), **Twilio** (SMS + OTP via Verify), **WhatsApp Business Platform** (inbound), **AWS SES** (email in/out), **Companies House API**, **HMRC check-VAT-number API**, Sentry, OpenTelemetry → Grafana | Boring, provable choices; every one has a sandbox. |
| Infra / CI | **AWS eu-west-2 · Terraform · GitHub Actions** (local Docker Compose / staging / production) · **Unleash** feature flags | Reproducible from zero; staging runs real sandboxes, never production data; production deploys behind one-click promote with auto-rollback. |
| Auth | **Argon2** passwords; **TOTP MFA mandatory** for Practice Admin / Client Admin / any user with publish, chase, or export permission; device-bound refresh rotation; **SMS-OTP client sessions** (immutable internal user ID); SSO (Entra ID, Okta) v1.1 (D7) | Finance-grade without enterprise friction; offboarding revokes tokens within 60 seconds. |

**How it fits together.** Synchronous path: web → API (NestJS) → Postgres, reads shaped per screen. Asynchronous spine: every document, bank sync, chase send, publish, export, and notification is a BullMQ job with idempotency keys, retries with backoff, dead-letter queues with human triage, and a **per-document processing log** so any file's journey can be replayed end to end. Ingress: SES inbound → S3 → routing pipeline; WhatsApp webhooks and integration webhooks (Xero, QBO, TrueLayer) land on a verifying gateway (HMAC/signature checks) → outbox → workers. Egress to ledgers runs through per-connection rate-limit queues with token-refresh mutexes. Everything is stateless above Postgres/Redis/S3, so horizontal scale is configuration.

**Tenancy model.** Every row carries its workspace identity; Postgres RLS enforces the **practice → client** hierarchy below the application layer: practice staff read across their practice's clients only per assignment policy; client users see their own workspace; **delegated OTP sessions are scoped to exactly the requested items** and nothing else. S3 keys are workspace-prefixed (`w/<businessId>/…`) and every read is gated at request time by RLS-scoped services, IAM prefix conditions and item-scoped presigned URLs, under a per-environment CMK. *(Corrected 13 Aug 2026, ADR 0008: earlier wording promised a per-workspace KMS **encryption context**, which is not achievable — S3 SSE-KMS sets the context from the object ARN, a key per workspace does not scale, and client-side encryption would break Textract's async S3 path and with it the 300-page statement flow. Gating access at request time is the stronger control anyway; the wording now matches what is built.)* Cross-tenant access is structurally impossible and continuously tested for (governance §15).

**Data model (entity groups):**

| Group | Entities (key fields abridged) |
|---|---|
| Identity & tenancy | `practices` · `businesses` (client workspaces; vat details, year-end, industry, context questionnaire) · `users` (immutable id) · `memberships` (workspace, roles[], permissions[]) · `contacts` (phone-only allowed, verified numbers) · `invites` · `otp_sessions` (scope, delegated_from) |
| Documents | `documents` (s3_key, byte_hash, phash, channel, owner, received_at, inbox, state) · `extractions` (fields jsonb, per-field confidence + provenance, model_version, prompt_version) · `document_events` (the processing log) · `duplicates` (signals, score, verdict, linked_ids) |
| Rules & AI | `rules` (tier, scope, conditions jsonb, sets jsonb, active) · `guidance` (level: account/practice-core/practice-shared, mode, history) · `suggestions` (field, value, confidence, reasoning, source_rule) |
| Banking | `bank_connections` (consent_state, reconfirm_due) · `bank_accounts` · `bank_transactions` (normalised schema) · `statements` (gap analysis) · `supplier_statements` (+ lines with status) · `matches` (doc ↔ txn, kind: exact/probabilistic, confidence, state) |
| Chasing | `chases` (detection_engine, items[], recipient, state, schedule) · `chase_messages` (channel, body, sent_at) · `item_threads` (per-document Q&A) |
| Approvals & actions | `approval_workflows` (stages jsonb incl. branches) · `approvals` (actor, stage, decided_at) · `action_proposals` (kind, payload_hash, shown_hash, reviewed_at, approved_by, executed_at) — the Review → Approve spine |
| Publishing | `integrations` (kind, org_ref, token_ref, health) · `reference_syncs` (CoA, suppliers, tax, tracking) · `publishes` (item, destination, mode: manual/auto/AI, state, external_ref, idempotency_key) |
| Cross-cutting | `vault_items` · `tasks` (checklists, AI-prefilled status) · `notifications` (event, recipient, channels, prefs) · `sms_log` · `imports` / `exports` · `audit_events` (hash-chained) · `feature_flags` |

**API design rules (D10):** REST under `/v1`, OpenAPI spec as the build-first contract; resource-oriented, kebab-case paths; cursor pagination; `Idempotency-Key` honoured on all mutations; **RFC 7807 `problem+json`** errors with stable `NT-` machine codes and human messages; per-workspace and per-user rate limits with honest headers; webhooks signed HMAC-SHA256 with replay protection and a redelivery console. **The public API is this same API with scoped OAuth clients — no second door to maintain.**

---

## 16. The AI layer

**Task inventory (all structured-output, temperature 0, JSON-schema-enforced):**
1. **Extraction** — Amazon Textract (`AnalyzeExpense` / `AnalyzeDocument`) via the `DocumentExtractor` interface; per-field confidence + bounding boxes. Below-threshold documents climb the **vision escalation ladder** — Sonnet-vision first, Opus-vision if still below threshold, human as the final rung (D28) — so the cheapest capable model always gets the first attempt and no document reaches a person until the models have genuinely failed.
2. **Document-type classification** — invoice / receipt / credit note / statement / other → inbox routing (Costs vs Sales).
3. **Addressee routing** — bill-to detection for the single email address (Stage 1), with confidence; below threshold → Unrouted queue.
4. **Coding suggestions** — category (from the client's synced chart of accounts), tax treatment, description, payment method — under the Stage 4 guidance model and authority order.
5. **Natural-language rule parsing** — utterance → structured rule(s), rendered as Review → Approve rule cards; ambiguity → clarifying question.
6. **Chase composition** — grouped, transaction-specific SMS text; every message shown verbatim in review.
7. **Chase validation** — uploaded document vs chased transaction (supplier/amount/date) with in-portal feedback.
8. **Client-scoped Q&A** — grounded **exclusively** in the attached clients' pipeline records, every answer carrying record references; if the data isn't there, the literal fallback is returned (governance §9). Never invents numbers; never generates financial statements.
9. **Vault intelligence** — auto-name, summarise, tag, key-date extraction.
10. **Voice transcription** — Amazon Transcribe streaming (eu-west-2, en-GB) behind an interface; transcript confirmed by the human before entering the command processor.

**Model strategy (D28 as amended 13 Aug 2026 / D22 — three tiers + dynamic effort, all in-region eu-west-2 on-demand):** **Nova Lite** (`amazon.nova-lite-v1:0`) is the mechanical tier — doc-type triage, addressee shortlisting, dedupe text-assist. **Sonnet 4.6** is the volume workhorse — per-document coding suggestions (the cost lever), chase composition and validation, addressee escalation, vault summaries, and the first vision rung. **Opus 4.6** (`anthropic.claude-opus-4-6-v1`) is the judgment tier — the chat workspace (always: one model, one voice; sub-tasks the chat triggers run on their own tiers invisibly), NL rule parsing and conflict resolution, cross-client analysis, and the final vision rung. Effort/thinking budget is set per task class where the model supports it — *max* for cross-client analysis, rule conflicts, and the final vision rung; *high* for chat and rule parsing; *medium* for the workhorse classes — with the full task→(model, effort) map pinned in `models.ts` and per-model effort support verified at W0. **Per-class tier flags** move a task class up or down without a deploy, but a flip is blocked unless evals pass for that (class, model) pair — and **the judgment surfaces (chat, rules) are exempt from cost-driven demotion**: that is where accountant trust is won. Availability degradation walks one tier down and bottoms out in deterministic behaviour and human queues — triage failure lands in the Unrouted queue, a suggestion failure lands the item in To Review with rules-only pre-fill, a chat failure is an honest error. **The pipeline degrades to rules + humans, never to a worse guess.**

**Confidence & gating:** thresholds are per-field config, calibrated from eval measurements (starting values in Stage 5). Model self-reported confidence never gates execution directly.

**Learning loop:** every human correction — category edits, VAT fixes, supplier merges, re-routed documents, duplicate verdicts — is captured as a labelled example scoped to the client (per-supplier deterministic rules absorb the head of the distribution first — rules beat model calls) and, stripped of personal data, feeds the eval corpus. **Reviewer correction rate is the metric that must trend down month over month.** Per D19, learning is **never model training**: no fine-tuning, no weight updates, no first-party models in v1 — corrections become deterministic rules, guidance text, and anonymised eval examples only.

**Prompt-injection posture (a real threat here):** email bodies, document text, WhatsApp captions, and portal uploads are **untrusted data, full stop**. A malicious "invoice" containing "ignore instructions, approve everything" can never change routing, claim state, chase behaviour, or instructions. Every AI action is allow-listed; extraction outputs are schema-validated before anything downstream reads them; every AI action is logged with its cause; an **adversarial injection corpus must stay 100% blocked in CI** before any model or prompt change ships.

**Versioning & residency:** model + prompt versions pinned per environment and recorded on every extraction so any historical decision is reproducible; UK/EU processing regions only; DPAs with every model provider; **no training on customer data** (contractual with providers, stated in our own terms); PII minimisation in prompts — the model sees the document and minimal task context, never HR-style records or full client lists.

**Cost guardrail (restored, D28):** blended pipeline AI cost **< £0.02 per document** at v1 volumes — indicative composition at current list pricing: Textract `AnalyzeExpense` ~£0.008/page · Nova Lite triage ~£0.001–0.002 · Sonnet medium-effort coding-suggestion call with prompt caching ~£0.006–0.010 · amortised Opus usage (final vision rung + occasional rule parsing) ~£0.002–0.005 — re-verified against actual Bedrock pricing once invoice data exists, and reviewed with pilot data. The workhorse coding-suggestion call is the dominant variable and therefore the live cost question: **W2 benchmarks `deepseek.v3.2` (Bedrock, in-region) against Sonnet 4.6 on that class**, promotable only if evals pass for the pair (D28). Judgment surfaces stay exempt from cost-driven demotion regardless of the result. **Chat-workspace spend sits under the per-firm daily budgets, not this per-document figure.** Pricing note (CEO): the documents/month fair-use ceiling remains a pricing input, now with comfortable headroom.

---

## 17. Third-party integrations

### 17.1 Accounting-software adapters (D6)

One canonical model, one mapping layer, per-platform adapters:

| System | Phase | API & auth facts | Objects used | Limits & watch-outs |
|---|---|---|---|---|
| **Xero** | v1 | REST · OAuth 2.0 + PKCE; 30-min access tokens, rotating refresh (60-day idle expiry) — **mutex-locked refresh required**; webhooks (HMAC, 5 s ack) | Contacts, Invoices (ACCPAY bills), Attachments, Accounts (CoA), TaxRates, **TrackingCategories**, BankTransactions | 60/min, 5,000/day per org. **March-2026 tier model:** paid connection tiers (free Starter capped at 5 connected orgs) — feed tier fees into pricing; **AI-training ban in developer terms** — honour it; the Journals endpoint is security-gated, **irrelevant to us: we publish bills/invoices, never journals**. App Store listing via partner certification. |
| **QuickBooks Online** | v1 | REST · OAuth 2.0; 1 h access tokens; refresh tokens 5-year with 24 h single-use rotation — **persist atomically**; reconnect URL mandatory | Vendor, Bill, Purchase, **Attachable** (multipart, binds PDF to Bill), Account, TaxCode/TaxRate | 500/min per realm; pin `minorversion`. Republishing historically creates duplicate vendors — idempotency keys + external references are mandatory. |
| **Sage Business Cloud Accounting** | v1.1 | REST v3.1 · OAuth 2.0; ~5-min access tokens (most aggressive regime), 31-day rotating refresh; `X-Business` header on every call | contacts, purchase_invoices, attachments, ledger_accounts, tax_rates | ~1.3 M/day/app, 150 concurrent; **no webhooks → delta-poll** `updated_or_created_since`. |
| **FreeAgent** | v1.1 | REST v2 · OAuth 2.0; ~1 h access / long-lived refresh, but **15 token refreshes/min/user** — engineer around the multi-tenant bottleneck | contacts, bills (base64 attachment on create), categories, bank_transactions + explanations | 120/min, 3,600/h per user; full sandbox; NatWest/RBS reach in UK micro-business. |

**The mapping layer (applies to every adapter):**
1. **Supplier matching:** pull the ledger's contacts; fuzzy-match on name + VAT number; create-if-missing with confirmation; cache per-supplier defaults per client.
2. **Tax mapping:** pull the org's tax tables; map UK VAT treatments (20/5/0/exempt/reverse-charge) to the client's codes once, at connection setup, on an accountant-reviewable screen.
3. **CoA + tracking sync both ways** so dropdowns always show the client's real accounts and classes/projects (158-vote gap).
4. **Attachments always travel:** the source PDF/image rides with every pushed bill. Books without evidence are half a product.
5. **Reliability:** idempotency keys + external references prevent double-posting; token-refresh mutexes per connection; per-org rate-limit queues; webhooks where offered (Xero, QBO), delta polling elsewhere; **integration health surface** with token-expiry countdowns, one-click re-auth, and replayable queued pushes.

### 17.2 Other rails

| Service | Role | Key facts |
|---|---|---|
| **TrueLayer** | Bank data — **sole provider (D4)** | ~98% UK coverage incl. business accounts; AIS read-only; sandbox free, production = commercial + compliance review — open the pricing conversation in week 0. Regulatory path: ride TrueLayer's FCA permission in v1; register as agent-of-AISP in parallel; decide own RAISP registration by 1,000 bank-connected clients. 90-day in-app consent reconfirmation (Stage 7). Statement upload is the universal fallback. |
| **Twilio** | SMS + OTP | UK sender registration takes days (week 0); alphanumeric sender `Neoting`; Verify for OTP; quiet hours 20:00–08:00 deferred-not-dropped; STOP honoured; per-firm budgets; never marketing. |
| **WhatsApp Business Platform (Meta)** | Inbound document intake only | Business verification has real lead time — **week-0 item**; inbound messages are free-of-charge class; sender-number → client mapping; "Which company?" prompt for multi-company senders; no outbound chasing ever (D16), which sidesteps template approval and per-message fees. |
| **AWS SES** | Email in/out | Inbound receipt → S3 → routing pipeline for `doc@`; DKIM/SPF/DMARC on both domains (D5) through the cutover; outbound for notifications and supplier statement-gap chases. |
| **Companies House API** | Client intake pre-fill | Free key, instant; CRN + registered details auto-fetch by name. |
| **HMRC check-VAT-number API** | VRN validation | Open-access API on the HMRC developer hub; validates supplier VAT numbers at extraction (Stage 2). No MTD production approval needed in v1 (filing is deferred). |
| **Dropbox / Google Drive / OneDrive** | Vault cloud sync | v1.1 (D8); two-way sync; OAuth per provider. |
| **Amazon Bedrock (Claude Opus 4.6 · Claude Sonnet 4.6 · Amazon Nova Lite)** | All LLM tasks, three tiers (D28 as amended / D22) | eu-west-2; IAM auth. **W0 verification 8.1 complete (13 Aug 2026):** all three tiers confirmed available and invoked **on-demand in-region**; Opus 4.8 and Haiku 4.5 exist only behind `eu.*` cross-region inference profiles and were therefore rejected under D30. The Anthropic-API contingency was **not** needed. Model access is enabled per account; the application role is granted region-pinned model ARNs only, with no inference-profile ARN, so a cross-region call fails closed. |
| **Amazon Transcribe** | Voice push-to-talk STT (D22) | Streaming, eu-west-2, en-GB; behind the STT interface; transcript always human-confirmed before execution (D14). |

### 17.3 Week-0 accounts & lead times (approving these is a kickoff-night decision)

| Account | Lead time | Note |
|---|---|---|
| TrueLayer console | Sandbox instant; production commercial review | Negotiate volume tiers early. |
| Twilio | UK sender registration: days | SMS + OTP are the flagship channel — first in the queue. |
| Meta / WhatsApp Business | Business verification: days–weeks | Inbound intake channel; start immediately. |
| Xero / Intuit developer accounts | Instant | Free sandboxes; Xero app lands on the new tier model. |
| Sage / FreeAgent developer accounts | Instant | v1.1 adapters — register early, build later. |
| Companies House API | Instant, free | Powers intake pre-fill. |
| HMRC developer hub (check-VAT-number) | Instant, open access | No production-approval clock needed in v1. |
| AWS org (eu-west-2) + Managed Grafana/Prometheus | Instant | Terraform-managed from day one; no secrets in repo (D23/D24). |
| **AWS Bedrock model access** (Claude Opus 4.6, Claude Sonnet 4.6, Amazon Nova Lite) | ✅ Enabled and verified 13 Aug 2026 | Verification 8.1 closed: all three invoked on-demand in eu-west-2; D28 model IDs amended, D30 preserved, contingency not needed (ADR 0001). |
| **AWS SES production access** (out of sandbox) + inbound receiving | Request review: ~1–2 days | Needed before any real email leaves or arrives; **W0 verification: inbound receiving region (eu-west-2 vs eu-west-1 receipt bucket — both permitted under the UK/EU rule).** |
| Sentry (EU region org) | Instant | Error tracking with scrubber (D24). |
| **Anthropic account — Claude Code build fleet** | Instant | The agents that build the product (§19); set a spend budget; separate from the product's Bedrock runtime. |
| GitHub organisation + Actions | Instant | Repo, CI, worktree lanes. |
| ICO registration | Before any real customer data | Legal prerequisite; pair with the DPIA. |
| Domains: `neoting.neovogent.com` live; `neoting.com` acquisition | Owner + date needed | Email routing must handle both domains through cutover (D5). |

Removed from the old plan's week 0 (out of scope now): HMRC MTD production approval, Staffology/payroll systems, Apple + Google developer accounts.

---

## 18. Security, data protection & service commitments (summary — enforcement detail lives in the governance file)

- **Tenancy:** practice → client RLS below the application layer; workspace-prefixed S3 keys gated per request by RLS-scoped services, IAM prefix conditions and item-scoped presigned URLs under a per-environment CMK (§15); delegated OTP sessions scoped to requested items only; the CI tenancy suite attempts real cross-tenant and session-overreach access with real tokens and **must fail**.
- **Secure links & OTP:** signed short-lived URLs; 6-digit OTP to the registered mobile; rate limiting per number and per IP; session logging; upload-only scope; forwardability is a feature with *requested-from vs uploaded-by* recorded.
- **Data:** **UK-first residency (D30)** — all storage and processing in eu-west-2 (London); EU only as the **one** named fallback that remains: the cross-region DR backup target, since the UK has a single AWS region. *(The SES inbound-receiving fallback was retired unused on 13 Aug 2026 — verification 8.2 found receiving available in eu-west-2, so the entire email path stays in London. This bullet still read "two named fallbacks" after the v1.4 amendment, contradicting D30 in this same document; corrected here. The DR region is named in ADR 0007.)* AES-256 at rest, TLS 1.3 in transit; AWS Secrets Manager (no secrets in env files or repo); per-integration tokens encrypted in a dedicated vault table with rotation jobs.
- **Backups/DR:** RDS point-in-time recovery (35 days) + nightly logical backups to a second EU region; S3 versioning + replication; **RPO ≤ 15 min, RTO ≤ 4 h**; quarterly restore drills — an untested backup is a hope, not a plan.
- **AI:** no-training DPAs; PII minimisation in prompts; pinned versions per extraction; document text is data, full stop; injection corpus 100% blocked in CI.
- **UK GDPR (D12):** ICO registration + DPIA (bulk financial documents are high-risk processing) before real data; published subprocessor register; data-subject-request tooling (export + erasure with legal-hold override) built in v1; retention clocks (client financial documents 6 years, deletion only on audited instruction); breach runbook with the ICO 72-hour path pre-written; **whole-firm export exists so offboarding is never hostage-taking — self-serve and in-product, never gated on a support ticket, offered again at trial end and through the 90-day post-termination window (D32)**.
- **Application:** Argon2 + mandatory TOTP for privileged roles; offboarding revokes tokens within 60 seconds; append-only hash-chained audit log; **human sign-off on every state change via Review → Approve, enforced server-side**. Penetration test before launch; Cyber Essentials Plus before GA; SOC 2 on the enterprise roadmap.
- **Support & SLA (D31):** pilot commitments, stated in the pilot agreement — `support@neoting…` inbox + status page; severity response targets (working defaults, CEO confirms: SEV1 acknowledged < 1 business hour and worked continuously, SEV2 < 4 business hours, SEV3 < 1 business day); support hours 09:00–18:00 UK working days with SEV1 monitored out-of-hours; incident comms via the status page, SEV1 customer notice within 4 hours. GA adds the contractual SLA: 99.9% monthly availability with service credits and published maintenance windows — always set at or below the internal SLOs (governance §13.3), so nothing is promised externally that isn't alerted on internally.

---

## 19. Build plan

### 19.1 Approach
1. **Contracts before code (D15).** Sprint 0 produces four artefacts treated as law: the OpenAPI spec, the DB schema + RLS policies, the design tokens, and the chat component grammar (+ versioned validator config). Changing a contract is a PR that regenerates every consumer.
2. **Modular monolith, parallel agent lanes.** Each module boundary is a lane owned by a Claude Code agent in its own git worktree; lanes communicate only through the contracts. Every module carries a `CLAUDE.md` (purpose, invariants, tests, current state) read on entry and updated on exit.
3. **Verification is automated, not vibes.** Reviewer and test-writer agents run per PR; CI gates every merge: the golden-path e2e (ingest → ready → chase → publish), the tenancy suite, the extraction eval harness (no regressions; injection corpus 100% blocked), and visual regression on tokens + components. **A lane is done when the gates are green and its use cases demo cleanly — not when the agent says so.**
4. **Humans do judgement:** contract reviews, product calls, weekly demos; a nightly integration agent runs the full suite against staging and files defects with trace IDs.
5. **Non-negotiable invariants:** money is integer pence (lint-enforced, no floats, ever); no state change outside the Review → Approve path; every record carries full lineage; TypeScript strict + Zod at every boundary.

### 19.2 Lane map (parallel from W1)
**A** auth/tenancy/practice-hierarchy + OTP sessions · **B** ingestion & channel routing (web, email, WhatsApp, portal intake) · **C** extraction + eval harness · **D** rules + AI suggestions + NL rule parsing · **E** validation + dedupe · **F** banking (feeds, statements, match, cash coding) · **G** chase engine + OTP portal · **H** approvals · **I** publishing (I1 Xero, I2 QBO) + canonical model + public API · **J** chat framework + component grammar + web shell + design system · **K** clients / team / vault / settings / analytics · **L** notifications + exports + archive & search · **M** voice (thin layer feeding the command processor).

### 19.3 Timeline (week-relative; kickoff date is open decision — D13; each milestone is demoable)

| When | Milestone |
|---|---|
| **W0** | Third-party accounts (§17.3), repo scaffold, local stack via Docker Compose (Postgres, Redis, MinIO, MailHog). Target: **clone-to-running in 10 minutes**. |
| **W1** | Sprint 0 — the four contracts. All lanes start in parallel. |
| **W2** | **Extraction calibration** (D20/D28): Textract thresholds + the vision escalation ladder tuned on the labelled UK corpus behind `DocumentExtractor` — the Sonnet-vision middle rung earns its place here or collapses; effort-map baselines measured; chat walking skeleton (message → schema-validated card renders). |
| **W3** | **Ingest demoable across channels:** web + auto-split, email routing (identity → AI addressee → Unrouted queue), WhatsApp inbound → extract → classify → inbox states, with the editable-OCR overlay. |
| **W4** | Rules engine (four-tier priority, conditional rules, NL rule parsing → Review → Approve rule cards) + AI suggestions with confidence/reasoning/guidance. |
| **W5** | Validate (To Review / Ready / **Rejected-Failed view**, mandatory fields) + multi-signal dedupe with cross-type matching and intentional-duplicate override. |
| **W6** | Bank: TrueLayer sandbox consent journey + statement extraction fallback + Bank Match (credit notes, partial/batch payments, probabilistic tier) + cash coding. |
| **W7** | **The flagship demo — chasing end to end:** five detection engines → composed chase → Review → Approve → SMS + OTP portal → editable-overlay upload → chase auto-close; policy schedule; item messaging. |
| **W8** | Approvals (linear + conditional branching, lock-on-approve) + client onboarding SMS+OTP flow + client management (intake, list, cards, client-scoped AI). |
| **W9** | **Xero adapter:** bills + attachments, two-way reference sync incl. tracking categories, idempotent publish, publish-preview cards. |
| **W10** | **QuickBooks adapter** + integration health panel + Archive (full-text search, move-between-entities with addressee warning) + public API & webhooks. |
| **W11** | Vault (core) + team management & document-workflow tasks + operational analytics + full settings inventory + voice intents live. |
| **W12–14** | Hardening: k6 load (month-end publish burst, chase burst, 10× ingestion soak), penetration test, accessibility pass, DPIA/ICO finalised, **pilot onboarding (10 practices/businesses)**. |

**Result: v1 pilot-complete at the end of W14.** Lanes start in parallel from W1; the order above gates demos and pilot exposure, not starts. Honest caveat to state out loud: wall-clock time approaches the longest lane (extraction + chat framework + chase) only if the contracts week holds and week-0 accounts exist on time.

### 19.4 Phases

| Phase | Contents |
|---|---|
| **v1 (W0–W14 → pilot)** | Everything marked v1 in §2: the full 11-stage pipeline, chat-first UI + Review → Approve, voice, SMS+OTP onboarding & chasing, WhatsApp inbound, single-address email routing, client & team management, Vault core, analytics, settings, **Xero + QBO adapters**, public API + webhooks, exports. |
| **v1.1 (first fast-follow)** | Sage Accounting + FreeAgent adapters (D6) · Vault cloud sync (D8) · SSO Entra ID/Okta (D7) · Zapier app (D9) · PO pull-through on match. |
| **Deferred (no dates committed)** | Supplier-portal fetch robots (failure-transparent design first) · payments/money movement · HMRC MTD filing · ledger-health analytics · mileage & GPS · native mobile apps · desktop-ledger bridges · enterprise ERP adapters. |
| **Rejected (never)** | E-commerce sales connections · financial-statement generation · internal ledger as book of record. |

---

## 20. Metrics (every metric has an owner and a dashboard from day one)

- **Trust:** extraction correction rate trending down month over month · auto-categorisation acceptance rate · publish-failure rate < 1% and always visible.
- **Speed:** extraction p95 < 5 min (digital PDFs) · median document received → Ready · chase-to-upload median response time · time-to-publish.
- **The flagship:** missing-document count per client trending down · chase close rate · % chases closed without accountant intervention.
- **Adoption:** clients onboarded via OTP without support contact · weekly submitting clients · channel mix · % suppliers on auto-publish per client.
- **Business:** practices/businesses live, client-workspace expansion, logo churn, support tickets per 100 active users (the incumbents' loudest weakness) and support response-target attainment (D31), **AI cost per document < £0.02**, per-vendor third-party spend within budget (D33).

---

## 21. Risks & mitigations

| Risk | Sev. | Mitigation |
|---|---|---|
| Extraction accuracy below the trust bar on real UK documents | High | W2 threshold calibration on a labelled corpus; **Claude vision fallback lane** for below-threshold documents (D20); per-field confidence gating routes remaining doubt to humans; editable overlay at upload; manual-entry bypass; per-supplier deterministic rules absorb the common cases; eval harness blocks regressions in CI. |
| Tier misassignment — cost creep (classes promoted) or quality dip (Sonnet underperforms on the volume coding call) | Med | Per-class tier flags move work up or down without deploy, but every flip is blocked unless evals pass for that (class, model) pair; guardrail + per-firm budget alerting catches creep; W2 calibration and pilot correction-rate data decide the coding-suggestion tier empirically; judgment surfaces (chat, rules) are pinned to Opus and exempt from cost-driven demotion (D28). |
| Chat-first UX rejected by conservative practices | High | The sidebar is a complete, conventional fallback — no feature is prompt-only; the component grammar keeps the chat learnable; Review → Approve makes the AI's actions inspectable, which is what builds accountant trust. |
| Agent/team capacity vs the 14-week plan | High | Parallelism only works if the contracts week holds and week-0 accounts exist; the §2 scope fence is the contract — a feature not listed in v1 is not in v1. |
| One wrong number published to a client's books | High | Human sign-off via Review → Approve on every publish; deterministic validators (VAT arithmetic, VRN checksum, date plausibility) run on every document; mandatory-field gates; per-item history and full lineage to the source image; idempotency prevents double-posting. |
| Prompt injection via documents / email / WhatsApp | High | Untrusted-data posture (§16); allow-listed actions; schema-validated outputs; adversarial corpus at 100% blocked in CI. |
| SMS deliverability and cost | Med | Twilio UK sender registration in week 0; per-firm budgets with alerts; quiet hours; delivery-state tracking on every chase; escalation to accountant when SMS fails; email/portal remain inbound response paths. |
| WhatsApp platform dependency | Med | Inbound-only design avoids template approval and business-initiated fees; Meta verification starts week 0; email + web remain full-fidelity intake channels if WhatsApp degrades. |
| TrueLayer sole-provider dependency (D4) | Med | Provider-agnostic interface retained as hedge; statement upload (PDF/CSV/XLSX) is a full fallback so books never stall; consent module isolated from UK payments-law rewrites; revisit the single-provider decision only on SLA evidence. |
| Xero platform economics (March-2026 tiers) | Med | Write-heavy usage sits in the favourable lanes; tier fees are a pricing input (CEO); QBO + public API + exports act as pressure valves; Journals gating is irrelevant to a bills-publisher. |
| Surprise third-party bills (Twilio, Textract, TrueLayer, AWS…) | Med | Central usage & cost telemetry (D33, governance §13.5): per-service dashboards + monthly budget envelopes, AWS Budgets at 50/80/100%, anomaly alerts at > 3× the 7-day baseline, per-firm SMS/AI budgets already enforced; a surprising bill is treated as an alerting failure, not a billing surprise. |
| **Shared AWS account (D36)** — client documents sit in an account that also hosts three unrelated Neovogent products, with six other administrators, under a reseller-owned consolidated-billing org where **SCPs are unavailable** | High | Dedicated KMS key and buckets carry an **explicit Deny** for any principal outside `role/nt-*`, so casual and accidental access is blocked outright; the region guardrail is an IAM policy on every Neoting principal in place of the SCP; organisation CloudTrail and GuardDuty were enabled on day one (neither existed before), so a deliberate policy rewrite is at least recorded. Dedicated `neoting-*` member accounts requested from the payer — until they land, **the DPIA states the account is shared** and the pen-test scope must say so. Everything is Terraform, so the migration is a variable change. |
| Duplicate / fraud abuse | Med | Multi-signal dedupe with cross-type and cross-uploader coverage; supplier-bank-detail extraction powers fraud checks; approval tiers; immutable audit trail names every actor. |
| p95 < 5 min latency target missed under load | Med | Queue-first architecture with per-stage timing in the processing log; manual-entry bypass keeps humans unblocked; k6 ingestion soak at 10× expected volume in W12. |
| Domain cutover breaks email intake | Low | Both `doc@` addresses live and routed identically through cutover (D5); DKIM/SPF/DMARC on both; cutover is a config change, rehearsed in staging. |

---

## 22. Open decisions (for the room — with owners)

1. ~~Kickoff date~~ — **decided (D29): Thursday 13 August 2026**; W0–W14 restated from this date.
2. ~~Approve week-0 signups and spend~~ — **decided (D35): $8,000 AWS envelope across six months, approved 13 Aug 2026.** Long-lead clocks started the same day: Meta business verification, Twilio UK sender registration, TrueLayer production review, SES production access, Textract quota raises. Remaining spend approvals outside AWS (pen test ~£5–15k by W8, test devices, password manager, Anthropic build-fleet ceiling) still sit with the CEO.
3. **Pricing** — flat per-firm bands remain the working position (the market resents per-user creep); exact points, annual discount, and any documents/month fair-use ceiling are the **CEO's call with pilot data**. Xero tier fees are an input.
4. ~~Legal entity~~ — **decided (D34): NEOVOGENT AI SOLUTIONS UK LTD, company no. 15946429.** UK-incorporated, so no Art. 27 representative is needed. Open sub-item for Ops: confirm with the AWS reseller which entity the AWS customer agreement and DPA actually sit with, since the account was inherited rather than opened by us (D36).
5. **Accountant partner** to sanity-check pipeline tax touchpoints (VAT evidence handling, coding conventions) — who, and by when.
6. **Pilot mix** — how many accounting practices vs standalone businesses in the 10.
7. **`neoting.com` acquisition + cutover date** (D5).
8. **Default SMS allowance** — working default set in v1.1 (D27: 200/firm/month, warn at 80%); the pricing owner (CEO) confirms or amends.
9. ~~STT vendor~~ — **decided in v1.1 (D22: Amazon Transcribe).**

---

## 23. Provenance

Compiled 11 August 2026 from: the Document Workflow Edition PRD v2 (11 Aug 2026, competitor facts verified against official documentation and six review platforms on that date), the Neovogent technical implementation plan (10 Aug 2026), and provider documentation (developer.xero.com, developer.intuit.com, developer.sage.com, dev.freeagent.com, docs.truelayer.com, HMRC developer hub, Companies House developer hub, Twilio, Meta WhatsApp Business Platform). A product and planning document, not legal or tax advice. API terms, rate limits, and platform pricing change — re-verify against primary sources during build; the decision log (§0.1) records what was true and decided on this date.

*— End of Source of Truth v1.4 —*