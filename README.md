# Neoting

Chat-first document-to-bookkeeping for UK accounting practices, by Neovogent.

A receipt arrives by photo, email, WhatsApp or upload. Neoting reads it, codes it against the client's own chart of accounts, flags duplicates, matches it to the bank feed, notices what's *missing* and chases the client by SMS with a no-app upload link, routes it through approvals, and publishes it to Xero or QuickBooks with the source image attached — driven from chat, with nothing changing state until a human presses Approve.

## Start here

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm dev
```

**Clone to running is a 10-minute target.** If a fresh clone fails, the environment is broken — not you — and fixing it is the day's first priority.

No cloud credentials are needed for core development. Extraction and AI default to fixture mode, so the whole pipeline runs offline.

## Repository map

```
apps/web              Next.js — (workspace) practice app · (portal) public OTP portal
apps/api              NestJS modular monolith
packages/contracts            LAW  OpenAPI spec + generated client + Zod schemas
packages/component-grammar    LAW  chat card schemas incl. Review → Approve
packages/tokens               LAW  design tokens — no hex codes anywhere else
packages/validators           LAW  VAT arithmetic, VRN, dates, currency
packages/ui           Shared components built on tokens + grammar
services/extraction   DocumentExtractor + eval harness + corpus tooling
prisma                LAW  schema + RLS policies + migrations
infra                 Terraform (AWS eu-west-2)
e2e                   Playwright: workspace, portal, tenancy
evals                 Gold datasets incl. the adversarial injection corpus
docs                  The source-of-truth pair, ADRs, runbooks
```

Frontend and backend meet **only** through `packages/contracts` and `packages/component-grammar`. Nobody imports across `apps/`.

## Documentation

| File | Read it when |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Before writing any code, human or agent |
| [`docs/Team_Engineering_Guideline.md`](docs/Team_Engineering_Guideline.md) | New joiner — read this first |
| [`docs/Engineering_Governance.md`](docs/Engineering_Governance.md) | The law of the codebase |
| [`docs/Source_Of_Truth.md`](docs/Source_Of_Truth.md) | What we are building and what we are not |
| [`docs/Sprint_1_Execution_Plan.md`](docs/Sprint_1_Execution_Plan.md) | What is happening this week |
| [`docs/AWS_Foundation_Runbook.md`](docs/AWS_Foundation_Runbook.md) | Anything touching AWS |

## Contributing

Issue first, branch `type/area-short-description`, draft PR from your first push, rebase before marking ready, all checks green before requesting review. The PR title must be a valid conventional commit — squash-merge takes it.

The review bar is deliberately mechanical (Guideline §6): if none of R1–R16 fire and the Definition of Done holds, it merges. No taste-based gatekeeping.

**You own every line you merge, regardless of who or what wrote it.**

---

Confidential. © Neovogent AI Solutions UK Ltd.
