# METH_MODE — the 72-hour MVP push

**Written 18 Aug 2026 · Deadline: Wed 20 Aug, end of night · Client demo: Thu 21 Aug**
**People: Shakib (lead, auth/engine/frontend) · Abdullah (backend: extraction/chase/portal/publish/bank)**

---

## 0. How to use this file (read this first, every session)

This file is the **only plan** for the 18–20 Aug push. Each stage below is a self-contained
work order sized for one Claude Code session. The operating contract:

> **Prompt template:** *"Read METH_MODE.md. Execute Stage N. Do not exceed its scope."*

Rules for every session, no exceptions:

1. **Read first:** this file's §1–§4, then the stage's own *Read first* list, then the
   `CLAUDE.md` of every module you touch. Update module `CLAUDE.md`s on exit.
2. **Scope is a fence.** Each stage has an *Out of scope* list. Anything on it — or anything
   not explicitly in the stage — is not yours. Resist "while I'm here" improvements.
3. **Definition of done per stage:** the *Acceptance* checklist passes locally, AND
   `pnpm typecheck && pnpm lint && pnpm test` is green, AND `pnpm build` passes.
   Existing tests may not be deleted or skipped to get green.
4. **Mark every mock.** Any code that fakes a real capability carries a `// DEMO-MOCK:` comment
   naming what the real implementation will be. This is how we un-fake the product after the 21st.
5. **No real external calls, ever, in this push.** No Twilio, no Bedrock, no Textract, no Xero,
   no TrueLayer, no Meta Graph fetches beyond the existing fixture adapters. Everything external
   is an env-selected fixture/demo adapter (the house pattern — see §4). A real SMS leaving this
   codebase before the pilot is an incident.
6. **Invariants still hold** (repo CLAUDE.md): money is integer pence server-side; every Prisma
   query through `scopedDb(ctx)`; Zod at every boundary; untrusted content stays data;
   Approve unreachable before Read-review, **server-side**; UTC storage / Europe/London render.
7. **One branch + worktree per stage.** The working tree is shared between concurrent sessions —
   never assume the branch under you is still yours. One PR per stage, issue filed first
   (title: `METH Stage N: <name>`).
8. Self-correction: one hypothesis, max two attempts, then stop and surface the trace.

**What this push is NOT:** infra, CI/CD changes, security hardening, QA estates (e2e/evals),
performance work, observability, compliance artefacts. If a stage seems to need any of those,
it doesn't — re-read its scope.

---

## 1. Mission & strategy

**Mission:** on 21 Aug, walk the client through Neoting as a working product: log in, watch a
receipt arrive by WhatsApp/email/upload, watch it get extracted and coded, correct a field,
catch a duplicate, see the missing Currys receipt on the bank feed, chase the client by SMS,
open the OTP portal on a phone, upload the receipt, watch the chase auto-close, create a rule
in plain English, and publish the approved batch to "Xero" — with Review → Approve gating every
state change, for real, server-side.

**Strategy — a real spine, a fixture body:**

- The 31k-line frontend already renders nearly the entire Source-of-Truth screen inventory on
  synthetic data. We do **not** wire all of it. We wire the **golden path** end-to-end against
  the real API, and everything off that path stays on its (excellent) fixtures, presented
  honestly as designed surfaces in build.
- Externals are mocked **behind the interfaces the real versions will use** (`DocumentExtractor`,
  `SmsSender`, `LedgerAdapter`), selected by env like every existing fixture adapter. The demo
  is a real system with fake vendors — not a fake system.
- The fallback is always available: `VITE_API_ENABLED=false` returns the entire app to synthetic
  mode, which demos cleanly today. **No stage may break synthetic mode.**

**Demo environment: local** (`docker compose up -d` + `pnpm dev`), presented from Shakib's
machine. Staging deploy is Stage 15, a stretch goal — never the plan of record.

---

## 2. The PRD — every feature, its status, its demo treatment

Treatments: **DONE** works today · **WIRE** exists one side, connect it · **BUILD** thin real
version · **MOCK** real seam, fake output · **FIXTURE** stays synthetic, demo as designed ·
**SKIP** absent from demo, don't touch.

### 2.1 The eleven-stage pipeline (SoT §4)

