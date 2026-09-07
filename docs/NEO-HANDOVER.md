# Neoting (Neo Accounting, UK) — engineering handover

**Written:** 2026-09-07 · **Branch audited:** `item-54-tasks`, including the uncommitted item-54 working tree · **Audience:** the AI assistant and product team planning an Australian version and an MVP on top of this codebase.

**Status legend:** `DONE` (built, wired, tested) · `PARTIAL` (works, with named gaps) · `STUB` (UI or interface exists, nothing real behind it) · `MISSING` (not present).

**Governing documents, in reading order:** `CLAUDE.md` (repo entry point) → `docs/Source_Of_Truth.md` (scope, v1.6) → `docs/Engineering_Governance.md` (engineering rules, v1.6) → `docs/Team_Engineering_Guideline.md`. Conflict rule: Source of Truth wins on scope, Governance wins on process. The release being built is **Initial Delivery (ID)**, not v1 — a narrower product with a complete spine, with its own scope fence (SoT §24, decisions D39–D49).

**Already in the repo and directly relevant to the Australia work:** `docs/research/australia-market-entry.md` — 333 lines, dated 3 Sep 2026, a verified gap analysis with regulatory citations, a UK→AU terminology table, a competitive survey, and a tiered gap list with effort estimates. Section 13 below is grounded in it and should not be re-derived from scratch.

---

# 1. One-paragraph summary

Neoting is a chat-first document-to-bookkeeping platform for UK accounting practices. A client's receipt, invoice or bank statement arrives by web upload, email, WhatsApp or a phone-link portal; the pipeline sanitises it, stores the original immutably in S3, reads it with Amazon Textract and Claude on Bedrock, de-duplicates it against what the client has already sent, suggests a category against a per-client chart of accounts, matches it against imported bank-statement lines, and chases the client by email or SMS for anything missing — then routes every state change through a Review → Approve gate that only the practice's super admin can release, and emits a VT Transaction+ or generic CSV import file with a resolvable link back to the source image. The primary user is the **accountant or bookkeeper at a practice** (multi-client workspace, chat + board UI); the secondary user is the **business owner or their staff** (a lightweight OTP-authenticated client portal for uploading documents and answering chases); a standalone business with no practice above it is a supported but thinner shape. Maturity: **pre-first-paying-client, feature-rich, unevenly wired.** The backend spine — tenancy with row-level security, ingestion, extraction, coding, approvals, export, billing, portal — is genuinely built and covered by 256 test files; the accountant-facing web app is a hybrid in which three data slices (documents, bank transactions, businesses) read the live API and the rest still render synthetic generators; there is no ledger integration of any kind (deliberately, decision D42), no bank feed (D40: manual statement upload only), no obligations calendar at all, and roughly 50 `DEMO-MOCK` markers name what is fixture rather than real.

---

# 2. Tech stack and repo layout

## 2.1 Stack

| Layer | Choice | Version / detail | Where |
|---|---|---|---|
| Language | TypeScript | 5.6.x, `"type": "module"` throughout, Node ≥ 22 | `tsconfig.base.json`, `.nvmrc` |
| Package manager | **pnpm only** | `pnpm@9.12.0`, workspaces | `package.json`, `pnpm-workspace.yaml` |
| Monorepo runner | Turborepo | 2.1.x, strict env mode with a `globalEnv` allow-list | `turbo.json` |
| API framework | NestJS | 10.x on Express 4 | `apps/api/package.json`, `apps/api/src/main.ts` |
| Web framework | React 19 + Vite 6 | Tailwind CSS 4 (`@tailwindcss/vite`), `motion`, `lucide-react` | `apps/web/package.json` |
| Client data layer | TanStack Query 5 | MSW 2 for the mocked mode | `apps/web/src/api/queryClient.ts` |
| i18n | react-intl 7 / FormatJS | `en-GB` is the only locale | `apps/web/src/i18n/index.ts` |
| Database | PostgreSQL | Docker `postgres` service locally; RDS in staging/prod; RLS enforced | `docker-compose.yml:107`, `prisma/sql/rls.sql` |
| ORM | Prisma | 5.22.x, `fullTextSearch` preview enabled | `prisma/schema.prisma:18` |
| Queue / background jobs | BullMQ 6 on Redis (ioredis 6) | selectable `fixture` \| `bullmq` | `apps/api/src/modules/ingestion-routing/queue/` |
| Cache / counters | Redis | AI budget ledger, email rate limit, idempotency, webhook replay | `apps/api/src/common/ai-budget.ts` |
| Object storage | S3 / MinIO (`@aws-sdk/client-s3` 3.1110.0) | selectable `fixture` \| `s3`; presigned PUT/GET | `apps/api/src/modules/ingestion-routing/storage/` |
| Search | **MISSING** | `fullTextSearch` preview flag is on but unused; `archive-vault-search` is an empty directory | `apps/api/src/modules/archive-vault-search/` |
| Real-time layer | **MISSING** | No WebSocket, no SSE. Notifications are a 30 s poll of `GET /v1/notifications` | `apps/web/src/components/NotificationsBell.tsx` |
| OCR / table extraction | **Amazon Textract** | sync `AnalyzeDocument` for images and 1-page PDFs; async `StartDocumentAnalysis` from S3 for multi-page | `apps/api/src/common/ocr/textract-ocr-reader.ts` |
| LLM provider | **AWS Bedrock** — Anthropic Claude + Amazon Nova | `@anthropic-ai/bedrock-sdk`, region-pinned `eu-west-2`, model IDs pinned in code | `apps/api/src/modules/chat-framework/provider/bedrock-provider.ts`, `.../models.ts` |
| Email | Amazon SES v2 out; SMTP→MailHog for dev; inbound via an SES receipt rule writing to S3 | selectable `demo` \| `smtp` \| `ses` | `apps/api/src/modules/notifications/` |
| SMS | **AWS End User Messaging** (`@aws-sdk/client-pinpoint-sms-voice-v2`) | selectable `demo` \| `email` \| `aws`. Twilio env vars survive; **no Twilio client exists in code** | `apps/api/src/modules/chase/aws-sms-sender.ts` |
| WhatsApp | Meta Cloud API (Graph) webhook + media fetch | HMAC-verified webhook, `fixture` \| `graph` media fetch | `apps/api/src/modules/ingestion-routing/webhooks/whatsapp/` |
| Payments | Stripe, via a hand-rolled HTTP client (no SDK) | Checkout Session + Billing Portal + signature-verified webhook | `apps/api/src/modules/billing/http-stripe-client.ts` |
| Image handling | `sharp` 0.35.3, `heic-decode` 2.1.0 | EXIF strip, HEIC decode, perceptual dHash | `apps/api/src/modules/ingestion-routing/lib/sanitisation/` |
| PDF safety | `qpdf` binary, selectable `fixture` \| `qpdf` | encryption / JS detection | `.../sanitisation/qpdf-document-guard.ts` |
| Antivirus | ClamAV defined in Terraform — **interface only in code** | `fixtureVirusScanner` matches the EICAR string and nothing else | `.../sanitisation/virus-scan.ts`, `infra/envs/staging/clamav.tf` |
| Auth | Own implementation: scrypt passwords, HMAC stateless session cookie, TOTP via `otplib` 13, separate OTP portal sessions | no Auth0, no Cognito | `apps/api/src/modules/auth-tenancy/` |
| Contracts | OpenAPI 3 → orval-generated Zod schemas, TS models, React-Query client | 10,543-line spec, 76 paths | `packages/contracts/openapi.yaml` |
| Hosting | **API + workers:** AWS ECS Fargate, ARM64/Graviton, behind an ALB, `eu-west-2`. **Web:** Vercel static, with a `/v1/*` rewrite to the API | `infra/envs/{staging,prod}/`, `vercel.json`, `apps/api/Dockerfile` |
| IaC | Terraform — `account`, `staging`, `prod` envs plus shared modules | `infra/` |
| CI/CD | GitHub Actions: a nine-stage `check` workflow fronted by a readiness probe, plus `deploy-web.yml` and `terraform.yml` | `.github/workflows/` |
| Containerisation | Docker Compose locally (postgres, redis, minio, minio-init, mailhog, migrate, api, workers, web, unleash, unleash-init); one image, three commands, in production | `docker-compose.yml`, `apps/api/Dockerfile` |
| Monitoring / logging | CloudWatch via Terraform; structured JSON log lines carrying `traceId`. **No APM, no Sentry, no OpenTelemetry** | `infra/envs/*/observability.tf`, `apps/api/src/common/trace/` |
| Feature flags | A `feature_flags` table and an Unleash container in compose — **nothing in application code reads either** | `prisma/schema.prisma:1837`, `docker-compose.yml:350` |

Two pinning decisions are load-bearing and documented in-file: the AWS SDK packages are pinned to an exact `3.1110.0`, and **Bedrock model IDs are pinned in code and deliberately not exposed as an env var** (`apps/api/src/modules/chat-framework/models.ts` — a model upgrade must be a PR that also passes the eval suite).

## 2.2 Repo layout — top two levels

```
neoting/
├─ apps/
│  ├─ api/            NestJS API + BullMQ workers + all Prisma access. Every piece of server logic.
│  └─ web/            React/Vite SPA: accountant workspace, client portal, landing page, legal pages.
├─ packages/
│  ├─ contracts/      openapi.yaml (LAW) + orval-generated Zod, TS models, React-Query client.
│  ├─ component-grammar/  S0 scaffold — package.json only, no sources.
│  ├─ tokens/         S0 scaffold — package.json only, no sources.
│  ├─ ui/             S0 scaffold — package.json only, no sources.
│  └─ validators/     S0 scaffold — package.json only. Validators actually live inline in apps/api.
├─ services/
│  └─ extraction/     S0 scaffold — CLAUDE.md + package.json only. Extraction lives in apps/api.
├─ prisma/            schema.prisma (LAW), seed.ts, 14 migrations, sql/{rls,app-role,tenancy-check}.sql
├─ e2e/               S0 scaffold — package.json + README only. No Playwright suite exists.
├─ evals/             AI eval harness: 4 JSONL datasets, 3 runners (chat, coding, workflow).
├─ fixtures/          synthetic/ — HTML source documents used to generate test invoices and statements.
├─ infra/             Terraform: envs/{account,staging,prod} + modules/{data,network,storage,iam-policies}.
├─ scripts/           demo/ (seed reset, statement + invoice generators), billing/, measure/, smoke/.
├─ docs/              Source of truth, governance, ADRs, runbooks, reviews, research (incl. Australia).
├─ .github/           workflows/{check,deploy-web,terraform}.yml + scripts/apply-branch-protection.sh
└─ .claude/ .husky/ .scratch/   local tooling
```

Root files worth knowing: `docker-compose.yml` (the whole local stack, heavily commented), `.env.example` (18 KB, 69 documented variables), and three **expired historical records that govern nothing** — `METH_MODE.md`, `PROJECT_STATUS_2026-08-17.md`, `docs/DEMO_SCRIPT_2026-08-21.md`. `CLAUDE.md` says so explicitly; do not treat any of them as a roadmap.

## 2.3 Workspace reality check

Six workspace entries (`packages/ui`, `packages/tokens`, `packages/component-grammar`, `packages/validators`, `services/extraction`, `e2e`) are **S0 scaffolds** whose `test`, `lint` and `typecheck` scripts are literally `echo "…no tests yet (S0)"`. The CI readiness probe in `.github/workflows/check.yml` detects this by rejecting any script whose body begins with `echo`, and skips the corresponding pipeline stage with a `NOT IMPLEMENTED` label rather than reporting a false green. Treat the scaffolds as intent, not as code — in particular, **`packages/validators` is empty and the real validators are inline in `apps/api/src/modules/extraction/` and `.../validation-dedupe/`**.

---

# 3. Architecture

## 3.1 Service map

```
                        ┌──────────────────────────────────────────────┐
   accountant  ────────▶│  apps/web  (React SPA, Vercel)               │
   client      ────────▶│  /app workspace · /p/<token> portal ·        │
                        │  / landing · /legal                          │
                        └───────────────┬──────────────────────────────┘
                                        │ HTTPS  /v1/*  (Vercel rewrite → ALB)
                                        ▼
   Meta WhatsApp ──webhook──▶┌────────────────────────────────────────┐
   Stripe        ──webhook──▶│  apps/api  (NestJS on ECS Fargate)     │
   SES inbound ──S3 bucket──▶│                                        │
                             │  TraceMiddleware → ContextMiddleware   │
                             │      → ScopeContext (ALS)              │
                             │  ProblemFilter (RFC 7807, NT-* codes)  │
                             │  22 feature modules (§3.2)             │
                             └──┬───────┬────────┬───────┬────────┬───┘
                     scopedDb()  │       │ BullMQ │       │Bedrock│ SES / EUM SMS
                                ▼       ▼        ▼       ▼        ▼
                        ┌───────────┐ ┌─────┐ ┌───────┐ ┌──────┐ ┌────────┐
                        │ Postgres  │ │Redis│ │  S3   │ │Claude│ │Textract│
                        │ + RLS     │ │     │ │ MinIO │ │ Nova │ │        │
                        └───────────┘ └─────┘ └───────┘ └──────┘ └────────┘
                                ▲
                                │  same image, different command
                        ┌───────┴────────────────────────────────┐
                        │ workers:  worker/main.ts (ingest)      │
                        │           worker/email-intake-main.ts  │
                        └────────────────────────────────────────┘
```

Everything is one deployable image (`apps/api/Dockerfile`) run three ways: `api`, `workers`, and a one-shot `migrate` task. There are no microservices; `services/extraction/` is an empty scaffold.

## 3.2 Modules (`apps/api/src/modules/`), by non-test source-file count

| Module | Files | Owns |
|---|---:|---|
| `ingestion-routing` | 66 | Web upload, email intake, WhatsApp webhook + media, sanitisation, dedupe hashing, BullMQ queue, S3 store, routing |
| `exports-public-api` | 30 | Canonical row model, VT + generic CSV emitters, ZIP bundle + manifest, `/d/{code}` capability links |
| `validation-dedupe` | 30 | Document state machine, readiness gate, duplicate resolution, **the 18 proposal executors** |
| `auth-tenancy` | 30 | Sessions, passwords, TOTP, invites, email verification, password reset, practice signup, businesses |
| `portal` | 23 | Client-side OTP portal: sessions, uploads, documents, people, business profile, onboarding |
| `chat-framework` | 23 | Workspace chat: prompts, Bedrock provider, circuit breaker, grounding, conversations, suggestions |
| `rules-suggestions` | 22 | Chart of accounts + 4 business profiles, coding ladder, capital/revenue rules, supplier memory, escalation |
| `approvals` | 18 | Review → Approve engine, `assertCan` release gate, canonical hash, rendered summary, audit chain, workflow drafts |
| `billing` | 18 | Stripe checkout/portal, webhook, entitlement, signature verification |
| `chase` | 17 | Detection engine (a), suppression, auto-close, SMS/email senders, portal links, statement requests |
| `banking-matching` | 16 | Statement parse/ingest/completeness, bank transactions, match suggester |
| `notifications` | 16 | Outbound email composition + transports, rate limits, in-app inbox |
| `clients-team-settings` | 13 | Client intake, practice team, business profile, setup links |
| `extraction` | 12 | Extractor seam, Bedrock extractor + schema, demo extractor, field geometry, pipeline step |
| `publishing` | 11 | `LedgerAdapter` interface + `DemoXeroAdapter` only; publish projection and preview |
| `tasks` | 7 | Practice checklist and teams (landed 7 Sep 2026, review item 54) |
| `documents` | 6 | Document read + management surface |
| `health` | 2 | `/healthz` |
| `analytics`, `archive-vault-search`, `voice` | **0** | **Empty directories containing only a `CLAUDE.md`. No code at all.** |

Module boundaries are lint-enforced: `apps/api/eslint/no-cross-module-internals.js` forbids reaching into another module's internals; each module exposes an `index.ts` seam. `common/` is deliberately exempt.

## 3.3 Request flow (a) — a document is uploaded and becomes an accounting entry

```
 upload / email / WhatsApp
   │
   ├─ WEB:      POST /v1/document-uploads → HMAC-signed uploadId + presigned PUT
   │            (UPLOAD_URL_SECRET, 15 min TTL) → POST /v1/document-uploads/{uploadId}/complete
   │            apps/api/src/modules/ingestion-routing/web-upload/
   ├─ EMAIL:    SES receipt rule → S3 `inbound/` → email-intake worker polls → postal-mime parse
   │            → sender map (D45: known senders only) → practice anchor
   │            apps/api/src/modules/ingestion-routing/email/inbound/
   └─ WHATSAPP: POST /v1/webhooks/whatsapp (HMAC + timestamp + replay store) → phone_number_id
                → practice (Practice.whatsappPhoneNumberId, or the WHATSAPP_PRACTICE_MAP override)
                apps/api/src/modules/ingestion-routing/webhooks/whatsapp/
   ▼
 SANITISATION   lib/sanitisation/pipeline.ts
   format detect → zip safety → virus scan (fixture) → PDF guard (qpdf: encryption / JS) →
   image normalise (sharp: EXIF strip, HEIC decode) → safe basename
   ▼
 STORE + ENQUEUE   storage/s3-document-store.ts + queue/bullmq-ingest-queue.ts
   S3 key under `w/`, sha256 byte hash, perceptual dHash for images
   ▼
 SINK   queue/document-sink.ts → `documents` row, state RECEIVED, channel + practice anchor,
                                  `notifications` row `document.received`
   ▼
 DEDUPE   queue/duplicate-detector.ts → exact byteHash (indexed) + pHash Hamming ≤ 10 over the
                                        newest 500 images → `duplicates` rows, verdict PENDING
   ▼
 EXTRACTION   extraction/extraction-pipeline.ts
   RECEIVED → PROCESSING (visible immediately)
   ├─ OCR rung: Textract text + tables (STATEMENT_READER=textract) — one call, result passed forward
   ├─ Extractor (EXTRACTOR=demo|bedrock|replay): Claude reads the image, forced tool call, strict
   │   Zod parse → docType, supplier, dates, currency, totalPence, taxPence, vatNumber, line items
   ├─ Validators, inline: checkVatArithmetic (net+tax=gross ±1p), field-geometry cross-check
   ├─ Coding advice: rule tier → supplier memory → deterministic rules → model rung → escalation
   └─ Writes `extractions`, `suggestions`, the denormalised header on `documents`, `document_events`
   PROCESSING → READY | TO_REVIEW | FAILED   (validation-dedupe/readiness.ts: READY requires
     type ∧ non-zero total ∧ supplier ∧ category ∧ no failed validator)
   ▼
 MATCH SUGGESTER   banking-matching/suggestion/match-suggester.ts
   exactly one candidate or nothing → `matches` row SUGGESTED, transaction matchState SUGGESTED
   ▼
 CHASE AUTO-CLOSE   chase/auto-close.ts → an open chase whose document just arrived becomes CLOSED_RECEIVED
   ▼
 HUMAN   Review → Approve (§3.6) → `publishes` rows → `exports` file
```

The whole extraction path runs **outside any database transaction** — Textract takes 40–60 s on a 29-page PDF and `scopedDb` has a 10 s transaction timeout. This is documented at `apps/api/src/common/ocr/textract-ocr-reader.ts:43`.

## 3.4 Request flow (b) — a suggestion or reminder is generated and shown

There are five distinct mechanisms and **they do not share a scheduler**.

