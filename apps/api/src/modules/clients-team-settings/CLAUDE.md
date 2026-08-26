# clients-team-settings

**Lane K** · **Source of Truth:** SoT §5, §7, §12, **§24.4, §24.5** · **Launch stage:** A11 (`docs/launch/ABDULLAH.md`)

## Purpose

Client intake, the client list and cards, client-scoped AI grounding, team management, document-workflow tasks, and the full settings inventory.

## ⚠ Initial Delivery (ID) — read this before the sections below

**Client onboarding in ID asks for no connections at all** (D47, amending §5.1 and §6 for this release). Adding a client asks for **neither a bank connection nor an accounting-software connection** — both steps are skipped, because D40 and D42 mean neither exists yet. What intake must capture instead is the **business-type profile**, because §24.4 makes it the substitute for the chart of accounts this release does not have.

- **Two authorities, not one (D44).** Accountants and their team members compose and edit; only the accounting firm's **super admin** releases. Team management must model that distinction, and it is enforced server-side (Governance §11.2).
- **A client may add their own team members** (D45), and those people may upload — but only they, and only through identity-gated channels.
- **Subscription is part of intake now, not deferred** (D48 supersedes D26): **€8.50 per month plus VAT, per client business, paid by the client**, asked for at the end of the client's own onboarding. The price is quoted and stored **exclusive of VAT**; VAT is added at the prevailing rate and the displayed price must say which it is. **Money is integer pence — the VAT-exclusive figure is what is stored.**

## What is here (A11)

| File | What it is |
|---|---|
| `business-profile.ts` | **The business-type profile** — the shape, the read, the wrapped render. **A6 reads this file.** |
| `client-intake.service.ts` | `POST /v1/businesses` — the workspace, its contact, its VT integration and its setup invite, in one transaction |
| `team.service.ts` | `GET`/`POST /v1/businesses/{businessId}/members` |
| `team-authority.ts` | **D44** as two predicates: compose is everyone, release is the super admin. **A12 imports `canRelease`.** |
| `setup-link.ts` | The setup token: mint, hash, expiry, link. **A2's portal verifier imports `hashSetupToken`.** |
| `projections.ts` | Prisma rows → the contract's `Business`, `BusinessMember`, `Invite` |
| `clients-team-settings.controller.ts` | One thin controller, three operations |
| `index.ts` | The public seam. Read its header before adding a name |

## The business-type profile — the shape A6 seeds from

**Stored in `businesses.context_questionnaire` (`Json?`).** The schema is not written here: it is
`createBusinessBody.shape.contextQuestionnaire`, taken from the generated contract, so it cannot
drift from `openapi.yaml`.

```ts
import { readBusinessProfile, profileForModel } from '../clients-team-settings/index.js';

const row = await scopedDb(prisma, ctx, (db) =>
  db.business.findUnique({ where: { id }, select: { contextQuestionnaire: true } }),
);
const profile = readBusinessProfile(row?.contextQuestionnaire); // BusinessTypeProfile | null
```

```jsonc
{
  "businessActivity": "Commercial cleaning for offices and schools",  // REQUIRED, 3–500 chars
  "typicalSuppliers": ["Nisbets", "Costco"],       // optional, ≤50 — A6 seeds SUPPLIER RULES from this
  "typicalCosts": ["Cleaning materials", "Wages"], // optional, ≤50 — A6 seeds the CHART OF ACCOUNTS from this
  "hasEmployees": true,                            // optional
  "usesSubcontractors": false,                     // optional
  "notes": "…"                                     // optional, ≤2000
}
```

Four things about it that are load-bearing:

- **An absent optional answer is an omitted key, never a `null` and never an `undefined`.**
  `exactOptionalPropertyTypes` is on and `undefined` is not a JSON value; a stored `null` would
  fail the strict schema on the way back out and the client would read as *"no profile"*.
