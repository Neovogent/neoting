# exports-public-api

**Lane L** · **Source of Truth:** SoT §4 Stage 10, §15 · **Owner:** see the project board

## Purpose

CSV/XLSX/PDF/ZIP exports, admin-defined custom mappings, the public REST API, and signed webhooks.

## ⚠ Initial Delivery (ID) — read this before the sections below

**In ID this module is the ONLY way data leaves the product** (D42, SoT §24.3). There is no ledger adapter and no auto-publish, so the export is not a convenience feature here — it is the delivery.

- **The first client uses VT Software (VT Transaction+), so VT is the primary emitter and it gates the release** — not an afterthought, and not a generic CSV someone maps by hand. Build the export as a **canonical model plus per-target emitters** so VT is one emitter and not the architecture.
- **D43 is the acceptance test for the whole release:** every exported transaction carries a **resolvable link to its source document**, and the requirement is written on the *outcome*, not the mechanism. The accountant must get from a line in their accounting software to the document. SoT §24.3.2 specifies a four-rung fallback ladder in advance — read it before choosing an approach.
- **Known constraints, already researched — do not rediscover them the hard way:** VT’s import accepts **one nominal per row**, so a document spanning several nominals either collapses or splits; decide deliberately. Target reference fields are short and **truncate without warning** (one clips at 30 characters, another at ~25), so a link must survive that budget. Three of the five export targets cannot accept line items at all.
- **The public REST API and signed webhooks are v1, NOT ID** (SoT §24.6). Do not build them into the ID lane.
- **Capability URLs leave our control by design** — they sit inside a third party’s software. Unguessable per-document tokens, view-only scope, revocable, access-logged, expiry configurable per practice (SoT §21).

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- The public API is this same API with scoped OAuth clients — no second door to maintain. Large exports generate async into a download centre.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

## Tests

```bash
pnpm --filter @neoting/api test -- exports-public-api
```

## Current state

**Skeleton only.** Created by the S0 scaffold; no implementation yet.

## TODO

- [ ] Await the frozen OpenAPI contract for this module's endpoints (SoT §24 names four
      missing OpenAPI surfaces this release needs — a LAW change, contract-change issue first)
- [ ] **ID-critical** — the canonical export model + the **VT Transaction+ emitter**
- [ ] **ID-critical** — the source-document link (D43) and its fallback ladder (SoT §24.3.2)
- [ ] Service + repository skeleton with Zod DTOs
- [ ] Unit tests for the logic above
- [ ] Update this file on exit — it is how the next session picks up