| # | Pipeline stage | State today (per 17 Aug audit) | Demo treatment | Stage |
|---|---|---|---|---|
| 1 | Ingest — web upload | API real (presigned PUT + intent), no frontend caller | **WIRE** drag-drop → real API | 7 |
| 1 | Ingest — email `doc@` | Lane real (MailHog local, poller, routing code), sender map empty | **BUILD** seed the sender map; live MailHog beat | 5 |
| 1 | Ingest — WhatsApp | Webhook real (HMAC, sandbox-verified), fixture media fetcher | **DONE** + demo script that posts a fixture webhook | 5 |
| 1 | Ingest — auto-split, CSV/XLSX import, ZIP explode | 0% | **FIXTURE** (upload modes shown in UI copy) | — |
| 1 | Unrouted queue | Server semantics real, no UI wiring | **WIRE** | 12 |
| 2 | Extraction (Textract + vision ladder) | 0% — nothing leaves RECEIVED | **MOCK** — `DemoExtractor`, deterministic fixture profiles, per-field confidence + provenance | 4 |
| 2 | Deterministic validators (VAT arithmetic, VRN, dates) | `packages/validators` empty | **MOCK** inside DemoExtractor profiles (pre-computed validator verdicts) | 4 |
| 2 | Statement / supplier-statement extraction | 0% / frontend CSV parser only | **FIXTURE** | — |
| 3 | Rules engine (four-tier) | Schema + seeds only | **MOCK** — single-tier supplier match honored by DemoExtractor | 4, 13 |
| 3 | NL rule parsing ("Whenever Bidfood…") | 0% | **MOCK** — canned parse for scripted utterances → real rule row via proposal | 13 |
| 4 | AI coding suggestions + confidence + reasoning | Schema + seeds only | **MOCK** — DemoExtractor emits suggestion rows with reasoning | 4 |
| 5 | Inbox states To Review / Ready / Processing | State machine real & tested server-side; UI on fixtures | **WIRE** | 7 |
| 5 | Rejected/Failed view (337-vote feature) | Server read surface real; UI on fixtures | **WIRE** | 12 |
| 5 | Mandatory fields / confidence gating config | Deliberate empty seam | **FIXTURE** (settings panels) | — |
| 6 | Dedupe (byte-hash + perceptual) | Real, in worker, tested | **DONE** — live duplicate beat | 7 |
| 6 | Cross-type / OCR-similarity dedupe signals | 0% | **FIXTURE** | — |
| 7 | Bank feed (TrueLayer) | 0% | **MOCK** — seeded transactions presented as connected feed | 5, 11 |
| 7 | Bank match engine | Frontend prototype (31 tests, float pounds, fixture-only) | **WIRE** — real seeded txns through the client engine; confirm-match persists via proposal | 11 |
| 7 | Statement upload fallback | Frontend CSV/XLSX parse (53 tests) | **FIXTURE** (client-side demo ok) | — |
| 8 | Detection engines (five) | 0% | **BUILD** engine (a) unmatched-txn only + suppression list; (b)–(e) **FIXTURE** | 8 |
| 8 | Chase composition | Frontend prototype behind R→A gate | **MOCK** server-side template composition (verbatim SMS in review) | 8 |
| 8 | SMS send (Twilio) | 0% | **MOCK** — `DemoSmsSender` → SMS outbox screen | 8 |
| 8 | OTP portal (signed link, OTP, scoped upload) | Portal UI shell real; OTP decorative; no server | **BUILD** server + **MOCK** OTP (fixed `000000`) | 9 |
| 8 | Editable extraction overlay in portal | Component exists | **WIRE** | 9 |
| 8 | Chase auto-close on inbound match | Frontend prototype only | **BUILD** server-side (deterministic compare) | 8, 9 |
| 8 | Policy scheduler, quiet hours, item messaging | 0% | **FIXTURE** (settings + thread UI) | — |
| 9 | Review → Approve engine (the constitution) | DB spine + triggers + full OpenAPI contract real; **no controller/service** | **BUILD** — the real engine, no mocking | 3 |
| 9 | Approval workflows (linear/branching) | Schema + builder UI on fixtures | **FIXTURE** builder; live queue = real pending proposals | 12 |
| 10 | Publish to Xero/QBO | 0% — no SDK, no adapter | **MOCK** — `DemoXeroAdapter`, fake refs, one scripted failure→retry | 10 |
| 10 | Publish preview (counts + gross/VAT) | UI on fixtures | **BUILD** server-computed preview in proposal payload | 10 |
| 10 | Reference sync (CoA etc.) | 0% | **MOCK** — seeded chart of accounts presented as synced | 5 |
| 10 | Exports, public API, webhooks | Client-side CSV only | **FIXTURE** (client-side export fine) | — |
| 11 | Archive + auto-archive after publish | Archive executor real & tested | **DONE** + wired by publish executor | 10 |
| 11 | Full-text search, move-between-entities | ILIKE search only / executor stub | **FIXTURE** | — |

### 2.2 Surfaces & cross-cutting

| Surface | State today | Demo treatment | Stage |
|---|---|---|---|
| Auth / login | **Zero. No authenticated identity exists.** | **BUILD** thin real sessions (scrypt + signed cookie) · TOTP **MOCK** (`000000`) | 1, 6 |
| Context header (user/role/scope, SoT §13.3) | Absent | **BUILD** (small, from `/v1/me`) | 6 |
| Chat workspace | Regex classifier, no model | **MOCK** — scripted intents → real components → real proposals | 13 |
| Voice push-to-talk | Web Speech + confirm-before-execute UX | **DONE** as-is (browser STT is fine for demo) | — |
| Clients list/detail | High-fidelity fixtures | **FIXTURE** (+ real waiting-counts if trivial) | 12 |
| Client onboarding flow | Fixture UI | **FIXTURE** | — |
| Team, Settings (18 panels), Analytics, Vault, Supplier statements, Expense claims | Fixture UI | **FIXTURE** | — |
| Notifications | 0% | **MOCK** — in-app toast on portal upload only | 9 |
| Companies House / HMRC checks | Cosmetic labels | **FIXTURE** | — |
| Audit log | Schema only, no writer | **BUILD** minimal hash-chain writer inside the engine | 3 |
| SMS outbox (dev surface) | n/a | **BUILD** — demo-only screen; this is how we "show the phone" | 8, 12 |

**Explicitly SKIP (sessions must not touch):** e2e/evals estates, real vendor SDKs, TOTP/Argon2
device rotation, WhatsApp media token & Meta verification, auto-split, CSV/XLSX structured
import, vault backend, async export engine, public API OAuth, pg full-text search, LAW package
extraction (`tokens`/`component-grammar`/`validators`/`ui` stay as they are), portal separate
build entry (D37 debt, tracked), i18n catalogue expansion beyond strings you actually add,
notifications delivery channels, retention jobs, rate limiting.

---

## 3. Standing approvals (ratified by Shakib by committing this file)

The repo constitution routes these through stop-and-ask / contract-change issues. For this push
they are **pre-approved exactly as scoped here** — nothing beyond:

1. **Contract deltas** (`packages/contracts/openapi.yaml` + regeneration), only the paths and
   kinds listed in Stages 1–2. Demo-only paths carry `x-demo: true`.
2. **Prisma additive-only migration**: new `ProposalKind` enum values
   `chase.send`, `publish.batch`, `bank.confirm-match`, `rule.create` (Stage 2). **No other
   schema change of any kind.** If a stage appears to need a column, it doesn't — store it in
   an existing jsonb field or drop the feature to FIXTURE and note it.
3. **Auth logic** as scoped in Stage 1 (session resolver + login), **Review → Approve engine**
   as scoped in Stage 3, **chase/SMS** as scoped in Stage 8 — mock sender only.
4. **New dependencies: none.** Password hashing uses `node:crypto` scrypt; cookies/tokens use
   HMAC via `node:crypto` (the upload-intent pattern). If a session believes it needs a package,
   stop and ask Shakib.
5. Demo credentials/passwords in seed code are **not** "secrets in the diff" — they are
   documented fixtures (`.test` emails, published demo passwords). Real secrets remain banned.