- **`null` from `readBusinessProfile` has two meanings and both are the same fact:** nothing was
  captured, or what is stored is not a profile this release understands. Either way **the coding
  engine has no context for this client** — surface it, do not default it.
- ⚠ **`prisma/seed.ts` writes a LEGACY shape** — `{ sells, revenueStreams, typicalSuppliers,
  companyCards, expectedUnusual }`, with no `businessActivity` at all. **Every seeded demo client
  therefore reads as `null`.** That is deliberate: mapping `sells` onto `businessActivity` would
  hand the coding engine a sentence no accountant wrote. Fixing the seed is a `prisma/` change
  (LAW, G7) — see TODO.
- **The free text is untrusted content.** `profileForModel(profile)` renders it wrapped in
  `<untrusted_content>` with any embedded tag entity-escaped. Use it rather than interpolating the
  fields into a prompt — a helper you call is a rule you cannot forget.

## Intake writes four rows, in one transaction

| Row | Why it exists |
|---|---|
| `businesses` | the workspace, carrying the profile |
| `contacts` (primary, **lower-cased email**) | **D45.** `ingestion-routing`'s sender map keys on `contacts.email` after lower-casing, so this row is what makes the client's own email routable instead of Unrouted |
| `integrations` — **exactly one, `VT`, active** | **A5.** `publish-batch.ts` refuses a client with no active integration, so without this row no document could ever reach Published |
| `invites` | the setup link the registration email carries (§24.5 step 2) |

**Why exactly one integration, and why it is a constant.** `IntegrationKind` admits `VT` and
`MANUAL`; creating both would give the client two export destinations and A5 refuses that
outright. `@@unique([businessId, kind])` prevents a duplicate `VT` but nothing in the database
prevents a `VT` *and* a `MANUAL` — so the guarantee is that `CLIENT_INTEGRATION_KIND` is a module
constant no request can influence, plus a test that counts the rows. An intake form with an
export-destination picker would be the connection step D47 deleted, wearing a different hat. The
row carries **no `orgRef`, no `tokenRef`, no `health`**: those are what an OAuth connection fills
in, and there is no connection.

## The setup token

`invites.token_hash` is the mechanism — a row, not a signature. It can be revoked and consumed,
it needs no new secret to rotate, and the contract already says the token lives *"in the email and
in `invites.token_hash`, and nowhere else"*.

- 32 CSPRNG bytes, base64url; **only `sha256(token)` is stored**; expiry **7 days**.
- ⚠ **A2's portal verifier must hash the presented `setupToken` with `hashSetupToken` and look the
  row up by `token_hash`.** Two hashings is a sign-in that works on one side and not the other.
- ⚠ **The app origin is a constant** (`DEFAULT_APP_ORIGIN`), not configuration: `config/env.ts`
  carries no public web origin and `config/` was not A11's to change. It is a constructor
  parameter, so promoting it to an env var is one line in the module file.

## D44, as code

`team-authority.ts`: `canRelease(role)` is `role === 'PRACTICE_ADMIN'`; `canCompose(role)` is
always true. **Nothing in this module enforces release** — the check belongs on the approve path
in `modules/approvals` (A12), because that is the one door the irreversible acts go through, and a
role check scattered across the surfaces that *offer* those acts is a permission model with no
single place to read.

What this module does instead is make the split **visible**: `BusinessMember` carries `role`,
`scope` and `isOwner`, so a screen can show who may release and degrade honestly for who may not.

`POST …/members` accepts only `BUSINESS_ADMIN`, `USER_ADMIN`, `BUSINESS_STANDARD`; a practice-level
role — **including `CLIENT_ADMIN`, which reads like a client role and is not** — is `NT-VAL-001`.

## Tenancy: RLS, plus the one place it cannot be

Every query goes through `scopedDb`. `businesses_tenant`'s `WITH CHECK` is what admits an intake
row (proven, not assumed: the integration test forges a context naming another practice and
asserts **Postgres** refuses it).

