# rules-suggestions

**Lane D** · **Source of Truth:** SoT §4 Stages 3-4 · **Owner:** see the project board

## Purpose

Four-tier rule engine, multiple conditional rules per supplier, natural-language rule parsing into Review-Approve cards, and AI coding suggestions with confidence and reasoning.

## ⚠ Initial Delivery (ID) — read this before the sections below

**There is no ledger-synced chart of accounts in ID** (SoT §24.2 Stage 3). D42 means nothing syncs a COA in, so rules and coding run against a **platform-side COA seeded from the business-type profile captured at intake**. That is a real reduction in available context, and §24.4 — the AI context pack — is the whole answer to it. Read §24.4 before writing coding logic; it is not background reading, it is the specification.

- **Rules run first, and they are not a fallback** (§24.4.2). The authority order below is unchanged and still absolute; ID leans on it harder, because the AI has less to go on.
- **Cold start is the named risk** (SoT §21): published evidence puts category accuracy around 79% where the category already exists, and it collapses on a brand-new client — which is exactly when the product is being judged. §24.4.7 states what accuracy is achievable and therefore **what may be claimed**; do not promise past it in UI copy.
- **§24.4.6 ranks what a coding error actually costs.** Review effort follows that hierarchy rather than treating every field as equally risky.
- **Document acceptability is a new task in this lane** (D46): is this the document that was asked for, and is it acceptable evidence for this business category? Flagged, **never blocked** — and every file in a batch is judged **individually**, because a batch is never one document.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Authority order is absolute: accountant rules, practice defaults, client context, learned history, then AI inference. The AI never silently overrides an explicit rule.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

## Tests

```bash
pnpm --filter @neoting/api test -- rules-suggestions
```

## Current state

**Skeleton only.** Created by the S0 scaffold; no implementation yet.

## TODO

- [ ] Await the frozen OpenAPI contract for this module's endpoints
- [ ] Service + repository skeleton with Zod DTOs
- [ ] Unit tests for the logic above
- [ ] Update this file on exit — it is how the next session picks up
