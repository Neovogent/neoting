# chase

**Lane G** · **Source of Truth:** SoT §4 Stage 8 · **Owner:** see the project board

## Purpose

The five detection engines, chase composition, SMS with OTP secure links, the upload portal endpoints, the policy scheduler, and auto-close on matching inbound.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- The flagship. Every SMS is shown verbatim in review before sending. Chasing is SMS-only, but a client may reply through any inbound channel and that still closes the chase.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

## Tests

```bash
pnpm --filter @neoting/api test -- chase
```

## Current state

**Skeleton only.** Created by the S0 scaffold; no implementation yet.

## TODO

- [ ] Await the frozen OpenAPI contract for this module's endpoints
- [ ] Service + repository skeleton with Zod DTOs
- [ ] Unit tests for the logic above
- [ ] Update this file on exit — it is how the next session picks up