⚠ **`memberships` and `users` carry NO RLS** — they are the tables the policies themselves read,
and a policed one would recurse. So on the team list the database is **not** the boundary. The
boundary is the `businesses` lookup that runs **first, in the same transaction**; every membership
filter is derived from the row RLS handed back. A test asserts `memberships` is **never queried**
when the business is invisible, because the 404 alone would look identical if it were.

The filter is `{ businessId } OR { practiceId, businessId: null }` — practice-**wide** only. Plain
`{ practiceId }` would match a colleague's membership on a *different* client of the same practice
and list every client's staff on every client.

**404, never 403.** A client outside the caller's scope is invisible, so the lookup returns null
and the service raises 404 with a detail that never echoes the id. `NT-NOT-001` does not exist in
the contract's enum; `NT-VAL-001` is the house fallback for an otherwise-uncoded 4xx.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever. (Nothing in this module touches money yet; the subscription projection is read-only and Stripe owns the amounts.)
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- **Intake and invites are `x-nt-side-effect: ingest`, not proposals.** They create new records and
  change the state of nothing that exists, so they need no Approve and open no side-effect door
  outside Review → Approve (Governance §10.6). The architectural route-table test reads that field
  from `openapi.yaml`, so the claim is mechanical rather than a promise here.

## Boundaries

Exposes **only** `index.ts` — lint-enforced (`neoting/no-cross-module-internals`). It imports
`notifications/index.ts` for the one door outbound email leaves by; the dependency runs one way.

## Tests

```bash
pnpm --filter @neoting/api test -- clients-team-settings   # 50 tests: 43 offline + 7 against a real DB
```

The integration suite owns the **`a11_`** id namespace and tears down by explicit id list — the
businesses it creates carry generated cuids, so their ids are collected as they are made. It skips
when no database is configured and fails when one is configured but unreachable.

## Current state

**A11 is built.** `POST /v1/businesses`, `GET`/`POST /v1/businesses/{businessId}/members`,
registered in `app.module.ts`. Three things it deliberately did **not** do:

- **No client-list endpoint.** `GET /v1/businesses` already exists in `auth-tenancy` and is the
  client list. A second door for one resource is what `packages/contracts/CLAUDE.md` convention 1
  forbids.
- **No settings endpoints.** The S0 contract publishes none — no `GET /businesses/{id}`, no
  settings resource — and inventing public API is a contract change, not a stage's decision. The
  settings shell is therefore the module and its providers: the Plan section reads
  `BusinessSummary.subscription` (billing lane, S4), and the profile read A6 needs is a provider
  (`ClientIntakeService.getClientProfile`) rather than a route.
- **No audit row.** `approvals/audit-writer.ts` is not on a public seam, so this module cannot
  reach it without breaking the boundary rule. The durable record of an intake is the four rows
  themselves. See TODO.

## TODO

- [ ] **`prisma/seed.ts` writes a legacy questionnaire shape** with no `businessActivity`, so every
      seeded client reads as *no profile* and A6 will seed nothing for them. `prisma/` is LAW —
      needs a contract-change issue (G7), not a quiet edit.
- [ ] **`config/env.ts` has no public app origin.** `DEFAULT_APP_ORIGIN` is a constant standing in
      for one; when S1 adds the key, wire it in `clients-team-settings.module.ts` (one line).
- [ ] **Audit events for intake and invites**, once the approvals module exposes its audit writer
      on a seam.
- [ ] **A durable `IdempotencyStore`.** The in-memory one is per-process, so a replay that lands on
      another API task does the work twice — a second client, and a second invite email.
- [ ] Removing a member, deactivating a client, and editing the profile after intake: **no contract
      operation exists** for any of them (`POST /businesses` is the only write). All three are real
      day-one needs and all three are contract changes first.
- [ ] **D48 subscription at intake** — the columns exist on `businesses` and the projection reads
      them; the checkout that fills them is the billing lane (S4).
- [ ] Update this file on exit — it is how the next session picks up.