---

## 4. The mocking doctrine

Every mock follows the existing house pattern — an interface, an env-selected adapter, honest
naming:

| Capability | Interface | Demo adapter | Env selection | Real version (post-demo) |
|---|---|---|---|---|
| Extraction | `DocumentExtractor` (per `services/extraction/CLAUDE.md`) | `DemoExtractor` — deterministic fixture profiles | `EXTRACTOR=demo` | Textract + vision ladder |
| SMS | `SmsSender` | `DemoSmsSender` — writes outbox rows | `SMS_SENDER=demo` | Twilio |
| OTP verify | inside portal service | fixed code `000000` | `OTP_MODE=demo` | Twilio Verify |
| Ledger publish | `LedgerAdapter` | `DemoXeroAdapter` — fake refs, scripted failure | `LEDGER_ADAPTER=demo` | Xero SDK/OAuth |
| Bank feed | (none needed) | seeded `bank_transactions` | — | TrueLayer |
| NL rule parse / chat AI | command processor | canned intent table | (web code) | Bedrock Opus |

Mock behaviours must be **deterministic** (same input → same output; keyed on byte-hash or
filename), **stateful where the product is** (rows written to the real DB through `scopedDb`),
and **latency-honest** (2–4 s simulated processing so Processing states render truthfully).

---

## 5. The stages

Dependency graph (nothing else blocks anything):

```
S1 auth ──► S6 login ──► S7 documents wiring ──► S12 views ──► S14 hardening
S2 contracts ──► S3 engine ──► S7, S8, S10, S11, S13
S4 extractor ──► S7, S9
S5 seed ──► everything demo-visible
S8 chase ──► S9 portal ──► S12
S10 publish, S11 bank ──► S12, S13
```

### Day plan

| Day | Shakib | Abdullah |
|---|---|---|
| **Mon 18** | S1 auth · S2 contract pass · S3 engine | S4 DemoExtractor · S5 seed v2 + demo drivers |
| **Tue 19** | S6 web login · S7 documents/inboxes wiring | S8 chase + SMS outbox · S9 portal server |
| **Wed 20** | S12 views wiring · S13 chat paths · S14 hardening (joint) | S10 publish · S11 bank · S14 hardening (joint) · S15 stretch |

---

### STAGE 1 — Demo auth: real sessions, mocked TOTP — **Shakib** (~4 h)

**Objective:** the product gains an authenticated identity. Login with seeded credentials issues
a signed session cookie; `AUTH_MODE=session` resolves it into the existing `RequestContext`;
every scoped endpoint works without fixture headers.

**Read first:** `apps/api/CLAUDE.md` · `apps/api/src/common/context/` (all files — especially
`session-context-resolver.ts`, the placeholder that throws, and `fixture-context-resolver.ts`
as the shape reference) · `apps/api/src/config/env.ts` (AUTH_MODE enum ~line 80) ·
`apps/api/src/modules/auth-tenancy/CLAUDE.md` · `packages/contracts/openapi.yaml` auth section
(none exists yet).

**Build:**
1. **Contract delta (pre-approved):** `POST /v1/auth/sessions` (email, password, totp) →
   204 + `Set-Cookie` · `DELETE /v1/auth/sessions/current` → 204 ·
   `GET /v1/me` → user + practice + role + in-scope businesses. Regenerate contracts.
2. `apps/api/src/modules/auth-tenancy/`: `auth.controller.ts`, `auth.service.ts`,
   `demo-credentials.ts` (email → scrypt hash + userId map; hashes precomputed in-file;
   passwords documented in §7; `// DEMO-MOCK: replace with Argon2 + credentials table at S1-real`),
   `session-cookie.ts` — stateless HMAC-signed payload `{userId, exp}` (12 h), httpOnly,
   SameSite=Lax, secret from new env `SESSION_SECRET` (add to `env.ts` + `.env.example` with a
   dev default; staging value is out of scope).
3. Implement `session-context-resolver.ts`: verify cookie → load the user's memberships →
   build the same `ScopeContext` the fixture resolver builds. The membership lookup runs before
   tenant scope exists; use the repo's existing privileged/SYSTEM-actor pattern (see how the
   ingestion sink and seed handle the SYSTEM actor). Keep the privileged surface to exactly this
   one lookup; comment it.
4. TOTP field accepted and checked server-side against literal `000000` when `OTP_MODE=demo`
   (`// DEMO-MOCK`).

**Acceptance:**
- [ ] `curl` login with seeded credentials → cookie → `GET /v1/documents` returns scoped data
      with `AUTH_MODE=session` locally.
- [ ] Wrong password / missing cookie → RFC 7807 with a stable `NT-AUTH-*` code.
- [ ] `GET /v1/me` returns the practice cast; logout invalidates (cookie cleared; exp respected).
- [ ] Fixture mode still works (`AUTH_MODE=fixture` untouched). Full suite green.

**Out of scope:** Argon2, real TOTP, refresh rotation, device history, password reset, rate
limiting, session revocation lists, `assertCan` authorization beyond what membership loading
already gives.

---

### STAGE 2 — The demo contract pass — **Shakib** (~2–3 h)

**Objective:** one PR freezes every API surface the rest of the push implements, so Abdullah and
Shakib never collide on LAW again. **The single biggest de-risker in the plan.**

**Read first:** `packages/contracts/CLAUDE.md` · `openapi.yaml` `/action-proposals` block
(lines ~569–830) as the style reference · the enum-parity tests in `packages/contracts` ·
`prisma/schema.prisma:1042` (`ActionProposal`).

**Build:**
1. **openapi.yaml additions** (kebab-case, cursor pagination, `Idempotency-Key` on mutations,
   problem+json errors — house style):
   - `GET /v1/chases` · `GET /v1/chases/{chaseId}`
   - `GET /v1/sms-outbox` (`x-demo: true` — the dev "phone screen")
   - `POST /v1/portal/sessions` (link token + OTP → scoped portal session) ·
     `GET /v1/portal/context` (requested items for the session) ·
     `POST /v1/portal/uploads` (presign, delegated scope)
   - `GET /v1/publishes`
   - `GET /v1/bank-transactions`
   - `GET /v1/businesses` (id, name, counts for header/switcher)
