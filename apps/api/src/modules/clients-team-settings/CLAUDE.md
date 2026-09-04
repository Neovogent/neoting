# clients-team-settings

**Lane K** · **Source of Truth:** SoT §5, §7, §12, **§24.4, §24.5** · **Launch stage:** A11 (`docs/launch/ABDULLAH.md`)

## Purpose

Client intake, the client list and cards, client-scoped AI grounding, team management, document-workflow tasks, and the full settings inventory.

## ⚠ Initial Delivery (ID) — read this before the sections below

**Client onboarding in ID asks for no connections at all** (D47, amending §5.1 and §6 for this release). Adding a client asks for **neither a bank connection nor an accounting-software connection** — both steps are skipped, because D40 and D42 mean neither exists yet. What intake must capture instead is the **business-type profile**, because §24.4 makes it the substitute for the chart of accounts this release does not have.

- **Two authorities, not one (D44).** Accountants and their team members compose and edit; only the accounting firm's **super admin** releases. Team management must model that distinction, and it is enforced server-side (Governance §11.2).
- **A client may add their own team members** (D45), and those people may upload — but only they, and only through identity-gated channels.
- **Subscription is part of intake now, not deferred** (D48 supersedes D26): **£8.50 per month plus VAT, per client business, paid by the client**, asked for at the end of the client's own onboarding. The price is quoted and stored **exclusive of VAT**; VAT is added at the prevailing rate and the displayed price must say which it is. **Money is integer pence — the VAT-exclusive figure is what is stored.**

## What is here (A11)

| File | What it is |
|---|---|
| `business-profile.ts` | **The business-type profile** — the shape, the read, the wrapped render. **A6 reads this file.** |
| `client-intake.service.ts` | `POST /v1/businesses` — the workspace, its contact, its VT integration and its setup invite, in one transaction |
| `team.service.ts` | `GET`/`POST /v1/businesses/{businessId}/members` — the CLIENT's own people |
| `practice-team.service.ts` | `GET`/`POST /v1/practice-members` — **the FIRM's own people.** See below |
| `practice-members.controller.ts` | One thin controller, two operations, flat resource |
| `team-authority.ts` | **D44** as two predicates: compose is everyone, release is the super admin. **A12 imports `canRelease`.** |
| `setup-link.ts` | The setup token: mint, hash, expiry, link. **A2's portal verifier imports `hashSetupToken`.** |
| `projections.ts` | Prisma rows → the contract's `Business`, `BusinessMember`, `PracticeMember`, `Invite` |
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
- ✅ **The app origin is `env.APP_ORIGIN`** as of 2 Sep 2026 — the one line this note predicted.
  It was a constant standing in for a key `config/env.ts` did not have; the chase lane added the
  key, and all three link builders in the app now read the value a task definition actually sets.
  ⚠ **Set it to the host customers arrive on.** Both hostnames are CloudFront aliases, but a
  verification or invitation mail naming a different host from the one somebody just used is the
  phishing shape, to an audience trained to distrust it.

## D44, as code

