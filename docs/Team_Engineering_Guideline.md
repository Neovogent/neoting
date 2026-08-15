# NEOTING — Team Engineering Guideline

**Version 1.2 · 15 August 2026 · Confidential**
*Changelog v1.0 → v1.1: kickoff-review feedback (11–12 Aug) folded in — G9 reserve review & merge authority (Mubashir, Shadman) with CODEOWNERS updated; G10 preview protection mandatory (§7.2, new R16); thin CI skips draft PRs (§8.7); companion references bumped (Governance v1.3, SoT v1.3).*
*Changelog v1.1 → v1.2: aligned to SoT v1.5 / Governance v1.5 — **D37** makes `apps/web` a Vite SPA, so §7.4 rule 1 (server components) is retired and replaced by the route-splitting rule that now carries the per-route budget; §7.2 Vercel setup and the API-mode variable renamed to `VITE_`; §7.4 rule 4 drops the library name per Governance §12.6. **D38** changes the palette values — rule 2 and R8 are unchanged, because the discipline was never about which colours.*
The working handbook for the four of us — plus two named G9 reserves. It sits **under** the Engineering Governance (v1.5) — governance is the law of the codebase, this is the law of the team and of the **bootstrap phase**. Where governance describes the funded target state (ECS, Terraform, full CI), this document says what we do *right now*, with free and disposable tools, so nothing blocks while approvals and spend are pending. Every rule here is written so that **app code runs unchanged when the real infrastructure arrives** — that is the test of whether we did bootstrap right.

This file lives at `docs/NEOTING-Team-Engineering-Guideline-v1.1.md`. Changing it is a PR reviewed by Shakib. New joiner? Read this first, then Governance §1.

---

## 0. Bootstrap-phase decisions (G-log — ratified into the Source-of-Truth decision log by reference: SoT v1.3, D29)

| # | Decision |
|---|---|
| G1 | **Free & disposable until Infra Week.** Development runs on: local Docker Compose (canonical), Vercel previews for `apps/web`, GitHub for repo + thin CI, optional Neon/Upstash free tiers for shared throwaway services. AWS, Terraform, ECS, Grafana, Sentry, and the full CI pipeline (Governance §14) are **deferred, not skipped**. Everything disposable can be deleted any day without losing anything. |
| G2 | **Synthetic data only, everywhere, during bootstrap.** No real customer data, no real personal data, on any laptop or any free-tier service — ICO registration and the DPIA aren't done yet, and free tiers make no residency promises. The seed dataset and the team-collected corpus (personal data stripped) are the only data that exist. |
| G3 | **Thin CI now:** typecheck + lint + unit tests on every PR (GitHub Actions free tier, ~10 min to set up, zero maintenance). The full nine-stage pipeline, e2e-in-CI, evals-in-CI, security scans, and deploys activate at Infra Week. |
| G4 | **Squash-merge to a protected `main`.** PR titles must be valid conventional commits, because the squash commit takes the title. Repo is private on **GitHub Team** (kickoff 4.10) so branch protection + CODEOWNERS are enforced, not honour-system. |
| G5 | **Review chain:** Moyen → Shamim · Abdullah → Shakib · Shamim → Moyen (code) with Shakib on anything architectural or contract-touching · Shakib → Abdullah (four-eyes applies to the lead too; exception: `chore/infra` PRs may self-merge with a note). **Shakib holds final merge authority repo-wide** and can revert anything with a stated reason. |
| G6 | **Vercel is a viewing tool, not hosting.** Preview deployments per PR + one standing dev URL from `main`. Production hosting remains D23 (ECS, eu-west-2) — unchanged. Vercel gets deleted or demoted the day the real target is live, and nobody will miss it. |
| G7 | **Contracts are law even in bootstrap.** `packages/contracts`, `component-grammar`, `tokens`, `validators`, and `prisma/` change only via a contract-change issue approved by Shakib before the PR is opened. |
| G8 | **Infra Week trigger:** legal entity + AWS spend approved → Shakib executes Governance §14 + Terraform within one week. The deferral list in §8.5 flips off. App code must not change — if it has to, we broke G1. |
| G9 | **Reserve review & merge authority (no single point of failure).** If a default reviewer (G5) is unavailable > 24 working hours — OOO, sick, unreachable — finals fall to the named reserves: **frontend → Mubashir, then Shadman; backend → Mubashir, with the Claude review bot on the PR as assist**. The bot's review is *evidence, never the approval*: merge requires all checks green + a clean Claude review + the reserve's explicit human approval, and the approver owns every line merged (§1 rule, unchanged). **G7 LAW paths (contracts, grammar, tokens, validators, prisma, infra) freeze until Shakib returns**, unless he pre-delegated in writing. Shakib retro-reviews everything merged under G9 within 48 h of return. Reserves are listed in CODEOWNERS so branch protection enforces this, and they hold standing GitHub + Vercel access from day one — access granted during an emergency is not an emergency plan. |
| G10 | **Preview deployments are protected, always.** Vercel Deployment Protection (Vercel Authentication) is enabled before the first preview ships; every preview URL requires login. "Unguessable" is not protection — a leaked preview URL stays publicly reachable and indexable. An unprotected preview is treated like a leaked credential (take it down immediately) and is an instant reject (R16). If a plan tier ever puts protection behind a paywall: pay, or the surface dies — never run open. |