2. **ProposalKind additive values** in both contract and Prisma enum (+ additive migration,
   pre-approved §3): `chase.send`, `publish.batch`, `bank.confirm-match`, `rule.create`.
3. Regenerate generated client/zod/MSW; update enum-parity tests; register the four new kinds
   in `apps/api/src/modules/validation-dedupe/proposals/registry.ts` as
   `ProposalNotImplementedError` stubs (the registry is total over the enum — it won't compile
   otherwise).

**Acceptance:**
- [ ] Repo-wide `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green.
- [ ] Migration is additive-only (enum values); parity tests green.
- [ ] No runtime behaviour change anywhere.

**Out of scope:** implementing any endpoint. Contract passes 2–4 proper (auth is minimal here,
banking/approvals full shape comes post-demo).

---

### STAGE 3 — The ActionProposal engine (Review → Approve, for real) — **Shakib** (~5 h)

**Objective:** the contracted-but-unbuilt constitutional engine. After this stage, a proposal
can be created, reviewed, approved and executed end-to-end server-side, with the DB triggers
enforcing approve-requires-review and execute-exactly-once.

**Read first:** `packages/contracts/openapi.yaml` `/action-proposals` ops (569, 645, 670, 718,
806) — **the contract already exists; implement it, don't redesign it** ·
`prisma/sql/rls.sql:422–448` (`action_proposals_guard()`) ·
`apps/api/src/modules/validation-dedupe/proposals/` (registry, `proposal-executor.ts`, the two
real executors) · `apps/api/src/modules/approvals/CLAUDE.md` ·
`apps/api/src/common/db/scoped-db.ts`.

**Build (home: `apps/api/src/modules/approvals/` per the registry's own comment):**
1. `action-proposals.controller.ts` + `.service.ts` implementing all five contracted ops:
   create (compute + store `payload_hash`), get/list, **review** (records `reviewed_at` +
   `shown_hash` — what was actually displayed), **approval** (executes via the registry
   **in the same transaction**, honouring the DB guard; approver identity from RequestContext),
   cancellation. `Idempotency-Key` honoured on mutations.
2. Build the executor registry in the module's `useFactory` (the seam the registry comment
   describes); implement the **`document.update-coding` executor** (currently stubbed):
   applies field edits to the extraction/coding surface + writes a `document_events` row.
   The four new kinds stay as stubs (Stages 8/10/11/13 fill them).
3. **Minimal audit writer:** on approve/execute, append an `audit_events` row with
   `sha256(prev_hash + canonical_payload)` chaining. Small and real — not a mock.

**Acceptance:**
- [ ] Integration test (real DB, as `nt_app`): create → review → approve a `document.archive`
      proposal on a seeded document → document is ARCHIVED; audit row chains.
- [ ] Approve **without** review → the DB guard rejects; API returns problem+json with an
      `NT-` code (server-side enforcement demonstrated — this is a demo talking point).
- [ ] Double-approve → exactly-once holds (second call idempotent/409).
- [ ] Full suite green.

**Out of scope:** approval *workflows* (multi-stage/branching), `assertCan` matrix,
practice-staff assignment filtering, pseudonym map, proposal expiry.

---

### STAGE 4 — DemoExtractor: documents finally leave RECEIVED — **Abdullah** (~5 h)

**Objective:** every ingested document gets extraction fields, per-field confidence, provenance,
classification, coding suggestions, and a resulting To Review / Ready / Failed state — from a
deterministic fixture engine behind the real `DocumentExtractor` interface.

**Read first:** `services/extraction/CLAUDE.md` (the interface + fixture-mode doctrine — build
to this) · `apps/api/src/modules/ingestion-routing/queue/ingest-processor.ts` (persist ~219,
sink ~226, the "left for extraction" comment ~240, dedupe ~254) ·
`apps/api/src/modules/validation-dedupe/readiness.ts` + `document-state.ts` ·
`apps/api/src/common/documents/document-response.ts:136` (`toExtraction` — the shape the read
surface already serves) · `apps/api/src/modules/extraction/CLAUDE.md`.

**Build (home: `apps/api/src/modules/extraction/`):**
1. `DocumentExtractor` interface per the services/extraction CLAUDE.md contract; env selection
   `EXTRACTOR=demo` (only value for now); `// DEMO-MOCK: Textract + vision ladder replaces this`.
2. `DemoExtractor`: a fixture library of ~10 UK document profiles keyed by filename keyword,
   falling back to a hash-derived generic profile. **Profiles must include the demo cast (§7):**
   Bidfood invoice · Currys receipt £1,299 · Google Ads invoice £600 · Adobe monthly ·
   Shell fuel receipt · a Just Eat payout email doc · one profile with a **low-confidence total**
   (lands To Review) · one **extraction-failure** profile (lands Failed with reason + retryable).
   Each profile: header fields (type, date, supplier, currency, total/tax in **pence**,
   reference, VAT number), 2–5 line items, per-field confidence, provenance `demo-fixture`,
   pre-computed validator verdicts (VAT arithmetic ok/fail etc.), `model_version:
   'demo-extractor-1'`.
3. **Rule honouring (feeds the Stage 13 wow beat):** before emitting the category suggestion,
   check the `rules` table for an active supplier-match rule in scope; if hit, set category from
   the rule with provenance `rule` + the rule id. Single-tier exact supplier match only
   (`// DEMO-MOCK: four-tier priority engine`).
4. Wire into the worker after `persist()` in `ingest-processor.ts` (~line 245): new pipeline
   step → write `extractions` row + `suggestions` rows + `document_events` → drive the state
   machine via `readiness.ts` (`RECEIVED → PROCESSING → TO_REVIEW | READY | FAILED`).
   Simulate 2–4 s latency so Processing renders.

**Acceptance:**
- [ ] Web-upload API call with `currys-receipt.jpg` → document READY with extraction +
      suggestions + events, visible on `GET /v1/documents/{id}/extractions`, inside 10 s locally.
- [ ] Low-confidence profile → TO_REVIEW; failure profile → FAILED with reason + retryable.
- [ ] Same file twice → dedupe still flags (existing behaviour intact).
- [ ] Seeded Bidfood rule honoured when present. Full suite green.

