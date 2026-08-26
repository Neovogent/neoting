# rules-suggestions

**Lane D** · **Source of Truth:** SoT §4 Stages 3-4, **§24.4** · **Launch stage:** A6 (`docs/launch/ABDULLAH.md`)

## Purpose

The chart of accounts, and the authority ladder that decides how a document is
coded. In v1 this lane is the four-tier rule engine, natural-language rule
parsing and AI coding suggestions; **in ID it is deliberately much less than
that** — see the scope fence below.

## ⚠ Initial Delivery (ID) — read this before the sections below

**There is no ledger-synced chart of accounts in ID** (SoT §24.2 Stage 3). D42
means nothing syncs a COA in, so rules and coding run against a **platform-side
COA seeded from the business-type profile captured at intake**. That is a real
reduction in available context, and §24.4 — the AI context pack — is the whole
answer to it.

- **Rules run first, and they are not a fallback** (§24.4.2). The authority order
  is unchanged and still absolute; ID leans on it harder, because there is less
  to go on.
- **Cold start is the named risk** (SoT §21): published evidence puts category
  accuracy around 79% where the category already exists, and it collapses on a
  brand-new client — exactly when the product is being judged. Do not promise
  past §24.4.7 in UI copy.
- **§24.4.6 ranks what a coding error actually costs.** The chart in
  `chart-of-accounts/profiles.ts` is organised by that hierarchy and not by
  taxonomy; the reasoning is written into the file.
- **Document acceptability (D46) is this lane's on paper and is NOT built.**

## What A6 built, and what it deliberately did not

**Built:** a per-business chart of accounts seeded from the business-type
profile, and a supplier-name → account ladder that turns an accountant's own
first coding into a `rule.create` proposal — so the *second* invoice from that
supplier codes itself.

**Not built, by name, from the stage brief:** *the four-tier rule engine,
natural-language rule parsing, and AI coding suggestions.* Also not built: D46
acceptability judgement, the versioned §24.4 context pack (a lane-D deliverable,
not this week), and any accountant-facing edit of the chart (**no contract
operation exists** — see TODO).

> *A human coding it by hand is an acceptable product; a wrong code applied
> silently is not.*

| File | What it is |
|---|---|
| `chart-of-accounts/account.ts` | The account model, and `analysisAccount()` — **the one place `Ledger: Account` is produced** |
| `chart-of-accounts/profiles.ts` | **The four hardcoded business-type profiles.** Data, with the §24.4.6 reasoning beside it |
| `chart-of-accounts/chart-of-accounts.ts` | Pure: profile → chart. Owns the null-profile answer |
| `chart-of-accounts/chart-of-accounts.service.ts` | The chart in `reference_syncs`. Seeds once, **never overwrites** |
| `coding/authority.ts` | The authority order, as ranks. Which rungs ID fills, stated |
| `coding/coding-decision.ts` | The answer shape — including `LOCKED` as a first-class outcome |
| `coding/supplier-coding.service.ts` | The ladder itself, and the human lock |
| `coding/rule-proposal.ts` | Decision → `rule.create` payload for the Review → Approve spine |
| `supplier-key.ts` | Supplier-name normalisation. Read its header before using it on a `scopeKey` |
| `index.ts` | The public seam. Read its header before adding a name |

## The four profiles, and why those four

| Profile | Who | Why it earns one |
|---|---|---|
| `GENERAL_BUSINESS` | everyone — **and the answer when the profile is null** | The core an accountant needs whatever the trade is, and the base of the other three (they are *additions*, never replacements) |
| `SERVICES_WITH_STAFF` | cleaning, maintenance, care, security, landscaping | **The first paying client is a cleaning agency.** Consumables, subcontracted labour, equipment hire |
| `TRADE_AND_CONSTRUCTION` | builder, plumber, electrician, roofer | Materials as a cost of sale, and CIS subcontractors — where the **domestic reverse charge** lives, a §24.4.6 tier-3 error straight onto a VAT return |
| `RETAIL_AND_HOSPITALITY` | shop, café, takeaway, bar, salon | Stock and food, where the zero-rate boundary (cold takeaway vs hot or eat-in) is the most expensive coding call a small UK business makes |