```
1. CODING SUGGESTION (per document, in-pipeline)
   extraction-pipeline → coding-advice.ts → rules-suggestions/coding/coding-decision.ts
   Ladder: USER rule → PAYMENT_METHOD rule → SUPPLIER_CUSTOMER rule → supplier memory
           → deterministic capital/revenue rules → Bedrock judgment rung → escalation reason.
   Writes `suggestions` rows (field, value, confidence, reasoning, sourceRuleId).
   Shown on the document card and in the correction dialog. A suggestion gates nothing.

2. MATCH SUGGESTION (document ↔ bank line)
   match-suggester.ts, run on extraction completion. Shown on the Bank screen as SUGGESTED.

3. CHASE (the client-facing reminder)
   Detection: chase/detection.ts — engine (a) UNMATCHED_TRANSACTION only.
   Four gates: chaseSuppressed flag · descriptor keyword list · matchState = UNMATCHED ·
               "a chase already covers this item" (in ANY state).
   Composition: validation-dedupe/proposals/compose-chase-send.ts (server-composed body)
   → ActionProposal `chase.send` → super admin approves → chase/select-sms-sender.ts
   → SmsLog / ChaseMessage rows, portal link minted with PORTAL_LINK_SECRET.
   ⚠ NO SCHEDULER EXISTS. Detection runs only when a surface asks (Chases board, chat
   LIVE_MISSING, bank-row selection). `Chase.schedule` is a JSON column nothing writes a
   cadence into; ChaseState declares REMINDED and ESCALATED and nothing transitions into them.

4. CHAT SUGGESTIONS (the prompt chips above the chat box)
   chat-framework/suggestions.service.ts, judgment tier at effort low — proposes what to ask,
   grounded in the client's real counts. Rendered by apps/web/src/lib/promptSuggestions.ts.

5. IN-APP NOTIFICATIONS
   `notifications` rows written by: document-sink (`document.received`), portal-upload-notifier,
   chase auto-close and statement-request (`chase.closed`), action-proposals
   (`action_proposal.executed` / `.denied`), portal-business-profile (`business.profile.updated`),
   tasks (`task.assigned`). Read via GET /v1/notifications; the web bell polls every 30 s.
```

## 3.5 Request flow (c) — data pushed to or pulled from an external accounting system

**There is none, and that is a deliberate product decision rather than an omission.**

- Decision **D42** (ID only) supersedes D6: no ledger API, no auto-publish. Export is the sole egress. `Published` is an internal state meaning *approved and released for export*; it asserts nothing about any ledger, and no surface may imply otherwise.
- `apps/api/src/modules/publishing/select-ledger-adapter.ts` returns `DemoXeroAdapter` and nothing else; `LEDGER_ADAPTER` is an enum with exactly one value, `demo`. `demo-xero-adapter.ts` opens no socket — it hashes the document id for a fake external reference and fails deterministically for one seeded supplier (`british gas`).
- The real path is:

```
 documents in READY state
   ▼
 ActionProposal `publish.batch`  (up to 500 items)
   review card shows the server-computed entry preview; approve is hash-checked
   ▼
 post-commit follow-up   validation-dedupe/proposals/publish-follow-up.ts
   `publishes` rows QUEUED → DemoXeroAdapter → SUCCEEDED | FAILED
   (never inside the tenant transaction — an external call must not hold row locks)
   ▼
 POST /v1/exports   exports-public-api/api/exports.service.ts
   documents → canonical rows (canonical/canonical-row.ts: debit-positive / credit-negative,
   integer pence) → emitter (VT Transaction+ | GENERIC_CSV) → CSV, plus an optional ZIP bundle
   carrying HOW-TO-IMPORT.txt and the source documents (bundle/manifest.ts)
   ▼
 every exported row carries a capability code → GET /d/{code} resolves to the source document
   (D43; the ONE route outside the session wall; per-practice TTL, revocable, access-counted)
```

- `Integration`, `ReferenceSync` and `IntegrationKind {XERO, QUICKBOOKS, SAGE, FREEAGENT, VT, MANUAL}` exist in the schema and are **unused by any code path** other than as a nullable foreign key on `Publish`.
- `XERO_CLIENT_ID/SECRET`, `INTUIT_CLIENT_ID/SECRET`, `TRUELAYER_CLIENT_ID/SECRET`, `HMRC_CLIENT_ID/SECRET` and `COMPANIES_HOUSE_API_KEY` are declared in `.env.example` and **read nowhere in `apps/api/src`**.

## 3.6 The Review → Approve spine

The single most important architectural invariant; it constrains every feature.

- **No state change may happen outside an `ActionProposal`** (Governance §10). 18 proposal kinds are declared at `packages/contracts/openapi.yaml:7745`; 16 have executors and 2 (`document.move-business`, `document.split`) throw `ProposalNotImplementedError` by design.
- Lifecycle: `CREATED → REVIEWED → APPROVED → EXECUTED`, plus `CANCELLED`, `DENIED`, `EXPIRED`. **Approve is unreachable until the review has been opened**, enforced server-side (`NT-PRP-002`), not in the UI.
- The rendered summary is hashed (`renderedSummaryHash`); if the underlying facts drift between review and approve, the approval is refused (`NT-PRP-004`).
- `assertCan(actor, action, resource)` — `apps/api/src/modules/approvals/assert-can.ts` — gates release. The releaser must be **`PRACTICE_ADMIN` AND `memberships.is_owner`**, the strict reading of D44. There is **no ownership-transfer operation**, which is a named bus-factor risk in that file's header.
- Every executed proposal appends to a hash-chained `audit_events` table (`seq`, `previousHash`, `hash`, `inputHash`, `modelId`, `promptVersion`, `payloadHash`).
- Executors are total over the contract enum by a mapped type, so forgetting a kind fails `pnpm typecheck` (`validation-dedupe/proposals/registry.ts`).

## 3.7 Where business logic lives vs where it is scattered

**Consolidated and well-placed:**

- Tenancy — exactly one door, `apps/api/src/common/db/scoped-db.ts`, lint-enforced (`unscoped-query`).
- Money — integer pence, no floats anywhere. `packages/contracts/scripts/enforce-money-int.mjs` enforces it in generated code; `apps/api/eslint/money-selectors.test.js` guards call sites.
- Environment — `apps/api/src/config/env.ts` is the only file permitted to read `process.env`; 935 lines, Zod-validated, with production boot refusals for every `demo`/`fixture` mode.
- Chart of accounts and coding rules — `apps/api/src/modules/rules-suggestions/`.
- Export shaping — canonical model plus per-target emitters, `exports-public-api/`.
- Prompts — `chat-framework/prompts/` and `rules-suggestions/coding/coding-instructions.ts`, versioned in code, never in a dashboard or env var.

**Scattered or duplicated — some by design, some by drift:**

- **Correction checks exist twice** — `apps/api/src/modules/validation-dedupe/correction-checks.ts` and `apps/web/src/lib/correctionChecks.ts` — deliberately mirrored, with a comment saying they must move together.
- **Readiness placeholders exist twice** — `apps/api/src/modules/validation-dedupe/readiness.ts` and `apps/web/src/lib/readiness.ts`.
- **`CorrectionOpinionVerdicts` is declared twice on purpose**, so a drift becomes a compile error at the composition root.
- **The web app carries a second, synthetic implementation of most of the domain**: `apps/web/src/lib/{seed,seed2,generate,ingest,matching,dedupe,detection,ruleParser,workflowParser,exportRules,readiness,tableImport,spreadsheet}.ts`. These are the demo generators — roughly 5,000 lines of parallel business logic that will diverge from the server's. **Only three slices have been migrated off them** (see §5, "Live vs synthetic").
- **Currency formatting exists in at least six places**: `apps/api/src/modules/validation-dedupe/correction-checks.ts` (`money`), `.../approvals/render-summary.ts:798`, `.../chase/sms-copy.ts:179` (`formatGbp`), `.../chat-framework/grounding.ts:224`, `apps/web/src/lib/resolver.ts:270`, `apps/web/src/api/document-detail.ts:341`.
- **`DEFAULT_APP_ORIGIN` is hardcoded twice** (in `clients-team-settings` and `auth-tenancy`) alongside the `APP_ORIGIN` env var — acknowledged at `apps/api/src/config/env.ts:324`.
---

# 4. Data model

Schema: **`prisma/schema.prisma`** (1,847 lines, declared `LAW` under Governance G7 — it changes only via a contract-change issue approved before a PR opens). Migrations: `prisma/migrations/` (14, from `20260813154540_init` to `20260907160000_approval_workflow_branches`). Row-level security: `prisma/sql/rls.sql` (612 lines); the application role is created by `prisma/sql/app-role.sql`; `prisma/sql/tenancy-check.sql` is a standalone verifier run by `pnpm db:tenancy-check`.

**43 models, 21 enums.** Every monetary column is `Int` and named `*Pence`. Every timestamp is UTC.

## 4.1 Tables

### Identity and tenancy

| Table | Purpose | Key fields | Relationships |
|---|---|---|---|
| `practices` | The accounting firm — top tenancy anchor | `id`, `name`, `countryCode` ("GB"), `baseCurrency` ("GBP"), `language` ("en-GB"), `vatNumber`, `vatRegistered`, `yearEndMonth/Day`, `documentLinkTtlDays`, `whatsappPhoneNumberId` (unique) | → businesses, memberships, invites, guidance, documents, proposals, otpSessions, chatConversations, teams |
| `businesses` | A client workspace. `practiceId` null = standalone business | `name`, `tradingName`, `companyNumber`, `legalStructure`, `industry`, `registeredAddress` (Json), `countryCode`, `baseCurrency`, `vatRegistered`, `vatNumber`, `vatScheme`, `vatFrequency`, `vatPeriodStart`, `yearEndMonth/Day`, `contextQuestionnaire` (Json), `nextDeadline`, `isActive`, `offboardedAt`, `erasureRequestedAt`, `stripeCustomerId` (unique), `subscriptionStatus`, `plan`, `subscriptionCurrentPeriodEnd` | practice? → 20 child collections |
| `users` | People who sign in. `kind` HUMAN \| SYSTEM (workers need an actor for RLS) | `email` (unique, nullable), `emailVerified`, `passwordHash`, `totpSecretRef`, `totpEnabledAt`, `deactivatedAt` | → memberships, sessions, approvals, proposals, teamMemberships |
| `memberships` | Role per account. Fine-grained permissions checked at call sites, never by role alone | `role` (WorkspaceRole), `permissions` String[], `hideFinancialFields`, `isOwner` | user × (practice? \| business?) — `@@unique([userId, businessId])` |
| `contacts` | Client-side people who may be a verified mobile and nothing else | `firstName/lastName`, `role` (free-text job title), `mobileE164`, `mobileVerifiedAt`, `email`, `isPrimary`, `receivesChases`, `whatsappOptIn`, `portalRole`, `canSendDocuments`, `canSeeTotals`, `deactivatedAt` | business → otpSessions, chases |
| `invites` | Practice or business invitation tokens | `email`, `mobileE164`, `role`, `tokenHash` (unique), `expiresAt`, `acceptedAt`, `hideFinancialFields`, `businessIds` String[], `invitedByUserId` | practice?, business?, invitedBy? |
| `sessions` | Refresh-token sessions | `refreshTokenHash` (unique), `deviceLabel`, `ipHash`, `userAgentHash`, `expiresAt`, `revokedAt` | user |
| `otp_sessions` | Portal / delegated-upload OTP grants | `scope` (ONBOARDING \| DELEGATED_UPLOAD \| ITEM_MESSAGE), `grantedItemIds` String[], `otpHash`, `otpExpiresAt`, `attempts`, `lockedUntil`, `verifiedAt`, `linkTokenHash` (unique), `expiresAt` | contact?, user?, chase?, practice? |
| `teams` | Named groups inside a practice | `name` — `@@unique([practiceId, name])` | practice → members |
| `team_members` | Join table | composite PK `[teamId, userId]` | team, user |

### Documents and the pipeline

| Table | Purpose | Key fields | Relationships |
|---|---|---|---|
| `documents` | The central record | `s3Key`, `originalFilename`, `mimeType`, `byteSize`, `byteHash`, `perceptualHash`, `channel` (DocumentChannel), `submitterUserId`, `submitterLabel`, `receivedAt`, `receivedLocal`, `routingDecision` (Json), `routingConfidence`, `inbox` (COSTS\|SALES\|UNROUTED), `state` (DocumentState), `docType`, **denormalised header**: `supplierName`, `customerName`, `documentDate`, `dueDate`, `currency`, `totalPence`, `taxPence`, `reference`, `categoryCode` (free text, no FK), `description`, `projectRef`; `failureCode/Message`, `parentDocumentId` + `pageRange` (split), `archivedAt`, `deletedAt` (soft delete) | practice?, business?, owner?, self-referencing split; → extractions, events, suggestions, duplicates, matches, publishes, itemThreads, approvals, links |
| `extractions` | One row per extraction attempt; originals are immutable, corrections are new rows | `fields` (Json), `extractorKind`, `modelVersion`, `promptVersion`, `ladderRung`, `overallConfidence`, `validatorResults` (Json), `isAccepted`, `keyedByUserId` | document |
| `document_events` | Pipeline telemetry per stage | `stage`, `outcome`, `durationMs`, `traceId`, `detail` (Json) | document |
| `duplicates` | Suspected duplicate pairs | `documentAId`, `documentBId` (`@@unique`), `signals` (Json), `score`, `verdict` (PENDING \| CONFIRMED_DUPLICATE \| CONFIRMED_DIFFERENT \| KEEP_BOTH), `decidedByUserId`, `decidedAt` | two documents |
| `suggestions` | Per-field coding suggestions | `field`, `value` (Json), `confidence`, `reasoning`, `sourceRuleId`, `sourceGuidanceId`, `modelVersion`, `acceptedAt`, `dismissedAt` | document |
| `item_threads` | Q&A against one document | `question`, `answer`, `askedByUserId`, `answeredVia` | document |

### Rules and guidance

| Table | Purpose | Key fields |
|---|---|---|
| `rules` | Coding rules, four tiers | `tier` (USER \| PAYMENT_METHOD \| SUPPLIER_CUSTOMER \| ACCOUNT_DEFAULT), `scopeKey`, `conditions` (Json), `sets` (Json), `isActive`, `createdVia`, `actionProposalId` |
| `guidance` | Free-text practice/account guidance fed to the model | `level` (ACCOUNT \| PRACTICE_CORE \| PRACTICE_SHARED), `mode` (MANUAL_REVIEW \| AUTO_APPLY), `text`, `isActive` |

### Banking

| Table | Purpose | Key fields |
|---|---|---|
| `bank_connections` | Feed consent — **schema only, no code writes it** | `provider` (default `"truelayer"`), `providerRef`, `institutionName`, `consentState` (PENDING\|ACTIVE\|RECONFIRM_DUE\|LAPSED\|REVOKED), `consentedAt`, `reconfirmDue`, `tokenRef` |
| `bank_accounts` | An account, real or synthetic ("Uploaded statements") | `displayName`, `accountType`, `currency` (default `"GBP"`), **`sortCode`**, `accountLast4`, `balancePence`, `balanceAt` |
| `bank_transactions` | Statement lines | `providerTransactionId`, `bookedAt`, `amountPence` (signed; negative = out), `currency`, `descriptionRaw`, `merchantName`, `classification`, `balanceAfterPence`, `counterparty` (Json), `standingOrderRef`, `importBatchId`, `importFingerprint`, `matchState`, `chaseSuppressed`. Two unique keys: `[accountId, providerTransactionId]`, `[accountId, importFingerprint]` |
| `statements` | One uploaded bank statement | `documentId`, `periodStart/End`, `openingBalancePence`, `closingBalancePence`, `gapAnalysis` (Json — D41 completeness verdict, account-holder mismatch flag), `rowCount` |
| `supplier_statements` / `supplier_statement_lines` | Supplier-statement reconciliation | line `status`: IN_LEDGER_AND_NEOTING \| IN_LEDGER_ONLY \| NEOTING_ONLY \| MISSING \| NOT_ON_STATEMENT |
| `matches` | Document ↔ transaction | `kind` (EXACT\|PROBABILISTIC\|PARTIAL_PAYMENT\|BATCH_PAYMENT\|CREDIT_NOTE), `confidence`, `state`, `matchedByUserId`, `unmatchedAt` |

### Chasing

| Table | Purpose | Key fields |
|---|---|---|
| `chases` | One request for missing paperwork | `detectionEngine` (5 values; only `UNMATCHED_TRANSACTION` is implemented), `transactionId`, `itemRefs` (Json — the grouped list), `recipientContactId`, `state` (10 values), `schedule` (Json, **never written**), `firstSentAt`, `lastSentAt`, `escalatedAt`, `closedAt`, `closedReason`, `closedByDocumentId`, `actionProposalId` |
| `chase_messages` | Each message sent | `channel` (default `"sms"`), `body`, `recipientE164`, `providerMessageId`, `deliveryState`, `sentAt` |
| `sms_log` | Per-business SMS ledger | `toE164`, `body`, `providerMessageId`, `deliveryState`, `costPence`, `chaseId` |

### Approvals and audit

| Table | Purpose | Key fields |
|---|---|---|
| `action_proposals` | **The spine.** Every state change | `kind`, `payload` (Json), `payloadHash`, `renderedSummary` (Json), `renderedSummaryHash`, `state` (7 values), `createdByUserId`, `createdByModel`, `reviewedAt`, `approvedByUserId`, `approvedAt`, `executedAt`, `expiresAt`, `policyProposalId`, `outcome` (Json), `traceId` |
| `approval_workflows` | Multi-stage approval policies | `name`, `stages` (Json), `branches` (Json), `appliesTo` (Json), `specificity`, `selfApproval`, `isActive` |
| `approvals` | One human decision at one stage | `stageIndex`, `actorUserId`, `decision`, `comment`, `decidedAt` |
| `audit_events` | **Hash-chained append-only log** | `seq` (BigInt), `previousHash`, `hash`, `traceId`, `correlationId`, `actorPseudonym`, `event`, `inputHash`, `inputPointer`, `modelId`, `promptVersion`, `proposalId`, `payloadHash`, `renderedSummaryHash`, `outcome` (Json), `latencyMs`, `tokensIn`, `tokensOut`. `@@unique([businessId, seq])` |

### Egress and integrations

| Table | Purpose | Key fields |
|---|---|---|
| `integrations` | Ledger connection — **schema only, unused** | `kind` (IntegrationKind), `orgRef`, `tokenRef`, `tokenExpiresAt`, `health`, `lastSyncAt`, `lastErrorAt/Message`. `@@unique([businessId, kind])` |
| `reference_syncs` | Cached vendor lists — **unused** | `listKind`, `payload` (Json), `syncedAt` |
| `publishes` | One document released | `mode` (MANUAL\|AUTO\|AI), `state` (QUEUED\|SUCCEEDED\|FAILED), `externalRef`, `idempotencyKey` (unique), `attachmentSent`, `failureCode/Message`, `publishedByUserId` |
| `exports` | One export run | `kind`, `format`, `target` (VT_TRANSACTION_PLUS \| GENERIC_CSV), `periodStart/End`, `rowCount`, `filters` (Json), `s3Key`, `state`, `virusScanned`, `expiresAt` |
| `document_links` | D43 capability URLs | `code` (unique), `expiresAt`, `revokedAt`, `accessCount`, `lastAccessedAt` |
| `imports` | Structured-import batches | `kind`, `filename`, `mappingRef`, `rowCount`, `state`, `failureMessage` |

### Everything else