**Out of scope:** any AWS SDK, real validators in `packages/validators`, confidence-threshold
config, classification beyond the profile's declared type, statement extraction, auto-split.

---

### STAGE 5 — Seed v2: the demo cast + demo drivers — **Abdullah** (~4 h)

**Objective:** one command resets the world into a rich, coherent, demo-scripted state — and
two driver scripts make "a document arrives" happen live.

**Read first:** `prisma/seed.ts` (lines 86–718 — extend, don't rewrite; keep existing ids like
`biz_burger`, `doc_001`) · `apps/api/src/config/routing.ts` ·
`apps/api/src/worker/email-intake-main.ts` + `mailhog-email-source.ts` ·
the WhatsApp webhook module (`modules/ingestion-routing/webhooks/whatsapp/`).

**Build:**
1. **Cast (align exactly with §7 and Stage 4 profiles):** 1 practice, 3 client businesses
   (American Burger Ltd + two existing), users for Shakib-demo (Practice Admin) + Abdullah-demo
   (Standard User), **contacts with routing identities**: demo sender email
   (`owner@americanburger.test`) and phone (`+447700900001`) mapped so the email/WhatsApp beats
   route to American Burger instead of Unrouted — plus one deliberately unregistered sender for
   the Unrouted beat.
2. **Data:** documents across every state (incl. 2 FAILED with honest reasons, 1 REJECTED,
   2 unrouted); a duplicate pair; suggestions; one pre-existing rule (NOT Bidfood — Stage 13
   creates that live); bank connection + accounts + ~25 transactions in pence, including the
   **unmatched Currys £1,299 (9 Aug)** and **Google £600 (5 Aug)**, a credit-note case, and
   2 suppression-descriptor lines (`STRIPE PAYOUT`, `SERVICE CHARGE`); a mid-flight chase;
   publishes history; a seeded "connected" Xero integration row + a chart-of-accounts
   reference-sync fixture (categories the suggestion profiles use); vault items, tasks,
   notifications as today.
3. **Demo credentials** rows matching Stage 1's `demo-credentials.ts` (emails/passwords in §7).
4. **Drivers:** `pnpm demo:reset` (drop/migrate/seed + flush Redis queues + clear the demo
   MinIO prefix) · `pnpm demo:whatsapp` (posts a correctly-HMAC-signed fixture webhook with a
   receipt image → lands via the real pipeline) · `pnpm demo:email` (sends a fixture invoice
   email into MailHog from the registered sender). Scripts live under `scripts/demo/`.

**Acceptance:**
- [ ] `pnpm demo:reset` from cold completes < 2 min; app boots; every screen shows the cast.
- [ ] `pnpm demo:whatsapp` → document appears for American Burger and runs the full pipeline.
- [ ] `pnpm demo:email` → routed by sender identity; unregistered sender → Unrouted queue.
- [ ] Suite green; seed still refuses production.

**Out of scope:** schema changes, AI addressee detection, Meta media fetching (fixture fetcher
handles bytes), new business logic.

---

### STAGE 6 — Web login + API hydration switch — **Shakib** (~4 h)

**Objective:** the app starts at a real login screen; after login the workspace knows who you
are; API mode is on by default; synthetic fallback survives per-slice.

**Read first:** `apps/web/CLAUDE.md` · `apps/web/src/api/config.ts` + `api/documents.ts` (the
house wiring pattern: generated client + Zod + pence↔pounds mapping) ·
`apps/web/src/context/AppContext.tsx` (module-scope seed imports — the thing being tamed) ·
`apps/web/src/App.tsx` (view switch, 161–185).

