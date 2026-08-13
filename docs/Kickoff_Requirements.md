# NEOTING — Kickoff Requirements & Procurement Checklist

**Version 1.1 · 11 August 2026 · Confidential**
*Changelog v1.0 → v1.1: model list expanded to three tiers (D28); Bedrock verification 8.1 covers Opus 4.8 + Sonnet 4.6 + Haiku 4.5 and per-model effort support; guardrail reference restored to £0.02/doc.*
Companion to the source-of-truth pair (v1.2). This is the complete, actionable list of everything that must **exist before W0 ends** — accounts, purchases, API access, legal prerequisites, verification items, and build inputs — so all lanes can start in W1 with nothing blocked. Every row has an owner column to fill at kickoff; suggested owners use the roles CEO / Eng lead / Integrations lead / Ops.

**How to use it:** work top to bottom — sections are ordered by critical path. An item marked ⛔ blocks a named milestone; start its clock first. Costs marked are order-of-magnitude signals for spend approval, not quotes.

---

## 1. Legal & compliance prerequisites

| # | Item | Owner | Lead time | Cost signal | Blocks |
|---|---|---|---|---|---|
| 1.1 | ⛔ **Legal entity decision** — which entity signs everything below; UK sales likely require a UK entity or UK representative (UK GDPR Art. 27) | CEO | Days–weeks | Incorporation/rep fees | Every contract in this list |
| 1.2 | ⛔ **ICO registration** (data-protection fee) — before any real customer data | CEO/Ops | Days | £40–£60/yr tier-dependent | Pilot onboarding (W12–14) |
| 1.3 | **DPIA started** as a living document (bulk financial documents = high-risk processing) | Eng lead | Start W0, living | — | Pilot; pen-test scoping |
| 1.4 | **DPA/terms inventory:** AWS DPA (covers Textract, Bedrock, Transcribe, SES, RDS, S3 — one umbrella, D20/D22/D23), TrueLayer, Twilio, Meta/WhatsApp, Sentry EU, Anthropic (contingency route only, D22). Confirm **no-training terms** on each AI-touching service (D19) | Ops | Days | — | Traffic to each service |
| 1.5 | **Privacy notice + terms of service draft** incl. AI disclosure, subprocessor register page, SMS/WhatsApp consent language, 6-year document retention statement | CEO/Ops | 1–2 weeks | Legal review fees | Pilot onboarding |
| 1.6 | **PI insurance conversation** opened (needed before GA, not pilot) | CEO | Weeks | Premium TBD | GA only |
| 1.7 | **Cyber Essentials Plus** — book assessment (needed before GA, not pilot) | Ops | Weeks | ~£1.5–2.5k | GA only |

## 2. Domains, DNS & email identity

| # | Item | Owner | Lead time | Cost signal | Blocks |
|---|---|---|---|---|---|
| 2.1 | ⛔ **Delegate `neoting.neovogent.com`** to Route 53 (pre-launch domain, D5) | Ops | Hours | — | SES, portal TLS, everything web |
| 2.2 | **Acquire `neoting.com`** + cutover date named (D5) | CEO | Unknown (negotiation) | Purchase TBD | Launch only — not the pilot |
| 2.3 | **SES domain identities + DKIM/SPF/DMARC** on both domains; both `doc@` addresses routed identically through cutover | Eng lead | Hours after 2.1 | — | Email intake (W3) |
| 2.4 | **Inbound MX** for `doc@` → SES receiving → S3 receipt bucket (region per verification item 8.2) | Eng lead | Hours | — | Email intake (W3) |
| 2.5 | TLS certificates via ACM (workspace, portal, API subdomains) | Eng lead | Hours | — | All web surfaces |

## 3. AWS foundation (one cloud — D20/D22/D23/D24)