---

## 1. The team

| Person | Role | Owns (paths) | Default reviewer |
|---|---|---|---|
| **Shakib** | Tech Lead — backend, infra, CI/CD, releases, final merge authority | `apps/api` (lead) · `prisma/` · `services/extraction` · `packages/contracts` · `packages/validators` · `infra/` · `.github/` | Abdullah |
| **Abdullah** | Backend engineer | Assigned `apps/api` modules **end-to-end** (code + tests + the module's `CLAUDE.md`); assignments live on the project board | Shakib |
| **Shamim** | Frontend lead — owns `apps/web` architecture, splits work to Moyen | `apps/web` · `packages/ui` · component-grammar **render side** · tokens consumption | Moyen (code) / Shakib (contracts, architecture) |
| **Moyen** | Frontend engineer | Tasks assigned by Shamim inside `apps/web` + `packages/ui` | Shamim |
| **Mubashir** | Reserve reviewer (G9) — first reserve, frontend and backend finals | — (activates only under G9) | — |
| **Shadman** | Reserve reviewer (G9) — second reserve, frontend | — (activates only under G9) | — |

`.github/CODEOWNERS` (enforced by branch protection):

```
# Reserves (G9): listed so branch protection accepts their review when the
# default reviewer is away; G9 governs when they may use it. LAW paths stay
# Shakib-only — they freeze under G9.
/apps/web/                 @shamim @mubashir @shadman
/packages/ui/              @shamim @mubashir @shadman
/apps/api/                 @shakib @mubashir
/prisma/                   @shakib
/services/extraction/      @shakib @mubashir
/packages/contracts/       @shakib
/packages/component-grammar/ @shakib @shamim
/packages/tokens/          @shakib @shamim
/packages/validators/      @shakib
/infra/ /.github/          @shakib
```

**Claude Code rule:** anyone may use Claude Code inside their lane — but **you own every line you merge, regardless of who or what wrote it**. "The agent did it" is not a review response. Agent-generated PRs follow every rule in this document, no exceptions.

---

## 2. One repo, one map

Monorepo (pnpm + Turborepo) — full layout in Governance §1.2. The short version of who lives where:

```
apps/web            → Shamim & Moyen        (Vite + React: (workspace) + (portal) separate build entries)
apps/api            → Shakib & Abdullah     (NestJS modular monolith)
packages/contracts  → LAW — Shakib approves  (OpenAPI + generated clients + Zod schemas)
packages/component-grammar → LAW            (chat card schemas incl. Review→Approve)
packages/tokens     → LAW                   (design tokens — no hex codes anywhere else)
packages/validators → LAW                   (VAT arithmetic, VRN, dates, currency)
packages/ui         → Shamim                (shared components on tokens + grammar)
prisma/             → Shakib                (schema + RLS — contract-change process)
services/extraction → Shakib                (DocumentExtractor + eval harness)
infra/ .github/     → Shakib                (dormant until Infra Week, except thin CI)
docs/               → everyone              (this file, ADRs, runbooks)
```

Frontend and backend meet **only** through `packages/contracts` and `packages/component-grammar`. Nobody imports across `apps/`. If you need something from the other side, you need a contract change (G7), not a reach-around.

---

## 3. Daily workflow — everyone

1. **Issue first.** Every branch traces to a GitHub issue with acceptance criteria and an area label (`api` / `web` / `ui` / `contracts` / `repo`). No issue, no branch. Shamim files and assigns frontend issues; Shakib files and assigns backend issues.
2. **Branch from fresh `main`:** `type/area-short-description` — e.g. `feat/api-email-routing`, `fix/web-chase-card-focus`, `chore/repo-eslint-rules`. Types: `feat` `fix` `chore` `refactor` `docs` `test` `perf` `ci`.
3. **Push early, push often.** Open a **draft PR from your first push** — visible work is reviewable work. Never push to `main` (it's protected anyway). Never force-push after review has started; push new commits instead — squash-merge erases the mess at the end.
4. **Rebase on `main` before marking ready.** Resolve your own conflicts.
5. **Keep at most two active branches per person.** Finish things.
6. **Non-interactive everything:** no watch modes in scripts, no TTY prompts, seeds and tests runnable by anyone from a fresh clone.

---

## 4. Commit messages

Format — **Conventional Commits**, enforced by commitlint in the thin CI:

```
type(scope): imperative subject, lowercase, no period, ≤ 72 chars

Optional body: wrap at 72, explain WHY, not what — the diff shows what.

Closes #123
```

Types as in §3. **Scope = module or area:** `ingest`, `chase`, `publish`, `rules`, `web`, `portal`, `ui`, `contracts`, `tokens`, `repo`.

| ✅ Good | ❌ Rejected |
|---|---|
| `feat(chase): group SMS composition per client` | `update code` |
| `fix(web): restore focus after review card closes` | `fixed bug` |
| `refactor(ingest): extract MIME sniffing into pipeline step` | `feat: lots of changes to ingestion and also fixed the chase thing` |
| `chore(repo): add commitlint to thin CI` | `WIP` *(fine on a draft branch, never in a merged title)* |

One logical change per commit. Review-feedback commits can be scrappy (`fix review comments`) — squash erases them. **The PR title is what survives**, so it must be a perfect conventional commit.

---

## 5. Opening a pull request

1. Linked issue, branch per §3, rebased on `main`.
2. **Self-review your own diff line by line first.** Half of all review comments die here.
3. Target **< 400 lines of diff** (generated files and lockfiles excluded — mark them in the description). Bigger? Agree the split with your reviewer *before* opening, or open stacked PRs.
4. Fill the template — completely. Empty sections read as "I didn't check."
5. All checks green **before** requesting review. Red checks = the PR doesn't exist yet.
6. **UI PRs:** Vercel preview link (auto-commented) + phone screenshots, light **and** dark, all four states (empty / loading / error / success) where the change touches them.
7. **API PRs:** test evidence — the new/changed tests, and for endpoints a request/response sample.
8. Mark ready → request your chain reviewer (§1). **Review SLA: 24 working hours.** Blocked longer → tag Shakib (or the G9 reserve when Shakib is the one away).
9. Address comments with new commits, re-request. Approved → **author squash-merges**, deletes the branch.

`.github/pull_request_template.md`:

```markdown
## What
One sentence. Closes #___

## Why
The problem this solves, in the product's terms.

## How verified
- [ ] typecheck / lint / unit green locally
- [ ] Tests added/updated for changed logic
- [ ] UI: preview link + phone screenshots (light+dark, states) below
- [ ] API: request/response sample or test evidence below
- [ ] Module CLAUDE.md updated (backend) / i18n keys added, no literals (frontend)

## Contract change?
- [ ] No
- [ ] Yes — approved contract-change issue: #___

## Screenshots / evidence
(paste here)
```

---

## 6. The bar — why a PR gets accepted or rejected

This is the shared review standard. Shamim applies it to Moyen, Shakib applies it to everyone, and it applies to Shakib. It is deliberately mechanical: if none of the reject conditions fire and the DoD holds, the PR merges — no taste-based gatekeeping, no moving targets.

**Instant reject (fix and resubmit — not a discussion):**

| # | Condition | Why it's fatal |
|---|---|---|
| R1 | Any check red | The robot already told you. |
| R2 | Secrets, tokens, `.env*`, or credentials in the diff | One leak costs more than the feature. Rotate immediately if it happened. |
| R3 | Hand-edited lockfiles or generated files | They're generated for a reason. |
| R4 | No linked issue | Untracked work is invisible work. |
| R5 | Money as float, anywhere | Governance §1.7. Integer pence or nothing. |
| R6 | Prisma query outside `scopedDb` | A tenancy leak waiting to happen (Governance §5.2). |
| R7 | State change bypassing the ActionProposal path | The Review→Approve contract is the product (Governance §10). |
| R8 | Hardcoded user-facing strings or raw hex colours | i18n and tokens are law (Governance §12.6, G7). |
| R9 | `console.log` / `debugger` / commented-out code left behind | Ship code, not archaeology. |
| R10 | Contracts / grammar / tokens / validators / prisma changed without an approved contract-change issue | G7. Contracts move first, code follows. |
| R11 | Force-pushed after review started | You just destroyed the reviewer's context. |
| R12 | Unrelated changes mixed in ("while I was there…") | Each PR is one reviewable idea. Split it. |
| R13 | New dependency without the justification block (purpose, license, maintenance, size) | Governance §19. |
| R14 | UI PR without preview link + screenshots | "Trust me it looks fine" is not evidence. |
| R15 | Changed logic without changed tests | Untested logic is unowned logic. |
| R16 | Preview deployment without Deployment Protection enabled | G10. An open preview URL is a leak, not a demo. |

**Will approve when** (the DoD, per side — details in §7.6 / §8.6): checks green · tests present · contracts respected · evidence attached · size sane · module `CLAUDE.md` / i18n obligations met · description honest about anything unfinished (an honest `# BOOTSTRAP` shim with an issue link is fine; a hidden one is an R-condition next time it's found).

**"Split this" requests are not rejections.** They mean the work is good but the unit of review is wrong. Expect them any time a PR does two things.

---

## 7. PART A — Frontend (Shamim & Moyen)

### 7.1 How the two of you work
Shamim owns the architecture of `apps/web` — route groups, the chat framework rendering, the Review→Approve card mechanics, data-layer patterns — and splits scoped tasks to Moyen as GitHub issues with acceptance criteria and a Figma/state reference. Moyen owns each assigned task end-to-end (component + states + tests + i18n keys) and never merges without Shamim's approval. Shamim escalates to Shakib before touching anything under G7, and for any pattern decision that future PRs will copy.

### 7.2 Vercel — the development viewing surface (G6)
One-time setup (Shamim, ~20 minutes):
1. Vercel account (Hobby, free) → **Import** the GitHub repo → **Root Directory: `apps/web`** → framework preset **Vite**, pnpm auto-detects from the lockfile.
2. **Ignored Build Step:** `npx turbo-ignore` — previews only rebuild when `apps/web` or its dependencies actually changed. Saves the free-tier build minutes.
3. Environment variables (Preview + Development): `VITE_API_MODE=mock`. **Nothing secret ever goes into Vercel** — the frontend needs no secrets, and that's by design.
4. Enable **Deployment Protection (Vercel Authentication)** so every preview URL requires a Vercel login — **mandatory before the first preview ships (G10, R16)**; add the four of us plus the G9 reserves. "Unguessable" is not protection: a leaked preview URL stays publicly reachable and indexable. If any plan change ever puts protection behind a paywall, we pay for the tier or the surface dies — an unprotected preview never ships.
5. Done. Every PR now auto-comments its preview URL; `main` maintains one standing dev URL for Friday demos.

Rules of the surface: it renders **synthetic data only** (G2); it is **not** the product and never gets a real domain — production hosting is D23 (ECS) and does not change; reviewers open previews **on a real phone** (the Moto-G-class device from kickoff 5.1 lives on Shamim's desk). Honest ToS note: Vercel's Hobby tier is for non-commercial use — fine for private throwaway previews now; the moment anything customer-facing or demo-to-prospects happens on it, we either pay for Pro or it's already Infra Week and the point is moot. Shamim flags it, Shakib decides.

### 7.3 Mock-first development — never blocked on backend
`packages/contracts` generates two things from the OpenAPI spec: the **typed API client** and **MSW mock handlers** with fixtures shaped like the seed dataset. `VITE_API_MODE` selects:
- `mock` — MSW intercepts everything; the default on Vercel and for pure-UI work.
- `local` — talks to `pnpm dev` NestJS on localhost; use when verifying against a real endpoint.

The consequence: **frontend starts building any screen the moment its contract exists**, days before the endpoint does. When the contract changes, regeneration breaks the build loudly — that's the system working. Never hand-write an API type; never `fetch` raw in a component (data flows through the generated client + TanStack Query; client components receive data or use Query for polling/streaming only).

### 7.4 Code rules (the frontend ten)
1. **Route-split every top-level area** (lazy import + suspense boundary), and **keep the practice app out of the `(portal)` build**. This replaces the server-components rule retired by D37, and it inherits its job: rule 8's per-route budget and the portal being the lightest surface in the product are now produced by this rule alone. A route over budget is a reject.
2. **Tokens only** — no hex, no arbitrary px; the lint rule is not a suggestion.
3. Chat renders **component-grammar primitives only** — no bespoke chat UI outside the grammar; if the grammar lacks a card you need, that's a G7 contract conversation, not a one-off `<div>`.
4. Every user-facing string through the message catalogues (en-GB); the lint rule blocks literals. Governance §12.6 fixes the rules; the library is an implementation choice since next-intl was retired with App Router.
5. All four states designed per screen: empty (teaches), loading (skeletons, no spinners on primary surfaces), error (plain English + `NT-` code), success.
6. Accessibility habits on every PR: full keyboard path, visible focus, `aria-live="polite"` on chat updates, contrast from tokens, error text never colour-only. Run axe DevTools locally before requesting review.
7. Motion by the numbers (SoT §14): 120–150 ms micro, 200–250 ms cards, one mover at a time, `prefers-reduced-motion` respected, animation never delays input.
8. Performance budget: < 250 KB gzipped JS per route — read the `next build` output on every PR; the **(portal)** route group is the lightest surface in the product and takes no heavy dependencies, ever.
9. Optimistic UI with rollback toasts for approve/submit-style actions; the Approve button literally cannot render before Read-review opens (the grammar enforces it — don't work around it).
10. Component tests (Vitest + Testing Library) for anything with logic; Playwright smoke runs locally during bootstrap (CI at Infra Week).

### 7.5 What frontend explicitly does not do in bootstrap
No auth wiring against real providers, no real API keys, no analytics/tracking snippets, no Sentry, no experiments with alternative UI kits. Boring on purpose.

### 7.6 Frontend Definition of Done
Checks green · states ×4 shown · preview link + light/dark phone screenshots · axe pass · i18n keys (no literals) · tokens only · component tests for logic · issue closed by the merge.

---

## 8. PART B — Backend & Infra (Shakib & Abdullah)

### 8.1 How the two of you work
Shakib owns architecture, `auth-tenancy`, RLS, contracts, releases, and (come Infra Week) everything under `infra/`. Abdullah owns assigned modules **end-to-end** — code, Zod boundaries, tests, seed updates, and the module's `CLAUDE.md` — with assignments visible on the project board. Abdullah stops and asks Shakib **before**: schema beyond additive fields · anything auth/permissions/RLS · deleting or migrating data · a new dependency · a contract change · anything touching SMS sending logic. (Same list as Governance §1.6 — it applies to humans, not just agents.)

### 8.2 Local is canonical
`docker compose up` (Postgres, Redis, MinIO, MailHog) + `pnpm db:migrate && pnpm db:seed && pnpm dev` is the one true environment. The smoke test (`pnpm e2e:smoke`) must pass on a fresh clone before any PR — if it fails on fresh clone, the environment is broken, not the developer, and fixing it is the day's first priority.

### 8.3 Optional shared disposables (when frontend needs a live API without running compose)
Neon free tier (Postgres 16, EU region) + Upstash free Redis, seeded with the synthetic dataset, connection strings in the team password manager (kickoff 5.3) — **never committed**. Rules: synthetic data only (G2) · may be wiped without notice (treat as ephemeral — anything you'd miss belongs in a migration or the seed) · exists for demos and frontend `local`-mode testing, not as a crutch replacing compose. If nobody uses it for two weeks, delete it — that's what disposable means.

### 8.4 Keys, secrets, and shims during bootstrap
Sandbox keys only (Xero demo, Intuit sandbox, Twilio test, TrueLayer sandbox) — production keys don't exist yet and that's a feature. Local secrets in `.env` from `.env.example`; thin-CI secrets (if any) in GitHub Actions secrets; nothing in Vercel (§7.2). Any temporary workaround gets a `# BOOTSTRAP: <issue-link>` comment — grep-able, honest, and scheduled to die at Infra Week.

### 8.5 Deferred until Infra Week (G1/G8) — the flip list
Deferred **now**: Terraform apply · ECS/ECR · CloudFront + WAF · ElastiCache/RDS (real) · Managed Grafana/Prometheus · Sentry · full nine-stage CI (Governance §14) · e2e-in-CI · evals-in-CI · blocking security scans · deploy pipelines · Unleash server (use a local flags file with the same interface).
**Trigger (G8):** entity + spend approved → Shakib executes the flip within one week, working from Governance §14 and kickoff §3. The measure of bootstrap discipline: **zero application-code changes required** — only config and pipelines.

What is **not** deferred: the thin CI (G3), branch protection (G4), Zod at every boundary, `scopedDb`, integer pence, the ActionProposal path, untrusted-content wrapping, tests. Correctness was never a bootstrap luxury.

### 8.6 Backend Definition of Done
Checks green · Zod on every new boundary · queries through `scopedDb` · money in pence · tests for changed logic (property tests on money paths) · seed updated so screens stay honest · module `CLAUDE.md` updated · migration additive or via the contract process · no `# BOOTSTRAP` shim without an issue.

### 8.7 The thin CI (G3) — the whole thing
`.github/workflows/check.yml` — this is *all* the CI we run until Infra Week:

```yaml
name: check
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
concurrency: { group: ${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    if: ${{ !github.event.pull_request.draft }}   # drafts don't burn free-tier minutes
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint        # includes commitlint on the PR title
      - run: pnpm test        # unit only during bootstrap
```

Draft PRs skip CI by design — §3 says draft-from-first-push, and running the suite on every WIP push would burn the Actions free tier for nothing. Run `pnpm typecheck && pnpm lint && pnpm test` locally while drafting; the full check fires automatically the moment you mark ready (`ready_for_review`), and concurrency-cancel means rapid pushes to a ready PR only ever run the latest.

Branch protection on `main`: require the `check` status · require one code-owner review · no direct pushes · no force pushes · linear history (squash only).

---

## 9. Rituals & communication

- **Async daily, by 11:00, three lines** in the team channel: done / doing / blocked. Blocked > 2 hours → tag Shakib directly; blocked is a fire, not a status.
- **Friday demo, 30 minutes:** everyone shows working software — preview URL or local screen-share. Demos come from `main`, which is why `main` stays green.
- **Decisions that ate > 30 minutes of debate** get a 10-line mini-ADR in `docs/adr/` in the same PR — future-you will ask "why is it like this," and the answer should not be archaeology.
- **Issue hygiene:** an issue is ready when it has acceptance criteria and an area label; it's done when the PR that closes it is merged, not before.

---

## 10. Quick reference card (print this)

```
BRANCH   type/area-short-desc            feat/api-email-routing
COMMIT   type(scope): imperative ≤72     feat(chase): group SMS per client
PR       draft early · <400 lines · self-review · checks green · evidence attached
TITLE    must be a valid conventional commit (squash takes it)
REVIEW   Moyen→Shamim · Abdullah→Shakib · Shamim→Moyen/Shakib · Shakib→Abdullah
         away >24h → G9 reserves: Mubashir (FE+BE) · Shadman (FE) · LAW paths freeze
MERGE    author squash-merges after approval · delete branch
NEVER    push to main · force-push after review · float money · unscoped query ·
         secrets in diff · hex colours · hardcoded strings · bypass ActionProposal ·
         real data on anything disposable · unprotected preview
ALWAYS   issue first · synthetic data · sandbox keys · tokens · Zod · pence ·
         # BOOTSTRAP tag + issue on any shim
```

*— End of Team Engineering Guideline v1.1 —*