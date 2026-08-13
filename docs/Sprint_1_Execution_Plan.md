# NEOTING — Sprint 1 Execution Plan (7 Days)

**Version 1.1 · 13 August 2026 · Confidential**
*Changelog v1.0 → v1.1: aligned to the 13 Aug doc bump (SoT v1.3 · Governance v1.3 · Guideline v1.1 · Kickoff v1.2). Kickoff-date fold recorded as D29; §13.3 mandates wired in — provenance-class language + context header into the S0 contracts pre-freeze, context header into F0, next-actions queue as T2 in F9, provenance check in QA charter 8; AWS Budgets added to S3 (D33); §2 reflects R16, the draft-CI skip, and G9 reserves on the sprint clock; the D1 gate asserts a protected preview. No dates, tiers, or owners change.*
**Start: Thursday 13 August 2026, morning (BD time) · Sign-off: Wednesday 19 August 2026, 19:00 — sharp.**

Subordinate to the source-of-truth pair (v1.3) and the Team Guideline (v1.1); it changes no locked decision. It **resolved SoT open decision #1** — kickoff = 13 Aug 2026 — now folded into the decision log as **D29** (SoT v1.3). The 14-week map to pilot still governs everything after Day 7; this sprint executes its front half at Claude-Code speed.

## 0. The honest frame

- **The deadline is fixed, so scope is the variable.** Every module carries a tier: **T1** = integrated + QA'd by Day 7 (the core loop — non-negotiable), **T2** = built this sprint, integrated only if green, **T3** = parked on external clocks that no sprint can compress (Meta verification, Twilio sender registration, TrueLayer production review, pen test, pilot).
- **The drop rule:** at every 18:00 checkpoint, any T2 work endangering a T1 gate is parked on the spot, no debate. Parking is winning — a shipped core loop beats ten half-modules.
- **Contract freeze:** the four Sprint-0 contracts freeze at **Day 1, 14:00**. After that, contract changes batch at day boundaries only, signed by Shakib + the affected side. Contract churn is the #1 killer of parallel sprints.
- **What Day 7 is:** the full core pipeline live on staging with synthetic data — capture → extract → code → dedupe → bank match → chase → OTP portal → auto-close → approve → publish to Xero sandbox — driven from chat via grammar cards, tenancy suite green, injection mini-corpus 100% blocked, demo script clean twice.
- **What Day 7 is not:** live WhatsApp, real SMS sender, production bank feeds, QBO, pilot-ready hardening. Those ride the kickoff-checklist clocks (§7).
- **Days 3–4 are Saturday/Sunday.** Said out loud, planned as full days. Day 7 evening, everyone sleeps.

## 1. D0 — Wednesday 12 August (tomorrow): prerequisites or Day 1 slips

| # | Item (from Kickoff Requirements v1.2) | Owner |
|---|---|---|
| P1 | Spend + accounts approved: AWS org (eu-west-2) created, **Bedrock model-access requests fired** (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 — verification 8.1) | Shakib |
| P2 | GitHub Team org + repo + branch protection + thin CI secrets | Shakib |
| P3 | Vercel account ready for Shamim's Day-1 import | Shamim |
| P4 | Twilio account + **UK sender registration submitted** + Verify (test credentials work Day 1) | Shakib |
| P5 | **Meta business verification submitted** (WhatsApp is T2/T3 — but the clock starts now) | Shakib |
| P6 | TrueLayer sandbox account; production conversation opened | Abdullah |
| P7 | Xero + Intuit developer accounts, demo/sandbox companies | Abdullah |
| P8 | Companies House key + HMRC check-VAT-number app | Abdullah |
| P9 | DNS: `neoting.neovogent.com` delegated; SES identities + production-access request submitted | Shakib |
| P10 | Everyone: dev machine ready — Docker, Node 22, pnpm, Claude Code authenticated | All |

## 2. Operating model for the week

