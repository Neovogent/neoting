# NEOTING — Comprehensive Project Status Report

**Date: Sunday 17 August 2026 (kickoff + 4.9 days) · Compiled by: Claude (Fable 5), commissioned by Shakib**
**Method:** 12 parallel code auditors scored every sector against Source of Truth v1.5 scope with harsh, evidence-based rules (scaffold ≈ 0, untested code discounted, "built-but-not-wired" discounted); a history agent compiled the full PR/issue/commit dataset; infra and CI/CD were verified against live AWS and GitHub, not documentation.

---

## 1. TL;DR

| Question | Answer |
|---|---|
| **Was infra & CI/CD done?** | **No — and it was worse than "not done": every deploy since PR #89 had been silently failing and rolling back while CI reported green.** Found, root-caused, and fixed today (§2). Infra & CI/CD are now **complete for the current phase**: staging deploys real code, deploys can no longer lie, terraform auto-applies on merge, the real ingest lane is live, and all five §14.3 lint families are enforced. What remains is externally blocked or scheduled (Infra Week), itemised in §2.4. |
| **Total completion (v1 pilot scope)** | **≈ 22%** (weighted; method in §3). Front-loaded with genuinely excellent groundwork — schema/RLS, contracts, CI, infra, a 31k-line frontend — but the server-side product core (extraction, AI runtime, rules, chase engine, approvals engine, publishing, auth) is 0–14% built. |
| **Velocity** | 62 PRs merged, 46/46 issues closed, ~90k lines in **4.9 days** by 2 committers at a 12–19 h/day cadence. Extraordinary — and not sustainable as a planning assumption. |
| **Forecast** | Core pipeline demo on staging: **~mid-September**. v1 pilot-complete (SoT W14 = **19 Nov 2026**): **achievable**; realistic band **19 Nov – mid-Dec**. The tail risk is not code — it is external clocks (Meta verification, Twilio UK sender, TrueLayer production review, ICO + DPIA, pen test) and the empty eval/e2e estate. |
| **The 7-day sprint (sign-off Wed 19 Aug)** | The full Day-7 bar (capture→extract→code→dedupe→match→chase→portal→approve→publish live on staging) **will not be met** — extraction, chase server-side, approvals and publishing are skeletons. What *can* demo cleanly: ingest across web/email/WhatsApp into real S3+queue on staging, dedupe, document states + Rejected/Failed, the full UI walkthrough on synthetic data, and the tenancy suite green. |

**One manual action needed from you now:** three SNS confirmation emails are sitting in shakibbinkabir@gmail.com (`nt-staging-alerts`, `nt-prod-page`, `nt-prod-ticket`). Until you click them, every alarm in the estate fires into a void.

---

## 2. Infra & CI/CD — the first question, answered A→Z

### 2.1 The incident found today (this alone justified the audit)

**Staging had been silently pinned to PR #89 for a day while CI reported green on 16 consecutive merges.**