| # | Item | Owner | Lead time | Cost signal | Blocks |
|---|---|---|---|---|---|
| 3.1 | ⛔ **AWS Organization**, eu-west-2 default; member accounts: `dev`, `staging`, `prod`; SSO for humans; billing alerts | Eng lead | Hours | Usage-based | Everything |
| 3.2 | **Terraform state bootstrap** (S3 backend + DynamoDB lock) per account | Eng lead | Hours | — | All infra |
| 3.3 | ⛔ **Bedrock model access enablement** — Claude Opus 4.8 + Sonnet 4.6 + Haiku 4.5 in eu-west-2 (access requests are per-account: dev, staging, prod) | Eng lead | Hours–days | Token usage (pipeline guardrail < £0.02/doc) | W2 calibration; every LLM task |
| 3.4 | **Textract + Transcribe** service quotas reviewed/raised for pilot volume (AnalyzeExpense TPS, Transcribe streaming) | Eng lead | Days if raise needed | ~$0.01/page; STT per-minute | W2–W3 |
| 3.5 | ⛔ **SES production access** (sandbox exit request per account) — outbound; plus receiving setup (2.4) | Eng lead | ~1–2 days review | Per-email | Notifications, chases-adjacent email, W3 |
| 3.6 | **Core infra modules:** VPC, RDS Postgres 16 (+ PITR 35d, cross-region logical backup target), ElastiCache Redis, ECS Fargate clusters + ECR, CloudFront + **WAF** (tightest ruleset on the OTP portal), S3 buckets (documents, receipts, exports — versioned, KMS per-workspace context), Secrets Manager, EventBridge/scheduler | Eng lead | W0 build item | Baseline ~low hundreds £/mo pre-traffic | Clone-to-running; staging |
| 3.7 | **Observability:** Managed Prometheus + Managed Grafana workspaces, CloudWatch log groups + retention (30d), OTel collector on ECS | Eng lead | Hours | Modest | W1 onward |
| 3.8 | **ClamAV scanning** path (container/Lambda on S3 upload events) — build item, no external account | Eng lead | W1 build item | Compute only | Ingest (W3) |
| 3.9 | **Self-hosted Unleash** on ECS (D23) | Eng lead | W0–W1 build item | Compute only | All flagged work |

## 4. Third-party accounts & API access

| # | Service | What to do | Owner | Lead time | Cost signal | Blocks |
|---|---|---|---|---|---|---|
| 4.1 | ⛔ **Twilio** | Account; **UK sender/alphanumeric `Neoting` registration**; Verify service (OTP); **buy one UK virtual number** (for WhatsApp registration, 4.2); test credentials for staging | Integrations lead | Sender registration: **days** | Number ~£1–5/mo; SMS ~£0.03–0.04 ea; Verify per-verification | OTP onboarding (W8), chasing (W7) — clock starts night one |
| 4.2 | ⛔ **Meta / WhatsApp Business Platform** | Business Manager; **business verification**; WhatsApp Business app; register the Twilio-bought number; webhook endpoint + token; test number for staging | Integrations lead | Verification: **days–weeks** | Inbound service messages free (D25) | WhatsApp intake (W3) — longest external clock, start night one |
| 4.3 | ⛔ **TrueLayer** | Console account; sandbox immediately; **open the production commercial + compliance review and pricing conversation now** | Integrations lead | Sandbox instant; production **weeks** | Commercial tiers — negotiate | Bank feeds (W6 sandbox; pilot needs production) |
| 4.4 | **Xero developer** | Account + app (OAuth PKCE); demo company; note **March-2026 tier model** — confirm current connection-tier terms and the AI-training ban clause | Integrations lead | Instant | Free to build; tiers at scale | Xero adapter (W9) |
| 4.5 | **Intuit developer** | Account + app; sandbox company; pin `minorversion` | Integrations lead | Instant | Free | QBO adapter (W10) |
| 4.6 | **Sage + FreeAgent developer** | Register now, build v1.1; FreeAgent sandbox at api.sandbox.freeagent.com | Integrations lead | Instant | Free | v1.1 only |
| 4.7 | **Companies House API** | Free key | Integrations lead | Instant | Free | Client intake pre-fill (W8) |
| 4.8 | **HMRC developer hub** | App registration for **check-VAT-number API** only (no MTD production clock in v1) | Integrations lead | Instant | Free | VRN validation (W3) |
| 4.9 | **Sentry** | Org in **EU region**; DSNs per app; scrubber verified | Eng lead | Instant | Team tier ~$26+/mo | W1 onward |
| 4.10 | ⛔ **GitHub organisation** | Org, repo, branch protection, Actions; secrets via OIDC → AWS | Eng lead | Instant | Team ~$4/user/mo | W0 scaffold |
| 4.11 | ⛔ **Anthropic — Claude Code build fleet** | Account + spend budget for the agent lanes (§19 build model); **separate from product runtime (Bedrock)** | Eng lead | Instant | Build-period spend budget — approve a ceiling | All lanes, W1 |
| 4.12 | **Figma** | 1–2 seats for key-screen specs (tokens remain law) | Eng lead | Instant | ~$15/seat/mo | Design QA gate |
| 4.13 | *(Contingency only)* **Anthropic API — product runtime** | Only if verification 8.1 fails; EU processing terms required; ADR logged | Eng lead | Instant | Same guardrail | — |

## 5. Purchases & procurement

| # | Item | Owner | Lead time | Cost signal | Blocks |
|---|---|---|---|---|---|
| 5.1 | **Test devices:** one Moto G-class Android + one mid-range iPhone (real-browser motion + portal QA on 4G) | Ops | Days | ~£350 total | Design QA gate (from W3) |
| 5.2 | ⛔ **Penetration test vendor** — scope + book by **W8** for a W12–13 test window | Ops | Booking lead: weeks | ~£5–15k | Pilot go/no-go (W14) |
| 5.3 | Team password manager (humans; app secrets stay in Secrets Manager) | Ops | Instant | ~£3–6/user/mo | — |
| 5.4 | Status page + support inbox (`support@neoting…`) — lightweight for pilot | Ops | Hours | Free–low | Pilot |