- **Claude Code + human, lanes model:** each human directs **2–3 agent lanes max**, one git worktree per module. The module `CLAUDE.md` is updated at **every** lane hand-off — it is how agents resume overnight and how humans stay oriented. Agents may run overnight **only** on lanes whose gates are green, and overnight output lands as **draft PRs** for morning review — drafts don't trigger CI by design (Guideline §8.7): agents run the suite locally, and the full check fires the moment a PR is marked ready. You own every line you merge (Guideline §1).
- **Sprint review SLA: 4 working hours** (not the normal 24). Two pair-review windows daily: 11:00 and 17:00. If a chain reviewer is sick or unreachable for a full sprint day, the G9 reserves (Mubashir · Shadman) activate on this same 4-hour SLA; G7 LAW paths still freeze for Shakib.
- **Two syncs, 15 minutes each:** 10:00 standup (done/doing/blocked) · **18:00 checkpoint** — the day's gate demos or the drop rule fires.
- All Guideline rules hold (branches, commits, PR template, R1–R16). Speed changes the SLA, never the bar — R5–R7 (pence, `scopedDb`, ActionProposal) are precisely the things a 7-day sprint is tempted to skip and must not, and R16 means no preview ever ships unprotected.
- **Freezes:** FE code-freeze on mocks — Day 5, 18:00 · feature freeze everywhere — Day 6, 18:00 · after that, fixes only.

## 3. Module inventory & tiers

### 3.1 Shakib — base, infra, AI/prompting, integration (the S-tracks)

| ID | Track | Contents | Tier | Days |
|---|---|---|---|---|
| S0 | **Base setup** | Repo scaffold (monorepo per Governance §1.2) · the four contracts (OpenAPI, schema+RLS, tokens, component grammar) + validator config · Docker Compose · seed dataset · thin CI + commitlint · **mock generation** (typed client + MSW from OpenAPI) · module skeletons for every NestJS module · PR/CODEOWNERS templates · **§13.3 into the contracts before the freeze:** tokens + component grammar carry the provenance-class language (human-confirmed · rule/validator · AI-suggested + confidence — visible by default) and the card trace-expansion affordance; the shell spec carries the persistent context header (user · role · client scope) — retrofitting these after 14:00 is a batched contract change, so they land now. **Contracts frozen 14:00.** | T1 | D1 |
| S1 | **Auth-tenancy + the constitution** | Argon2 + sessions + TOTP scaffold · SMS-OTP sessions (Twilio Verify test) · RLS policies + `scopedDb` + GUC pattern · **ActionProposal engine (Review→Approve, Governance §10)** · audit service (hash-chained). Everything depends on this — it lands before anything integrates. | T1 | D1–2 |
| S2 | **AI & prompting** | `models.ts` (three tiers + effort map, D28) · Bedrock client + Anthropic contingency switch · `DocumentExtractor`: Textract + **fixture mode** (lanes stay green if Bedrock access lags) + vision ladder rungs · prompts per task class (coding suggestion, addressee routing, rule parsing, chase composition, chase validation, chat) · grammar-emission service (model → schema-validated cards) · **mini eval harness + injection mini-corpus wired as a CI gate** · Transcribe glue (T2). | T1 (voice T2) | D2–5 |
| S3 | **Infra & CI/CD** | Terraform: **one staging environment** — RDS, ElastiCache, ECS (api + workers), S3/KMS, SES, CloudFront + basic WAF, secrets · **AWS Budgets** (org + per-account, 50/80/100% alerts — D33; the full §13.5 per-vendor telemetry is Infra Week) · CI deploy job to staging · domain/TLS wiring. Production is a post-sprint re-apply of the same modules. | T1 | D2–4 |
| S4 | **Integration** | D3 **canary**: wire ONE flow (upload → inbox) web↔staging to catch contract drift early · D5–6: auth wiring into web, `NEXT_PUBLIC_API_MODE` flip, screen-by-screen wiring checklist, env config, drift fixes. | T1 | D3 (canary), D5–6 |