**Professional services has no profile on purpose** — `GENERAL_BUSINESS` already
carries software, subscriptions, professional fees, travel and training. A fourth
specialist that added nothing would be a fourth thing to maintain and be wrong.

Two §24.4.6 rules are visible in the data and pinned by tests: **no catch-all
`SUNDRY`** (*a catch-all is where misclassification hides*), and **every
distinction the outside world enforces has its own code** — entertaining vs staff
welfare, charitable vs political donations, depreciation, private use, and every
capital item in the `Fixed assets` ledger.

## The handshake with A7 — `Ledger: Account`

A7's VT emitter requires `Analysis account` to carry the ledger prefix, literally
`Cost of sales: Purchases`, and raises `analysis-account-unprefixed` for a bare
name. So:

- An account is **`ledger` + `name`, never one string.** `Primary account` wants
  the bare name and `Analysis account` wants the prefixed one; storing the joined
  form would make the bare one a `split(': ')` at the emitter, and a name
  containing a colon would silently lose half of itself inside VT.
- `analysisAccount(account)` is the one join. `ChartAccountSchema` refuses a
  colon in either part, so the join is reversible.
- `ClientChartOfAccounts.categories` is `{ code, name }` with **`name` already
  in the emittable form** — one string with one meaning in chat, in a rule card
  and in the export file.
- **Off-chart codes answer `null`, never a guess.** `documents.category_code` is
  free text in the schema, and an accountant's explicit rule outranks the chart
  and may name a code it does not carry. A guessed ledger is a wrong nominal in
  someone's books.

## The two guarantees, and the tests that prove them

> *An explicit accountant rule beats everything, and nothing overrides a human's
> correction.*

**1 · A rule beats everything below it.** `decide()` consults rules FIRST and
returns the moment one sets a category. Learned history is never *compared*
against a rule — there is no code path in which it could win. Proven by
`supplier-coding.service.test.ts` → *"a USER rule beats a conflicting learned
history"*, and end to end against a real database in
`rules-suggestions.integration.test.ts` → *"an explicit accountant rule beats a
conflicting learned history"*, where both the rule and the history were created
through the real Review → Approve engine.

**2 · Nothing overrides a human's correction.** This is **not a rung** on the
ladder — a rung is something a better rung can beat. It is a `LOCKED` outcome
carrying no code to apply, checked *before* the ladder runs. Proven by
`documentLockFor` unit tests and, decisively, by the integration test *"nothing
overrides a human's correction — not even the rule that now disagrees"*: a
document a person coded, then contradicted by an approved rule, still answers
`LOCKED` and is not rewritten.

⚠ **The lock is read off the accepted `extractions` row, not off
`documents.category_code`** — the column alone cannot tell a value a person chose
from one a rule applied. `document.update-coding` writes
`provenance: 'HUMAN_CONFIRMED'` and is the only writer of it.

## Nothing in this module writes

No `documents.category_code`, no `rules` row. A `CodingDecision` is a read; a
`SupplierRuleProposal` is a payload for `POST /v1/action-proposals`. Governance
§10 has no exception for a rule that is probably right, and A6's brief names the
specific case: *a rule that silently recodes a document is exactly the thing §10
forbids.*

The **one** write is the chart itself, into `reference_syncs`. That creates a
reference list where there was none and changes the state of nothing that exists
— A11's `x-nt-side-effect: ingest` class — it is idempotent, and it **never
overwrites**, which is what keeps it out of §10's scope. The moment it could
replace an existing chart it would stop being that.

## Where the chart lives, and why there is no new table