**Build:**
1. `LoginView` (tokens-only styling, i18n'd strings, the four designed states): email +
   password + TOTP field (any 6 digits pass UI validation; server checks `000000`) →
   `POST /v1/auth/sessions` (`credentials: 'include'` everywhere; dev CORS/proxy via Vite if
   needed). Errors render the `NT-` code per house style.
2. Session bootstrap: `GET /v1/me` on load; unauthenticated → LoginView; authenticated → app.
   Logout in the user menu.
3. **Context header (SoT §13.3):** persistent strip — signed-in user, acting role, client scope.
   Small, real, from `/v1/me`.
4. **Hydration architecture** (the pattern Stages 7/11/12 fill): per-slice source selection in
   AppContext — `documents | chases | proposals | bankTransactions | publishes | businesses`
   each resolve from the API when `API_ENABLED`, else from the synthetic generators. A slice
   whose fetch fails falls back to synthetic **with a visible dev-only badge**, never a blank
   screen. Wire the `businesses` slice now as the proof.

**Acceptance:**
- [ ] Login → workspace with context header; refresh keeps session; logout returns to login;
      bad password shows coded error.
- [ ] `VITE_API_ENABLED=false` → entire app runs synthetic exactly as today (no login wall).
- [ ] web suite + build green (bundle budget still met — LoginView is lazy).

**Out of scope:** registration, forgot-password, role-based UI hiding, practice switching,
aria-live chat work.

---

### STAGE 7 — Documents & Inboxes on real data — **Shakib** (~6 h)

**Objective:** the core screens read the real API: inbox states, document detail with the
original image and the confidence overlay, drag-drop upload, live pipeline progress, duplicate
compare — and a field edit that round-trips through a real Review → Approve.

**Read first:** `apps/web/src/api/documents.ts` (`useDocuments` exists) · views:
`DocumentsView.tsx`, `InboxesView.tsx`, `ClientInbox.tsx` · the extraction-overlay and
duplicate-compare components (locate via the views) · API: `documents.controller.ts` routes
(`/original`, `/events`, `/extractions`) · web-upload module
(`modules/ingestion-routing/web-upload/`) · generated `/action-proposals` client.

**Build:**
1. Documents + Inboxes + ClientInbox render from the `documents` slice (Costs/Sales from
   classification; state tabs; counts). Pence→pounds only at the api-mapping layer.
2. Document detail: original image (presigned `/original`), extraction overlay from real
   extraction rows — per-field confidence colouring + provenance class (human · rule ·
   AI+confidence, SoT §13.3), events timeline from `/events`.
3. **Drag-drop upload** → presigned-PUT flow (intent → PUT → complete) → poll/refetch: watch
   Processing → Ready live (2–4 s DemoExtractor latency makes this a real moment).
4. **Edit-a-field flow:** correcting supplier/category/total opens a Review → Approve card →
   `POST /v1/action-proposals` (`document.update-coding`) → review → approve → refetch shows
   the human-confirmed provenance. The card must keep the house gating: Approve not mounted
   until Read-review expanded (component exists — reuse it).
5. Duplicate flag renders the side-by-side compare from real dedupe verdict data.

**Acceptance:**
- [ ] Upload `currys-receipt.jpg` in the browser → Processing → Ready with overlay, < 15 s.
- [ ] Edit a category → proposal → approve → value updates with provenance change.
- [ ] Upload the same file twice → duplicate compare renders.
- [ ] Synthetic mode untouched; suite + build green.

**Out of scope:** bulk actions, saved views, keyboard nav polish, upload modes (split), Sales
pipeline specifics beyond classification tab, mandatory-field config.

---

### STAGE 8 — Chase engine + SMS outbox — **Abdullah** (~6 h)

**Objective:** the flagship, server-side: detection finds unmatched bank transactions, the
chase composes into verbatim SMS shown at review, approval "sends" through the mock sender into
an outbox, and an arriving matching document auto-closes the chase.

**Read first:** `apps/api/src/modules/chase/CLAUDE.md` · SoT §4 Stage 8 (the copy shape is
specified — use it) · Stage 3's engine + registry · seeded bank data (Stage 5) · contract paths
from Stage 2.

**Build (home: `apps/api/src/modules/chase/`):**
1. **Detection engine (a) only:** unmatched, non-suppressed bank transactions per client
   (descriptor keyword suppression list from SoT §4 Stage 7 — `SERVICE CHARGE`, `STRIPE PAYOUT`,
   etc.). Exposed as a service the chat/table endpoints use. Engines (b)–(e):
   `// DEMO-MOCK` comment listing them, nothing more.
2. **Composition:** template interpolation producing the SoT's exact copy shape
   (*"American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload
   securely: [link]"*), grouped per client. `// DEMO-MOCK: Sonnet composition`. The signed
   portal link token (Stage 9's format — coordinate: HMAC over chaseId + exp; define it here,
   Stage 9 consumes it).
3. **`chase.send` executor:** proposal payload = every SMS verbatim + recipients (that is what
   Read-review shows). Execute → create `chases` + `chase_messages` rows → `SmsSender`.
   `DemoSmsSender` writes the outbox (`sms_log`/`chase_messages` surface) — **no Twilio, ever**.
4. `GET /v1/chases`, `GET /v1/chases/{id}`, `GET /v1/sms-outbox` per contract.
5. **Auto-close:** on document ingest (post-extraction hook), compare supplier+amount(+date
   window) against open chases in scope → close, write chase event + in-app notification row.
   Deterministic compare — this is real product logic, not a mock.

**Acceptance:**
- [ ] Detection lists the seeded Currys + Google transactions; suppressed lines absent.
- [ ] Create chase proposal → review shows verbatim SMS → approve → chase ACTIVE, SMS in outbox
      with working portal link.
- [ ] Ingesting a matching receipt (Stage 4 profile) closes the chase automatically.
- [ ] Suite green.

**Out of scope:** policy scheduler/reminders/escalation, quiet hours, STOP handling, item
messaging threads, engines (b)–(e), supplier email chasing, SMS budgets.

---

### STAGE 9 — OTP portal server + wiring — **Abdullah** (~6 h)

**Objective:** the no-app client journey is real: SMS link → OTP challenge → scoped portal →
camera/file upload with editable overlay → document lands in the client workspace → chase
closes → accountant sees it.

**Read first:** `apps/web/src/views/business/` (BusinessPortal + OTP screens + capture/upload
views — the UI shell exists) · web-upload module (presign flow to reuse with delegated scope) ·
`otp_sessions` model in `prisma/schema.prisma` · the RLS delegated-OTP-session policies in
`prisma/sql/rls.sql` · Stage 8's link-token format · portal contract paths (Stage 2).

**Build:**
1. **Portal session:** `POST /v1/portal/sessions` — verify link token (HMAC, expiry), verify
   OTP `000000` when `OTP_MODE=demo` (`// DEMO-MOCK: Twilio Verify`), create `otp_sessions` row
   scoped to the chase's items (delegated-from recorded), issue portal cookie. Rate-limit
   nothing; log the session.
2. `GET /v1/portal/context` — the chased items (supplier/amount/date) this session may see, and
   nothing else (RLS delegated policies do the enforcement — test it).
3. **Upload:** `POST /v1/portal/uploads` → delegated presign → same ingestion pipeline →
   DemoExtractor → **chase validation**: compare extraction vs chased transaction; match →
   auto-close (Stage 8's hook) + success screen; mismatch → in-portal feedback naming the
   difference (SoT beat: *"This looks like a £420 invoice, but we need the £600 Google
   transaction from 5 Aug."*). Deterministic compare — real logic.
4. **Wire the portal UI:** link entry → OTP screen → item list → Take Photo / Upload File →
   uploading state → extraction overlay (fields editable; corrections recorded as a
   `document_events` entry — no schema change) → success/mismatch states. Client-side image
   compression stays as built.
5. In-app toast/notification row for the accountant on portal upload (`// DEMO-MOCK:
   notification delivery channels`).

**Acceptance:**
- [ ] Full journey on a phone-sized viewport: outbox link → `000000` → upload Currys fixture →
      chase closes → document visible in American Burger's inbox with `uploaded-by-delegated-
      session` recorded.
- [ ] Wrong-document upload → mismatch feedback, chase stays open.
- [ ] Portal session cannot read anything beyond its items (add the negative test).
- [ ] Suite green.

**Out of scope:** real OTP/SMS, forwardability UX beyond what exists, portal as separate build
entry, onboarding flow, passkeys.

---

### STAGE 10 — Mock publish to Xero — **Abdullah** (~4 h)

**Objective:** approving a publish batch pushes documents through a `LedgerAdapter` that
behaves exactly like Xero from the product's side: preview totals, per-item results, external
refs, lock-on-publish, auto-archive — plus one scripted failure to show the Rejected/Failed →
retry story.

**Read first:** `apps/api/src/modules/publishing/CLAUDE.md` · `publishes` + `integrations`
models · the archive executor (`validation-dedupe/proposals/archive-document.ts`) ·
state machine `document-state.ts` · contract (Stage 2).

**Build (home: `apps/api/src/modules/publishing/`):**
1. `LedgerAdapter` interface (publish bill with attachment ref → external ref | typed failure).
   `DemoXeroAdapter`: 1–2 s delay per item, refs `XERO-INV-####`; deterministic failure for one
   flagged seed document (`// DEMO-MOCK: Xero OAuth + SDK adapter`).
2. **`publish.batch` executor:** validate minimum fields (Total + Supplier + Category) per item;
   proposal payload carries the server-computed preview — item count, gross, VAT (pence) — which
   is what Read-review renders; execute → `publishes` rows, document state → PUBLISHED (locked)
   → auto-archive via existing executor logic; failure → publish row FAILED + document to the
   Rejected/Failed surface with reason + retryable.
3. `GET /v1/publishes`; retry = new proposal on the failed item (succeeds second time —
   deterministic).

**Acceptance:**
- [ ] Publish proposal over seeded Ready docs → review shows real counts/totals → approve →
      refs + locks + archived.
- [ ] Scripted failure lands in Rejected/Failed; retry succeeds.
- [ ] Item missing Category refuses to enter the batch with a coded error. Suite green.

**Out of scope:** real Xero/QBO anything, reference-list sync engine (seeded CoA suffices),
canonical-model completeness, integration health logic, webhooks, exports.

---

### STAGE 11 — Bank screen on real data — **Abdullah** (~3 h)

**Objective:** the Bank workspace lists the seeded (mock-feed) transactions; suggested matches
come from the existing client-side engine; confirming a match persists server-side through a
proposal.

**Read first:** `apps/web/src/views/BankView.tsx` + the client-side match engine (31 tests) ·
`bank_transactions`/`matches` models · contract (Stage 2).

**Build:**
1. `GET /v1/bank-transactions` (normalised schema, pence, match_state) — thin controller in
   `modules/banking-matching/`.
2. Web: `bankTransactions` slice → BankView renders real rows ("feed" presented as connected —
   the seeded integration row; `// DEMO-MOCK: TrueLayer`). The client-side engine produces
   suggestions for display only (its float-pounds arithmetic stays display-tier; flagged for
   post-demo rewrite).
3. **`bank.confirm-match` executor:** writes the `matches` row (doc ↔ txn, kind, confidence) and
   flips `match_state` — pence-only server-side. Confirm from the UI via Review → Approve;
   unmatched count now agrees with chase detection (same data).

**Acceptance:**
- [ ] BankView lists seeded txns; Currys/Google show as unmatched with suggestions where a doc
      exists; confirm persists across refresh.
- [ ] Matched txns disappear from chase detection. Suite green.

**Out of scope:** cash coding, partial/batch payments server-side, statement upload wiring,
consent lifecycle, configurable windows.

---

### STAGE 12 — Remaining view wiring: Chases · Approvals · Rejected/Failed · Unrouted · SMS outbox — **Shakib** (~5 h)

**Objective:** every screen on the demo route reads real data; the rest keep fixtures.

**Read first:** `ChasesView.tsx`, `ApprovalsView.tsx`, `DocumentsView` failure surfaces,
Unrouted UI (find via InboxesView/ClientsView), generated clients for chases/proposals/outbox.

**Build:**
1. **ChasesView** → `chases` slice: list + detail (messages, state, linked items) + an **SMS
   outbox panel** (the "client's phone" for the demo — renders `GET /v1/sms-outbox`, each SMS
   with its tappable portal link; dev-styled, clearly a demo surface).
2. **ApprovalsView** → pending `action-proposals` as the live approval queue (list, Read-review
   expand, Approve/Cancel — the real engine). The workflow *builder* stays FIXTURE.
3. **Rejected/Failed view** → real FAILED/REJECTED documents with reason + retry action
   (retry = `document.reprocess`… which is stubbed — scope check: wire retry only for the
   publish-failure case via Stage 10's retry proposal; extraction-failure retry shows a
   disabled-with-tooltip "re-request from client" pointing at chase).
4. **Unrouted queue** → real unrouted documents; one-click assign → `document.route` proposal
   (executor already real) → lands in the client inbox.
5. **ClientsView:** real waiting-document counts per business if it's one cheap aggregate on the
   existing documents endpoint; otherwise leave counts fixture — do not build an analytics
   endpoint for this.

**Acceptance:**
- [ ] Chase from Stage 8 visible end-to-end; outbox panel link opens the portal.
- [ ] A pending proposal approved from ApprovalsView executes (state visibly changes).
- [ ] Unrouted doc routed via proposal appears in the right inbox.
- [ ] Synthetic mode intact; suite + build green.

**Out of scope:** analytics wiring, team/settings/vault wiring, client detail deep tabs,
notifications centre.

---

### STAGE 13 — Chat golden paths — **Shakib** (~5 h)

**Objective:** the chat workspace drives the demo: scripted utterances render real components
backed by real endpoints, and every state change goes through the real proposal engine. The
model is mocked; the actions are not.

**Read first:** `AIWorkspaceView.tsx` + the existing regex classifier + component-card renderers
· the Review→Approve card component · generated API clients.

**Build — a canned intent table (`// DEMO-MOCK: Opus via Bedrock`) covering exactly these
utterances (+ tolerant matching), each falling back to a graceful "here's what I can do" card:**
1. *"Show missing paperwork for American Burger"* → table of unmatched transactions + open
   chases (real data, drillable).
2. *"Chase American Burger for the missing receipts"* → chase composer card → Review → Approve
   → real `chase.send` proposal → outbox.
3. *"Whenever Bidfood invoices arrive for American Burger, code them Cost of Sales Food with
   standard VAT"* → canned parse → rule card (fields, tier, scope) → Review → Approve →
   `rule.create` executor (implement here: writes the `rules` row; ~30 lines) → next Bidfood
   upload arrives pre-coded (Stage 4 honours it) — **the wow beat**.
4. *"Publish all approved costs to Xero"* → publish preview card (real server totals) →
   Review → Approve → `publish.batch`.
5. *"Show everything to review"* / *"open the Currys receipt"* → navigation intents.

Read-only intents execute instantly; state-changing intents always render the R→A card
(SoT §8.2). Voice keeps working (it feeds the same processor).

**Acceptance:**
- [ ] All five utterances work against real data end-to-end; unknown input degrades gracefully.
- [ ] Rule beat: create rule in chat → `pnpm demo:whatsapp` variant with Bidfood fixture →
      document arrives pre-coded with rule provenance.
- [ ] Approve is never mounted pre-review in any card. Suite + build green.

**Out of scope:** real model calls, streaming, aria-live, conversation persistence, multi-client
attachment logic beyond what exists.

---

### STAGE 14 — Demo hardening + the script — **Both** (Wed evening, ~4 h)

**Objective:** the demo cannot fail twice. Rehearsed, resettable, with fallbacks at every beat.

**Build:**
1. `docs/DEMO_SCRIPT_2026-08-21.md` — beat-by-beat (§6 below is the skeleton: expand with exact
   clicks, exact utterances, exact files to upload, reset points, and per-beat fallback).
2. Golden-path sweep: no console errors; every dead button on the route is hidden or
   disabled-with-tooltip; loading skeletons on wired screens; `NT-` errors render.
3. `pnpm demo:reset` rehearsed twice from cold. Backup: **record a full run-through video on
   the 20th night** (the demo-of-last-resort), and verify `VITE_API_ENABLED=false` still demos.
4. Laptop checklist in the script: docker up, api+web+workers running, MailHog open, outbox
   open on a phone-sized window, fixtures folder on the desktop, network offline-safe (all
   local).
5. Update every touched module `CLAUDE.md` + repo `CLAUDE.md` pointer to this file's outcome.

**Acceptance:** two clean consecutive full rehearsals, one by each of us, from `demo:reset`.

### STAGE 15 — STRETCH: staging deploy — **Shakib** (only if 14 is done early)

Staging already runs `AUTH_MODE=session` + real queue/S3; Stage 1 makes it bootable-meaningful.
Deploy, seed staging DB with the demo cast, smoke the golden path. **The demo plan of record
remains local regardless** — staging is a flex, not a dependency. No infra changes beyond env
values for the new `SESSION_SECRET`/`EXTRACTOR`/`SMS_SENDER`/`OTP_MODE`/`LEDGER_ADAPTER` vars.

---

## 6. The demo script (skeleton — Stage 14 expands it)

1. **Login** — real session, TOTP prompt, context header (who am I, what scope). *"Nothing in
   this product changes state without a named human."*
2. **A receipt arrives by WhatsApp** (`pnpm demo:whatsapp`) → Processing → extracted, coded,
   confident — overlay tour (confidence + provenance per field).
3. **Email beat** (`pnpm demo:email`) → routed by sender identity; the unregistered sender lands
   in **Unrouted** → one-click route (through Review → Approve).
4. **Drag-drop** a receipt → watch the pipeline live. Upload it **again** → duplicate caught,
   side-by-side.
5. **Fix a field** → Review → Approve → provenance flips to human-confirmed. Show the server
   rejecting approve-without-review (the constitution is real).
6. **Bank** — the feed, the unmatched Currys £1,299. **Chat:** *"chase American Burger…"* →
   Read review shows the exact SMS → Approve → **the phone** (outbox panel).
7. **The portal** — link → OTP → photo → editable overlay → submit → **chase auto-closes**,
   accountant notified. *(Also show the wrong-doc mismatch feedback.)*
8. **The rule beat** — dictate/type the Bidfood rule → approve → next Bidfood invoice arrives
   pre-coded.
9. **Publish** — *"publish all approved costs to Xero"* → preview totals → Approve → refs,
   locked, archived. One failure in **Rejected/Failed** → retry → green.
10. **Breadth tour** (fixtures, presented as designed surfaces): Clients, Analytics, Approvals
    builder, Team, Settings, Vault. Close on the roadmap: real Textract/Bedrock, Twilio, TrueLayer,
    Xero — the seams are already in the code.

---

## 7. Demo cast & credentials (single source — seed, extractor, script all align to this)

| Thing | Value |
|---|---|
| Practice | Neovogent Accounting (existing seed practice) |
| Clients | American Burger Ltd (`biz_burger`) + the two existing seed businesses |
| Login — Practice Admin | `shakib@neoting.test` / `demo-neoting-2026` / TOTP `000000` |
| Login — Standard User | `abdullah@neoting.test` / `demo-neoting-2026` / TOTP `000000` |
| Registered client sender | `owner@americanburger.test` · `+447700900001` |
| Unregistered sender (Unrouted beat) | `stranger@example.test` |
| Portal OTP | `000000` |
| Chase targets | Currys £1,299.00 (9 Aug) · Google Ads £600.00 (5 Aug) |
| Rule beat | Bidfood → Cost of Sales Food, standard VAT |
| Publish failure fixture | one flagged seed document (Stage 10 defines the flag) |

---

## 8. Risks & fallbacks

| Risk | Fallback |
|---|---|
| Any wired screen breaks on the day | Per-slice synthetic fallback (Stage 6) — the screen degrades to fixtures, not to blank |
| The spine slips (Stages 1–3 late) | Demo = synthetic UI walkthrough (works today) + recorded video of whatever spine exists |
| Whole environment fails | The Stage 14 recorded run-through video |
| A stage overruns | Cut order (last first): 15 → 11 → 12.5 (ClientsView counts) → 13.5 (utterances 5, then 3) → 9.4 (overlay editing in portal — upload alone still demos) |
| Two people, one main, no branch protection | One branch per stage, PRs reviewed by the other person, merge only on green local suite — CI won't stop a bad merge, so we do |

**After the 21st:** every `// DEMO-MOCK` becomes a tracked issue; client feedback lands as
changes to the Source of Truth first, then here. This file expires when that plan is written —
it must not silently become the roadmap.

*— METH_MODE v1, 18 Aug 2026 —*