### 3.2 Abdullah — backend logic & API exposing (the B-modules)

| ID | Module | Core contents (SoT §4) | Tier | Days |
|---|---|---|---|---|
| B1 | ingestion-routing | Web upload + auto-split · email-in parse (MailHog local / SES staging) · sender-identity → AI-addressee (S2) → **Unrouted queue** · sanitisation pipeline · WhatsApp webhook **simulator** (real channel = T3, Meta clock) | T1 (WhatsApp sim T2) | D1–2 |
| B2 | validation-dedupe | Processing/To Review/Ready states · mandatory-field config · **Rejected/Failed view API** · dedupe: byte-hash + field-rule nets T1; pHash + OCR-similarity + cross-type T2 · intentional-duplicate action | T1/T2 | D2–3 |
| B3 | rules-suggestions | Four-tier rule engine · conditional rules per supplier · NL-rule endpoint (consumes S2 parser) → rule-card proposals · corrections → one-tap rules · retro-apply | T1 | D2–3 |
| B4 | banking-matching | **Statement/CSV import (T1 bank source)** · normalised txn schema · match engine (exact + windows; credit-notes T2) · cash coding · TrueLayer sandbox consent flow T2 | T1/T2 | D3–4 |
| B5 | **chase** (flagship) | Five detection engines · composer (S2) → Review→Approve → Twilio-test SMS · signed links + OTP portal endpoints (upload, editable-overlay corrections, chase validation) · policy scheduler + suppressions · auto-close on matching inbound · item threads | T1 | D3–4 |
| B6 | approvals | Linear workflows, thresholds, lock-on-approve T1 · conditional branching T2 | T1/T2 | D4 |
| B7 | publishing | Canonical model · **Xero adapter** (bills + attachment + reference sync + idempotency) → demo company T1 · publish-preview totals · QBO T3 (post-sprint) | T1 | D4–5 |
| B8 | clients-team-settings | Client intake (Companies House pre-fill, VRN check) · client list/cards data · client-scoped AI grounding endpoints · minimal settings T1; full inventory + team/tasks T2 | T1/T2 | D2–5 (interleaved) |
| B9 | archive-search · notifications · exports | Archive semantics + entity-move T1 · pg full-text search T2 · email notifications T1 (SMS templates ready, real sender post-registration) · CSV/XLSX exports T1 · analytics T2 · vault T2 | mixed | D5 |

### 3.3 Shamim & Moyen — frontend on mocks (the F-modules)