- Every deploy from **#90 through #107** failed at container start: `env.ts` (correctly) refuses `AUTH_MODE=fixture` and an empty `UPLOAD_URL_SECRET` under `NODE_ENV=production` (the gates landed with #84/#92), and the task definitions set neither.
- The ECS circuit breaker rolled each deploy back to the old revision. `aws ecs wait services-stable` then **succeeded** — a service serving the old build is perfectly stable — and `/healthz` probed the old build and returned 200. The pipeline's own comment claimed this wait "turns a rollback into a red pipeline"; it does not.
- Evidence: api service running task-def **rev 25** (image `2e56514` = #89) while CI had registered **rev 35** (image `e9e60fd` = #107); ECS events `deployment failed: tasks failed to start → rolling back`; container exit code 1 with the exact env-validation error in CloudWatch.

### 2.2 What was fixed and shipped today (all merged, all verified live)

| PR | What | Verified |
|---|---|---|
| **#108** `fix(infra): set auth_mode and a real upload secret so staging boots` | `AUTH_MODE=session` on both services; `UPLOAD_URL_SECRET` as a Terraform-generated real secret (a placeholder would pass the boot gate and sign forgeable upload intents) + injection + KMS/execution-role grants. Prod mirrored so its first deploy can't hit the same wall. | Staging jumped rev 25→37; serving image = main HEAD for the first time since #89; `/healthz` 200 through the edge. |
| **#109** `ci(repo): fail stage 9 red when ecs rolls a deploy back` | After each `services-stable` wait, the deploy job asserts the PRIMARY deployment's task-definition ARN equals the one **this run registered** (api and workers); on mismatch it dumps stopped-task reasons + log tails and fails. The lying comment replaced with the measured truth. | Exercised live on its own merge-deploy: assertions passed on a genuine deploy. |
| **#110** `feat(infra): flip the staging ingest lane from fixtures to real` | `INGEST_QUEUE=bullmq`, `OBJECT_STORE=s3`, `IMAGE_NORMALISER=sharp` on staging + prod; fixed the latent `S3_BUCKET_DOCS` vs `S3_BUCKET_DOCUMENTS` name mismatch that would have 403'd every persist the day the flip landed; retired the now-false "ingest is in-memory" caveats in check.yml and apps/api/CLAUDE.md; refreshed four stale infra/README bullets. | Deployed: api rev 40 / workers rev 29, rollout COMPLETED, revision assertions green. A WhatsApp/webhook document now survives a restart: Redis queue + S3 persistence under `w/<businessId>/…`. |
| **#111** `fix(infra): fence the plan role out of prod and account state` | Explicit Deny on `prod/*` and `account/*` state-bucket prefixes for `nt-staging-ci-plan` — closes "any PR can read prod state" while prod state is still theoretical. Deliberately a deny overriding `ReadOnlyAccess`, not a hand-enumerated read policy that breaks with the next module. | Applied (terraform run green). Live test = the next infra PR's plan. |
| **#112** `feat(repo): enforce all five governance lint families repo-wide` | `eslint-plugin-jsx-a11y` + `eslint-plugin-react-hooks` in apps/web with the full 39-violation sweep (28 a11y findings fixed with real markup — 9 modals gained proper dialog semantics + a stack-aware Escape hook; 11 exhaustive-deps handled honestly, incl. one where "just add the dep" would have regenerated the reviewed SMS link every render); custom `neoting/no-cross-module-internals` rule for api module boundaries (no new dependency, first public seam created); money-type selectors catching float literals meeting `*Pence` names. | web: typecheck/lint/test/build all green (188 tests); api re-proven untouched (374 tests). |

**GitHub/AWS-side actions (no PR needed):**
- `TERRAFORM_AUTO_APPLY=true` set — staging infra now applies automatically on merge, the workflow's own documented steady state after the first apply.
- **GitHub environment `prod` created** with a main-only deployment branch policy → `nt-prod-ci-deploy` (which trusts `environment:prod`) is now assumable at Infra Week. **Required reviewers were rejected by the free plan (HTTP 422)** — same class as the known branch-protection deferral; re-run the reviewer PUT the day the org moves to Team.
- **SNS subscriptions created** for all three alert topics → pending your three clicks.
- **SES production access verified GRANTED** (`ProductionAccessEnabled: true`, HEALTHY) — the infra README said "awaiting AWS"; corrected. Textract quota raises are still `CASE_OPENED` (current `AnalyzeExpense` limit 5 TPS, requested 10).

### 2.3 CI/CD state vs Governance §14 (the nine stages)

| # | Stage | State |
|---|---|---|
| 1 | install --frozen-lockfile + commitlint | ✅ real, blocking |
| 2 | typecheck | ✅ real (api, web, contracts) |
| 3 | lint | ✅ real; **all five §14.3 families now enforced**: unscoped-query (PrismaClient import choke), i18n-literal (custom rule + catalogue gate), a11y (jsx-a11y), module-boundary (custom cross-module rule), money-type (float-meets-`*Pence` selectors) — the last three landed today |
| 4 | test (unit + integration, isolated DB) | ✅ real: 430+ api tests incl. 9 real-DB integration suites running as `nt_app` under RLS; **30-assertion SQL tenancy suite blocking on every merge** |
| 5 | build (+ no-tracked-mutation + generated-tree guards) | ✅ real |
| 6 | test:e2e (+ axe + tenancy-over-HTTP) | ⛔ **no suite exists** (e2e/ is an echo scaffold). The stage self-activates the moment a real `test:e2e` script lands — this is test debt, not pipeline debt |
| 7 | test:eval | ⛔ **no suite, no gold datasets, no injection corpus** — same auto-activation; this is the SoT's named mitigation for its two highest risks and is the most important missing artefact in the repo |
| 8 | security (pnpm audit + gitleaks on the diff) | ✅ real, blocking |
| 9 | deploy (migrate → api → workers, staging) | ✅ real **and now truthful** — rollback = red; real ingest lane deployed; prod promote = the `prod` environment (reviewer gate awaits plan upgrade) |

Terraform CI: plan on every infra PR (read-only role, now state-fenced), auto-apply on merge, applies serialised by state-file concurrency group. **`main` is deployable and deployed: staging serves today's HEAD.**

### 2.4 What remains on infra/CI-CD — none of it blocked on code written today

| Item | Why it's open | Owner / clock |
|---|---|---|
| Click 3 SNS confirmations | Email confirmation is a human click | **Shakib, 2 minutes, today** |
| Email-intake ECS service (`EMAIL_SOURCE=s3`) | The s3 poller (`worker/email-intake-main.ts`) is a separate process with no service; env.ts refuses the flip until queue+store are real (they now are) | Next infra PR (~80 lines mirroring workers + a deploy step) |
| qpdf in the image (`DOCUMENT_GUARD=qpdf`) | Deliberately not installed; flip = Dockerfile change | Small PR, with the email service |
| Staging hostname → `staging.neoting.neovogent.com` | Decided 15 Aug; touches live edge + cert + `EDGE_HOST` in check.yml — its own carefully-sequenced PR; gates only prod's edge authoring | Shakib, before prod apply |
| Prod apply (Slice C) | **Scheduled, not blocked**: runbook burn profile stands prod up ~Oct (W9–12); applying now burns the $8k pot early | Infra Week trigger |
| AMP/AMG, Sentry, Unleash server, ClamAV scanner app | Deferred to Infra Week by G1/§8.5 design (CloudWatch covers Kickoff §7.6 now); ClamAV needs application code, not just the infra that exists | Infra Week |
| Branch protection + prod required reviewers | GitHub Free plan blocks both (403/422) — known, deliberate deferral; `apply-branch-protection.sh` is staged | CEO decision on plan upgrade |
| Dedicated `neoting-*` AWS accounts | Requested from Cloudvisor; until then D36 shared-account caveats hold and the DPIA must say so | External |
| Textract quota raises | `CASE_OPENED` since 13 Aug | AWS |

---

## 3. Total completion: **≈ 22%** of v1 pilot scope

Weighted by estimated build effort toward the SoT's pilot bar. Weights are judgment, stated openly; scores are the auditors', evidence-based.

| Sector | Weight | Score | Contribution |
|---|---:|---:|---:|
| Extraction + AI runtime (Textract, Bedrock tiers, prompts, evals) | 12 | **7%** | 0.8 |
| Banking-matching + Chase (the flagship) | 12 | **14%** | 1.7 |
| Auth-tenancy + the constitution (RLS, ActionProposal, audit) | 10 | **40%** | 4.0 |
| Web workspace app (apps/web) | 10 | **36%** | 3.6 |
| Ingestion & routing | 9 | **42%** | 3.8 |
| Approvals + Publishing (Xero/QBO) | 9 | **8%** | 0.7 |
| Validation-dedupe + Rules-suggestions | 8 | **10%** | 0.8 |
| Clients/team/settings · archive/vault · notifications · exports · analytics · voice | 8 | **12%** | 1.0 |
| OTP portal + the four LAW packages | 6 | **15%** | 0.9 |
| Testing estate (vs Gov §15) | 6 | **22%** | 1.3 |
| Third-party rails (8 vendors) | 4 | **22%** | 0.9 |
| Compliance ops + observability (app side) | 3 | **17%** | 0.5 |
| AWS infra (Terraform estate) | 2 | **75%** | 1.5 |
| CI/CD pipeline | 1 | **85%** | 0.9 |
| **Total** | **100** | | **≈ 22.4%** |

**How to read this honestly:** the 22% is *not* evenly distributed risk. The four highest-scoring sectors (tenancy/RLS, ingestion, web UI, infra/CI) are the platform; the four lowest (extraction/AI 7%, approvals/publishing 8%, validation/rules 10%, clients-etc 12%) plus chase (14%) are **the product** — the eleven-stage pipeline the SoT calls "the product; everything else exists to serve it." The dominant repo-wide pattern the auditors found is **"built but not wired"**: LAW-grade schema and seeds for every domain, a high-fidelity 31k-line UI running entirely on synthetic generators (`apps/web/CLAUDE.md`: "The screens do not read from the API yet"), and 13 of ~17 api modules that are `CLAUDE.md`-only skeletons.

---

## 4. Sector-by-sector

### 4.1 Auth-tenancy + the constitution — **40%** (the strongest engineering in the repo, split in half)
**Real:** RLS over all 34 tenant tables with `FORCE ROW LEVEL SECURITY`, the `nt_app` non-owner role split, delegated-OTP-session policies, `scopedDb` + GUC pattern (lint-choked, integration-tested against real Postgres, blocking in CI via the 30-assertion SQL tenancy suite); ActionProposal DB spine with below-the-app triggers (approve-requires-review, execute-exactly-once, payload-hash-immutable); complete OpenAPI contract for the Review→Approve engine; 2 real + 5 honestly-holed proposal executors; full domain schema (~35 models, money in integer pence throughout).
**Missing:** the **Review→Approve engine itself** (no `/action-proposals` controller/service — the contracted spine is unimplemented, so no proposal can execute end-to-end in production); Argon2/sessions/TOTP at zero; Twilio Verify OTP at zero; the hash-chain audit **writer** (schema only); `assertCan` authorization; practice-staff assignment filtering. The product currently has **no authenticated identity** — staging's `AUTH_MODE=session` correctly refuses everything until S1 lands.

### 4.2 Ingestion & routing — **42%** (engineering-dense, routing-light)
**Real:** the full sanitisation pipeline in Governance §11.4 order (magic-byte, extension-spoof, per-channel caps matching the SoT table, real sharp EXIF/HEIC, real qpdf guard code, ZIP-bomb caps); web upload with HMAC-signed stateless intents proven against Postgres+MinIO; the most complete email lane (postal-mime, MailHog/S3 sources, quarantine semantics); WhatsApp webhook sandbox-verified with HMAC + replay protection; BullMQ queue with claim/release idempotency + DLQ; RLS-scoped document sink; two-signal dedupe (byte-hash + measured perceptual-hash) wired into the worker; 236 unit tests. **As of today this runs for real on staging** (Redis + S3, not memory).
**Missing:** **auto-split (0%)** — the lead Stage-1 competitive claim; **sender-identity routing runs on an empty map** — in production every document lands Unrouted; AI addressee detection (deliberate seam, not built); CSV/XLSX structured import (0); real virus scanning (interface + EICAR fixture; no scanner service); ZIP explode into documents; the web upload channel has an API but no frontend caller.

### 4.3 Extraction + AI runtime — **7%** (the emptiest critical sector)
**Real:** frozen extraction contract (per-field confidence/provenance, four-rung ladder, pinned model/prompt versions); untrusted-content wrapping built, tested and wired at both intake boundaries; extraction read endpoints; CI eval-gate plumbing that auto-arms.
**Missing:** `services/extraction` has **zero source files** — no `DocumentExtractor`, no Textract binding, no vision ladder; no `models.ts` (the Governance §9.1 source of truth); no Bedrock/Textract SDK dependency anywhere; no prompts; no eval harness, no labelled corpus (W2 calibration has nothing to calibrate); no injection corpus; `packages/validators` empty (no VAT arithmetic/VRN/date/currency validators). In production nothing ever writes an Extraction row — **no document can leave RECEIVED**.

### 4.4 Banking-matching + Chase — **14%** (flagship: convincing demo, zero server)
**Real:** complete LAW schema (consent lifecycle, normalised txns in pence, five-engine chase state machine, verbatim SMS doctrine); a genuinely good frontend prototype — match engine with 31 tests (windows, credit notes, partial payments, fuzzy merchants), CSV/XLSX statement parsing with 53 tests, chase composition behind a real Review→Approve gate with GSM segment counting, in-browser auto-close loop.
**Missing:** both api modules are empty; **no contract endpoints exist for chase/bank/portal** (openapi pass 3/4 unwritten); no TrueLayer code; no Twilio/SMS client; no signed links or OTP issuance; no detection engines running anywhere; no policy scheduler; the prototype matcher uses float pounds (fixture-only); no chase auto-close server path.

### 4.5 Approvals + Publishing — **8%**
**Real:** schema + honest seeds; publish preview/workflow-builder/lock-on-approve UI at high fidelity (fixture-driven); 2 document executors on the proposal seam.
**Missing:** both modules zero-code; no canonical publish model; **no Xero or QBO adapter code at all** (no SDK, no OAuth, no bill push, no reference sync); no publish worker; no approvals evaluation logic. Note: W9 (Xero) is the SoT's scheduled slot — ~7 weeks away — so this is *on plan* to be empty, but it is the longest single lane left.

### 4.6 Validation-dedupe + Rules — **10%**
**Real:** the document state machine (8×8 transition matrix tested, compare-and-swap, event log in-transaction), readiness rule (Total+Supplier+Category), Rejected/Failed read surface with reason+retryable — merged at HEAD and good.
**Missing:** `packages/validators` empty (all five deterministic validator families); rules-suggestions zero-code (no four-tier engine, no NL rule parsing, no contract paths drafted); confidence gating (deliberately empty seam); dedupe beyond two signals (no field-rule parity nets, no verdict endpoints, no review surface); mandatory-fields config server-side.

### 4.7 Clients/team/archive/notifications/exports/analytics/voice — **12%**
**Real:** archive executor (tested, server-side) + ARCHIVED read semantics wired; ILIKE search; deep fixture UI (1,630-line intake form, 2,470-line client detail, 18 settings panels); client-side CSV exports; browser push-to-talk with confirm-before-execute UX.
**Missing:** all six api modules empty; Companies House and HMRC checks are cosmetic labels; no onboarding flow; no notification delivery of any kind; no async export engine/download centre; no public API/OAuth/webhooks; no pg full-text search (no tsvector/GIN in any migration); no vault backend; voice is the wrong provider (Web Speech, not Transcribe) with no interface.

### 4.8 Web workspace — **36%**
**Real:** ~31k disciplined lines covering most of the SoT screen inventory; **the Review→Approve card implemented correctly** (Approve not *mounted* until Read-review expands); i18n genuinely done (2,642 ICU messages, two independent gates); tokens-only colour with a lint gate; contract path built and tested (generated client + Zod + MSW); bundle inside the 250KB budget (6KB headroom); as of today, jsx-a11y + react-hooks enforced with a clean sweep.
**Missing:** **the wiring** — one read endpoint exists and defaults off; every screen runs on ~1,700 lines of synthetic generators; no auth/login; chat is a regex classifier, not a model, with no streaming and no aria-live; Review→Approve is client-side only (nothing posts to the proposal spine); error states with NT- codes rendered nowhere; the SoT §13.3 context header absent.

### 4.9 OTP portal + LAW packages — **15%**
**Real:** portal UI shell with real camera capture, format/size rejection, editable-overlay component, OTP-challenge screens; contracts pass 1 (1,986 lines, 14 operations) wired into both apps with negative-tested invariant checkers (money-int, single-execute-op, enum parity).
**Missing:** **the portal is not a separate build entry** (explicit D37 requirement — `vite.config.ts` says so itself); OTP is decorative (any code verifies); upload bytes never leave the browser; no server side; contracts passes 2–4 unwritten (auth, chase/portal, banking/approvals/publishing/exports); `component-grammar`, `tokens`, `validators`, `ui` packages all **zero source files** — the values live in apps/web, not in the LAW packages the SoT names as the contract.

### 4.10 Testing estate — **22%**
**Real:** ~430 api test cases incl. 9 real-DB integration suites under RLS-as-nt_app; the blocking 30-assertion SQL tenancy suite; 190+ web test cases on the money/date/matching logic; a CI honesty framework that auto-arms missing stages.
**Missing:** e2e **0** (no Playwright anywhere); evals **0** (no gold datasets, no injection corpus — the named mitigation for the SoT's two top risks); money property tests (fast-check absent); adapter cassettes; visual regression; k6 load profiles; coverage not even measured (no floors, no ratchet).

### 4.11 Third-party rails — **22%** (post-today adjustments included)
Levels (0 absent → 4 production-ready): **WhatsApp webhook 3** (sandbox-verified, now on a real queue), media fetch 2 (token not issued), business verification **0 — blocked on buying the Twilio UK number**; **SES inbound 3** (live receipt rule → S3; poller code real, service not deployed), **SES outbound: production access granted today, no sending client exists**; **Twilio 1** (env slots only — no client code, and it gates the flagship); TrueLayer 1; Xero 1; QBO 1; Companies House 1; HMRC 1. The four long-lead production clocks the SoT ordered started at W0 show no completion evidence.

### 4.12 Compliance + observability (app side) — **17%**
**Real:** i18n gates; RFC 7807 problem+json with stable NT- codes at every real boundary; traceId propagation through the queue; webhook HMAC; idempotency keys on the mutation surface that exists; 30-day log retention + security headers at the edge.
**Missing:** audit **writer** (no hash-chain code, no pseudonym map); retention jobs (zero scheduled jobs exist); DSR export/erasure tooling; DPIA/ICO artefacts and breach runbook absent from docs/; structured JSON logging (**found bug: infra's error-metric filter parses JSON but the app logs text — that alarm can never fire**); OTel, Sentry, app metrics, rate limiting, app-emitted CSP, runbook pages per NT- code: all absent.

### 4.13–4.14 Infra **75%** / CI-CD **85%** — detailed in §2. Infra loses points only for scheduled Slice-C items (prod apply, AMP/AMG, ClamAV service, Unleash server, hostname move); CI loses points for stage 6/7 having no suites to run and the plan-gated prod reviewer.

---

## 5. Delivery log & velocity (from the PR/issue/commit record)

**Span:** first commit 13 Aug 18:25 → 17 Aug (4.9 calendar days). **People:** Shakib (51 PRs, 58 commits), Abdullah (12 PRs, 12 commits) — before today's five.

| Day | PRs merged | Issues opened | Issues closed | Commits | Active span |
|---|---:|---:|---:|---:|---|
| Wed 13 Aug | 6 | 3 | 1 | 6 | 2.5 h |
| Thu 14 Aug | 22 | 22 | 24 | 24 | 19.9 h |
| Fri 15 Aug | 10 | 8 | 4 | 7 | 18.3 h |
| Sat 16 Aug | 10 | 12 | 5 | 19 | 12.2 h |
| Sun 17 Aug | 14+ | 1 | 12 | 14+ | in progress |

- **67 PRs total (incl. today's #108–#112): 66 merged, 0 abandoned.** Median PR size 310 lines (the < 400 discipline mostly holds); five outliers were imports/scaffolds (#68 frontend import 32.5k, #6 infra 22.8k, #93 i18n extraction 15.1k).
- **Issues: 46 opened, 46 closed, `0 open`.** The tracker is *empty* — which means the outstanding work in §4 is currently **untracked**. That violates "issue first" (Guideline §3) the moment anyone starts a branch tomorrow. First housekeeping move: file the next wave of issues from this report.
- **Commit types:** 34 feat · 18 fix · 8 docs · 8 chore · 1 refactor. **CI health:** 93% success on completed `check` runs; terraform 100%.
- **Code volume:** 444 tracked files, ~90k lines (excl. lockfile): apps/web 40.5k · apps/api 17.6k · infra 17.7k · prisma 5.2k · docs 3.4k · packages 3.2k · .github 1.7k · **e2e + evals + services/extraction: 74 lines combined (scaffolds)**.

---

## 6. Time forecast

**Model.** 22% in ~4.5 working days ⇒ ~4.9%/day at sprint intensity. Three discounts apply to the remainder: (1) the cheap points are gone — imports, scaffolds and schema bought early percentage that has no analogue in the remaining 78%; (2) the remaining work is integration-shaped (auth engine, model runtime, adapters, evals) where parallel lanes converge and review becomes the bottleneck; (3) the current 12–19 h/day cadence is not a planning number. Sustainable estimate: **1.5–3%/day** with both engineers (+agent lanes) active.

| Milestone | Optimistic | **Realistic** | Conservative |
|---|---|---|---|
| Core loop live on staging (ingest→extract→code→match→chase→approve→publish, sandbox) — the original Day-7 bar | 5 Sep | **12–19 Sep** | 30 Sep |
| Feature-complete v1 (all §2 scope, evals green, e2e suite real) | 10 Oct | **24 Oct – 7 Nov** | 21 Nov |
| **v1 pilot-complete (SoT W14 target: 19 Nov)** | 7 Nov | **19 Nov – 12 Dec** | mid-Jan 2027 |

**What actually decides which column you land in — external clocks, not typing speed:**

| Clock | Status today | Why it gates |
|---|---|---|
| Twilio UK sender registration + UK virtual number | No completion evidence; number not bought | Gates the flagship (real SMS) **and** Meta verification |
| Meta business verification | **Not started** (blocked on the number) | Gates live WhatsApp intake |
| TrueLayer production review | Conversation opened at kickoff; no evidence since | Gates real bank feeds (statement upload is the designed fallback) |
| ICO registration + DPIA | Not in the repo; G2 forbids real data until done | Gates the pilot itself |
| Pen test (booked by W8 ≈ 8 Oct) | Not booked in any doc | Gates pilot exposure |
| Labelled UK document corpus (≥500 docs) | 0 documents exist | Gates W2 calibration → extraction thresholds → the trust bar |
| Dedicated AWS accounts (Cloudvisor) | Requested | Gates the DPIA's isolation story |
| GitHub plan upgrade | Deferred deliberately | Gates branch protection + prod one-click promote |

**Budget note:** the $8,000/6-month envelope assumed prod stands up ~Oct. Today's spend shape (staging ≈ $150/mo) is on-profile. A December pilot slip pushes ~6 weeks of pilot-grade prod burn (~$1,300/mo) past the pot's horizon — re-check Appendix B if the conservative column materialises.

---

## 7. Top risks & the next ten moves

**Risks, ranked:**
1. **The eval estate is empty** while being the SoT's named mitigation for its two highest-severity risks (extraction accuracy, prompt injection). Every day of pipeline building without the harness increases rework risk.
2. **Auth/S1 is the universal blocker** — the Review→Approve engine, OTP portal, chase links, and unfreezing staging's scoped endpoints all wait on it. It is one person's lane (Shakib) and competes with infra + review load.
3. **Routing runs on an empty sender map** — as built, 100% of production email/WhatsApp lands Unrouted; the product would be a manual-assignment inbox.
4. **The frontend integration cliff**: 31k lines of UI on synthetic data, one flag-gated read endpoint. S4-style wiring (auth first, then screen-by-screen) is 2–4 weeks nobody has scheduled since the sprint plan's D5–6 slot passed.
5. External clocks (§6) — several show zero movement since kickoff day.
6. **Zero open issues** = the remaining 78% is untracked work; the board no longer reflects reality.
7. Single-reviewer bottleneck: 51 of 63 pre-today PRs authored by the same person who holds final merge authority on everything.
8. LAW packages empty while their values live in apps/web — every day widens the migration.

**Next ten moves (in order):**
1. Click the 3 SNS confirmations (2 min).
2. File the issue wave from §4's "missing" lists — restore issue-first discipline.
3. **S1: the ActionProposal engine** (controller/service for the already-contracted spine + audit writer) — it unblocks four other lanes.
4. **Start the labelled corpus + eval harness** (even 100 docs + the injection mini-corpus turns CI stage 7 on).
5. `DocumentExtractor` + Textract binding + fixture corpus (`services/extraction` lane) — nothing leaves RECEIVED until this exists.
6. Buy the Twilio UK number, submit sender registration, then Meta verification — the longest clocks, all idle.
7. Sender-identity routing map (contacts → routing) so documents stop landing Unrouted.
8. Email-intake ECS service + qpdf Dockerfile flip (finishes the last two fixture switches).
9. Auth: Argon2 + sessions + TOTP + `SessionContextResolver` — un-errors staging's scoped endpoints and unlocks web wiring.
10. Begin S4-style frontend wiring behind `VITE_API_ENABLED` screen by screen (documents list first — it already works).

---

## 8. Appendix — sources & method

- **Sector audits:** 12 parallel auditors (one per sector), each reading the SoT/Governance sections + module code + module CLAUDE.md, scoring v1 scope only, harsh rules (scaffold ≈ 0; "built-but-not-wired" discounted; absence claims grep-verified).
- **History dataset:** GitHub API (63 PRs, 46 issues, 100 runs) + git log on `main` (70 commits), collected ~10:15 UTC today.
- **Live verification:** AWS (ECS task definitions/revisions/events, CloudWatch logs, SNS, SES account, Service Quotas) and GitHub (environments, variables, runs) — not repo docs.
- **Known measurement caveats:** sector boundaries overlap slightly (the archive executor is credited in two sectors; dedupe sits in ingestion); web bundle numbers are the module CLAUDE.md's own measurements; the rails audit predates today's ingest flip and SES grant (adjusted +2 in §3).
- **Today's infra/CI work:** PRs #108, #109, #110, #111, #112 — all merged, applied, and verified (infra against live ECS/edge; lint against full green suites); plus repo variable `TERRAFORM_AUTO_APPLY`, GitHub environment `prod`, and the SNS subscriptions.

*— End of report —*