`team-authority.ts`: `canRelease(role)` is `role === 'PRACTICE_ADMIN'`; `canCompose(role)` is
always true; `isBusinessLevelRole` and `isPracticeLevelRole` partition the enum **minus
`PRACTICE_ADMIN`**, which neither invite path may grant. **Nothing in this module enforces release** — the check belongs on the approve path
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
pnpm --filter @neoting/api test -- clients-team-settings   # offline + against a real DB
```

`practice-invite.integration.test.ts` (prefix **`pti-`**, teardown by explicit id
list) walks the WHOLE journey through the real services — invite, read the token
out of the email, accept — and then asserts the three things only Postgres can
answer: a scoped colleague sees their assigned client and NOT the withheld one;
an invited colleague approving a `publish.batch` gets `NT-PRM-001` with the
document still READY, no `publishes` row and the proposal unconsumed; and a
non-admin inviting is `403` with no `invites` row and no email. Hand-written
membership fixtures would have been the test agreeing with itself — the SHAPE
acceptance writes (`practice_id` NULL on a scoped row) is the thing under test.

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
- [x] **`config/env.ts` has a public app origin** (`APP_ORIGIN`), and both services are wired to it
      (2 Sep 2026). `DEFAULT_APP_ORIGIN` survives only as the schema's default and as the value
      `setup-link.test.ts` builds links with.
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


## The client invite carries the legal links (4 Sep 2026 — walkthrough finding 4)

Both `sendClientInvite` callers (`client-intake.service.ts`,
`team.service.ts`) now spread `buildLegalLinks(this.config.appOrigin)` into the
send — the composer's `termsLink`/`privacyLink` are REQUIRED, so a new caller
cannot forget them. The paths and the SPA drift pin live in
`notifications/legal-links.ts`; nothing here knows a legal address.

## The practice's own team — `GET`/`POST /v1/practice-members` (2 Sep 2026)

**Before this, a firm could only ever have the one person `POST /practices`
created.** There was no operation anywhere in the contract that granted a second
human access to a practice: the Team screen's "Invite colleague" opened a local
record editor whose save evaporated on reload, and the chat surface's invite card
printed *"Invitation sent to {email}"* over a handler that did nothing.

### Why it is NOT `team.service.ts`

That class's tenancy argument is its own header: the boundary on the client-team
surface is *"the `businesses` lookup at the top of every method"* —
`businesses_tenant` decides whether the caller can see that client, and every
membership filter is derived from the row RLS handed back. **This surface has no
business to look up.** Its subject is the practice itself, so the same code with a
different first query would be the same comment guarding a different thing, which
is how a tenancy argument silently stops being true.

### ⚠ The boundary here is `ctx.practiceId`, and nothing else

`memberships` and `users` carry no RLS, so on the member list the database is not
the boundary. The `practiceId` filter is — and it is legitimate for exactly one
reason: `ctx.practiceId` comes from the **verified session**, resolved by
`session-scope.ts` from the caller's own membership rows. A caller cannot NAME a
practice, only be one. `approvals/assert-can.ts` states the identical thing about
its own membership read.

What IS policed and is therefore left to RLS: `businesses` (which clients exist,
and which a colleague may be scoped to) and `invites` — `invites_tenant` already
admits `business_id IS NULL AND practice_id = app_practice_id()`, which is exactly
the shape a colleague invitation has. **This feature needed no policy change.**

### The three rules it enforces, and where each lives

| Rule | Where |
|---|---|
| Only a practice admin may invite | `assertCan(actor, 'team.invite')`, imported from `modules/approvals`' new seam. **There is deliberately no second role test in this module** |
| `PRACTICE_ADMIN` is refused, by name | `isPracticeLevelRole` / `INVITABLE_PRACTICE_ROLES` in `team-authority.ts` |
| A client the inviter cannot see is `404` | the `businesses` read inside `scopedDb` — RLS answers, and a `403` would confirm the client exists |

`mayManageTeam` is `canRelease(role)` **without** the `isOwner` narrowing, and the
divergence from `mayRelease` is argued at the seam: inviting is reversible and
internal, and requiring ownership would make team management a bus factor of one
in a product with no ownership-transfer operation.

### The member list pages over USERS, not memberships

A colleague scoped to three clients holds three membership rows, and a keyset over
rows would page the same person three times with their `businessIds` split across
page boundaries. One row per person is the only unit a cursor can seek to, so the
seek runs on `users.created_at` and the memberships arrive as an include;
`toPracticeMember` folds them. ⚠ The SORT key is therefore the user row's
`created_at` while the reported `createdAt` is the earliest membership's. They
agree for everyone this product creates (acceptance writes both in one
transaction).

`pendingInvites` rides on the same response rather than an endpoint of its own,
because an invitation nobody can see is an invitation nobody chases.

### ⚠ `invites.business_ids` — the column the feature could not exist without

The contract's `businessIds` had nowhere to live: `invites.business_id` is a
single column, and N invitation rows would need N tokens (`token_hash` is
`@unique`). It is a `TEXT[]` with an empty default — **empty means practice-wide**,
which is also what a `CLIENT_ADMIN` always gets. Additive, no backfill.

⚠ **`hide_financial_fields` is carried and READ BY NOTHING** when a document is
served. The invite boundary used to accept it and silently discard it, which is
worse; storing it is the honest half. **No screen may present it as a protection
in force** — `apps/web`'s live team table deliberately does not render it.

### ⚠ `firstName` / `lastName` on the invite request are the SAME anti-pattern, still half-open

`PracticeMemberInviteRequest` declares them, `invitePracticeMember` never reads
them, and **`invites` has no column for either.** Acceptance then asks the
invitee for their own first and last name as REQUIRED fields
(`auth-tenancy/invitation-acceptance.service.ts`), so a persisted value would be
overwritten by the person it describes — an admin's guess at a colleague's
spelling is not a fact worth a migration.

Half of it is closed as of 2 Sep 2026: **`apps/web` no longer collects them or
sends them** (the two form fields and their message ids are gone, `api/team.ts`
composes a body of `email` + `role` + optional `businessIds`, and
`api/team.test.ts` asserts the exact key set so a re-add has to argue with a
test). The service names the discard at the `invite.create` call rather than
letting it stay silent.

**What is still owed is the contract half**: removing the two properties from
`PracticeMemberInviteRequest` in `openapi.yaml` (LAW, G7). Until then the server
keeps accepting a key nothing in this product sends. The alternative — persisting
them — was rejected for the acceptance-overwrite reason above, and would need a
`prisma/` migration (also LAW).

### The invite `Idempotency-Key` remembers BOTH endings (2 Sep 2026)

`invitePracticeMember` wrote the row, sent the email, then stored the replay
record — so the `NT-RATE-001` branch **threw before the key was remembered**. A
retry carrying the same key missed the replay cache and created a **second
`invites` row with a second live token**: one address holding two outstanding
invitations, either of which admits its holder to the practice.

The stored value is now an `InviteReplay` discriminated union, and the
rate-limited ending is recorded before the throw, so a replayed key raises the
same 429 rather than re-deciding. Three tests pin it, including that a FRESH key
still reaches the send path — this is replay bookkeeping, not a lockout.

Two things it deliberately does **not** do, both flagged rather than guessed:

- **A replay does not re-send.** Only `sha256(token)` is stored, so the plaintext
  that would go in the email no longer exists. `openapi.yaml`'s 429 says *"a
  retry re-sends rather than re-decides"*, which is true of an operator's retry
  and not achievable for a replay without re-minting the token on the existing
  row.
- **A fresh key still writes a second outstanding invitation for one address.**
  `prisma/CLAUDE.md` records that `@@unique([practiceId, email])` was left off
  deliberately, because re-inviting must be legal — but nothing then collapses
  the old row, so the address ends up with two live tokens. Making the create a
  refresh of any outstanding invitation is the fix, and it is a behaviour change
  touching token lifetimes: Shakib's call, not this file's.

⚠ **The same ordering exists in `team.service.ts`'s client-invite path** (the row
commits, `sendClientInvite` may refuse, `remember()` is only reached on success).
Untouched here because it was outside the reviewed change set — reported, not
fixed.