| ID | Module | Owner | Tier | Days |
|---|---|---|---|---|
| F0 | Shell: scaffold, tokens wiring, workspace layout (sidebar + chat frame + **persistent context header — §13.3**), **Vercel import with Deployment Protection on before the first preview** (Guideline §7.2, G10) | Shamim | T1 | D1 |
| F1 | **Grammar renderer + Review→Approve card mechanics** ([Approve] unreachable pre-review — the product's heart) | Shamim | T1 | D1–2 |
| F2 | Auth screens: workspace login + TOTP · portal OTP entry | Moyen | T1 | D2 |
| F3 | Inboxes: Costs/Sales, three states, **Rejected/Failed view**, document preview + **editable extraction overlay** | Moyen (+Shamim on overlay) | T1 | D2–3 |
| F4 | Chat workspace: conversation, context bar, client picker, streaming, voice button (stub → T2 wiring) | Shamim | T1 | D2–4 |
| F5 | Clients: intake form (grammar), list table, 3:4 cards, client tabs | Moyen | T1 | D3–4 |
| F6 | Chase surfaces: composer review card, chases tab, dashboard counts · **OTP portal**: camera/file, client-side compression, editable overlay, mismatch feedback — lightest surface in the product | Shamim (portal) / Moyen (dashboard) | T1 | D3–4 |
| F7 | Bank: transactions, match cards, statement-import wizard | Moyen | T1 | D4 |
| F8 | Approvals UI · publish-preview cards · integration health | Moyen | T1/T2 | D4–5 |
| F9 | Archive/search, vault, analytics, settings screens · workspace-home **next-actions queue** (§13.3) | Both | T2 | D5 |
| F10 | Polish pass: states ×4 audit, a11y sweep (axe), motion numbers, i18n key sweep, budget check | Both | T1 | D5 |

---

## 4. The seven-day board

Each day ends at the **18:00 checkpoint** — the gate demos, or the drop rule fires on whatever endangered it.

| Day | Date | Shakib | Abdullah | Shamim | Moyen | 18:00 gate |
|---|---|---|---|---|---|---|
| **D1** | Thu 14:00 **contracts freeze** | S0 base (morning) → S1 auth/ActionProposal | B1 ingestion lanes | F0 shell + Vercel · F1 grammar | F1 support → F2 prep | Clone-to-running ≤10 min for all four · mocks generated · first grammar card renders on a **protected** Vercel preview (G10) |
| **D2** | Fri | S1 finish · S3 Terraform starts · S2 prompts begin | B1 finish · B2 · B3 · B8 intake | F1 finish · F4 chat | F2 auth · F3 inboxes | **Local demo: upload → extract (fixture) → coded → inbox states**, incl. Rejected/Failed |
| **D3** | Sat | S3 staging pieces · S2 Textract live (or fixture) · **S4 canary: upload→inbox wired web↔staging** | B4 banking · B5 chase starts | F4 · F6 portal | F3 finish · F5 clients | **Canary green on staging** · statement import → match locally · corpus ≥100 docs labelled |
| **D4** | Sun | S3 done: **CI deploys to staging green** · S2 eval gate wired | B5 chase done · B6 · B7 Xero | F6 portal done | F5 · F7 bank · F8 | **Flagship local: detect → compose → R→A → SMS(test) → OTP portal upload → auto-close** · **Scope gate #1: red T2 parked** |
| **D5** | Mon | S2 polish · **S4 integration begins** (auth wiring, mode flips) | B7 Xero publish to demo co. · B9 · bugfixes | F9 · F10 polish | F8 finish · F9 · F10 | **R→A publish lands in Xero demo with attachment** · **FE code-freeze on mocks 18:00** |
| **D6** | Tue | **S4 integration day** — every T1 screen wired to staging | Integration bugs (backend side) | FE fallout fixes | FE fallout fixes | **Feature freeze 18:00** · tenancy suite + injection corpus green on staging · QA charters start tonight |
| **D7** | Wed | QA lead + fixes | Fixes | QA + fixes | QA + fixes | Morning: 8 charters · triage (Sev-A fix now, Sev-B log) · 15:00 regression re-run · 17:00 demo ×2 clean · **19:00 sign-off** |

## 5. Integration plan (S4 — Shakib)

1. **D3 canary** (the drift detector): one real flow, web↔staging, days before the crunch. Any contract drift found here is a Day-3 problem, not a Day-6 crisis.
2. **D5–6 sequence:** wire auth + session first → flip `NEXT_PUBLIC_API_MODE` per screen, in T1 order: inboxes → chat → clients → chase/portal → bank → approvals/publish → rejected/failed → exports. A screen is "wired" when its happy path AND its error state render from real API responses.
3. Mock handlers stay in the repo — they're the frontend's permanent offline mode and the contract's living test double.
4. Every drift fix flows **through the contract** (regenerate both sides), never a hand-patched type. That rule is why integration is two days and not a week.

## 6. QA plan (D6 night → D7)

**Eight charters** (scripted passes, run on staging, synthetic data, two people per charter — one drives, one records):
1. Onboarding: practice signup → client intake (CH pre-fill) → client OTP onboarding end-to-end.
2. Ingest: web (auto-split) + email-in (identity route, AI route, **Unrouted queue**) → extract → editable overlay correction persists → Ready.
3. Dedupe: exact + field-rule nets → review verdicts → intentional duplicate.
4. Bank: statement import → match (exact + window) → cash coding → missing-paperwork detection (incl. suppression descriptors).
5. **Flagship:** chase composed → [Read review] shows every SMS verbatim → Approve → test SMS → OTP portal (wrong OTP ×5 lockout, forwarded-link delegated session) → upload → mismatch feedback → correct doc → **auto-close**.
6. Approvals + publish: linear workflow → lock-on-approve → R→A publish preview totals → lands in Xero demo with attachment → per-item history says who/how.
7. Adversarial: injection corpus documents through the full pipeline (100% inert) · tenancy probes (cross-practice, cross-client, portal-session overreach) all fail · Approve unreachable before Read-review (asserted in UI and API).
8. Truth surfaces: Rejected/Failed shows every failure with reason + retry · exports match on-screen totals · audit trail names every actor for everything done in charters 1–7 · every AI-suggested value wears its provenance class + confidence by default (§13.3).

**Severity bar:** Sev-A (breaks a T1 flow, tenancy, or Review→Approve) = fix before sign-off, no exceptions. Sev-B = logged with owner, post-sprint. **Sign-off = all eight charters pass + zero open Sev-A + the demo script runs clean twice.**

## 7. Parked at Day 7 (owners + clocks — the 14-week map resumes here)

Live WhatsApp (Meta verification — Shakib watching) · real SMS sender (Twilio registration — auto-swaps from test creds) · TrueLayer sandbox-if-slipped + production (Abdullah) · QBO adapter (Abdullah, next) · voice full wiring if T2-parked (Shakib) · full analytics/vault/team-tasks if T2-parked · pHash/cross-type dedupe if parked · load tests, pen test (booked per kickoff 5.2), Cyber Essentials, pilot onboarding · production Terraform re-apply (Shakib) · full D33 cost/usage telemetry — per-vendor dashboards + budget envelopes (Shakib, Infra Week, governance §13.5) · next-actions queue if T2-parked (Shamim). Nothing on this list is forgotten — it's all already in the Kickoff Requirements with owners.

## 8. The five sprint-killers, and the kill-switch for each

| Risk | Kill-switch |
|---|---|
| D0 prerequisites slip → D1 slips | The P-list (§1) is tomorrow's only job. Anything not done by Thursday 09:00 gets a fixture/simulator so lanes start anyway — external accounts gate *going live*, never *building*. |
| Contract churn after the D1 freeze | Changes batch at day boundaries, Shakib + affected side sign, both sides regenerate in one PR. An unbatched contract change is an R10 reject. |
| Bedrock access delayed | Fixture mode in `DocumentExtractor` + mock grammar-emission keep every lane green; Anthropic-API contingency (D22) flips by config the hour access lands. |
| Integration crunch anyway | The D3 canary exists precisely for this; if the canary bleeds, D4 reallocates Shakib to contracts full-time and the drop-gate fires early. |
| Human review becomes the bottleneck | 4-hour sprint SLA, the 11:00/17:00 pair-review windows, and agents fixing to green **before** requesting review. If Shakib's queue exceeds five PRs, Shamim absorbs frontend finals and Shakib keeps contracts + backend only. |

## 9. Day 7, 17:00 — the demo script (run twice, clean)

One take, no cuts: create a client (CH pre-fill) → onboard them by OTP on a real phone → forward a receipt to `doc@` → watch it route, extract, get coded → fix one field in the overlay → import a bank statement → the missing-paperwork engine finds the gap → compose the chase in chat → **[Read review]** shows the SMS → Approve → the phone buzzes → open the link, OTP, photograph the receipt, correct one number → the chase auto-closes → approve the item → **[Read review]** shows the publish totals → Approve → open Xero: the bill is there, source image attached → open the audit log: every step, every actor, hash-chained.

That is what "sharp 7 days" buys. Sleep on Day 7 night; the clocks in §7 keep running without us.

*— End of Sprint 1 Execution Plan v1.1 —*