| Table | Purpose | Notes |
|---|---|---|
| `tasks` | Practice checklist | `title`, `description`, `ownerUserId`, `dueAt`, `status`, `cadence` (monthly/quarterly), `dependsOnTaskId`, `aiPrefilledAt`. Live since 7 Sep 2026 |
| `notifications` | In-app inbox | `event`, `recipientUserId`, `channels` String[], `payload` (Json), `readAt`, `sentAt` |
| `chat_conversations` | Persisted chat threads | `clientKey`, `title`, `pinned`, `messages` (Json array). `@@unique([practiceId, createdByUserId, clientKey])` |
| `vault_items` | Document vault | `title`, `summary`, `category`, `tags` String[], `folderPath`, `keyDates` (Json), `expiresAt`. **No API surface reads or writes it** |
| `feature_flags` | Local flag store | `key` (unique), `isEnabled`, `owner`, `removeBy`. **Nothing reads it** |

## 4.2 Compact ER list

```
Practice 1─* Business 1─* {Contact, Document, Rule, Guidance, BankConnection, BankAccount,
                           BankTransaction, Statement, SupplierStatement, Chase, ApprovalWorkflow,
                           ActionProposal, Integration, Publish, VaultItem, Task, Notification,
                           SmsLog, Export, Import, AuditEvent, DocumentLink}
Practice 1─* {Membership, Invite, Guidance, Document, ActionProposal, OtpSession, ChatConversation, Team}
Team 1─* TeamMember *─1 User
User 1─* {Membership, Session, OtpSession, Approval, ActionProposal(created/approved), Document(owned), TeamMember}
Business 1─* Membership *─1 User          (@@unique userId+businessId)
Business 1─* Contact 1─* {OtpSession, Chase}
Document 1─* {Extraction, DocumentEvent, Suggestion, Match, Publish, ItemThread, Approval, DocumentLink}
Document *─* Document  via Duplicate (documentAId, documentBId)
Document 1─* Document  via parentDocumentId  (batch split)
BankAccount 1─* {BankTransaction, Statement}   BankConnection 1─* BankAccount
BankTransaction 1─* {Match, Chase}
SupplierStatement 1─* SupplierStatementLine
Chase 1─* {ChaseMessage, OtpSession}
ApprovalWorkflow 1─* Approval
Integration 1─* {ReferenceSync, Publish}
```

## 4.3 Multi-tenancy design — `DONE`, and the strongest part of the codebase

- **Two tenancy anchors.** `practiceId` for practice-managed rows, `businessId` for client-owned rows. A document arriving before it has been routed to a client carries only `practiceId`, and a `documents_tenant_anchor` CHECK constraint refuses a row with neither.
- **Postgres row-level security is the enforcement**, not the application. `prisma/sql/rls.sql` enables and **forces** RLS on every tenant table and installs `app_can_access_business(business_id)`, which runs an `EXISTS` against `memberships`. Two indexes (`memberships_user_business_idx`, `memberships_user_practice_idx`) exist purely to make that an index probe; they are declared in the Prisma schema with `map:` so `migrate diff` does not silently drop them.
- **Two database roles.** Migrations and the seed run as the owner (`DIRECT_URL`); the application connects as `nt_app` (`DATABASE_URL`), which holds neither `SUPERUSER` nor `BYPASSRLS`. `apps/api/src/db/app-role-sql.ts` raises an exception if either is ever granted, because RLS would silently become decorative.
- **One door: `scopedDb(prisma, context, fn)`** (`apps/api/src/common/db/scoped-db.ts`). It opens a transaction, writes five GUCs with `set_config($1,$2,true)` (`SET LOCAL`, parameterised — never string-interpolated, because `actorId` can derive from a link a stranger holds), and hands back a transaction client with `$transaction`/`$connect`/`$executeRaw` removed from the type. All five GUCs are always written so context is a function of this transaction alone on a pooled connection.
- **Machine writes have a real actor.** Every policy requires `app_actor_id() IS NOT NULL`, so workers run as a `UserKind.SYSTEM` user with a practice-level membership rather than a magic string — `audit_events.actor_id` then names a real row whoever acted.
- **Special policies:** `documents_delegated_upload` and `extractions_delegated_upload` for OTP portal grants; `audit_events_read` / `audit_events_append` split so audit rows can be appended but not rewritten; `action_proposals_tenant` covers both anchors.
- **Verification:** `apps/api/src/common/db/scoped-db.integration.test.ts` plus a per-module `*.integration.test.ts` that asserts cross-tenant invisibility against a real database, and a standalone `pnpm db:tenancy-check` SQL script.

## 4.4 Audit logging — `DONE`

`audit_events` is append-only and hash-chained per business (`seq`, `previousHash`, `hash`). Written by `apps/api/src/modules/approvals/audit-writer.ts` on every executed proposal, and by `auth-tenancy/signup-audit.ts` on signup (which has no proposal). The row records the model id, prompt version, input hash, payload hash, rendered-summary hash, latency and token counts, so an AI-influenced decision is reproducible. `actorPseudonym` rather than a name — personal data stays out (Governance §11.6).

Separately, `document_events` is a non-chained per-document pipeline log (stage, outcome, duration, traceId).

## 4.5 Soft delete — `PARTIAL`

- `documents.deletedAt` — a real reversible Trash, with `notDeleted()` applied at read sites (`apps/api/src/common/documents/deleted-documents.ts`), a restore endpoint, and a `document.purge` proposal for permanent deletion that refuses anything already exported. Expiry is swept by `pnpm trash:purge` (`scripts/purge-expired-trash.ts`) — **a manual script, not a scheduled job**.
- `businesses.isActive` + `offboardedAt` + `erasureRequestedAt` — client offboarding is soft; `erasureRequestedAt` is a flag on a list, and **nothing acts on it on a schedule** (a deliberate ruling: any fixed window shorter than the UK's six-year statutory retention would delete a practice's records out from under them). See `docs/Retention_and_Deletion_Policy.md`.
- `contacts.deactivatedAt`, `users.deactivatedAt`, `sessions.revokedAt`, `document_links.revokedAt` — revoke, never delete.
- **No soft delete on** `bank_transactions`, `matches`, `chases`, `extractions`, `suggestions`, `rules`, `tasks` (tasks are hard-deleted via `DELETE /v1/tasks/{taskId}/deletion`).

---

# 5. Feature inventory

## 5.0 Live vs synthetic — read this before anything else in this section

`apps/web/src/api/config.ts` gates the whole web app on `VITE_API_ENABLED`. Off (the default) the app renders synthetic generators; on, individual *slices* read the API. `apps/web/src/api/slices.ts` names seven slices — `documents`, `chases`, `proposals`, `bankTransactions`, `publishes`, `businesses`, `expenseClaims` — and `apps/web/src/context/AppContext.tsx:1117-1119` wires exactly **three** to real queries: `documents`, `bankTransactions`, `businesses`. Everything else in `AppContext` is generated locally. Individual screens outside that context do call the API directly (`ApprovalsLiveQueue`, `ChasesLiveBoard`, `LivePortal*`, `WorkflowsPanel`, `ExportView`, tasks, teams, notifications, chat), so the split is per-screen, not per-app. A slice that errors **never falls back to synthetic rows** — that stance is explicit and was a deliberate reversal of an earlier design.

## 5.1 Auth and roles — `DONE` (with named gaps)

Paths: `apps/api/src/modules/auth-tenancy/`, `apps/web/src/api/auth.ts`, `apps/web/src/views/LoginView.tsx`, `.../signup/SignupView.tsx`, `.../invite/InviteView.tsx`.

- Password sign-in with scrypt (`password.ts`, format `scrypt$salt$key`, timing-safe compare, a burn-hash for unknown users so timing cannot enumerate).
- Stateless HMAC-signed `nt_session` cookie (`session-cookie.ts`, `signed-claims.ts`) plus `sessions` rows for refresh. `AUTH_MODE=fixture|session`; `fixture` is refused under `NODE_ENV=production`.
- **TOTP** (RFC 6238 via `otplib`) with single-use recovery codes: `totp.ts`, `totp-enrolment.service.ts`. `OTP_MODE=demo|totp`; `demo` accepts one literal six-digit code and is refused in production.
- Email verification, password reset, practice signup chain, invitation preview + acceptance — all live contract operations.
- Roles: `WorkspaceRole` = `PRACTICE_ADMIN`, `CLIENT_ADMIN`, `PRACTICE_STANDARD`, `BUSINESS_ADMIN`, `USER_ADMIN`, `BUSINESS_STANDARD`. Permissions are checked at call sites via `assertCan`, never by role at the perimeter. Seven permitted actions: `publish.release`, `proposal.approve`, `team.invite`, `team.manage`, `business.people.manage`, `business.profile.manage`, `business.billing.manage`.
- **Limitations:** `memberships.permissions` (String[]) is populated by the seed and **consulted by nothing** — `assertCan` deliberately ignores it because signup leaves it empty. `invites.hideFinancialFields` and `memberships.hideFinancialFields` are **written and never read when serving a document** — the redaction is owed (noted in `prisma/schema.prisma`). There is no ownership-transfer operation, so a practice whose owner is unavailable cannot release anything.

## 5.2 Organisation / client management — `DONE`

Paths: `apps/api/src/modules/auth-tenancy/businesses.service.ts`, `.../clients-team-settings/`, `apps/web/src/views/{ClientsView,ClientDetailView,RemovedClientsPanel,TeamView}.tsx`, `.../DynamicComponents/ClientIntakeForm.tsx`.

- Practice → many client businesses; standalone businesses supported (`practiceId` null).
- Client intake form captures name, trading name, company number, legal structure, industry, addresses, country, currency, VAT registration/scheme/frequency, year end, bookkeeping arrangement, next deadline, and a free-text context questionnaire that feeds AI grounding.
- Practice team management: invite, edit, remove, per-client scoping for `PRACTICE_STANDARD` (`invites.businessIds`).
- Client offboarding via the `business.offboard` proposal (soft, with a scope question), `business.reactivate` as its exact mirror, and a Removed-clients panel with a restore window.
- Teams (`/v1/teams`) — named groups within a practice, board-filterable.
- **Limitation:** intake defaults are hardcoded UK (`'United Kingdom'`, `'GBP'`) at `ClientIntakeForm.tsx:991-992`.

## 5.3 Document upload and capture — `DONE`

| Channel | Status | Path |
|---|---|---|
| Web upload (accountant) | `DONE` | `ingestion-routing/web-upload/`; presigned PUT + HMAC intent token |
| Client portal upload | `DONE` | `portal/portal-upload.service.ts`; staged files, explicit Upload button, optional note |
| Portal camera capture | `DONE` | `apps/web/src/views/business/portalCamera.ts`, `LivePortalCapture.tsx` |
| Chat upload | `DONE` | `apps/web/src/components/ChatUpload.tsx` + a decision card that asks what the document is before ingesting |
| Email intake | `DONE` | `ingestion-routing/email/inbound/`; SES→S3 or MailHog; known senders only (D45) |
| WhatsApp | `PARTIAL` | webhook + routing `DONE`; media fetch is `MEDIA_FETCH=fixture` by default and needs a Meta System User token to be real |
| SMS-portal link | `DONE` | `chase/portal-link.ts` + `portal/` OTP |
| Structured import (CSV/XLSX) | `PARTIAL` | `imports` table + `apps/web/src/lib/tableImport.ts` + `spreadsheet.ts`; bank statements go through the real server path, other structured imports are client-side only |
| API channel | `MISSING` | `DocumentChannel.API` exists in the enum; no public ingest API |

Accepted formats and safety are in `ingestion-routing/lib/sanitisation/formats.ts` and `guards.ts`. HEIC is decoded (`IMAGE_NORMALISER=sharp`); the `fixture` normaliser refuses HEIC and is refused in production for that reason.

## 5.4 OCR / extraction and accuracy handling — `DONE`

Paths: `apps/api/src/common/ocr/`, `apps/api/src/modules/extraction/`.

- **OCR rung:** Textract (`STATEMENT_READER=textract|none`). One call returns both text and tables and the result is passed forward so a 29-page statement is not read (or paid for) twice. Every failure is classified as a *document* problem or an *our* problem so a throttle is never reported as "your document is unreadable". A multi-page PDF with no S3 key is refused rather than truncated to page one.
- **Extractor:** `EXTRACTOR=demo|bedrock|replay` behind a `DocumentExtractor` seam. `bedrock` sends the image to Claude with a forced tool call, then strict-Zod-parses the answer (`bedrock-extraction-schema.ts`). Fields: `docType`, `supplierName`, `customerName`, `documentDate`, `dueDate`, `currency`, `totalPence`, `taxPence`, `netPence`, `reference`, `vatNumber`, `lineItems[]`, plus a four-field confidence block.
- **Accuracy handling — this is well thought through:**
  - There is **no fallback extractor**. A `FallbackExtractor` existed until 25 Aug 2026 and was deleted because a throttle produced an invented supplier, total and VAT number at 0.8 confidence, marked Ready. A failed read is now a `FAILED` document with a visible reason, retryable via a `document.reprocess` proposal.
  - `EXTRACTOR=demo` is refused in production for the same reason — the demo extractor *invents* fields from a filename hash.
  - `replay` mode runs the real adapter against recorded cassettes; a request with no cassette fails loudly naming the record command.
  - **Field geometry** (`field-geometry.ts`) cross-checks the model's answer against the OCR word positions; ambiguity never guesses.
  - The **readiness gate** (`validation-dedupe/readiness.ts`) is the accuracy backstop: READY requires type ∧ non-zero total ∧ supplier ∧ category ∧ no validator failure. Placeholders (`—`, `n/a`, `unknown`, `extracting…`) do not count as values.
  - **The confidence-threshold seam is deliberately empty** — SoT Stage 5 wants eval-calibrated per-field thresholds and they have not been measured; the file explicitly forbids inventing a number.
- Extraction cost is metered per practice through the shared AI budget.

## 5.5 Data validation rules — every rule implemented

**Deterministic, server-side:**

| Rule | Where | Behaviour |
|---|---|---|
| Exact duplicate (byte hash, sha256) | `ingestion-routing/queue/duplicate-detector.ts` | score 1.0, `Duplicate` row PENDING |
| Near-duplicate (perceptual dHash, Hamming ≤ 10 of 64) | `.../lib/dedupe/perceptual-hash.ts` | threshold is measured, not guessed: re-encode = 0, downscale = 0, different images = 28. Candidate scan capped at 500 newest images and reports `candidatesTruncated` |
| VAT arithmetic | `extraction/bedrock-extraction-schema.ts:150` `checkVatArithmetic` | net + tax = gross within ±1p; failure forces TO_REVIEW |
| Currency agreement | same file | symbol vs ISO code on the document |
| Readiness (4 fields + validator) | `validation-dedupe/readiness.ts` | type / total≠0 / supplier / category |
| Placeholder rejection | same, `READINESS_PLACEHOLDERS` | `''`, `—`, `-`, `n/a`, `unknown`, `extracting…` |
| Category must be on the client's chart | `validation-dedupe/proposals/validate-update-coding.ts` | a **refusal**, not an advisory |
| Tax exceeds total | `validation-dedupe/correction-checks.ts` | advisory: the exact £9,000-tax-on-£994 shape that used to reach export |
| Tax and total signs disagree | same | advisory: gross/net/VAT must share one sign or the export drops the line |
| Document date in the future | same | advisory |
| Document date > 7 years old (`IMPLAUSIBLY_OLD_YEARS`) | same | advisory |
| Money/category typed onto a non-financial document | same | advisory: `docType === OTHER` or extraction found no values (the "selfie" case) |
| Statement account-holder mismatch | `banking-matching/statement-ingest/account-holder.ts` | warns, never blocks (D46) |
| Statement completeness (D41) | `banking-matching/statement-ingest/completeness.ts` | proven / could-not-be-checked / checked-and-failed — three distinct verdicts, never collapsed |
| Statement re-import fingerprint | `.../row-identity.ts` + `bank_transactions.importFingerprint` unique | same rows re-uploaded do not double-import |
| Zip-bomb / nested-archive safety | `.../sanitisation/zip-safety.ts` | |
| Encrypted or JS-bearing PDF | `.../sanitisation/qpdf-document-guard.ts` | `fixture` mode has a known false negative on incrementally-updated PDFs and is refused in production |
| EICAR / virus | `.../sanitisation/virus-scan.ts` | interface only |
| Export refusal `NT-EXP-001` | `exports-public-api/api/exports.service.ts` | names every refused document — supplier, UK-format date, amount, and which check it failed |
| Idempotency (`Idempotency-Key`) | `common/idempotency/idempotency-store.ts` | `NT-IDM-001` on reuse with a different payload |

**Model-backed second opinion** (`rules-suggestions/coding/correction-opinion.ts`, surfaced through `correction-checks.ts:modelCorrectionChecks`): three verdicts only — `model-supplier-not-in-document`, `model-total-not-in-document`, `model-category-dissonant`. The model contributes an enum; **every sentence shown to the user is composed by our code**, because the approval hash covers that text. `NOT_CHECKABLE` and positive verdicts produce nothing.

**Supplier matching** is normalisation + containment (`rules-suggestions/supplier-key.ts`, `chase/chase-projection.ts:chaseMatchesDocument`) with one shared tolerance constant `CHASE_MATCH_AMOUNT_TOLERANCE_PENCE`, reused by the match suggester so the two can never disagree. **VAT-number checksum validation is `MISSING`** — the SoT asks for GB-checksum validation against HMRC's API and neither exists in code (`COMPANIES_HOUSE_API_KEY` and `HMRC_CLIENT_*` are unused).

## 5.6 Categorisation / coding — `DONE`

Paths: `apps/api/src/modules/rules-suggestions/`.