`reference_syncs`, `listKind: 'chart_of_accounts'`, `@@unique([integrationId,
listKind])`. `prisma/` is LAW (G7) so a new table was never available — but this
one is the better answer anyway, because **`chat-framework/grounding.ts` already
reads it**:

```ts
db.referenceSync.findMany({ where: { listKind: 'chart_of_accounts', integration: { businessId } } })
```

It returned empty for every client in the product, so every accountant trying to
teach a coding rule got *"This client has no synced chart of accounts yet, so a
coding rule has nothing to code against."* Seeding this row removes that sentence
with **no change to the chat module at all**, and the integration test asserts it
through the real `loadCategories` under real RLS.

The payload is a **superset** of what chat parses: `categories` first (the half
it reads), plus a `neoting` block carrying the VAT and tax flags. Chat's
non-strict `z.object` ignores the extra.

## The exact-match trap — read this before touching a `scopeKey`

`extraction-pipeline.ts` matches a rule by **exact string equality**:

```ts
where: { businessId, isActive: true, tier: 'SUPPLIER_CUSTOMER', scopeKey: extracted.supplierName }
```

A normalised, title-cased or hand-typed key produces a rule that is written,
renders correctly on the review card, is approved by a human — **and then never
fires**, with nothing reporting it. So:

- `rule-proposal.ts` takes `scopeKey` **verbatim from a document the client
  actually received** (`history.spellings[0]`), and reports the other spellings
  as `unmatchedSpellings` rather than pretending one rule covers them.
- `decide()` matches rules the *same* exact way the pipeline does, and reports a
  differently-spelled rule as `nearMissRuleScopeKeys` instead of honouring it.
  Matching loosely here would make this module claim a coding the pipeline never
  applies — a disagreement nobody would see until the export was wrong.
- `normaliseSupplierKey` is for **finding history and comparing names only.**

## A client whose profile reads null

`readBusinessProfile` returns `null` when nothing was captured *or* when the
stored value is not a profile this release understands. **Every client seeded by
`prisma/seed.ts` reads as `null`** — the seed writes a legacy shape (`sells`,
`revenueStreams`, `companyCards`, `expectedUnusual`) with no `businessActivity`,
and A11 deliberately refused to map `sells` onto it.

The answer is the **general chart**, with `basis: 'NO_PROFILE'` and a caveat
written to be rendered: *"This client has no business-type profile, so this is a
generic UK small-business chart rather than one built for them. Nothing is coded
automatically from it."* That is not a default dressed as an answer — a chart is
a **picklist**, the `CLIENT_CONTEXT` rung never wins so a generic chart cannot
become a wrong code, and refusing to produce one would stop the accountant coding
by hand too.

## Client free text never reaches an account name

`businessActivity` and `typicalCosts` are untrusted content. They are used for
exactly two things: **choosing between four objects this repository authored**,
and **selecting which authored accounts join the picklist**. A cost that matches
nothing is reported as `unmatchedCosts`, never turned into an account — the
`Analysis account` column of an accountant's import file is not where a client's
free text belongs. A test pins it with a prompt-injection string in the activity
field.

Anything that puts the profile in front of a *model* must use A11's
`profileForModel()`, which wraps it in `<untrusted_content>`.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a
PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Authority order is absolute: accountant rules, practice defaults, client
  context, learned history, then AI inference. The AI never silently overrides an
  explicit rule — and in ID there is no AI rung at all.
- Every Prisma query goes through `scopedDb(ctx)` (Governance §5.2). **404, never
  403** for an invisible client or document; the detail never echoes the id.
- Money is integer pence. Nothing in this module touches money.
- Every state change creates an `ActionProposal` and executes only after a human
  Approve (Governance §10). This module creates none — it produces payloads.
- Zod at every boundary, including the database: `reference_syncs.payload` is
  `Json` and is parsed on the way out, never trusted.

## Boundaries