## 6. Build inputs (work items due by end of W1 — no accounts, but the build starves without them)

| # | Item | Owner | Due | Notes |
|---|---|---|---|---|
| 6.1 | ⛔ **Labelled UK document corpus** — target ≥ 500 items: receipts, purchase/sales invoices, credit notes, bank + supplier statements; **synthetic + team-collected only, zero customer data (D19)**; per-field ground truth | Eng lead + everyone with a wallet | End W1 | Feeds W2 calibration + the eval harness; grows continuously |
| 6.2 | **Adversarial injection corpus v1** (documents/emails containing instruction-attacks) | Eng lead | End W1 | CI gate must hold at 100% blocked from first merge |
| 6.3 | **Seed dataset** — demo practice, 3 clients, 40 documents in all states, a month of bank lines, open chases | Eng lead | End W1 | Clone-to-running honesty |
| 6.4 | **VAT-treatment mapping reference** per ledger (our 20/5/0/exempt/reverse-charge → Xero TaxType / QBO TaxCode) | Integrations lead | W1 | Accountant partner sanity-checks (SoT §22.5) |
| 6.5 | **SMS + email template copy** (en-GB): onboarding invite, OTP, chase, reminders, escalation — through Review → Approve wording rules | CEO + Eng lead | W1 | Twilio sender approval may want sample content |
| 6.6 | **Brand asset export** → `packages/tokens` (colours, type, spacing, motion per SoT §14) + logo set for portal/onboarding | Eng lead | W1 | Tokens are a Sprint-0 contract |

## 7. Environment bootstrap — definition of "W0 done"

1. Fresh clone → `pnpm install && docker compose up && pnpm db:migrate && pnpm db:seed && pnpm dev` → running in **≤ 10 minutes**.
2. `pnpm e2e:smoke` green on the walking skeleton.
3. Staging deployed by CI with **real sandboxes wired**: TrueLayer sandbox bank, Xero demo company, Intuit sandbox, Twilio test creds, WhatsApp test number, Bedrock dev access.
4. Both `doc@` domains verified in SES; a test email lands in the receipt bucket and produces an ingest record.
5. Zero secrets in the repo; all in Secrets Manager; OIDC from GitHub Actions works.
6. Dashboards live: error rate, p95, queue age, token spend (even at zero traffic).

## 8. W0 verification items (facts to confirm before contracts freeze — each gets a one-line ADR)

| # | Verify | If it fails |
|---|---|---|
| 8.1 | ⛔ **Bedrock eu-west-2: Opus 4.8 + Sonnet 4.6 + Haiku 4.5 available; per-model effort/thinking support; confirm actual token pricing** against the £0.02/doc pipeline guardrail (D28/D22) | Contingency: Anthropic API with EU processing terms (4.13); guardrail recomputed; ADR logged |
| 8.2 | **SES inbound receiving availability in eu-west-2** | Receive in eu-west-1 (EU — permitted), receipt bucket stays eu-west-2 (governance §12.1) |
| 8.3 | **Per-model effort/thinking-budget support** + enum names + `models.ts` shapes across all three tiers | Pin whatever the API calls them; where a model lacks effort, map to a thinking budget or plain call — the task→(model, effort) map is the contract |
| 8.4 | **Textract `AnalyzeExpense` quotas + per-page pricing** in eu-west-2 at pilot volume | Quota raise (3.4) or batch pacing |
| 8.5 | **Transcribe streaming en-GB** quality sanity on 10 real utterances | Acceptable floor or re-open STT vendor (interface makes it a config swap) |
| 8.6 | **Xero connection-tier terms current** (they changed March 2026) | Feed into pricing; no build impact (we publish bills, not journals) |
| 8.7 | **Meta business verification status** by end of W1 | Escalate; WhatsApp slips to W4 without moving other W3 channels; Twilio-hosted WhatsApp contingency assessed (D25) |

## 9. Critical path, in one paragraph

Night one: name the **legal entity (1.1)** and approve this list's spend — then immediately start the four longest clocks: **Meta business verification (4.2)**, **Twilio UK sender registration (4.1)**, **TrueLayer production review (4.3)**, and **ICO (1.2)**. In parallel the same evening: AWS org + Bedrock access requests (3.1/3.3), SES production access (3.5), GitHub + Anthropic build-fleet accounts (4.10/4.11), and DNS delegation (2.1). Everything else is hours of work inside W0. Book the pen test (5.2) no later than W8. If 8.1 verifies clean and W1's contracts hold, no external dependency blocks the W14 pilot.

*— End of Kickoff Requirements v1.0 —*
