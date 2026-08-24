# clients-team-settings

**Lane K** · **Source of Truth:** SoT §5, §7, §12 · **Owner:** see the project board

## Purpose

Client intake, the client list and cards, client-scoped AI grounding, team management, document-workflow tasks, and the full settings inventory.

## ⚠ Initial Delivery (ID) — read this before the sections below

**Client onboarding in ID asks for no connections at all** (D47, amending §5.1 and §6 for this release). Adding a client asks for **neither a bank connection nor an accounting-software connection** — both steps are skipped, because D40 and D42 mean neither exists yet. What intake must capture instead is the **business-type profile**, because §24.4 makes it the substitute for the chart of accounts this release does not have.

- **Two authorities, not one (D44).** Accountants and their team members compose and edit; only the accounting firm’s **super admin** releases. Team management must model that distinction, and it is enforced server-side (Governance §11.2).
- **A client may add their own team members** (D45), and those people may upload — but only they, and only through identity-gated channels.
- **Subscription is part of intake now, not deferred** (D48 supersedes D26): **€8.50 per month plus VAT, per client business, paid by the client**, asked for at the end of the client’s own onboarding. The price is quoted and stored **exclusive of VAT**; VAT is added at the prevailing rate and the displayed price must say which it is. **Money is integer pence — the VAT-exclusive figure is what is stored.** The payment provider is an open decision (SoT §22 item 10) and the currency question rides with it.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Every settings mutation passes Review to Approve and is audit-logged. Client-scoped AI answers only from that client's pipeline records, with record references.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

## Tests

```bash
pnpm --filter @neoting/api test -- clients-team-settings
```

## Current state

**Skeleton only.** Created by the S0 scaffold; no implementation yet.

## TODO

- [ ] Await the frozen OpenAPI contract for this module's endpoints
- [ ] **ID-critical** — intake without connection steps (D47) + the business-type profile
      that §24.4 grounds coding on
- [ ] **ID-critical** — subscription at intake (D48). Needs a subscription model on
      `prisma/` and super-admin authority on `Membership` — both **LAW**, both needing
      their own contract-change issue before any PR opens
- [ ] Service + repository skeleton with Zod DTOs
- [ ] Unit tests for the logic above
- [ ] Update this file on exit — it is how the next session picks up