Exposes **only** `index.ts` — lint-enforced (`neoting/no-cross-module-internals`).
It imports `clients-team-settings/index.ts` for two pure functions
(`readBusinessProfile`, `BusinessTypeProfile`); the dependency runs one way and
needs no NestJS import, which is why `RulesSuggestionsModule` imports nothing.

## Tests

```bash
pnpm --filter @neoting/api test -- rules-suggestions   # 111 tests: 103 offline + 8 against a real DB
```

The integration suite owns the **`a6_`** id namespace and tears down by explicit
id list — never `startsWith`, because Prisma's LIKE leaves `_` a wildcard. It
skips when no database is configured and fails when one is configured but
unreachable.

## Current state

**A6 is built.** Providers only, registered in `app.module.ts`. Three things it
deliberately did **not** do:

- **No controller.** The S0 contract publishes no rules, chart-of-accounts or
  suggestions endpoints — the whole path list is in `openapi.yaml` and none of
  them are there. Inventing public API is a contract change, not a stage's
  decision (A11's settings decision, and A7's, applied again).
- **No `Suggestion` rows.** The table exists and the extraction pipeline writes
  it; a decision returned from here is a read, and persisting an opinion nobody
  asked for is a second, quieter coding path.
- **No change to `extraction-pipeline.ts`.** Its single-tier exact
  `SUPPLIER_CUSTOMER` match is already the half that makes the second invoice
  code itself, and it was outside A6's `Owns` fence.

## ⚠ Owed to other lanes — one line each, and neither is a correctness blocker

1. **`clients-team-settings/client-intake.service.ts`** — after the intake
   transaction commits, call
   `chartOfAccountsService.ensureChartOfAccounts(ctx, business.id)` so a new
   client has its chart (and therefore working chat rule-drafting) from minute
   one. Without it the chart is seeded lazily on the first read instead, which is
   correct but later.
2. **`extraction/extraction-pipeline.ts`** — if a future stage wants the
   `LEARNED_HISTORY` rung to code a *first* read as well as a rule,
   `SupplierCodingService.decide(db, businessId, supplierName)` takes a
   `ScopedClient` and can be called inside the pipeline's own transaction.
   ⚠ Doing so writes `categoryCode` on a fresh document, which is the pipeline's
   existing behaviour and not a recode — but it must never touch a document that
   already carries a human-confirmed coding.

## TODO

- [ ] **The accountant cannot edit the chart.** §24.4.1 says it is *owned and
      edited by the accountant thereafter*, and no contract operation exists for
      it. The storage and the never-overwrite guarantee are ready; the endpoint
      is a contract change (G7) first.
- [ ] **`prisma/seed.ts` writes a legacy questionnaire shape** with no
      `businessActivity`, so every seeded demo client gets the general chart and
      says so. `prisma/` is LAW — a contract-change issue, not a quiet edit.
      (Shared with `clients-team-settings`.)
- [ ] **A human who *confirms* a value without changing it leaves no trace.**
      `document.update-coding` short-circuits on an empty change set, so no new
      extraction row is written and `documentLockFor` sees nothing. Such a
      document is not locked. Closing it is a change to that executor's
      idempotency branch (`validation-dedupe`).
- [ ] **`HISTORY_WINDOW = 200`** bounds the learned-history lookup, because
      normalisation happens in this process and Postgres cannot index it. Fine at
      ID volumes; revisit with a normalised column (LAW) if a client outgrows it.
- [ ] The four-tier engine's `conditions` (amount bands, line-item keywords,
      document type, uploader, project) are stored verbatim by `rule.create` and
      **nothing evaluates them**. That is v1, not ID.
- [ ] **D46 acceptability judgement** — is this the document that was asked for,
      is it acceptable evidence, is it plausible for this business. Flagged,
      never blocked, judged per file. Not started.
- [ ] The versioned, evaluated §24.4 **context pack**. `profiles.ts` is the seed
      data it will consume, not a substitute for it.
- [ ] Update this file on exit — it is how the next session picks up.