- **Chart of accounts:** platform-side, seeded at intake from one of **four hardcoded business-type profiles** (`chart-of-accounts/profiles.ts`, 829 lines): `GENERAL_BUSINESS` (the core and the fallback), `SERVICES_WITH_STAFF`, `TRADE_AND_CONSTRUCTION`, `RETAIL_AND_HOSPITALITY`. Profiles are selected by keyword match against what the client typed at intake; additions sit on top of the core, never replacing it. Owned and editable by the accountant thereafter.
- Each account carries `code` (SCREAMING_SNAKE), `ledger` (one of `Sales`, `Cost of sales`, `Expenses`, `Fixed assets`, `Current assets`), `name`, `vatTreatment` (`STANDARD`, `ZERO_OR_EXEMPT`, `OUTSIDE_SCOPE`, `BLOCKED`, `VARIES`), `taxConsequence` (`ALLOWABLE`, `DISALLOWABLE`, `CAPITAL`), keywords, and an optional `reviewNote`. `analysisAccount()` joins ledger + name into the exact string the VT emitter writes; a colon is refused in either half so the join stays reversible.
- **No catch-all `SUNDRY` account, deliberately** — an uncertain document goes to To Review where it is visible.
- **The coding ladder** (`coding/coding-decision.ts`): USER rule → PAYMENT_METHOD rule → SUPPLIER_CUSTOMER rule → supplier memory (this client's own prior human codings) → deterministic capital/revenue rules → Bedrock judgment rung → escalation. Each rung records its `basis` in `document_events` so the escalation rate is measurable (`scripts/measure/coding-escalation-rate.ts` — **written, never run against a real corpus**).
- **Capital vs revenue** (`coding/capital-revenue.ts`, 446 lines): per-unit threshold test against a practice capitalisation policy; the platform default is £1,000 with a ±10% boundary band that escalates rather than rounding. `source: 'PRACTICE' | 'PLATFORM_DEFAULT'` so a card never presents our default as the accountant's policy. **A per-practice policy setting is owed and does not exist.**
- **Escalation reasons** are a closed set (`coding/escalation.ts`) — `SOFTWARE_TERM_UNKNOWN`, `THRESHOLD_BOUNDARY`, `MIXED_CAPITAL_AND_REVENUE`, `ARITHMETIC_MISMATCH`, `NO_MATCH_ON_CHART` and others. "No category" is never an answer.
- Rules are created through a `rule.create` proposal and activate only on approval. `apps/web/src/lib/ruleParser.ts` + `chat-framework` parse natural-language rules ("whenever Bidfood invoices arrive code them Cost of Sales Food").
- `document_events` records the basis; `coding-instructions.test.ts` asserts that every escalation reason and named basis appears in the prompt text, so a rule added in code and forgotten in the prompt fails the build.

## 5.7 Bank feeds — `MISSING` (deliberately). Statement upload — `DONE`

- **D40 supersedes D4 for ID: manual bank statement upload (PDF/CSV/XLSX) is the only bank input.** There is no TrueLayer client, no Open Banking, no feed of any kind, for any country. `bank_connections.provider` defaults to `"truelayer"` and nothing writes the table; `TRUELAYER_CLIENT_ID/SECRET` are unused.
- What does exist (`banking-matching/statement-ingest/`, `DONE`): `sheet-reader.ts` (CSV/XLSX), `statement-parser.ts` (header detection, day-first date parsing, integer-pence money parsing that refuses inexact pence), `completeness.ts` (D41 verdicts), `row-identity.ts` (re-import fingerprints), `account-holder.ts` (foreign-statement warning), `statement-ingest.ts` (persistence into a synthetic "Uploaded statements" account).
- Column vocabulary recognised (`statement-parser.ts:91-96`) — this is the UK-shaped part: `date|transaction date|posting date|booked|value date|date posted`; `description|details|narrative|reference|transaction|payee|merchant|particulars`; `amount|value|transaction amount|amount (gbp)|amt`; `paid out|debit|money out|withdrawal|withdrawals|out|dr`; `paid in|credit|money in|deposit|deposits|in|cr`; `balance|running balance|balance (gbp)|closing balance`. Textract's fused-header quirk (`CREDIT BALANCE` as one cell) is handled.
- **A header row is required.** A headerless CSV is refused with `noHeaderRow`.
- PDF and image statements route through Textract; with `STATEMENT_READER=none` they are refused with a reason rather than silently skipped.

## 5.8 Reconciliation — `PARTIAL`

- `matches` table, five `MatchKind` values, `MatchState` UNMATCHED → SUGGESTED → CONFIRMED / EXCLUDED.
- **Automatic suggester** (`banking-matching/suggestion/match-suggester.ts`, `DONE`): runs on extraction completion, uses the chase module's own `chaseMatchesDocument` (normalised supplier containment + absolute pence tolerance + optional date window) so there is exactly one ruler. **Exactly one candidate or nothing** — a document matching two lines suggests neither.
- Human confirmation via the `bank.confirm-match` proposal; an existing SUGGESTED row is promoted, never duplicated.
- **`PARTIAL` because:** only `EXACT`/`PROBABILISTIC` are ever produced — `PARTIAL_PAYMENT`, `BATCH_PAYMENT` and `CREDIT_NOTE` are enum values nothing writes. Supplier-statement reconciliation has tables and a UI (`ClientSupplierStatements.tsx`) but the line-status computation is client-side synthetic. There is no bulk reconcile and no period-close.

## 5.9 The suggestion / reminder (chase) engine — `PARTIAL`

- **Detection engines declared:** five (`ChaseDetectionEngine`). **Implemented: one.** `UNMATCHED_TRANSACTION` (`chase/detection.ts`). `SUPPLIER_STATEMENT_GAP`, `STATEMENT_PERIOD_GAP`, `LEDGER_TXN_NO_ATTACHMENT` and `EXPECTED_RECURRING_MISSING` are enum values with a `// DEMO-MOCK` note in `detection.ts:12`.
- **Four suppression gates**, all in detection so they cannot disagree with the rest of the product: the stored `chaseSuppressed` flag; a descriptor keyword scan; `matchState = UNMATCHED`; and "a chase already covers this item, in any state".
- **The suppression descriptor list** (`chase/suppression.ts`) is SoT-verbatim and UK-specific: `SERVICE CHARGE`, `COMMISSION`, `CHG`, `CHAPS`, `UNPAID`, `OD INTEREST`, `SUMUP`, `WORLDPAY`, `STRIPE PAYOUT`. Per-client extension is a documented `DEMO-MOCK` needing a schema column.
- **Composition** is server-side and the reviewed body is sent byte-for-byte (`chase/sms-copy.ts`, `validation-dedupe/proposals/compose-chase-send.ts`). A composed message names supplier and the Europe/London day and **never an amount** in the SMS.
- **Delivery:** `SMS_SENDER=demo|email|aws`. `email` routes through the notifications transport; `aws` is AWS End User Messaging and requires `SMS_ORIGINATION_IDENTITY` (boot-refused if empty). A STOP'd recipient refuses the approval.
- **Auto-close** (`chase/auto-close.ts`): an arriving document that matches an open chase closes it `CLOSED_RECEIVED` and writes a `chase.closed` notification.
- **⚠ There is no scheduler and no cadence.** `Chase.schedule` (Json) is never written. `ChaseState.REMINDED` and `ESCALATED` have no transition into them. Detection runs only when a surface asks for it. **Nothing in this product wakes up on a timer** — there is no cron, no BullMQ repeatable job, no EventBridge rule for chases, statements, deadlines, trash purging or anything else.
- **Rules live in code**, not in data: `chase/suppression.ts` (the descriptor list), `chase/detection.ts` (the four gates), `chase/sms-copy.ts` (the message shape).

## 5.10 Deadline / obligation calendar — `MISSING`

There is **no obligation calendar of any kind**. Specifically:

- No VAT return, PAYE, Self Assessment, Corporation Tax, Confirmation Statement or Companies House deadline is coded anywhere. A grep for "Making Tax Digital", "MTD", "Self Assessment" and "tax year" over the whole tree returns nothing in code.
- `businesses.nextDeadline` is a **single manually-entered date** rendered as text (`auth-tenancy/businesses.service.ts:293`, `ClientDetailView.tsx:1201`). Nothing computes it, and nothing alerts on it.
- `businesses.vatScheme`, `vatFrequency`, `vatPeriodStart`, `yearEndMonth`, `yearEndDay` are **captured at intake and read by nothing**. The intake form offers `['Standard', 'Flat rate', 'Cash accounting', 'Not registered']` (`ClientIntakeForm.tsx:632`) and stores the string.
- The closest thing is `tasks.cadence` (`monthly` \| `quarterly`) with `advanceDueDate()` (`apps/api/src/modules/tasks/due-date.ts`) rolling a completed recurring task forward with correct month-end clamping — but a task is a free-text checklist item a human writes; nothing seeds it from a jurisdiction's obligations.
- The seed creates one illustrative task, "File the Q3 VAT return" (`prisma/seed.ts:983`), as data.

## 5.11 Tax rules and guidance logic — `PARTIAL`, and entirely inside the coding layer

There is **no tax computation** anywhere: no VAT return, no rate table, no reclaim logic, no return preparation. What exists is *guidance about how to code a document*, expressed as prompt text and deterministic branches:

- `rules-suggestions/coding/coding-instructions.ts` (520 lines) — nine numbered decision rules given to the model, several citing UK authority: HMRC BIM35805 (software with a useful life under two years is revenue), CAA 2001 s.71 (computer software as plant), IAS 16.17(d)–(e) (installation capitalises), IAS 16.19(c) / IAS 38.69(b) (training is never capitalisable), IFRIC March 2019 (hosted software is a service contract), IAS 38.57 (development costs deliberately excluded), HMRC VATPOSS14600 (foreign consumption tax increases the reverse-charge base but is never reclaimable).
- `rules-suggestions/coding/capital-revenue.ts` — deterministic per-unit threshold branches for the same rules.
- `chart-of-accounts/profiles.ts` — `vatTreatment` and `taxConsequence` flags per account, plus review notes naming the CIS domestic reverse charge and the hot/cold food zero-rate boundary. **These flags gate nothing** — they are review ordering and reviewer context.
- **The chat assistant is forbidden from giving tax advice.** `chat-framework/prompts/system-prompt.ts:60`: totalling figures into a VAT return or any financial statement, and questions about tax, company law or what a client should do, are `SCOPE_REFUSAL`.
- `guidance` table (ACCOUNT / PRACTICE_CORE / PRACTICE_SHARED, MANUAL_REVIEW / AUTO_APPLY) exists and is seeded; **there is no CRUD surface for it in the contract**.

## 5.12 Reporting and dashboards — `PARTIAL`

- **Practice analytics** (`apps/web/src/views/AnalyticsView.tsx` + `apps/web/src/lib/analyticsReport.ts`, spec at `docs/reports/PRACTICE_ANALYTICS_REPORT.md`): one row per client plus a practice roll-up, exported as UTF-8-BOM CSV. Counts come from the server's `BusinessSummary.counts`, so it cannot disagree with the Clients board. **Metrics the API does not serve are omitted, never guessed** — duplicates caught, item delay, chases sent/answered, and any period filter are all absent, and the report says so in its own header. Time-saved uses a printed constant, `MINUTES_SAVED_PER_PUBLISHED_DOCUMENT = 3`.
- **`apps/api/src/modules/analytics/` is an empty directory.** There is no analytics API.
- Boards and counters: Clients board, Inboxes, Approvals queue, Bank screen, Chases board, `PipelineStats`. `GET /v1/documents/counts` is the one real aggregate endpoint.
- **No financial reports at all** — no P&L, no balance sheet, no VAT summary, no aged creditors. Correctly so: the product does not hold a ledger.

## 5.13 Accounting-software integrations — `STUB`

| System | Read | Write | Status | Notes |
|---|---|---|---|---|
| Xero | ✗ | ✗ | `STUB` | `IntegrationKind.XERO` + `DemoXeroAdapter` (no socket). `XERO_CLIENT_ID/SECRET` unused |
| QuickBooks | ✗ | ✗ | `STUB` | Enum value only. `INTUIT_CLIENT_ID/SECRET` unused |
| Sage | ✗ | ✗ | `STUB` | Enum value only |
| FreeAgent | ✗ | ✗ | `STUB` | Enum value only |
| **VT Transaction+** | ✗ | **CSV file, `DONE`** | `DONE` | `exports-public-api/emitters/vt/` — Universal Input Sheet, `DD/MM/YYYY` cells, magnitudes with a `Type` code (`PIN`/`PCR`/`SIN`/`SCR`/`PAY`/`CHQ`/`REC`), `Analysis account` carrying the ledger prefix |
| Generic CSV | ✗ | **CSV file, `DONE`** | `DONE` | `emitters/generic-csv/` — canonical signs, one row per analysis line, 11 columns including `Source code` and `Source URL` |

Sync frequency: **none — export is user-initiated.** Auth flow: **none — no OAuth anywhere.** The `LedgerAdapter` interface (`publishing/ledger-adapter.ts`) is the real seam a Xero/QBO adapter would drop into, and it already encodes two rules a future adapter must honour: never hold a tenant transaction across an external call, and a per-item failure is a result, not a throw.

## 5.14 Dext / other capture-tool integrations — `MISSING`

No Dext, Hubdoc, AutoEntry, Datamolino or Receipt Bank integration or import path exists. Dext appears only as competitive research (`docs/research/dext-categorisation.md`, `docs/research/dext-document-management.md` — 5,000 lines of feature analysis used to shape the coding and document surfaces).

## 5.15 Notifications — `PARTIAL`

| Channel | Status | Path |
|---|---|---|
| In-app | `DONE` | `notifications` table, `GET /v1/notifications`, `POST /v1/notifications/read-receipts`, `apps/web/src/components/NotificationsBell.tsx` — **30 s poll, no push** |
| Email | `DONE` | `notifications/{email-copy,email-html,ses-email-sender,smtp-email-sender}.ts`; one door (`notifications.service.ts`), pure composition, per-address and per-IP rate limits, domain-only logging |
| SMS | `DONE` for chases | `chase/aws-sms-sender.ts`; not a general channel |
| WhatsApp outbound | `MISSING` | inbound only |
| Push / web push | `MISSING` | |
| Slack / Teams | `MISSING` | |

Email kinds composed: client invite, team invite, business-people invite, document request (chase), sign-in code, email verification, password reset, duplicate-signup notice, proposal-denied. `notifications.channels` (String[]) is written but nothing fans out on it.

## 5.16 AI features — `DONE`

See §9 for detail. In summary: document extraction, coding suggestion, correction second opinion, workspace chat with intent routing, chat prompt suggestions, natural-language rule parsing, natural-language approval-workflow drafting. Guardrails: `<untrusted_content>` wrapping, forced-tool + strict Zod output parsing, a per-practice daily budget in pence, a circuit breaker, empty degrade chains (no silent tier drop), no fallback to invented data, and a rule that **no model-authored sentence appears on an approval card**.

## 5.17 Mobile / responsive — `DONE`

`apps/web/src/lib/useViewport.ts` defines three modes matching Tailwind's breakpoints: phone (<768 px — no rail, bottom tab bar, tables become cards), tablet (768–1023), desktop (≥1024). `BottomNav.tsx` is the phone navigation. The client portal is phone-first by design (camera capture, staged uploads). There is **no native app** and none is planned for ID.

## 5.18 Admin / back-office tools — `MISSING`

There is no internal admin surface, no support console, no impersonation, no tenant browser and no `/admin` route. Operational work is done through: `pnpm demo:reset`, `pnpm db:tenancy-check`, `pnpm trash:purge`, `scripts/billing/create-promotion-code.ts`, `scripts/measure/*`, and the runbooks in `docs/runbooks/`. `feature_flags` and the Unleash container exist and nothing reads them.

## 5.19 Billing / subscriptions — `DONE`

Paths: `apps/api/src/modules/billing/`, `apps/web/src/api/onboarding.ts`, `apps/web/src/views/business/{BusinessSettingsView,LapsedSubscriptionNotice}.tsx`.

- **D48 (ID only):** subscription is live at intake — **£8.50/month + VAT per client business, paid by the client**, not the practice.
- Stripe Checkout Session + Billing Portal via a hand-rolled HTTP client (no SDK). `BILLING=demo|stripe`. Return URLs are allow-listed (`BILLING_RETURN_ORIGINS`).
- Four columns on `businesses` rather than a subscriptions table: `stripeCustomerId` (**unique on purpose** — the webhook runs with no session and must resolve its tenant from the Stripe customer id), `subscriptionStatus`, `plan`, `subscriptionCurrentPeriodEnd`.
- The Stripe customer is created **before** checkout, so `customer.subscription.created` can never name a customer no row points at.
- Webhook signature verification (`stripe-signature.ts`, `stripe-signature.guard.ts`) plus a replay store.
- **Entitlement** (`billing/entitlement.ts`): `ACTIVE` and `TRIALING` may ingest; everything else, including `PAST_DUE` and `null`, may not. **Reading and exporting survive a lapse; new uploads do not** — and this check lives in the service layer and must never move into RLS, because a lapsed tenant would then see an empty workspace instead of a billing message.
- Tax: `STRIPE_TAX=rate|automatic`; `rate` attaches an explicit **20% GB VAT** rate id (`STRIPE_TAX_RATE_ID`), and the boot gate refuses `rate` without it, because the price is tax-exclusive and the VAT would otherwise be absorbed.
---

# 6. External integrations and APIs

Every integration selected by config, never by import (`selectExtractor`, `selectIngestQueue`, `selectDocumentStore`, `selectEmailSender`, `selectSmsSender`, `selectLedgerAdapter`, `selectMediaFetcher`, `selectOcrReader`, `selectStripeClient`, `selectModelProvider`). Every `demo`/`fixture` mode is refused at boot under `NODE_ENV=production` (`apps/api/src/config/env.ts` `superRefine`).

| System | Used for | Auth | Endpoints / scopes | Rate limits | Error handling | Files | Country-specific? |
|---|---|---|---|---|---|---|---|
| **AWS Bedrock** (Anthropic Claude, Amazon Nova) | Document extraction, coding suggestion, correction second opinion, chat, chat suggestions, rule parsing, workflow drafting | ECS task role → region-pinned **foundation-model ARNs only**, no inference-profile ARN | `InvokeModel` on `anthropic.claude-opus-4-6-v1`, `anthropic.claude-sonnet-4-6`, `amazon.nova-lite-v1:0`, `eu-west-2` | Per-practice daily budget in pence (`AI_DAILY_BUDGET_PENCE`, default 2500 = £25/day); warn at 80%, hard stop at 100%; per-task `maxTokens` + timeout | Circuit breaker (`chat-framework/provider/circuit-breaker.ts`); **no degrade chain is populated**, so a failure is an honest error, never a quieter model; extraction failure = `FAILED` document with a reason, never invented data | `chat-framework/provider/bedrock-provider.ts`, `extraction/bedrock-extractor.ts`, `rules-suggestions/coding/bedrock-coding.ts`, `approvals/workflow-draft/bedrock-workflow.ts`, `common/ai-budget.ts` | **Yes** — `BEDROCK_REGION=eu-west-2` is a UK-residency commitment (D30 / ADR 0001). Adding an `eu.*` or `global.*` model id returns AccessDenied by design |
| **Amazon Textract** | OCR text + table extraction from PDFs and images | ECS task role | `AnalyzeDocument` (sync, ≤1 page / raw bytes), `StartDocumentAnalysis` + `GetDocumentAnalysis` (async, S3 only) | Async poll with a hard deadline (`ASYNC_TIMEOUT_MS`) | Failures classified *document problem* vs *our problem* (throttle / expired credential are retryable and never reported as "unreadable"); multi-page PDF with no S3 key is refused, never truncated | `common/ocr/textract-ocr-reader.ts`, `common/ocr/select-ocr-reader.ts` | Region-pinned `eu-west-2` |
| **Amazon S3 / MinIO** | Original documents, export files, SES inbound receipts | Task role in AWS; access keys locally | `PutObject`, `GetObject`, presigned URLs; buckets `S3_BUCKET_DOCUMENTS`, `S3_BUCKET_EXPORTS`, `S3_BUCKET_RECEIPTS` | n/a | Standard SDK retries | `ingestion-routing/storage/s3-document-store.ts` | No |
| **Amazon SES v2** | Outbound email (invites, sign-in codes, chases, verification, resets, denial notices) | Task role | `SendEmail`; configuration set `EMAIL_CONFIGURATION_SET` | Own limiter per address **and** per IP (`notifications/email-rate-limit.ts`), `memory` or `redis`; `memory` is refused alongside a real sender in production because the API runs more than one task | Refusals are return values, not exceptions, so sign-in (must not enumerate), invite (must tell the user) and chase batch (must continue) can each respond correctly | `notifications/ses-email-sender.ts`, `.../email-copy.ts`, `.../notifications.service.ts` | `SES_REGION=eu-west-2` (D30) |
| **SES inbound** (document intake by email) | Receiving client documents at `doc@` | SES receipt rule → S3 | Raw MIME under `inbound/`, parsed with `postal-mime` | n/a | Unknown sender = refused (D45); parse failure lands in the DLQ | `ingestion-routing/email/inbound/s3-email-source.ts`, `.../sender-map.ts`, `infra/envs/staging/email.tf` | Address topology is UK-region; see ADR 0002 |
| **AWS End User Messaging (SMS)** | Chase SMS | Task role + `sms-voice:SendTextMessage` | `SendTextMessage` with `SMS_ORIGINATION_IDENTITY` | Not implemented in code | A STOP'd recipient refuses the approval rather than failing at send | `chase/aws-sms-sender.ts`, `chase/aws-sms-transport.ts` | **Yes** — the origination identity is a UK number/pool; `SMS_REGION=eu-west-2` |
| **Meta WhatsApp Cloud API** | Inbound document capture | Webhook: HMAC-SHA256 with `META_APP_SECRET` + `META_VERIFY_TOKEN`; media fetch: bearer `META_MEDIA_ACCESS_TOKEN` with `whatsapp_business_messaging` | `POST /v1/webhooks/whatsapp` (in), Graph media download (out) | Timestamp window + replay store (`webhooks/whatsapp/{timestamp,replay-store}.ts`) | Fails **closed**: empty secrets → 401 on POST, 403 on the GET challenge; an unmappable `phone_number_id` yields no anchor and the job lands in the DLQ | `ingestion-routing/webhooks/whatsapp/*`, `.../queue/graph-media-fetcher.ts` | **Yes** — D25 assumes a dedicated UK virtual number |
| **Stripe** | Subscription billing (D48) | Secret key; webhook signature `STRIPE_WEBHOOK_SECRET` | `POST /v1/customers`, `/v1/checkout/sessions`, `/v1/billing_portal/sessions`; webhook `POST /v1/webhooks/stripe` | Not implemented | Replay store on webhook events; the webhook resolves its tenant from the unique `stripeCustomerId` and asserts exactly one row (RLS fails closed and silent otherwise) | `billing/http-stripe-client.ts`, `billing/stripe-webhook.service.ts`, `billing/stripe-signature.ts` | **Yes** — GBP price, explicit **20% GB VAT** tax-rate id |
| **VT Transaction+** | Export target (file, not API) | n/a | Universal Input Sheet CSV | n/a | Emitter refuses floats and unprefixed analysis accounts; warns on multi-nominal splits | `exports-public-api/emitters/vt/` | **Yes** — VT is a UK desktop product |
| **TrueLayer** | *(bank feeds — not built)* | — | — | — | — | `bank_connections.provider` default only | UK/EU |
| **HMRC check-VAT API** | *(not built)* | — | — | — | — | `HMRC_CLIENT_ID/SECRET` declared, unused | UK |
| **Companies House API** | *(not built; UI copy claims it)* | — | — | — | — | `COMPANIES_HOUSE_API_KEY` declared, unused; `ClientIntakeForm.tsx:311` says "Auto-fetched from Companies House" | UK |
| **Xero / Intuit** | *(not built)* | — | — | — | — | `XERO_CLIENT_*`, `INTUIT_CLIENT_*` declared, unused | — |
| **Twilio** | *(superseded by AWS EUM, 1 Sep 2026)* | — | — | — | — | `TWILIO_*` declared, unused; no client in code | — |
| **Unleash** | *(feature flags — container only)* | — | — | — | — | `docker-compose.yml:350`; nothing reads it | — |

**Neoting's own public API surface:** `packages/contracts/openapi.yaml`, 76 paths under `/v1` plus `GET /d/{code}` off-prefix. Errors are RFC 7807 problem+json with an `NT-<FAMILY>-<NNN>` code (`common/problem/`). Families in use: `NT-AUTH-*` (8), `NT-BIL-*` (2), `NT-DOC-*`, `NT-EXP-*` (3), `NT-EXT-*`, `NT-ING-*`, `NT-INT-*`, `NT-IDM-*`, `NT-OTP-*`, `NT-PRM-*`, `NT-PRP-*` (7), `NT-PUB-*`, `NT-SRV-*`, `NT-VAL-*`, `NT-WFL-*`. Every code has a runbook entry (`docs/runbooks/error-codes.md`); adding one to the contract enum is a G7 contract change.

---

# 7. UK-specific logic map

Grep counts over `apps/ packages/ prisma/ services/ e2e/ evals/ scripts/ fixtures/ infra/`, excluding `node_modules` and `dist`: `£` 583 · `VAT` 507 · `GBP` 264 · `vatNumber|vat_number|VAT number` 183 · `Companies House|companyNumber|company_number` 108 · `Europe/London` 79 · `en-GB` 65 · `HMRC` 54 · `PAYE` 39 · `sortCode|sort_code` 25 · `GB[0-9]{9}` 22 · `countryCode|country_code` 11 · `postcode` 2 · `National Insurance` 1. **Zero occurrences** of `Making Tax Digital`, `MTD`, `Self Assessment`, `UTR`, and `6 April|5 April` in code.

## (a) Trivially configurable — a value change, a default, or a message catalogue entry

| What | File:line | Note |
|---|---|---|
| `Practice.countryCode` default `"GB"` | `prisma/schema.prisma:43` (`migrations/20260813154540_init/migration.sql:66`) | column exists; nothing branches on it |
| `Practice.baseCurrency` default `"GBP"` | `prisma/schema.prisma:44` (init:67) | |
| `Practice.language` default `"en-GB"` | `prisma/schema.prisma:45` (init:68) | column exists; nothing reads it |
| `Business.countryCode` / `baseCurrency` defaults | `prisma/schema.prisma:99,100` (init:93,94) | |
| `BankAccount.currency` default `"GBP"` | `prisma/schema.prisma:924` (init:391) | |
| `BankTransaction.currency` default `"GBP"` | `prisma/schema.prisma:961` (init:411) | |
| Synthetic bank account created as `currency: 'GBP'` | `apps/api/src/modules/banking-matching/statement-ingest/statement-ingest.ts:142,276,284` | hardcoded, not read from the business |
| Missing document currency defaults to GBP at publish | `apps/api/src/modules/validation-dedupe/proposals/publish-follow-up.ts:95` | comment says "v1 is UK practices" |
| Capitalisation policy default `£1,000` / `currency: 'GBP'` | `apps/api/src/modules/rules-suggestions/coding/capital-revenue.ts:138` | `PLATFORM_DEFAULT_CAPITALISATION_POLICY` |
| Intake defaults `'United Kingdom'`, `'GBP'` | `apps/web/src/components/DynamicComponents/ClientIntakeForm.tsx:335,343,991,992` | |
| Speech recognition pinned `en-GB` | `apps/web/src/lib/useSpeech.ts:57` | D22 pins Transcribe to `en-GB` too |
| Currency symbol tables `{GBP:'£', USD:'$', EUR:'€'}` | `apps/api/src/modules/validation-dedupe/correction-checks.ts` (`CURRENCY_SYMBOLS`), `.../approvals/render-summary.ts:798`, `apps/web/src/lib/resolver.ts:258` | already multi-currency-aware; just needs AUD |
| `currency()` defaults its code to `'GBP'` | `apps/web/src/lib/resolver.ts:270-272` | ~99 call sites rely on the default |
| `parseCodingDraft` / documents default `'GBP'` | `apps/web/src/api/document-detail.ts:341,540`, `apps/web/src/api/documents.ts:145` | |
| Vault seed categories "VAT registration certificate", "PAYE reference letter" | `apps/web/src/lib/seed2.ts:257,258` | demo data |
| Landing-page copy "It does not file with HMRC" | `apps/web/src/views/LandingView.tsx:128` | message catalogue entry |
| Practice name `Migrate Properly LLP` | `apps/web/src/lib/seed2.ts:262` | demo data |
| Demo statement generator: UK high-street banks, fictional sort code, FSCS note, `HMRC VAT QUARTERLY`, `HMRC PAYE` lines | `scripts/demo/bank-statement/plan.ts:144,152,187` | demo data |
| Seed data: `GB`-prefixed VAT numbers, a UK postcode, a UK-format sort code, banks Barclays/Starling, `yearEndMonth: 3` (values not reproduced here) | `prisma/seed.ts:133,139,174,182,221,582,596` | synthetic demo data |
| Chart-of-accounts prose citing HMRC BIM35805, CAA 2001 s.71, CIS domestic reverse charge, hot/cold food | `apps/api/src/modules/rules-suggestions/chart-of-accounts/profiles.ts:253,334,600` | data, but see (c) |
| `AI_DAILY_BUDGET_PENCE` reasoning in £ | `apps/api/src/config/env.ts:464-481` | comment only |

## (b) Needs a localisation layer — a per-tenant setting threaded through code that currently has a constant

| What | File:line | Why it is not just a value |
|---|---|---|
| **`Europe/London` hardcoded in rendering** | `apps/api/src/modules/chase/sms-copy.ts:203-208`; `.../notifications/email-copy.ts:15,62,121`; `.../portal/portal-provenance.ts:99-102`; `.../validation-dedupe/correction-checks.ts:todayInLondon`; `apps/web/src/api/chases.ts:82-83`; `apps/web/src/context/AppContext.tsx:995`; `apps/web/src/views/{TeamView,RemovedClientsPanel,ClientDetailView,AnalyticsView,ClientExpenseClaims}.tsx`; `apps/web/src/views/business/{LivePortalSettings,BusinessOnboardingView,LivePortalHome,PortalDocumentList}.tsx`; `apps/web/src/components/DynamicComponents/UkDateField.tsx`; `infra/envs/{staging,prod}/services.tf`; `apps/api/Dockerfile:241` | The repo invariant is literally "UTC in storage, **Europe/London** in rendering" (root `CLAUDE.md`, Governance §12). Making it per-tenant is a governance-text change as well as a code change. Date-boundary logic ("received today", "more than 7 years ago", chase day labels, coverage grids) is wrong by up to a day for any non-UK tenant. |
| **`en-GB` as the only locale** | `apps/web/src/i18n/index.ts:53-57` (`DEFAULT_LOCALE`, `SUPPORTED_LOCALES` — a one-element array), `AppIntlProvider.tsx` (no `messages` prop), `apps/web/lang/en-GB.json` (12,277 lines) | The i18n discipline is good — every user-facing string goes through `defineMessages` and `pnpm i18n:check` fails the build on a duplicate id or a missing default — so a second catalogue is a data addition. But `resolveLocale()` returns a constant and `navigator.language` is deliberately not consulted. |
| **`en-GB` used for number/date formatting, not just copy** | `apps/web/src/lib/resolver.ts:272`, `.../promptSuggestions.ts:255`, `.../demoIntents.ts:47`, `.../business.ts:33`, `.../workflowParser.ts:301`, `apps/web/src/context/AppContext.tsx:1546,1848,2892`, `apps/web/src/api/statements.ts:60`, `apps/api/.../completeness.ts:185`, `.../approvals/workflow-draft/compose-draft.ts:102` | `toLocaleString('en-GB')` produces UK grouping and ordering regardless of the message catalogue. |
| **Currency formatting is per-callsite, not per-tenant** | six formatters, listed in §3.7 | `formatGbp` (`chase/sms-copy.ts:179-185`) hardcodes `£` and cannot take a code at all. |
| **`£` as a literal** | `apps/api/src/modules/chase/sms-copy.ts:185`; `.../banking-matching/statement-ingest/completeness.ts:187`; `.../chat-framework/grounding.ts:224`; `.../exports-public-api/api/exports.service.ts:777`; `.../approvals/workflow-draft/compose-draft.ts:48` (`const POUND = '£'`); `.../workflow-instructions.ts:258,271` (prompt text: "Give thresholds in POUNDS"); `apps/web/src/lib/workflowParser.ts:301`; `apps/web/src/components/DynamicComponents/{BankFilterPanel,ApprovalBatchCard,WorkflowEditor}.tsx` | Several of these are inside model prompts, so changing them changes an eval-gated artefact. |
| **`sortCode` in the model and the UI** | `prisma/schema.prisma:925`; `apps/web/src/views/BankView.tsx`; `apps/web/src/lib/types.ts`; `scripts/demo/bank-statement/*` | A `prisma/` change is LAW (G7). AU's BSB is a different shape and there is no account-number length assumption to keep. |
| **Bank statement header vocabulary** | `apps/api/src/modules/banking-matching/statement-ingest/statement-parser.ts:91-96` | Anchored regexes including `amount \(gbp\)` and `balance \(gbp\)`; `paid out|paid in` is a UK phrasing. Also **a header row is required** — `findMapping` refuses `noHeaderRow`. |
| **SMS: `+44`-first mobile handling** | chase composer (review item 8, `docs/reviews/MUBASHIR_REVIEW_NOTES.md`), `apps/api/src/modules/clients-team-settings/invite-sms.ts` | `07…` → `+44` normalisation. |
| **GSM-7 character set check includes `£`** | `apps/web/src/components/DynamicComponents/ChaseComposer.tsx:153` | segment-count estimate. |
| **UK d/m/y date control** | `apps/web/src/components/DynamicComponents/UkDateField.tsx`, `apps/web/src/lib/tableImport.ts:100-134` (`parseUkDate`) | Day-first is correct for Australia too, so this **carries over unchanged** — but the component name, copy and long-form rendering are UK-branded. |
| **VT `DD/MM/YYYY` cell format** | `apps/api/src/modules/exports-public-api/emitters/vt/vt-format.ts:37-52` | Correct for AU as well; belongs to the target, not the country. |
| **Stripe GBP price + 20% GB VAT rate** | `apps/api/src/config/env.ts:508-536,876,883`; `apps/api/src/modules/billing/http-stripe-client.ts:50,142,200` | Needs an AUD price object and AU GST treatment; the boot gate hardcodes the assumption in its own error message. |

## (c) Needs new logic for Australia — not a rename

| What | File:line | Why |
|---|---|---|
| **The whole VAT field model** | `apps/api/src/modules/extraction/bedrock-extraction-schema.ts:56,114,182,208` (`vatNumber`), `.../document-extractor.ts` (`ExtractedDocument.vatNumber`), `prisma/schema.prisma:47,103`, `packages/contracts/openapi.yaml` (`Extraction`, `Document`) | An AU tax invoice has legally prescribed contents (seven items under A$1,000, plus buyer identity/ABN at ≥ A$1,000). `vatNumber` → ABN is a **contract (LAW) change**, and the ABN has a mod-89 checksum with a free ABR lookup that also returns GST-registration status — which the tax-invoice validator needs. A non-GST-registered supplier legitimately issues an invoice with no GST and must not be flagged. |
| **`checkVatArithmetic`** | `apps/api/src/modules/extraction/bedrock-extraction-schema.ts:150-158` | The net+tax=gross core is rate-agnostic and survives; what changes is the implied-rate convention (GST is conventionally 1/11 of the GST-inclusive total, against the UK's 20%/5%/0% ladder). |
| **`vatTreatment` enum on every chart account** | `apps/api/src/modules/rules-suggestions/chart-of-accounts/account.ts:83` (`STANDARD`, `ZERO_OR_EXEMPT`, `OUTSIDE_SCOPE`, `BLOCKED`, `VARIES`) | `BLOCKED` encodes UK input-tax blocking (entertaining, most cars); AU has different rules. The five values are a UK VAT model. |
| **The four business-type profiles and every account in them** | `apps/api/src/modules/rules-suggestions/chart-of-accounts/profiles.ts` (829 lines) | `COS_SUBCONTRACTORS_CIS`, `EMPLOYER_NI_AND_PENSION`, `RATES_AND_WATER`, the CIS domestic reverse-charge review note (line 600) and the hot/cold-food zero-rate note are UK constructs. AU needs superannuation, PAYG, and a different set. |
| **The coding decision rules citing UK authority** | `apps/api/src/modules/rules-suggestions/coding/coding-instructions.ts:52-121` — HMRC BIM35805, CAA 2001 s.71, HMRC VATPOSS14600, "You are coding one purchase document for a **UK accounting practice**" | Prompt text that is also code (a test asserts prompt/code agreement). Rule 7 already names "Australian GST" as a foreign tax that is never reclaimable — from the UK side. |
| **Chase suppression descriptor list** | `apps/api/src/modules/chase/suppression.ts:23-33` | `CHAPS`, `SUMUP`, `WORLDPAY`, `STRIPE PAYOUT` etc. will not match AU narratives (BPAY, Osko, PayID, EFTPOS, Direct Entry/BECS, ATO, Tyro, Square AU, Zeller). Getting this wrong means chasing clients for BPAY fees and ATO payments in week one — the exact over-chasing failure §24.2.3 names as fatal. |
| **Chase redirect list (HMRC → pensions)** | SoT §24.2.3 (document, not code yet) | Becomes ATO → super clearing houses. |
| **Bank statement dialect handling** | `apps/api/src/modules/banking-matching/statement-ingest/statement-parser.ts` | CBA's CSV reportedly has **no header row** (refused outright today); Westpac uses `Debit Amount`/`Credit Amount` (not matched by the anchored regexes); ANZ's CSV carries no running balance, so D41's `reduced` assurance class will fire constantly. Needs an AU corpus and positional inference for headerless files. |
| **TFN detection and refusal to store** | **does not exist anywhere** | Privacy (TFN) Rule 2015 / TAA ss 8WA–8WB make recording a TFN without authority an offence. Clients will photograph payment summaries and super letters. There is no analogue in the UK build, so nothing looks for it. This is a **new pipeline stage**, not a rename. |
| **Export target** | `apps/api/src/modules/exports-public-api/emitters/vt/` | VT Transaction+ is UK-only. `GENERIC_CSV` exists but D43's whole link ladder is VT-shaped (the capability code rides VT's `Paid to/invoice details` column). AU needs at minimum a Xero-shaped CSV emitter, and competitively probably the Xero API adapter D42 defers. |
| **Data residency and model region** | `apps/api/src/config/env.ts:259` (`BEDROCK_REGION` default `eu-west-2`), `SES_REGION:371`, `SMS_REGION:314`, `S3_REGION:539`, `infra/envs/*`, `docs/adr/0001-bedrock-model-tiers-uk-residency.md` | D30 permits no non-UK processing without a versioned amendment. An AU deployment is a new region (`ap-southeast-2`), new KMS keys, new buckets, a new DPIA posture under APP 8, and re-verification that the three pinned model IDs are available in-region. |
| **`Practice.language` / `countryCode` are inert** | `prisma/schema.prisma:43,45` | The columns exist but **no code branches on either**. There is no country abstraction to hang AU behaviour on — see §8.4. |
| **SMS sender-ID registration** | operational, not code | ACMA's Sender ID Register has been mandatory since 1 Jul 2026; an unregistered alphanumeric sender is stamped "Unverified" on every chase. |

---

# 8. Configuration and environments

## 8.1 Environment variables

`apps/api/src/config/env.ts` is the **only** file permitted to read `process.env` (Governance §11.5). It is 935 lines, Zod-validated, and fails fast at boot. `.env.example` documents 69 variables. **No secret values appear below — names only.**

### Core

| Name | Controls | Default |
|---|---|---|
| `NODE_ENV` | development \| test \| production | development |
| `PORT` | API listen port (pinned 3000 by the ALB target group) | 3000 |
| `TZ` | Container timezone | `Europe/London` (set in Dockerfile and both `services.tf`) |
| `DATABASE_URL` | Application connection, role `nt_app`, **subject to RLS** | — |
| `DIRECT_URL` | Owner connection for migrations and seed | — |
| `REDIS_URL` | Queue, budgets, rate limits, replay stores | `redis://localhost:6379` |

### Mode switches (each `demo`/`fixture` value is refused under `NODE_ENV=production`)

| Name | Values | Selects |
|---|---|---|
| `AUTH_MODE` | `fixture` \| `session` | request-context resolver |
| `OTP_MODE` | `demo` \| `totp` | second factor for both accountant sign-in and the portal |
| `INGEST_QUEUE` | `fixture` \| `bullmq` | ingest queue |
| `OBJECT_STORE` | `fixture` \| `s3` | document storage |
| `EMAIL_SOURCE` | `fixture` \| `mailhog` \| `s3` | inbound email source |
| `EMAIL_SENDER` | `demo` \| `smtp` \| `ses` | outbound email transport |
| `EMAIL_RATE_LIMIT` | `memory` \| `redis` | limiter store |
| `SMS_SENDER` | `demo` \| `email` \| `aws` | chase transport (**the name is one value out of date**; it selects the chase transport, of which SMS is no longer the only one) |
| `MEDIA_FETCH` | `fixture` \| `graph` | WhatsApp media download |
| `IMAGE_NORMALISER` | `fixture` \| `sharp` | EXIF/HEIC handling |
| `DOCUMENT_GUARD` | `fixture` \| `qpdf` | PDF safety |
| `EXTRACTOR` | `demo` \| `bedrock` \| `replay` | document extractor |
| `STATEMENT_READER` | `none` \| `textract` | statement OCR |
| `AI_CHAT` | `demo` \| `bedrock` \| `replay` | chat model provider |
| `LEDGER_ADAPTER` | `demo` | ledger adapter (**one value only**) |
| `BILLING` | `demo` \| `stripe` | Stripe client |
| `STRIPE_TAX` | `rate` \| `automatic` | tax on the subscription |

### Secrets (names only; all default to empty and fail closed)

`SESSION_SECRET` (signs the session cookie) · `UPLOAD_URL_SECRET` (signs upload intents) · `PORTAL_LINK_SECRET` (signs the 24 h chase portal link) · `PORTAL_SESSION_SECRET` (signs the portal bearer — deliberately a *second* secret so rotating one does not invalidate the other) · `META_APP_SECRET` · `META_VERIFY_TOKEN` · `META_MEDIA_ACCESS_TOKEN` · `STRIPE_SECRET_KEY` · `STRIPE_WEBHOOK_SECRET` · `S3_ACCESS_KEY_ID` · `S3_SECRET_ACCESS_KEY` · `HMRC_CLIENT_ID` · `HMRC_CLIENT_SECRET` · `XERO_CLIENT_ID` · `XERO_CLIENT_SECRET` · `INTUIT_CLIENT_ID` · `INTUIT_CLIENT_SECRET` · `TRUELAYER_CLIENT_ID` · `TRUELAYER_CLIENT_SECRET` · `COMPANIES_HOUSE_API_KEY` · `TWILIO_ACCOUNT_SID` · `TWILIO_AUTH_TOKEN` · `TWILIO_MESSAGING_SERVICE_SID` · `TWILIO_VERIFY_SERVICE_SID`. **The last nine are declared and read by no code.** Empty secrets are refused at boot in production for the first four.

### Regions, addresses and tuning

`AWS_REGION` · `BEDROCK_REGION` (`eu-west-2`) · `SES_REGION` (`eu-west-2`) · `SMS_REGION` (`eu-west-2`) · `S3_REGION` (`eu-west-2`) · `S3_ENDPOINT` · `S3_FORCE_PATH_STYLE` · `S3_BUCKET_DOCUMENTS` · `S3_BUCKET_EXPORTS` · `S3_BUCKET_RECEIPTS` · `APP_ORIGIN` · `EMAIL_FROM_ADDRESS` (`no-reply@`, **never** `doc@` — that is the inbound intake address) · `EMAIL_REPLY_TO_ADDRESS` · `EMAIL_CONFIGURATION_SET` · `SMTP_HOST` · `SMTP_PORT` · `MAILHOG_API_URL` · `SMS_ORIGINATION_IDENTITY` · `UPLOAD_URL_TTL_SECONDS` (900) · `AI_DAILY_BUDGET_PENCE` (2500) · `WHATSAPP_PRACTICE_MAP` (JSON `phone_number_id → practiceId`, an override for the DB column) · `BILLING_RETURN_ORIGINS` · `STRIPE_PRICE_ID` · `STRIPE_TAX_RATE_ID`.

### Web (Vite, build-time)

`VITE_API_ENABLED` (default off — the app renders synthetic data) · `VITE_API_MOCKING` (`enabled` turns on MSW) · `VITE_API_BASE_URL`.

### Turbo

`turbo.json:globalEnv` is an explicit allow-list — an undeclared variable is silently absent inside a task, which is how a tenancy suite once reported "9 skipped" in CI while the workflow set both URLs three lines above. Anything a test needs must be declared there.

## 8.2 Feature flags — `STUB`

A `feature_flags` table (`prisma/schema.prisma:1837`: `key`, `isEnabled`, `owner`, `removeBy`) and an Unleash container plus init job (`docker-compose.yml:321,350`, `infra/envs/staging/unleash.tf`) exist. **No application code reads either.** A grep for `featureFlag`, `FeatureFlag`, `unleash` across `apps/api/src` and `apps/web/src` returns nothing. All behavioural switching is done by the env enums above.

## 8.3 Per-tenant settings

Held on `practices` and `businesses` and **only partly honoured**:

| Setting | Column | Read by code? |
|---|---|---|
| Document link TTL | `practices.documentLinkTtlDays` | **Yes** — `exports-public-api/links/` |
| WhatsApp number → practice | `practices.whatsappPhoneNumberId` | **Yes** — the worker's `PrismaWhatsAppPracticeResolver` |
| Country code | `practices.countryCode`, `businesses.countryCode` | **No** |
| Base currency | `practices.baseCurrency`, `businesses.baseCurrency` | **No** |
| Language | `practices.language` | **No** |
| VAT registration / number / scheme / frequency / period start | `businesses.vat*` | **No** — captured at intake, displayed, never used |
| Year end | `*.yearEndMonth`, `*.yearEndDay` | **No** |
| Next deadline | `businesses.nextDeadline` | Display only |
| Business context questionnaire | `businesses.contextQuestionnaire` | **Yes** — feeds coding grounding via `profileForModel()` |
| Subscription | `businesses.subscription*`, `stripeCustomerId`, `plan` | **Yes** — entitlement |
| Capitalisation policy | **no column** | Platform default only; a per-practice setting is owed |
| Chase cadence / quiet hours | **no column** | Not implemented |
| Approval workflows | `approval_workflows` | **Yes** |
| Guidance | `guidance` | Seeded and read by the model; **no CRUD surface** |

## 8.4 How a new country/locale/currency would be introduced today

**Honest answer: there is no country abstraction. There is a partial locale abstraction and no currency abstraction.**

- **Country:** `countryCode` is a column with a default and **zero readers**. Nothing branches on it. Adding Australia today means editing UK constants in place, not adding a second country. There is no `CountryProfile`, no jurisdiction registry, no per-country rule pack.
- **Locale:** genuinely good bones. Every user-facing string in `apps/web` goes through `defineMessages`/`intl.formatMessage`, ICU MessageFormat is mandatory, `eslint-plugin-formatjs` plus a custom `no-literal-string-in-jsx` rule block hardcoded copy, and `pnpm i18n:check` fails the build on a duplicate id or a message with no default. `apps/web/lang/en-GB.json` (12,277 lines) is the extracted artefact. Adding `en-AU` is a compiled catalogue plus a `SUPPORTED_LOCALES` entry plus making `resolveLocale()` do something (`apps/web/src/i18n/index.ts:66-73`). **But:** `toLocaleString('en-GB')` calls scattered through `lib/` and `AppContext` bypass the catalogue, and **the server has no i18n at all** — `email-copy.ts`, `sms-copy.ts` and every `render-summary` string are English literals composed in TypeScript.
- **Currency:** no abstraction. Six formatters, `£` literals in prompts and in `formatGbp`, and Prisma defaults of `"GBP"`. Field names (`amountPence`, `totalPence`, `formatPenceDecimal`) are contract-level (LAW). The AU research recommends **accepting the `pence` naming as "minor units"** rather than a LAW-wide rename, and flags that as a call for the owner.
- **Timezone:** the invariant is written into the root `CLAUDE.md` and Governance §12 as *"UTC in storage, Europe/London in rendering"*. Per-tenant rendering is a governance change plus threading a zone through ~20 formatters.

The one real seam that would help: **every external dependency is already selected by config rather than by import**, so an AU deployment can swap the extractor, OCR reader, SMS transport, email transport, object store and ledger adapter without touching a call site. That pattern is the template a country abstraction should follow.
---

# 9. AI layer

## 9.1 Where prompts live

Prompts are **source files, versioned like code**. Governance §9.8 forbids prompt edits via dashboards or env vars.

| Prompt | File | Version constant |
|---|---|---|
| Workspace chat system prompt | `apps/api/src/modules/chat-framework/prompts/system-prompt.ts` | `PROMPT_VERSION = 'chat-workspace/2026-09-05.2'` |
| Chat output schema (forced tool) | `.../prompts/output-schema.ts` | — |
| Chat prompt suggestions | `.../prompts/suggestions-prompt.ts` | — |
| Document extraction | `apps/api/src/modules/extraction/bedrock-extraction-schema.ts` + `bedrock-extractor.ts:112` | — |
| Coding instructions (the accounting rules) | `apps/api/src/modules/rules-suggestions/coding/coding-instructions.ts` | `CODING_PROMPT_VERSION = 'coding-instructions-2'` |
| Correction second opinion | `.../coding/correction-opinion.ts` | — |
| Approval-workflow drafting | `apps/api/src/modules/approvals/workflow-draft/workflow-instructions.ts` | — |
| Client profile for grounding | `apps/api/src/modules/clients-team-settings/business-profile.ts` (`profileForModel`) | — |

The chat system prompt is deliberately a **byte-stable cache prefix** — nothing per-request may be interpolated into it, because prompt caching is a byte-exact prefix match and the hash is the replay key for `pnpm test:eval`. Coding instructions live in their own module with their own version precisely so an accounting-rule change does not orphan every recorded chat eval.

## 9.2 Models

`apps/api/src/modules/chat-framework/models.ts` is the single source of truth (Governance §9.1). Three tiers, all on-demand in `eu-west-2`:

- `judgment` — `anthropic.claude-opus-4-6-v1`
- `workhorse` — `anthropic.claude-sonnet-4-6`
- `mechanical` — `amazon.nova-lite-v1:0`

Fifteen task classes map to (tier, effort): `chatWorkspace` (judgment/high), `chatSuggestions` (judgment/low), `crossClientAnalysis` (judgment/max), `ruleParsing` (judgment/high), `ruleConflictResolution` (judgment/max), `extractionVisionFinal` (judgment/max), **`codingSuggestion` (judgment/high — raised from workhorse on 6 Sep 2026 after review item 19)**, `chaseComposition`, `chaseValidation`, `addresseeEscalation`, `vaultSummary` (workhorse/medium), `extractionVisionFirst` (workhorse/high), `docTypeTriage`, `addresseeShortlist`, `dedupeTextAssist` (mechanical). Per-family decoding parameters are declared (`FAMILY_PARAMS`) because Opus 4.8 rejects `temperature` outright while 4.6 accepts it, and thinking and `temperature: 0` cannot co-exist.

**There is deliberately no `BEDROCK_MODEL_ID` env var** — an env override would let a model be swapped by editing an ECS task definition with no PR and no eval run. The ECS task role holds region-pinned *foundation-model* ARNs and no inference-profile ARN, so adding an `eu.*`/`global.*` id returns AccessDenied rather than quietly sending UK client documents abroad.

## 9.3 What is sent to the model

| Call | Inputs |
|---|---|
| Extraction | The document image/PDF bytes, plus our instruction block. Forced tool call `record_extraction`-style JSON schema. |
| Coding | Supplier name, line descriptions, amounts, currency, doc type (**all wrapped in `<untrusted_content>`**), plus the client's chart of accounts, the client's trade label and their own intake answers (wrapped), and the capitalisation policy. Measured 5,152 input + 204 output tokens = 2.47p per call on a real case. |
| Correction second opinion | The stored document facts and the human's typed correction. Returns three enums only. |
| Chat | The system prompt (cache prefix), then a grounding block of real records built by `chat-framework/grounding.ts` — documents, bank transactions, chases, statements, each with an id, each narrative field wrapped. |
| Chat suggestions | The client's real counts. |
| Workflow drafting | The accountant's sentence, wrapped. |

## 9.4 Output parsing

Every call uses a **forced tool call with a strict Zod parse** on the way back (`chat-framework/invoke-structured.ts`, `extraction/bedrock-extraction-schema.ts`, `coding/coding-instructions.ts`). Money fields are `z.number().int()`; confidence fields are deliberately *not* named after money fields so a float can never land in a pence column. `.catch(null)` is used per-field so one unreadable value does not discard the whole read. A code the model returns that is not on the client's chart is **refused outright, never fuzzy-matched** — the prompt says so and the parser enforces it.

## 9.5 Evaluation and test coverage

`evals/` — run with `pnpm test:eval` (chat), `test:eval:coding`, `test:eval:workflow`.

| Dataset | Lines | Covers |
|---|---|---|
| `evals/datasets/rule-parsing.jsonl` | 34 | chat intent routing + field extraction |
| `evals/datasets/coding-ladder.jsonl` | 17 | coding decisions and escalations |
| `evals/datasets/injection-corpus.jsonl` | 10 | prompt-injection resistance |
| `evals/datasets/workflow-drafts.jsonl` | 10 | natural-language workflow parsing |

Runners: `evals/src/run-{chat,coding,workflow}-evals.ts`, plus `replay-provider.ts` and `smoke-bedrock.ts`. Recorded results referenced in `docs/reviews/MUBASHIR_REVIEW_NOTES.md`: intent accuracy 93.3–94.1%, fields 100%, **0 injection leaks**, re-recorded live against the model on every prompt change. `coding-instructions.test.ts` additionally asserts that every escalation reason and named basis in code also appears in the prompt text, so a rule added in one place and forgotten in the other fails the build.

**Gap:** there is **no labelled extraction corpus and no extraction accuracy eval.** The readiness confidence thresholds SoT Stage 5 asks for cannot be calibrated until one exists, which is why that seam is deliberately empty (`validation-dedupe/readiness.ts`).

## 9.6 Cost controls

- `apps/api/src/common/ai-budget.ts` — a per-**practice** daily ledger in Redis, key `nt:{practiceId}:_:ai:budget:{date}` (UTC day, so it does not move with BST). Warn at 80%, hard stop at 100%. `AI_DAILY_BUDGET_PENCE` default 2500 (£25/day ≈ 1,250 documents).
- **Check-then-spend, not reserve-then-settle** — a practice can overshoot by at most one in-flight call.
- **One meter, two spenders** (chat and extraction), deliberately: a firm asking "what did we spend on AI today" must get one number. The consequence is stated plainly — a practice that exhausts the ceiling in chat will see that day's documents land `FAILED`.
- Rates are pinned in `models.ts:TIER_RATES_PENCE_PER_MTOK`; `costPence()` rounds **up** so a budget never under-counts.
- Per-task `maxTokens` and `timeoutMs` in `TASK_BUDGETS`.
- Prompt caching is mandatory on stable prefixes (§9.7); `usage.cache_read_input_tokens` reading zero is the documented symptom of someone interpolating into the system prompt.
- Measurement scripts exist: `scripts/measure/extraction-cost.ts`, `scripts/measure/coding-cost.ts`, `scripts/measure/coding-escalation-rate.ts`. **The escalation-rate script has never been run against a real corpus**, and the blended-cost guardrail (D20's £0.02/document) holds only while fewer than 27% of documents reach the judgment coding rung.

## 9.7 Fallbacks when the model fails

- **`DEGRADE_CHAIN` is populated with empty arrays for every task.** §9.3 permits degrading only to a tier whose evals a task has passed, and no lower tier has passed anything. So the answer to a model failure is an honest error with a retry, never a quieter model producing a worse answer silently.
- **No fallback extractor** — deleted 25 Aug 2026 (see §5.4). A failed read is `FAILED` with a visible reason.
- Circuit breaker on the chat provider (`chat-framework/provider/circuit-breaker.ts`).
- Budget exhaustion produces a clear user-facing message, not a silent degradation.
- `replay` mode (cassettes on disk, `apps/api/fixtures/cassettes/bedrock/`) fails loudly naming the record command when a cassette is missing; it never falls through to live Bedrock.
- Telemetry: `chat-framework/telemetry.ts` emits `ai.call`, `ai.fallback` and `ai.injection_signal` JSON log lines with metric names.

## 9.8 RAG / vector store — `MISSING`

There is no vector store, no embedding model and no retrieval index. "Grounding" is a **deterministic SQL read** (`chat-framework/grounding.ts`) that selects the client's actual records for the question at hand and puts them in the message body with ids the model must cite. If the supplied records do not contain the answer, the model returns `GROUNDED_ANSWER` with an empty `citedRecordIds` and the system says the honest thing on its behalf. `guidance` rows are injected as text, not retrieved. The Prisma `fullTextSearch` preview flag is enabled and unused.

## 9.9 Guardrails summary

1. `wrapUntrusted()` (`apps/api/src/common/untrusted-content.ts`) wraps every externally-supplied string in `<untrusted_content>` and entity-escapes any embedded wrapper tags so a sender cannot close the block early.
2. **No model-authored sentence appears on an approval card.** The model contributes enums; every string on the review card is server-composed from the payload, because the approve hash covers that text.
3. The model cannot approve, send, publish or change anything — it identifies intent and a human presses Approve.
4. Chat is forbidden from totalling figures into any financial statement and from giving tax or legal advice (`SCOPE_REFUSAL`).
5. Chat may never name amounts, dates or counts it was not given.
6. A category code not on the client's chart is refused, never corrected to the nearest.
7. Every AI call is audit-logged with model id, prompt version, input hash, latency and token counts.

---

# 10. Quality and readiness

## 10.1 Test coverage by area

| Suite | Count | Command |
|---|---:|---|
| API unit tests | 213 files | `pnpm --filter @neoting/api test` (vitest) |
| API integration tests (real Postgres + RLS) | 43 files | same, gated on `DATABASE_URL` + `DIRECT_URL` |
| Web tests (vitest + Testing Library + jsdom + MSW) | 88 files | `pnpm --filter @neoting/web test` |
| Contract runtime-import check | 1 script | `packages/contracts/scripts/verify-runtime-import.mjs` |
| AI evals | 4 datasets / 3 runners | `pnpm test:eval[:coding|:workflow]` |
| **End-to-end (Playwright or similar)** | **0 — `e2e/` is a scaffold** | `pnpm test:e2e` exits 0 having run nothing; CI marks the stage NOT IMPLEMENTED |

**How to run everything:** `pnpm install` → `docker compose up -d` → `pnpm db:migrate && pnpm db:app-role && pnpm db:seed` → `pnpm dev`. CI runs `pnpm typecheck && pnpm lint && pnpm test`, and the Definition of Done adds `pnpm build`. Clone-to-running target is 10 minutes.

Integration tests run **file-serially** (`apps/api/vitest.config.ts`: `fileParallelism: false`) because they share one Postgres and isolate by id prefix, and Prisma's `startsWith` compiles to an unescaped `LIKE 'p4_%'` that cross-matches other suites' prefixes.

## 10.2 Skipped tests

**All 43 integration suites use `describe.skipIf(!enabled)` and silently skip without a database.** That is the intended design, but it means a green local `pnpm test` may have exercised only the 213 unit files. `turbo.json:globalEnv` declares `DATABASE_URL`, `DIRECT_URL`, `RUN_S3_INTEGRATION` and the `S3_*` pair specifically so this cannot happen invisibly in CI — the comment in that file records that it once did ("9 skipped" while the workflow set both URLs three lines above). The MinIO round-trip (`s3-document-store.integration.test.ts`) additionally requires `RUN_S3_INTEGRATION=1`.

There are **no `it.skip`, `test.skip` or `.todo` tests** anywhere.

## 10.3 CI status

`.github/workflows/check.yml` — a nine-stage pipeline fronted by a **readiness probe** that inspects every workspace `package.json` and classifies a script as real only if it exists and does not start with `echo`. A stage with no suite behind it is skipped and labelled `NOT IMPLEMENTED`, and every run prints a debt table naming the stage, its governance clause and the condition that turns it on. A stage that *is* implemented treats Turbo's "No tasks were executed" as a failure. Draft PRs are skipped; `pull_request` runs cancel in progress, pushes to `main` queue. Branch protection pins the required check to the literal job name `check` (`.github/scripts/apply-branch-protection.sh`). Two more workflows: `deploy-web.yml` (Vercel), `terraform.yml`.

⚠ **A saved memory from this environment records that CI checks are currently DISABLED locally — a green result may mean nothing ran. Verify the live GitHub Actions state before trusting it.**

## 10.4 Linting

`eslint` 10 with `@typescript-eslint` 8. Governance §14.3 names five blocking rule families: **a11y, i18n-literal, money-type, module-boundary, unscoped-query**. Implemented:

- `apps/api/eslint/no-cross-module-internals.js` — module boundaries (with its own test).
- `apps/api/eslint/money-selectors.test.js` — money-type selectors.
- `apps/web/eslint/no-literal-string-in-jsx.js` — i18n literals (with its own test).
- `eslint-plugin-jsx-a11y` — accessibility, blocking.
- `eslint-plugin-formatjs`, `eslint-plugin-react-hooks`.
- `apps/web/scripts/check-i18n.mjs` — fails on duplicate ids or missing defaults.
- `apps/web/scripts/check-colors.mjs` — design-token discipline.
- `packages/contracts/scripts/{enforce-money-int,check-contract,strip-zod-describe,mark-zod-pure,add-js-extensions}.mjs` — contract generation guards.
- Commitlint (conventional commits) on the PR title, since the squash commit takes it.
- Husky hooks.

## 10.5 Performance hotspots

| Hotspot | Where | Note |
|---|---|---|
| Perceptual-hash duplicate scan | `ingestion-routing/queue/duplicate-detector.ts` | Hamming distance cannot be answered by a B-tree, so it is an in-memory scan of the business's images, **capped at 500 newest** and reported truncated. "At 50 documents per client per month that is fine this year and not fine in three." Real fix = hash banding or a BK-tree, which is a LAW change. |
| Textract async read | `common/ocr/textract-ocr-reader.ts` | 40–60 s for 29 pages. Must never run inside `scopedDb` (10 s transaction timeout). Already correct. |
| `scryptSync` password hashing | `auth-tenancy/password.ts` | Blocks the event loop ~50–100 ms per call. Called outside the signup transaction. Argon2id is the planned replacement, as a new scheme prefix. |
| Publish batches | `publishing/demo-xero-adapter.ts` | Up to 500 items; the 800 ms per-item delay is survivable only because it runs post-commit outside the effect transaction. |
| RLS `EXISTS` per row | `prisma/sql/rls.sql` §7 | Mitigated by two named indexes that must not be dropped. |
| Web page truncation | `apps/web/src/api/paged.ts`, `api/slices.ts` | A client with 2,288 bank transactions once showed 100 with no message. Truncation is now followed to the end and the residual case is reported visibly. |

## 10.6 Security posture

- **Auth:** scrypt passwords with a burn-hash against timing enumeration; HMAC-signed stateless session cookie; TOTP (RFC 6238) with single-use recovery codes; sign-in throttling (`sign-in-throttle.ts`) with rate-limit headers; portal OTP with attempt counting and lockout (`portal/otp-attempts.ts`); five distinct portal failures collapse into one `NT-OTP-001` to avoid an enumeration oracle.
- **Tenancy:** Postgres RLS, forced, with a non-superuser non-bypassing application role and a boot-time assertion that it stays that way.
- **Encryption in transit:** HTTPS via ALB and Vercel; VPC endpoints for AWS services (`infra/*/endpoints.tf`).
- **Encryption at rest:** customer-managed KMS keys for secrets and documents (`infra/envs/*/secrets.tf`, `modules/storage/`); RDS `storage_encrypted`; request-time encryption gating (ADR 0008).
- **Secrets management:** AWS Secrets Manager, KMS-encrypted, injected into ECS task definitions; the execution role's `secretsmanager:GetSecretValue` is scoped to the named ARNs and its `kms:Decrypt` is conditioned on `kms:ViaService`. No secret is in the repo; `.env.example` holds names and blanks only.
- **Input validation:** Zod at every boundary — controllers, job payloads, webhook receivers, portal endpoints, model outputs, adapter responses (`common/validation/parse-boundary.ts`).
- **File upload safety:** format allow-list, zip-bomb guard, virus-scan hook (interface only in code; ClamAV in Terraform), encrypted/JS PDF guard via qpdf, EXIF stripping and re-encoding via sharp, safe basename, HMAC-signed 15-minute upload intents, S3 keys namespaced under `w/`.
- **Webhooks:** HMAC verification with fail-closed empty secrets, timestamp windows, replay stores, for both Meta and Stripe.
- **Capability URLs:** `GET /d/{code}` is the only route outside the session wall; the token *is* the authorisation; per-practice TTL, revocable via a proposal, access-counted, rate-limited (`links/link-rate-limit.ts`).
- **Prompt injection:** `<untrusted_content>` wrapping plus a 10-case injection eval corpus reporting 0 leaks.
- **Logging hygiene:** the email domain and provider message id are logged, never the address or the body (a sign-in body contains a live credential). `audit_events.actorPseudonym`, not a name.
- **Known weaknesses:** the virus scanner is a fixture in code; `DOCUMENT_GUARD=fixture` has a documented false negative on incrementally-updated PDFs (refused in production); `hideFinancialFields` is stored and not enforced when serving a document; there is no ownership transfer; there is no CSP or security-header configuration visible in the web build; and no dependency-scanning or SAST stage exists in CI beyond `pnpm.overrides` pins for three advisories (`lodash`, `js-yaml`, `multer`).

## 10.7 Data residency

**UK, by decision D30 and ADR 0001.** Everything runs in `eu-west-2` (London): RDS, ElastiCache, S3, ECS, SES, Textract, Bedrock, AWS End User Messaging. Model IDs are chosen specifically because they are reachable on-demand *in region* — cross-region inference profiles process outside the UK and are excluded, and the task role holds no inference-profile ARN so the exclusion is structural rather than a promise. The one exception is the DR target: **eu-west-1 (Ireland), for backup and replication only** (ADR 0007, `infra/envs/prod/replication.tf`).

## 10.8 Backups

- RDS automated backups, **35-day retention** in prod (`infra/envs/prod/data.tf:142`), `deletion_protection = true`, final snapshot required with a generation-stamped identifier.
- ElastiCache snapshot retention 7 days.
- S3 versioning on both source and DR bucket; cross-region replication to eu-west-1 with **Replication Time Control deliberately purchased** (without it replication is best-effort); lifecycle transition to Standard-IA at 90 days.
- CloudTrail, GuardDuty, Access Analyzer and budgets at the account level (`infra/envs/account/`).
- **⚠ No restore drill has been performed.** ADR 0007 says so explicitly: "an untested backup is a hope… this ADR is not *finished* until an RTO number is measured and written into it." **That is still open.**

## 10.9 Accessibility

`eslint-plugin-jsx-a11y` is wired and blocking (Governance §12.5/§14.3). Semantic markup, `aria-label`s on icon buttons, `useEscape` for dialog dismissal, `useScrollActiveIntoView` for keyboard navigation, focus management in `Modal.tsx`, and a documented modal-overflow audit (review items 23 + 40) so Approve is always reachable. **There is no automated axe run, no screen-reader testing record, and no stated WCAG conformance target.**

## 10.10 Every TODO / FIXME / HACK comment

A repo-wide grep for `TODO`, `FIXME`, `HACK`, `XXX` over `apps/`, `packages/contracts/src/`, `prisma/`, `scripts/`, `services/`, `e2e/` and `evals/` (excluding `dist/` and `node_modules/`) returns **14 hits, and only two are live action items** — the rest are prose referring to a TODO that was already closed.

| File:line | Text | Live? |
|---|---|---|
| `apps/api/src/modules/health/health.controller.ts:21` | `TODO(readiness): once Postgres and Redis are wired, check reachability` | **Yes** — `/healthz` does not check dependencies |
| `apps/api/src/modules/ingestion-routing/lib/sanitisation/guards.ts:90,109` | `TODO(#7): replace with the PDF-toolkit-backed guard` | **Yes** — the fixture guard's false negative |
| `apps/api/src/config/app-database-url.ts:14` | narrative: a TODO the api "carried" | closed |
| `apps/api/src/modules/approvals/action-proposals.service.ts:390,998` | narrative: TODO deferred to Stage 12 / durable-store follow-up | open work, described in prose |
| `apps/api/src/modules/approvals/audit-writer.ts:46` | narrative: both files carry a TODO to collapse them | open work, described in prose |
| `apps/api/src/modules/approvals/index.ts:18` | narrative: the TODO that blocked this is closed | closed |
| `apps/api/src/modules/auth-tenancy/password-reset.service.ts:21` | narrative: the TODO it carried | closed |
| `apps/api/src/modules/exports-public-api/api/export-record.ts:36` | narrative: "the proper fix is three columns on `exports`; it is on this module's TODO" | open work |
| `apps/api/src/modules/extraction/extraction-pipeline.ts:3` | narrative: named in another module's TODO | closed |
| `apps/api/src/modules/portal/portal-onboarding.service.ts:251` | narrative: the half A2's TODO said whoever | closed |
| `apps/api/src/modules/validation-dedupe/index.ts:30` | narrative: the module's own TODO | open work |
| `apps/api/src/modules/validation-dedupe/proposals/reprocess-document.ts:60` | narrative: its own TODO asked for this | closed |

**The real debt marker in this codebase is `// DEMO-MOCK`, not `TODO` — 50 occurrences across 37 files.** `CLAUDE.md` states that every one of them is owed a tracked issue. Highest-value clusters:

- `apps/api/src/modules/chase/auto-close.ts` (4), `chase/sms-sender.ts` (2), `chase/detection.ts`, `chase/suppression.ts`, `chase/sms-copy.ts`, `chase/portal-link.ts`, `chase/chase-projection.ts` — the chase lane.
- `apps/api/src/modules/extraction/{extraction-pipeline,demo-extractor,demo-profiles,document-extractor}.ts`.
- `apps/api/src/modules/publishing/{ledger-adapter,demo-xero-adapter}.ts` — the Xero seam.
- `apps/api/src/modules/ingestion-routing/queue/{media-fetcher,select-media-fetcher}.ts` — WhatsApp media.
- `apps/web/src/tour/steps.ts` (4), `apps/web/src/lib/{types,demoIntents}.ts`, `apps/web/src/api/bank.ts`, `apps/web/src/components/*`.
- `scripts/demo/*` (9 across reset, email, whatsapp, portal-link) and `prisma/seed.ts`.

---

# 11. Known bugs and unfinished work

Sources: code comments, `docs/reviews/MUBASHIR_REVIEW_NOTES.md` (67 numbered review items with verbatim reporter wording, briefs and resolutions), the `DEMO-MOCK` markers, and the empty seams.

## 11.1 Named gaps, with the file that admits them

1. **Four of five chase detection engines do not exist.** `chase/detection.ts:12` — only `UNMATCHED_TRANSACTION`. `SUPPLIER_STATEMENT_GAP`, `STATEMENT_PERIOD_GAP`, `LEDGER_TXN_NO_ATTACHMENT`, `EXPECTED_RECURRING_MISSING` are enum values.
2. **No scheduler anywhere.** `Chase.schedule` is never written; `ChaseState.REMINDED` and `ESCALATED` are unreachable; `scripts/purge-expired-trash.ts` must be run by hand; there is no cron, repeatable job or EventBridge rule in the repo.
3. **Per-client chase suppression descriptors need a schema column** — `chase/suppression.ts:15`, a `DEMO-MOCK`, blocked on a LAW change.
4. **No real ledger adapter.** `publishing/ledger-adapter.ts:10`, `demo-xero-adapter.ts:8`.
5. **Two proposal kinds throw `ProposalNotImplementedError`** — `document.move-business` and `document.split` (`validation-dedupe/proposals/registry.ts`). Each needs its own issue.
6. **`hideFinancialFields` is written and never enforced** when serving a document — `prisma/schema.prisma` (on both `invites` and `memberships`) calls this out: "an accepted setting that governs nothing… the redaction is owed."
7. **`memberships.permissions` is populated and consulted by nothing** — `approvals/assert-can.ts`.
8. **No ownership transfer**, so a practice whose owner is unavailable cannot release — `approvals/assert-can.ts`.
9. **Readiness confidence thresholds are uncalibrated** and the seam is deliberately empty — `validation-dedupe/readiness.ts`.
10. **The perceptual-hash candidate cap can miss a duplicate** — `duplicate-detector.ts:PERCEPTUAL_CANDIDATE_LIMIT`, explicitly "a bound on a scan, not a page size… it can cost a miss."
11. **`/healthz` does not check Postgres or Redis reachability** — `health/health.controller.ts:21`.
12. **PDF guard `fixture` mode has a known false negative** on incrementally-updated PDFs — `sanitisation/guards.ts:90`.
13. **The virus scanner is a fixture** that only matches the EICAR string — `sanitisation/virus-scan.ts`.
14. **`SMS_SENDER` is misnamed** (it selects the chase transport, and SMS is no longer the only one); the rename is deliberately deferred because it spans `.env.example`, `infra/envs/staging/services.tf` and `infra/README.md` — `config/env.ts`.
15. **`DEFAULT_APP_ORIGIN` is hardcoded in two modules** alongside the `APP_ORIGIN` env var — `config/env.ts:324`.
16. **`exports` needs three columns it does not have**; the current workaround is noted at `exports-public-api/api/export-record.ts:36`.
17. **No restore drill has been run** — `docs/adr/0007-*.md`, still open.
18. **`packages/validators`, `packages/ui`, `packages/tokens`, `packages/component-grammar`, `services/extraction` and `e2e` are empty scaffolds.**
19. **`analytics`, `archive-vault-search` and `voice` API modules are empty directories.** `vault_items` has a table and no API; `useSpeech.ts` exists client-side with nothing behind it.
20. **`feature_flags` and Unleash are unread.**
21. **The `Guidance` table has no CRUD surface.**
22. **Only three of seven web data slices are live** — see §5.0. The synthetic generators are a second implementation of the domain and will drift.
23. **`STATEMENT_READER=none` is the local default**, so PDF/image statements cannot be tested locally at all (Textract cannot read MinIO).
24. **The coding escalation-rate script has never been run against a real corpus**, so the £0.02/document blended-cost guardrail is unverified — `chat-framework/models.ts:76-86`.
25. **There is no extraction accuracy eval and no labelled corpus.**
26. **`e2e/` produces no coverage**, so no user journey is verified end to end by an automated test.

## 11.2 Bug classes recently fixed, worth knowing because they recur

From `docs/reviews/MUBASHIR_REVIEW_NOTES.md` (items 16–67, all marked done). These are the shapes this codebase produces:

- **A screen and the server disagreeing about the same number** — items 25, 30, 35 (a Bank header that recalculated from the selected filter and read "0 unexplained" by definition; a Matches count reading a demo list that is always empty; chat answering "nothing missing" for a client with a screen full of undocumented transactions).
- **A document reaching Ready that should not have** — items 36 and 47 (a selfie driven to Ready with fabricated fields; a document with 20%-confidence fields Ready after only a category was set). Fixed by adding the type gate and the zero-total gate.
- **Wrong figures surviving to export** — item 22 (£9,000 of tax on a £994 invoice, accepted silently, dead at export). Fixed by the correction checks and by `NT-EXP-001` naming every refused document.
- **US date rendering** — items 16, 28, 46: native `<input type="date">` renders in the browser's locale and no attribute can force a format, so `03/08/2026` was silently ambiguous. Fixed by `UkDateField`.
- **Modals that cannot scroll, putting Approve out of reach** — items 23 + 40.
- **A foreign business's statement importing into the wrong client** — item 14. Fixed by `account-holder.ts` (warn, never block).
- **A client's team member seeing an action they cannot finish** — item 39, the role capability matrix.
- **Duplicate approval requests for the super admin's own actions** — item 26.
- **Chat history vanishing on reload** — item 59, fixed by server-persisted conversations.
- **Chat uploads claiming success while the document never appeared** — item 60.

---

# 12. Extension points

## 12.1 A new validation rule

**Deterministic, blocking (a refusal):** `apps/api/src/modules/validation-dedupe/proposals/validate-update-coding.ts`.
Pattern: a pure function taking the payload and the document projection, throwing `AppException` with an `NT-VAL-*` code. Add the code to `packages/contracts/openapi.yaml`'s `ErrorCode` enum (a G7 contract change) and to `docs/runbooks/error-codes.md`.

**Deterministic, advisory (a warning the human may ignore):** `apps/api/src/modules/validation-dedupe/correction-checks.ts`.
Pattern: add a member to the `CorrectionCheckCode` union and a branch in `evaluateCorrectionChecks(context, corrections, todayIso)`; keep it pure (the clock arrives as an argument) and integer-pence. **Then mirror it in `apps/web/src/lib/correctionChecks.ts`** — the two are deliberately duplicated and the file header says they must move together.

**Extraction-time validator:** `apps/api/src/modules/extraction/bedrock-extraction-schema.ts` — write a `ValidatorVerdict`-returning function beside `checkVatArithmetic` and add it to the `validatorResults` map. A failed verdict blocks READY through `readiness.ts` regardless of field presence.

## 12.2 A new reminder / chase type

**Detection:** `apps/api/src/modules/chase/detection.ts` — add a function alongside `detectUnmatchedChases(db, businessId)` returning candidate items, taking a `ScopedClient` (the caller owns the transaction, so RLS decides visibility). Add the matching `ChaseDetectionEngine` enum value — that is a `prisma/` change and therefore LAW.
Pattern to follow: gate on the *existing* suppression predicates (`isChaseSuppressed`, `alreadyChasedTransactionIds`) rather than writing new ones — the file's own warning is that "a fifth rule that re-derived any of those in its own words is how the accountant's screen and the client's inbox start disagreeing."

**Composition and send:** `apps/api/src/modules/validation-dedupe/proposals/compose-chase-send.ts` composes the body server-side; `chase/sms-copy.ts` shapes it. The reviewed body must go on the wire byte-for-byte.

**⚠ There is no scheduler to hang a cadence on.** A recurring reminder needs a job runner built first — BullMQ repeatable jobs are the natural home, in `apps/api/src/worker/main.ts`.

## 12.3 A new obligation deadline

**Nothing to extend — this must be built.** The nearest existing shape is `apps/api/src/modules/tasks/` (`tasks.service.ts` + `due-date.ts`): a `Task` with `dueAt`, `cadence` and `advanceDueDate()` that clamps month-end correctly. The pattern to follow is that file's: a calendar date is stored as UTC midnight, read with `getUTC*` only, and never put through a local-time formatter.
To make it an *obligation* calendar you would add a jurisdiction rule set (VAT/BAS quarters, PAYE/PAYG dates, year end) that seeds `tasks` rows per business from `businesses.{vatFrequency, vatPeriodStart, yearEndMonth, yearEndDay}` — four columns that already exist and are read by nothing.

## 12.4 A new tax rule / coding rule

`apps/api/src/modules/rules-suggestions/coding/coding-instructions.ts` (the prose the model is given) **and** `apps/api/src/modules/rules-suggestions/coding/capital-revenue.ts` (the deterministic branches).
Pattern: the two are the same rule said twice, on purpose, and `coding-instructions.test.ts` asserts every escalation reason and named basis appears in both — so adding a rule in code and forgetting the prompt fails the build. Bump `CODING_PROMPT_VERSION`. If the rule needs a new escalation outcome, add it to the closed set in `coding/escalation.ts`; if it needs a new account, add it to `chart-of-accounts/profiles.ts` (and remember those strings travel into an accountant's VT import file, so renaming one has a migration cost).

## 12.5 A new accounting-software connector

`apps/api/src/modules/publishing/ledger-adapter.ts` is the interface; `select-ledger-adapter.ts` is the switch.
Pattern: implement `LedgerAdapter`, add the value to the `LEDGER_ADAPTER` enum in `config/env.ts`, add the arm to `selectLedgerAdapter` (the single-arm switch is kept as a `return` so adding one is a compile-guided edit). Two rules the interface exists to enforce: **never call the vendor inside a tenant transaction** (the adapter runs from the post-commit follow-up in `validation-dedupe/proposals/publish-follow-up.ts`), and **a per-item failure is a `LedgerPublishFailure` result, not a throw** (a batch of 40 where item 12 is rejected must publish the other 39).

For a **file-based** connector instead, `apps/api/src/modules/exports-public-api/emitters/` is the place: implement `ExportEmitter`, add the value to the `ExportTarget` enum (contract + Prisma, both LAW), and register it in `select-emitter.ts`. `emitters/generic-csv/generic-csv-emitter.ts` is the reference implementation and exists precisely to prove the canonical model is not VT in disguise — the two emitters disagree about sign, date format, account presentation and row count without either changing the model.

## 12.6 A new country

**There is no extension point. This is the honest finding of this audit.**
The nearest things to build on:

1. `apps/api/src/config/env.ts` — the config-selected-implementation pattern (`selectExtractor`, `selectSmsSender`, …) is the right template for a country-varying dependency, and every external dependency already follows it.
2. `apps/web/src/i18n/index.ts:53-73` — `SUPPORTED_LOCALES` and `resolveLocale()` are the declared seam for a second locale; the catalogue discipline behind them is real.
3. `apps/api/src/modules/rules-suggestions/chart-of-accounts/profiles.ts` — `BUSINESS_PROFILE_IDS` and `BusinessProfileDefinition` are already a data-shaped registry; an AU chart is a second set of definitions, not a code change.
4. `practices.countryCode` / `businesses.countryCode` / `practices.language` — the columns exist with sensible defaults and **no readers**, so they are free to become the discriminator.

The pattern to introduce: a `CountryProfile` module — currency + symbol + minor-unit name, IANA timezone, locale, tax-identifier field name + checksum + lookup service, tax-treatment enum, chart-of-accounts profile set, bank-statement header vocabulary, chase suppression descriptors, export target set, obligation calendar — resolved once per request from `ScopeContext` and threaded exactly the way `ScopeContext` already is. The AU research (`docs/research/australia-market-entry.md` §D.5) sizes the whole localisation package at **6–10 engineering weeks**, dominated by contract (LAW) changes and by acquiring a real AU statement corpus, not by the money or date cores — which already fit.

---

# 13. Effort map for an Australian version

Scale: **S** ≈ days · **M** ≈ 1–3 weeks · **L** ≈ 3–6 weeks · **XL** ≈ 6+ weeks or a separate programme. Grounded in what is in the tree today and cross-checked against `docs/research/australia-market-entry.md`.

| Item | Effort | Reason, grounded in the code |
|---|---|---|
| **Currency → AUD** | **M** | The invariant that matters — integer minor units, no floats — ports unchanged; AUD is exact to the cent electronically (only *cash* rounds to 5c). But there is no currency abstraction: six formatters, `£` literals inside two model prompts (`workflow-instructions.ts:271`, `compose-draft.ts:48`), `formatGbp` that cannot take a code, and `@default("GBP")` on four Prisma columns. Field names (`amountPence`, `formatPenceDecimal`) are contract-level LAW; **recommend documenting "pence = minor units" rather than a LAW-wide rename** — an owner decision. |
| **GST 10% replacing VAT** | **L** | The arithmetic core survives (`checkVatArithmetic` is rate-agnostic: net + tax = gross ±1p). What does not: `vatNumber` → ABN across `prisma/`, `packages/contracts/openapi.yaml`, the extraction schema and the extraction prompt — all LAW changes; the five-value `vatTreatment` enum encodes UK input-tax blocking; the AU tax-invoice template is legally prescribed (7 items under A$1,000, buyer identity/ABN at ≥ A$1,000, the A$82.50 credit threshold) and a non-GST-registered supplier's GST-free invoice must **not** be flagged as defective; GST is conventionally 1/11 of the inclusive total. Plus the whole chart-of-accounts prose citing HMRC/CAA/BIM. |
| **Financial year 1 Jul – 30 Jun** | **S** | Genuinely cheap, because **nothing computes on the UK tax year today** — zero occurrences of "6 April", "5 April" or "tax year" in code. `yearEndMonth`/`yearEndDay` are columns with no readers, and the seed's `yearEndMonth: 3` is demo data. This is a default change plus copy, unless and until an obligation calendar exists — then it becomes part of that. |
| **ABN / TFN validation** | **M** | ABN: mod-89 checksum (~20 lines) plus the free ABR Lookup web service (GUID auth), which also returns GST-registration status the tax-invoice validator needs. It replaces a UK path **that was never built** — `COMPANIES_HOUSE_API_KEY` and `HMRC_CLIENT_*` are unused and `ClientIntakeForm.tsx:311,351` makes claims the server does not honour. **TFN is the harder half and has no UK analogue at all:** the Privacy (TFN) Rule 2015 makes recording one an offence, clients will photograph payment summaries, and nothing in the pipeline looks for one — so it is a *new* detect-and-refuse-to-store stage in `extraction/` and `portal/`, plus the vault. Compliance-critical and easy to miss. |
| **BAS / PAYG / STP / super obligation calendar** | **XL** | **This is greenfield.** There is no obligation calendar of any kind (§5.10) and, more fundamentally, **no scheduler anywhere in the product** — no cron, no repeatable job, no EventBridge rule. Building it means: a jurisdiction rule set, a job runner, per-business period derivation from four currently-unread columns, a notification/reminder path, and a UI. STP and super are out of product scope (Neoting runs no payroll) but appear on bank statements and must be coded and chase-redirected correctly. |
| **MYOB connector** | **L** | The `LedgerAdapter` seam is real and well-specified (post-commit only, per-item failures as results), but **no adapter has ever been written against it** — `DemoXeroAdapter` opens no socket, so the seam is unproven. MYOB adds OAuth, token refresh (`integrations.tokenRef`/`tokenExpiresAt` exist unused), ABN-keyed supplier matching, and attachment upload. Second priority behind Xero per the market data (Xero 90% vs MYOB 71% usage with clients). |
| **Xero AU connector** | **L** (API) / **M** (CSV only) | A Xero-shaped **CSV emitter** is M — the canonical-model + per-emitter architecture was built for exactly this and `generic-csv` proves it. The **API adapter** is L and is really D6/v1 scope pulled forward: OAuth 2 + PKCE, tenant selection, rate limits, idempotency, attachment upload. Note it collides with D42: *"export is the sole egress"* is an ID decision that **does not port to AU as a market stance**, because every incumbent there attaches the source document via the Xero API. Also note D43's link ladder is VT-shaped — Xero's CSV carries no URL column, so the AU story is the short typable code plus the manifest bundle. |
| **Australian bank feeds** | **S** if ID's stance holds, **XL** if not | D40 (manual upload only) ports unchanged and is viable — all four big AU banks export CSV/XLSX plus universal PDF. Real feeds mean CDR, where full unrestricted accreditation is genuinely heavy (Schedule-2 controls, AFCA membership, an ASAE 3150 assurance report, audits from A$60k). The realistic route is a **CDR representative** arrangement with an accredited principal (Basiq, Frollo, Adatree) — weeks, not a programme. Screen scraping should be assumed dead. |
| **AU bank statement dialects** | **M** | Not optional, and it is the thing that will break first. `statement-parser.ts:91-96` uses anchored header regexes including `amount \(gbp\)` and requires a header row — **CBA's CSV reportedly has none, so the most-used AU business bank's export is refused outright**; Westpac's `Debit Amount`/`Credit Amount` do not match; ANZ carries no running balance, so D41's `reduced` assurance class will fire constantly. The architecture (mapping + gates + reduced assurance) was built for this variance; what it needs is an AU corpus and positional inference for headerless files. Good news: it fails **loudly**, so there is no silent-wrong-books risk. |
| **AU chase suppression + redirect tables** | **S** config, **M** to get right | `chase/suppression.ts` is nine UK descriptor strings. AU needs BPAY, EFTPOS, Osko, PayID, Direct Entry/BECS, ATO, super clearing houses, Tyro/Square AU/Zeller payouts. Cheap to change, expensive to get wrong: over-chasing is the named product-killing failure, and a client chased for a BPAY fee in week one stops reading the messages. Needs a real statement corpus. |
| **Per-tenant timezone** | **M** | Mechanical but wide, and it is a **governance change** as well as a code change — the invariant is written into the root `CLAUDE.md` and Governance §12 as "UTC in storage, **Europe/London** in rendering". ~20 formatters across api and web, plus `TZ=Europe/London` in the Dockerfile and both `services.tf`. Australia has up to five simultaneous local times with partial DST (QLD/WA/NT do not shift), so this is correctness, not cosmetics — a chase saying "on 9 Aug" for a 10 Aug purchase. Calendar dates stored as bare `YYYY-MM-DD` are already safe, so exports do not corrupt; rendering and any future scheduling do. |
| **en-AU locale + copy sweep** | **S–M** | The i18n discipline makes this tractable — every string is in a catalogue, `no-literal-string-in-jsx` and `check-i18n.mjs` are blocking, and `apps/web/lang/en-GB.json` is the extracted artefact. Two caveats: `toLocaleString('en-GB')` calls bypass the catalogue, and **the server has no i18n at all** (`email-copy.ts`, `sms-copy.ts` and every rendered summary are English literals in TypeScript). AU keeps British spelling, so it is the domain vocabulary that changes, not the voice. |
| **A rules engine for tax-claim guidance** | **L–XL** | Depends entirely on ambition. The existing shape (prompt rules + deterministic branches + a closed escalation set + per-account tax flags, with a build-time test that prompt and code agree) is a good template and would be reused. But every rule in it is UK, and the product deliberately refuses to give tax advice today (`system-prompt.ts:60` — tax questions are `SCOPE_REFUSAL`). Turning coding guidance into *claim* guidance crosses a line the architecture currently defends, and in Australia it also crosses a **TPB** line: software is a tool, but advice on a client's particular circumstances is a tax agent service. Needs Australian legal advice before scoping. |
| **Multi-client accountant dashboard** | **S** | Already built and is the product's core differentiator — Clients board, Inboxes, cross-client Approvals queue, Chases board, Analytics, Teams, Tasks, per-client scoping for `PRACTICE_STANDARD`, chat with a client picker. The AU research names this as the gap no competitor fills. Work needed is AU labelling and the metrics the API does not yet serve. |
| **AWS Sydney region (ap-southeast-2)** | **M** | Known shape — Terraform is already parameterised across three envs, and D36 anticipated it. New KMS keys, buckets, DPIA posture under APP 8/NDB. Textract has been in Sydney since 2019 and Bedrock+Claude since 2024; Melbourne (ap-southeast-4) is the natural DR target, which is *better* than the UK's single-region position. **Must re-verify that the three pinned model IDs are available in-region** and add `en-AU` to Transcribe. Requires a versioned amendment to D30. |
| **Billing: AUD price + GST** | **S–M** + sign-off | `STRIPE_TAX_RATE_ID` currently attaches a 20% GB VAT rate and the boot gate says so in its own error message. Needs an AUD price object, GST-inclusive display on client-facing screens (ACL s 48), and an entity/registration decision — sales to unregistered micro-clients count toward the A$75k threshold, and D48 makes the *client* the payer, so GST registration should be expected. Calendar-bound more than code-bound. |
| **ACMA SMS Sender ID registration** | **S** process, long lead | Mandatory since 1 Jul 2026; an unregistered alphanumeric sender is stamped "Unverified" on every chase, which is fatal for a trust product. Requires an ABN, so it ties to the entity decision. No code change beyond configuration. |

## 13.1 Blockers, in the order they will bite

1. **No scheduler.** Everything reminder-shaped in an AU pitch — BAS quarters, chase cadences, statement coverage — needs a job runner that does not exist. This is a prerequisite, not a feature.
2. **An egress decision.** VT has no AU analogue. Shipping without at least a Xero-shaped CSV means the product has no usable output in Australia. D42's export-only stance is an ID decision that does not survive contact with the AU market.
3. **TFN handling.** A legal duty with no UK analogue, invisible to anyone porting field-by-field.
4. **CBA's headerless CSV.** The most-used AU business bank's export is refused by today's parser.
5. **Contract (LAW) churn.** `vatNumber` → ABN, new `ExportTarget` values, a new `ChaseDetectionEngine`, per-tenant timezone and currency columns are all `prisma/` + `openapi.yaml` changes, each requiring an approved contract-change issue before a PR opens (G7). The AU research is explicit that this process, not the coding, dominates the estimate.
6. **The web app's synthetic second implementation.** Four of seven slices still render generators (`apps/web/src/lib/seed*.ts`, `generate.ts`). Any localisation must be done twice, or those slices must be migrated first. **Recommend migrating them before localising, not after.**
7. **The free incumbent.** Hubdoc is bundled free with every paid Xero plan and is used with clients by 64% of surveyed AU bookkeepers; Xero's JAX "Smart Document Capture" has been in AU/NZ beta since July 2026 adding the line-item extraction Hubdoc lacked. **Do not enter on an extraction-quality pitch** — the durable wedge is the spine (identity-gated multi-channel intake, SMS chasing with no app, provable statement completeness, cross-client triage, enforced Review→Approve, source-linked export), which no single AU competitor sells at any price.

---

# 14. Questions the codebase cannot answer

**Product and commercial**

1. **Is Australia a port or a second product?** One codebase with a country abstraction, a second deployment with a forked chart and rule set, or a separate build? The code has no opinion — `countryCode` exists and nothing reads it — and this choice determines every estimate in §13.
2. **Does D42 (export-only, no ledger API) hold for Australia?** The research says it does not survive the market, because attachment-travels-with-the-bill via the Xero API is the AU norm. Reversing it for AU but not the UK forks the product's central claim.
3. **Practice-pays or client-pays in Australia?** D48 bills the client business £8.50/month. The entrenched AU partner model bills the practice per client entity with volume tiers. This is a CEO decision with schema consequences (`businesses.stripeCustomerId` is unique per business).
4. **What is the MVP referred to in the brief?** "An MVP built on top of this" is ambiguous against a codebase whose own current release (ID) is already a deliberate MVP. Is the new MVP narrower than ID, a different vertical, or the AU version of ID?
5. **Does the standalone-business persona ship in Australia?** AI coding relied on by an end business, sold for a fee with no registered agent in the loop, is the TPB grey zone. Needs Australian legal advice.

**Technical, where two half-built approaches exist**

6. **The web app's live/synthetic split.** `apps/web/src/lib/{seed,seed2,generate,ingest,matching,dedupe,detection}.ts` is a full second implementation of the domain, and four of seven slices still use it. Is the plan to finish the migration, or is the synthetic path a permanent demo mode? Nothing in the repo states an end date, and the answer changes whether localisation is done once or twice.
7. **`packages/validators` vs inline validators.** The package is an empty scaffold and `readiness.ts` still refers to it as the future home ("packages/validators — VAT arithmetic, VRN, dates, currency"), while the real validators live in `extraction/` and `validation-dedupe/`. Which wins? The research notes the inline placement *lowers* the LAW-change surface for the AU tax work, which argues for deleting the scaffold.
8. **`packages/{ui,tokens,component-grammar}` and `services/extraction`.** Four empty scaffolds declared LAW under G7. Are they planned, or should they be deleted so the CI debt table stops naming them?
9. **`feature_flags` + Unleash.** A table, a container, an init job, and no reader. Is flagging planned, or is the env-enum approach the final answer?
10. **`vault_items`, `analytics`, `archive-vault-search`, `voice`.** A table with no API and three empty module directories with `CLAUDE.md` files describing intent. Scoped, deferred, or abandoned?
11. **`Guidance` has no CRUD surface** but is seeded and fed to the model. How is a practice meant to author guidance today?
12. **`pence` naming under a non-GBP currency.** `amountPence`, `totalPence`, `formatPenceDecimal` are contract-level. The research recommends accepting them as "minor units" and documenting it rather than a LAW-wide rename, and explicitly flags it as an owner call. Unresolved.
13. **Where does the capitalisation policy live?** `PLATFORM_DEFAULT_CAPITALISATION_POLICY` is £1,000 with a `source` field that promises a per-practice setting. No column, no endpoint, no UI. Who sets it, and when?
14. **Ownership transfer.** `assertCan` requires `PRACTICE_ADMIN ∧ isOwner`, there is no transfer operation, and the file names the bus factor. What is the intended recovery when an owner leaves?
15. **`hideFinancialFields`.** Written on invites and memberships, enforced nowhere when serving a document. Is the redaction in scope, and at which layer — API projection or UI?
16. **Chase cadence and quiet hours.** `ChaseState.REMINDED`/`ESCALATED` and `Chase.schedule` describe a policy scheduler nobody has specified. What is the intended cadence, and does it need per-tenant quiet hours (mandatory in AU, given DST-split states)?
17. **Readiness confidence thresholds.** SoT Stage 5 wants eval-calibrated per-field thresholds; no labelled corpus exists. Who produces the corpus, and what is the target accuracy?
18. **Is the coding escalation rate acceptable?** The judgment-tier pin holds the £0.02/document guardrail only below a 27% escalation rate. Measured 75% on a brand-new client and 33% eight documents later. Nobody has run it on a real corpus.
19. **CI enforcement state.** A note in this environment records that CI checks are currently disabled locally, so a green run may mean nothing executed. Confirm the live GitHub Actions and branch-protection state before relying on it.
20. **The restore drill.** ADR 0007 is explicitly unfinished pending a measured RTO. When?
21. **Two proposal kinds throw.** `document.move-business` and `document.split` are contract values with no executor. Scoped, or should they leave the enum?
22. **The `SMS_SENDER` rename.** Deliberately deferred because it spans code, `.env.example` and two Terraform files. Who owns the coordinated change?

**Undocumented behaviour worth confirming with a human**

23. Whether `WHATSAPP_PRACTICE_MAP` (the env override) or `Practice.whatsappPhoneNumberId` (the column) is authoritative in production, and whether the override is still needed now that the column exists.
24. Whether `EXTRACTOR=replay` cassettes are refreshed on any schedule, or drift silently against the live model.
25. Whether the `britishgas` deterministic publish failure in `DemoXeroAdapter` is still wanted, given it fires against seeded data that a real practice could conceivably reproduce.
26. Whether `docs/DEMO_SCRIPT_2026-08-21.md`, `METH_MODE.md` and `PROJECT_STATUS_2026-08-17.md` should be deleted. `CLAUDE.md` says they govern nothing, and their continued presence is the most likely way a new contributor is misled.
