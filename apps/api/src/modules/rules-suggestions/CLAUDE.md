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
  past §24.4.7 in UI copy. ⚠ The independently published production numbers are
  **worse** than §24.4.7's: 62.5% top-1, 20.8% on an unseen category, 36%
  zero-shot. Design to those, not to a vendor's headline — every "99%" in this
  market is OCR extraction, not categorisation.
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

⚠ **The third of those was reversed on 2 Sep 2026** — see *The `AI_INFERENCE`
rung* below. A6's fence was right about the risk and wrong about the
consequence: with no suggestion rung, a first-time supplier could not be coded
by anything, and the product answered a real invoice with an empty field. What
is built is a **suggestion** carrying provenance and a confidence, never a
coding, and it changed nothing above it on the ladder. The four-tier engine and
natural-language rule parsing are still not built.

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
| `coding/supplier-coding.service.ts` | The ladder itself, the human lock, and `readStoredLines` |
| `coding/rule-proposal.ts` | Decision → `rule.create` payload for the Review → Approve spine |
| `coding/escalation.ts` | **The two closed sets** — why a coding is declined, and what is worth saying about one that is offered |
| `coding/capital-revenue.ts` | **The decision rules.** Pure, per line. The capitalisation policy lives here as a value, never a constant |
| `coding/ai-suggestion.ts` | The `AI_INFERENCE` rung: the document-level fold, the arithmetic hard stop, the confidence table |
| `coding/supplier-memory.ts` | **Tier 2** — this client's own remembered treatment, confidence scaled by consistency (item 48) |
| `coding/coding-instructions.ts` | The same rules in prose for a model, the tool schema, and the strict parse that refuses an off-chart code |
| `coding/correction-opinion.ts` | **The second opinion's pure half** — closed-set verdicts on a manual correction (items 22/47) |
| `coding/bedrock-coding.ts` | **The wire.** Both model calls, the meter, and the rule that every failure is `null` |
| `coding/select-coding-model.ts` | Config selection, keyed on `EXTRACTOR`. Read its header before adding a switch |
| `coding/coding-replay-corpus.ts` | The cassette corpus for both model calls |
| `supplier-key.ts` | Supplier-name normalisation. Read its header before using it on a `scopeKey` |
| `index.ts` | The public seam. Read its header before adding a name |

## The `AI_INFERENCE` rung — switched on 2 Sep 2026, and why

**A real invoice came back with no category at all**, repeatedly: Nexora
Solutions LLC, a US supplier, USD $54,352.51. Three facts composed into a
document nothing in the product was allowed to have an opinion about:

1. `extraction/bedrock-extraction-schema.ts` sets `categoryCode` null on purpose
   — *coding is the rules engine's job*;
2. `AI_INFERENCE` was off by name (A6's brief: *DO NOT build … AI coding
   suggestions*), and `CLIENT_CONTEXT` with it;
3. so **only a deterministic supplier rule could code anything — and a
   first-time supplier has no rule.**

The document reached To Review with an empty field and no sentence. That is
worse than a suggestion an accountant rejects in one click, and it is what this
rung fixes.

### Where it sits, exactly

Last. `decide()` returns on an accountant's rule, then on a practice default,
then on this client's own learned history; the rung is only reached when all
three have declined, and `resolveForDocument` checks the human lock before the
ladder is entered at all. **Nothing above it changed** — `outranks()` is
untouched and the existing precedence tests still pass unmodified.

### It attaches to `REVIEW`, and that is the safety property

A suggestion is **not** a `CodingDecision` with `outcome: 'CODE'`. `CODE` is
documented as *"the value that belongs in `documents.category_code`"*, and a
model opinion is not that. The rung hangs off the `REVIEW` outcome as
`decision.suggestion`, carrying `provenance: 'AI_SUGGESTED'` and a confidence
(SoT §13.3), so a surface renders it as an opinion. Accepting it is still a
`document.update-coding` proposal a human approves. `CODE` and `LOCKED` carry no
`suggestion` field at all — the type system, not a runtime check, is what stops a
model opinion riding along beside a rule or second-guessing a human's correction.

### It never answers nothing

Every path ends in a `SUGGEST` (a code, a confidence, a named basis, and a second
choice where there was a runner-up) or an `ESCALATE` carrying a reason from a
**closed set** in `coding/escalation.ts`:

`ARITHMETIC_MISMATCH` · `NO_CHART_OF_ACCOUNTS` · `CODE_NOT_ON_CHART` ·
`NO_LINE_DETAIL` · `SOFTWARE_TERM_UNKNOWN` · `MIXED_CAPITAL_AND_REVENUE` ·
`MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` · `THRESHOLD_BOUNDARY` ·
`NO_MATCH_ON_CHART` · `NEW_SUPPLIER_NO_HISTORY`

They are in **severity order** and the document reports the worst one found, so a
document whose sums do not reconcile is never categorised on top of them.
`ai-suggestion.test.ts` asserts the no-null property over a cross product of
charts, policies and evidence rather than by example.

### The accuracy ceiling it is designed around

Intuit's published research puts QuickBooks' production categoriser at **62.5%
top-1**, **20.8%** on a category unseen for that company, **36%** zero-shot for a
brand-new company. Every vendor "99%" in this market is OCR *extraction*, not
categorisation. So: rules first, a model only for the tail, **human review the
default**, and a **second choice** offered wherever there was a runner-up —
published top-2 runs about ten points above top-1.

⚠ **The confidence gates nothing**, and no branch in this repository may compare
it to a number. `modules/extraction`'s invariant holds here: *thresholds come
from eval measurements, never from model self-reported confidence.* It exists to
be displayed.

### The rules that decide the hard cases

Stated once in `capital-revenue.ts` as code and once in `coding-instructions.ts`
as prose; `coding-instructions.test.ts` fails if a reason or a basis exists in
one and not the other.

| | |
|---|---|
| **Line description beats supplier identity** | a reseller sells subscriptions AND hardware AND services, often on one invoice. The supplier name is consulted only when there is no line detail at all |
| **Amount decides exactly one thing** | the capitalisation threshold. Never which of two expense accounts. A property test changes the amount by four orders of magnitude and asserts every non-hardware answer is byte-identical |
| **Subscription ⇒ revenue, whatever the size** | HMRC BIM35805's under-two-years test; a right to *access* hosted software is a service contract (IFRIC, March 2019). A £22,500 annual M365 bill is not a capital item |
| **Perpetual ⇒ capital** | an intangible, and plant for UK tax (CAA 2001 s.71). ⚠ **The same product name can be either** — "Veeam Backup & Replication Enterprise" is capital if perpetual and revenue if annual, so a line that does not state the term **escalates rather than inferring from the vendor** |
| **The threshold is per UNIT, not per line** | 2 × $6,150 is two assets of $6,150. Tested as `net ≥ threshold × units` — no division, so no float and no rounding (R5) |
| **The services line SPLITS** | installing and testing hardware capitalises into the asset (IAS 16.17(d)–(e)); configuring the supplier's hosted software is expensed; **training is NEVER capitalisable** (IAS 16.19(c), IAS 38.69(b)) — one of the very few genuinely bright lines |
| **Foreign consumption tax is part of the cost** | never a tax control account. ⚠ And for a UK reverse charge it nonetheless *increases* the taxable base (HMRC VATPOSS14600) — both are said, because saying only the first invites the second to be got wrong |
| **Arithmetic first** | the example invoice does not reconcile ($52,550 + 8.875% = $57,213.81, stated total $54,352.51). A hard stop before any classification |

⚠ **The capitalisation threshold is a `CapitalisationPolicy` VALUE, not a
constant.** There is no statutory de minimis in UK GAAP or IFRS — it is the
practice's own accounting policy, so the same monitor is capital at one firm and
an overhead at another. `SupplierCodingService` takes it as a constructor
argument and it carries `source: 'PRACTICE' | 'PLATFORM_DEFAULT'` so a card can
never present our number as theirs. The *persisted* per-practice setting needs a
column and is therefore a contract-change issue (see TODO).

### Line descriptions are untrusted content

They come off documents strangers send, and since the OCR rung the channel is
plain text. They are lower-cased and matched against patterns **this repository
authored** — classifying a string is not obeying it, the same argument
`chart-of-accounts.ts` makes for `businessActivity` — and they are never
concatenated into an account name, a category, or a sentence rendered to a user:
a line is referred to by index, never quoted back. `codingEvidenceBlock()` wraps
the document with `wrapUntrusted`; the instructions sit outside the wrapper and a
test pins that a hostile description cannot close it.

### What the chart gained, and why each one

Seven accounts, all core (the example needs `SOFTWARE_AND_SUBSCRIPTIONS`,
`FA_COMPUTER_EQUIPMENT` and `PROFESSIONAL_FEES`, which already existed):

| Code | Ledger | Justification |
|---|---|---|
| `HOSTING_AND_INFRASTRUCTURE` | Expenses | consuming someone else's hardware is a service contract that can never be capital, at any amount — a different reviewer question from a named software product |
| `IT_SUPPORT_AND_MANAGED_SERVICES` | Expenses | a support contract *reads* like hardware ("24×7 server support") and acquires nothing. Without it those lines capitalised on the strength of the noun *server* |
| `SOFTWARE_IMPLEMENTATION` | Expenses | configuring the supplier's hosted software is expensed (IFRIC cloud agenda decisions) — the revenue half of the professional-services split |
| `IT_EQUIPMENT_AND_CONSUMABLES` | Expenses | the **below-threshold** half of the practice's own capitalisation policy, which a chart with only `FA_COMPUTER_EQUIPMENT` cannot express |
| `FA_SOFTWARE_LICENCES` | Fixed assets | a perpetual licence: an intangible, plant for UK tax (CAA 2001 s.71) |
| `FA_INSTALLATION_AND_COMMISSIONING` | Fixed assets | third-party work capitalising INTO an asset (IAS 16.17(d)–(e)) — the capital half of the same split |
| `PREPAYMENTS` | **`Current assets`** | an annual fee paid up front is a prepayment, not an intangible (IFRIC, March 2019) |

⚠ **`Current assets` is a FIFTH ledger**, and `account.ts`'s old rule said there
would not be one. It carries exactly one account and a test pins that. The cost
is downstream: VT's Converter maps on the exact string, so an unfamiliar ledger
name costs **one manual mapping in VT** — the emitter only requires *a* prefix
and never corrupts a figure. Adding a second balance-sheet account without an ID
document behind it would be the picklist entry the old rule was protecting
against.

**Deliberately NOT added: an internally-developed-software account.**
Capitalising development spend turns on IAS 38.57's six criteria, which are a
judgement about a project rather than a fact on an invoice. Offering the code
would invite a bespoke-development line to be capitalised *because an account
existed for it*. Such a line escalates instead.

## The ladder has five rungs and a MODEL now (6 Sep 2026 — review items 19 + 48)

**Mubashir's ruling, verbatim:** *"It is very important that the ai is not giving
any null value… at least give suggestion with confidence score; there won't be no
written account category on any invoice ever; this requires deep understanding of
accounting, use higher capable model for this if possible."* Said about an
**Aldgate Meats Ltd** invoice to a restaurant that came back with a BLANK
category and *"nothing on this client's chart matches… nothing was guessed at"*.

The order, and what each rung does:

| # | Rung | Answers | New? |
|---|---|---|---|
| 1 | Accountant's rule / practice default | `CODE` | no |
| 2 | **Supplier memory** — this client's own hand-codings | `CODE` (`LEARNED_HISTORY`), SHOWN as a suggestion | **the SHOWING is new** |
| 3 | Deterministic suggestion (`ai-suggestion.ts`) | `SUGGEST` or `ESCALATE` | no |
| 4 | **The model** (`bedrock-coding.ts`) | upgrades three escalations to `SUGGEST` | **NEW** |
| 5 | `ESCALATE` with a named reason | unchanged | no |

### ⚠ Item 48 was a missing CONSUMER, not a missing rung

`loadHistory` has read this client's prior HUMAN-CONFIRMED codings since A6, and
`decide()` has answered `CODE` on `LEARNED_HISTORY` ever since. **Nothing ever
showed it to anybody**: `extraction/coding-advice.ts` returned `null` for every
outcome that was not `REVIEW`, so a supplier a person had coded by hand arrived
with an empty Category and no sentence — identical on screen to a supplier
nobody had ever seen. The memory existed, the ladder used it, and the product
was silent about it.

`codingSuggestionFor(result)` (on the seam) is the one mapping now: the `REVIEW`
rung's suggestion, **or** the remembered treatment for a `LEARNED_HISTORY`
coding, **or** `null` beside an accountant's rule or a human's correction —
where an opinion is pressure to second-guess an explicit instruction rather than
extra information.

Two behaviour changes came with it, both named in item 48:

- **The confidence is CONSISTENCY, computed rather than looked up.**
  `memoryConfidence(times)` — 0.6 for one hand-coding, +0.08 each, capped at
  **0.9** (`TRAINING_NEVER_CAPITAL`'s ceiling: nothing may read as more certain
  than a bright line in a standard). It gates nothing, as ever.
- ⚠ **A remembered code the chart no longer carries is NOT offered**, and
  `decide()` falls THROUGH rather than answering `CODE` with it. Offering it
  produces a suggestion the export cannot prefix and that
  `assertUpdateCodingAllowed` refuses on the way back in — an affordance whose
  only possible outcome is a 422. The review reason says so by name instead of
  claiming nothing codes the supplier yet.

### The model rung: where it fires, and where it deliberately does not

`MODEL_ANSWERABLE_ESCALATIONS` (`escalation.ts`) is **three** reasons:
`NO_LINE_DETAIL`, `NO_MATCH_ON_CHART`, `NEW_SUPPLIER_NO_HISTORY` — exactly the
ones where the deterministic layer knows *nothing*, which is what Mubashir
overruled. Every other escalation stays terminal because it names something
SPECIFIC: the sums do not reconcile, there is no chart, a licence term is not
printed, the lines split across treatments the schema cannot hold, an amount
sits on the practice's own policy. That set's own doc argues each exclusion.

⚠ **A model answer never REPLACES a deterministic escalation.** If the model also
declines, the accountant keeps the named reason the rules worked out. The model
can only ever ADD a code.

### ⚠ IT RUNS OUTSIDE EVERY TRANSACTION, AND THAT FORCED A PIPELINE CHANGE

`decide()` takes a `ScopedClient`, so its caller holds an open transaction —
`extraction-pipeline.ts` called it inside the one that writes the extraction.
`scopedDb` gives that transaction **10 seconds** and a judgment-tier call takes
seconds of somebody else's network. So the model is a SECOND call,
`reconsider()`, made with nothing open; the pipeline reads the ladder in a short
transaction of its own (phase 2.5) and calls the model after it closes. The
`modules/approvals` ledger follow-up makes the same argument in its own words.

The cost of the split is one comparison: the rule read and the pipeline's rule
match are now two transactions, so phase 3 drops the suggestion whenever
`categoryCode` is set. The invariant *a suggestion never rides beside a rule*
holds by construction rather than by timing. What it buys, beyond the model: a
throw from Postgres inside the ladder no longer aborts the write transaction.

### The model pin, and the number that moved

`TASKS.codingSuggestion` was raised from `workhorse` to **`judgment`**
(opus-4-6) — §9.1, Shakib's decision in session on 6 Sep 2026, taken on
arithmetic and re-confirmed on the measurement.

⚠ **The estimate was 42% low, and `scripts/measure/coding-cost.ts` is why that
is known.** Estimated 1.74p/call from a character count of the GENERAL chart's
instructions; **measured 2.47p** (5,152 in + 204 out) once a real client's chart
and their own intake answers were in the prompt. A document that REACHES the
rung costs **3.81p** against D20's £0.02 blended guardrail, which holds while
fewer than **27%** of documents reach it. **Nobody has measured that rate** — it
is what the `document_events` rows with `stage: 'code'` answer, `suggested`
against `escalated` against the total, and it is the number to watch.

### The client's trade is the coding context (§24.4)

`ClientChartOfAccounts` gained `profile` — read off the business row in
`resolve()`, **not** off the chart, because the `reference_syncs` payload has no
profile in it and deriving it from the chart would give a client with a
freshly-derived chart its own trade as context and a client whose chart had been
saved none at all.

The prompt gets two things: the **trade label** (one of four strings this
repository authored, from `profileId`) and the client's own intake answers
through A11's `profileForModel()`, which wraps them. `basis: 'NO_PROFILE'` yields
a NULL label deliberately — `profileId` is `GENERAL_BUSINESS` both for a client
who answered nothing and for one whose answers matched no specialist, and telling
a model the first is a general business invents the one fact the context exists
to supply. There is an honest sentence for that case.

### Two new bases, and one the model may not claim

`SUPPLIER_MEMORY` and `INDUSTRY_CONTEXT_REASONING` joined `CODING_BASES`.
⚠ **A model answering `SUPPLIER_MEMORY` is rewritten to
`INDUSTRY_CONTEXT_REASONING` by `parseModelCodingSuggestion`** — that basis names
this client's own repeated hand-coding, settled from the database before the
model is asked, and a guess wearing it would put the strongest signal the product
has on top of the weakest. The prompt says so; the parse enforces it.

### ⚠ The model's own sentence is the ONE free-text field, and it is bounded

Item 19 asks for "a one-sentence reasoning note", and the model writes it —
*"Beef, chicken and lamb from a known meat wholesaler, purchased as food stock
for this restaurant."* Everything else it returns is a closed set. So
`sanitiseReasoning` collapses it to one line, refuses angle brackets, truncates
at `MAX_REASONING_CHARS` (240) and drops it entirely if nothing survives — after
which the note falls back to the named rule and is never empty. What it is NOT
protected against, stated plainly: a plausible well-formed lie. The confidence,
the named basis, the chart enforcement and the human's Approve are what stand
against that.

### ⚠ `MODEL_MAX_CONFIDENCE = 0.75`, and it was MEASURED into existence

The first live recording of the Aldgate case answered with a **confidence of
0.97** — a good code and a number that argues with everything around it, on a
zero-shot categorisation of a brand-new supplier where the published figures are
62.5% top-1 and ~36% zero-shot. The prompt asks for honesty and got 0.97 anyway:
`input_schema` instructs, the parse enforces. It is a DISPLAY bound, not a gate —
ordering below the ceiling is preserved and no branch compares it to a number.

## The model second opinion on a manual correction (items 22/47's deferred half)

Package B (#256) built the deterministic checks — tax exceeding the total, a
future date, money typed onto a document the pipeline read as OTHER — and the
advisory seam they render through. This is the half that needed a model, because
it asks a question arithmetic cannot: **is the thing a person typed actually on
the document at all?**

`correction-opinion.ts` is the pure half; `BedrockCodingModel.secondOpinion` is
the call. ⚠ **It returns VERDICTS FROM A CLOSED SET AND NO PROSE**, and the
sentence rendered on the approval card is OURS, composed from the value the
HUMAN typed (`validation-dedupe/correction-checks.ts`). Three reasons: that card
is frozen into the hash a super admin echoes and every other string on it is
server-composed; a closed set can be rendered, counted and tested; and it is
enough — what the accountant needs is *which* typed value the document does not
support, and they are looking at the document.

⚠ **`NOT_CHECKABLE` is a first-class answer and never a warning.** Measured live:
shown item 47's selfie — a document the pipeline read NOTHING off — the model
answers `NOT_CHECKABLE`, not `ABSENT`, and it is right. The deterministic layer
already covers that shape (*"this does not appear to be a financial document"*),
so the model staying quiet is the two layers not saying the same thing twice.
Where it earns its keep is a document that reads perfectly with a typed value
that names somebody else.

⚠ **It is the one model call in this module that runs INSIDE a transaction** —
`ActionProposalsService.review()`'s — with a hard 4 s cap
(`SECOND_OPINION_TIMEOUT_MS`). The reasoning and the rejected alternative are
written at that constant. A slow answer is discarded rather than waited for,
which is the correct direction: the ruling says the check must never block a
correction.

## The two Bedrock calls, and the rule that makes them safe to add

⚠ **NOTHING IN `bedrock-coding.ts` CAN FAIL A CALLER.** A throttle, an expired
credential, a budget ceiling, a refusal, an unparseable answer and a cassette
miss are all `null`, and both callers already hold a complete honest answer. That
is the OPPOSITE of `BedrockExtractor`, which must turn a failed read into a
FAILED document so a document nobody read does not look read.

- **Metered** against the same per-firm daily ledger (§9.7) — three spenders now,
  one number. The budget is a required constructor dep for the extractor's
  reason: an unmetered client does not fail, it just spends.
- **`temperature: 0`, no thinking.** The #252 convention, and here it does a
  second job: the cassette key hashes the request body, so a request that varied
  would be a fixture that cannot exist. `effort: 'high'` is recorded
  configuration and is not sent (thinking and `temperature: 0` are a 400).
- **Selected by `EXTRACTOR`**, not a fifth switch. `select-coding-model.ts`
  argues it at length: same document, same job, same meter; `demo` means the
  document was never read; the production boot gates already cover it; and
  `EXTRACTOR` is in staging's `common_environment`, so both task families carry
  it — which matters because the two consumers live in different processes.

## ⚠ The architectural blocker — `Document.categoryCode` cannot hold the answer

**This is the headline finding and it is NOT built.** `prisma/schema.prisma` is
LAW (G7) and belongs to another lane; this section is the proposal.

`documents.category_code` is **one nullable string with no line-item model**. The
Nexora invoice needs five different treatments — a subscription (revenue), two
servers (capital), a licence of unknown term (unanswerable), a services line that
splits, and training (never capital) — and there is no value of a single string
that is correct. The rung's `MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` and
`MIXED_CAPITAL_AND_REVENUE` escalations exist **because of the schema, not
because of the rules**: the lines were classified successfully and the answer
could not be written down.

It also degrades the export. `exports-public-api` already emits *one row per
analysis line* — the VT mechanism is there — and it is fed a single category, so
a five-treatment invoice exports as one line whatever the emitter can do.

### The proposal

```prisma
model DocumentLine {
  id          String  @id @default(cuid())
  documentId  String  @map("document_id")
  ordinal     Int                                  // the order on the page
  description String                               // UNTRUSTED — never an instruction
  quantity    Int?                                 // units, for the PER-UNIT threshold test
  netPence    Int     @map("net_pence")            // integer minor units
  taxPence    Int     @map("tax_pence")
  categoryCode String? @map("category_code")       // same free-text convention as the document
  treatment    String? // CAPITAL | REVENUE — §24.4.6 tier 1, per line
  provenance   String  // HUMAN_CONFIRMED | DETERMINISTIC | AI_SUGGESTED
  confidence   Float?  // present for AI_SUGGESTED, null otherwise (contract rule)
  escalationReason String? @map("escalation_reason") // the closed set, when the line could not be coded

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  @@unique([documentId, ordinal])
  @@index([documentId])
  @@map("document_lines")
}
```

Four things that make it a real proposal rather than a table:

1. **A checksum, enforced in code at the write site:** `Σ netPence + Σ taxPence`
   must equal `documents.total_pence` to within a penny per line, and a write
   that does not balance is refused. Lines that do not sum to the document are
   worse than no lines — they look authoritative and quietly change a total.
2. **`documents.category_code` stays, and stays authoritative for a
   single-treatment document.** It becomes a *projection*: the single distinct
   line category, or null when there is more than one. Nothing that reads the
   column today changes, which is what makes the migration additive.
3. **`document.update-coding` gains a line-scoped variant** so a human corrects
   line 4 rather than the document, and the human lock becomes per line. Every
   correction is still an approved ActionProposal.
4. **The export gains the row-per-line it was built for**, and D43's
   source-document link is unchanged because every line resolves to the same
   document.

Until it exists, `readStoredLines()` reads line items out of the `extractions.fields`
jsonb where the pipeline smuggles them, the rung classifies them in memory, and a
multi-treatment document is **reported** rather than coded. That is the honest
behaviour for the schema as it stands, and it is not the answer.

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

## A fourth consumer: the manual-correction gate (5 Sep 2026)

`approvals.module.ts` composes a `ChartCategoriesReader` from
`ChartOfAccountsService.resolve` for the `document.update-coding` CREATION gate
(validation-dedupe's `assertUpdateCodingAllowed`, review item 47): a manually
typed `categoryCode` must be EXACTLY a code on the client's chart — refused,
never fuzzy-matched, the same rule `parseModelCodingSuggestion` and the chat
drafts have always applied. Same service instance and same open transaction as
the publish entry preview. Nothing here changed; this records that the chart
now has a fourth reader and that its `categories` list is load-bearing for the
correction boundary too.

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
  explicit rule — it is reached only when every rung above it has declined, it
  produces a **suggestion** rather than a coding, and it is structurally unable
  to appear beside a `CODE` or a `LOCKED`. `CLIENT_CONTEXT` is still unfilled.
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

## ⚠ Trash is not coding evidence, and the exclusion is RETROACTIVE (3 Sep 2026)

`loadHistory` in `coding/supplier-coding.service.ts` now spreads `notDeleted()`
from `common/documents/deleted-documents.ts` beside its existing
`archivedAt: null` — different columns, two clauses. Soft delete
(`documents.deleted_at`) landed with this module fenced off, so a deleted
document was still teaching the ladder.

**The retroactivity is the decision worth recording**, because the aggressive
reading is the one that shipped: a document deleted last month stops being
evidence *today*, rather than the coding it contributed being grandfathered in.
Four reasons, in the order they settle it:

1. **The line above it already answered the question.** `archivedAt: null` has
   always excluded archived documents retroactively, and archiving is the
   **weaker** act — a duplicate set aside, still in the client's file. Two
   opposite answers to "does housekeeping reach backwards" inside one `where`
   would be indefensible whichever way each was argued alone.
2. **Deletion is very often the correction itself.** The documents that get
   deleted are the misfiled, the wrong client's, the duplicate coded to the wrong
   account — precisely the codings that must not teach. Grandfathering would keep
   exactly the evidence a practice deleted in order to be rid of.
3. **This is a RECOMMENDATION, not the audit trail.** `document_events` and
   `audit_events` still hold every coding decision that was made and are
   untouched. What `loadHistory` feeds is a claim about the NEXT document — a
   forward-looking claim, which may only rest on the file as it stands now.
   Retroactivity is right for a recommendation and would be wrong for a record.
4. **It reaches further than one screen.** `history.entries.length` is the
   `times` `buildSupplierRuleProposal` counts towards its threshold, so trashed
   evidence could otherwise carry a standing **rule** over the line — and a rule
   outlives the document that argued for it. `HISTORY_WINDOW` is also finite and
   filtered in memory, so a deleted row does not merely count, it occupies a slot
   and can push a real prior coding out of the window.

**The cost, stated honestly:** restoring a document restores its evidence, so a
delete-and-restore can move a suggestion twice. That is the behaviour
`archivedAt` already has, and a suggestion that tracks the current file is the
one a reviewer can check.

⚠ **`resolveForDocument`'s `findUnique` is deliberately NOT filtered.** It is the
per-document read, the same class as `getDocument` and `listDocumentExtractions`,
which serve a deleted document on purpose — previewing one is how a person
decides whether to restore it. Filtering it would turn that into a 404.

## Tests

```bash
pnpm --filter @neoting/api test -- rules-suggestions   # 271 tests: 263 offline + 8 against a real DB
pnpm test:eval:coding                                  # the §9.8 gate — replayed, offline, free
```

**The §9.8 gate for this module is `evals/src/run-coding-evals.ts`**, and it is a
SECOND runner rather than more cases in the chat one: a different prompt, tool
schema, task class and version constant, and one runner would have coupled a
coding-rule change to the chat eval gate — the exact coupling
`CODING_PROMPT_VERSION` exists to prevent. It drives the REAL
`decide()` → `reconsider()` → `codingSuggestionFor()` over a fake `ScopedClient`,
so it scores the whole answer an accountant sees rather than a re-implementation
of the tier order. **Recorded live 6 Sep 2026: ladder 12 cases / 30 assertions
100%, second opinion 5 cases / 7 assertions 100%, injection 0 leaks.**

The 85 added on 2 Sep 2026 are the suggestion rung. The five that matter most,
because each pins a rule the research says is expensive to get wrong: *an annual
subscription is revenue whatever its size* (a table of four amounts spanning five
orders of magnitude) · *the threshold is per unit* (2 × $6,150, with the £8,000
policy where the per-unit and per-line answers genuinely disagree) · *a software
line with no stated term escalates rather than guessing from the vendor* · *a
category not on the client's chart is refused, and not matched to the near miss
it is one character away from* · *no path returns a bare null*, asserted over a
cross product of three charts, three policies and eleven evidence shapes.

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
  ⚠ **Superseded 2 Sep 2026 — the pipeline now calls `decide()`.** See *The
  ladder has a caller* below; the sentence above describes A6's fence, not the
  current wiring.

## ⚠ Owed to other lanes — one line each, and neither is a correctness blocker

1. **`clients-team-settings/client-intake.service.ts`** — after the intake
   transaction commits, call
   `chartOfAccountsService.ensureChartOfAccounts(ctx, business.id)` so a new
   client has its chart (and therefore working chat rule-drafting) from minute
   one. Without it the chart is seeded lazily on the first read instead, which is
   correct but later.
2. ~~**`extraction/extraction-pipeline.ts`**~~ — **DONE, 2 Sep 2026.** See
   *The ladder has a caller* below.
   ⚠ **The warning this item used to carry was answered by NOT doing the thing
   it warned about.** It said calling `decide()` from the pipeline "writes
   `categoryCode` on a fresh document". The call as built writes no category at
   all: it stores an *opinion* beside the fields and leaves
   `documents.category_code` to its one existing writer. That is what makes the
   human-confirmed-coding hazard moot rather than merely avoided.

## The ladder has a caller (2 Sep 2026)

**196 passing tests and nobody calling them.** `decide()` shipped complete and
the accountant still saw a blank Category with no explanation — the reported
bug. The wiring is four small pieces and no new column:

| Where | What |
|---|---|
| `worker/main.ts` | builds `new SupplierCodingService(prisma, new ChartOfAccountsService(prisma))` and hands it to `PrismaExtractionStep` as `coding`. The composition root is the one place that decides which implementation runs. |
| `extraction/coding-advice.ts` | the seam. `DocumentCodingAdvisor` is an interface `SupplierCodingService` satisfies **structurally**, so this module has no idea the pipeline exists and a unit test drives the escalation branch with no database. |
| `extraction/extraction-pipeline.ts` | calls it **inside the existing scoped transaction**, AFTER the rule match and only when that left the document uncoded. Chart, rules and history therefore read from one consistent view — which is what `decide()` takes a `ScopedClient` for. |
| `common/documents/coding-suggestion.ts` | the stored shape and its parse. |

Three invariants, each pinned by a test in
`extraction-pipeline.integration.test.ts` against a real database:

- **⚠ Nothing new writes `documents.category_code`.** The header projection is
  still its one writer, carrying the extractor's value or an accountant's rule.
- **⚠ A suggestion does not make a document Ready.** The mandatory set (Total +
  Supplier + Category) is unchanged; a suggestion is not a category, so an
  advised document lands TO_REVIEW exactly as it did before.
- **A document a rule already coded is never asked about.** `adviseCoding`
  returns before the call — a suggestion beside an explicit instruction is
  pressure to second-guess it, not extra information.

Accepting one is an ordinary `document.update-coding` proposal a human reads and
approves. There is no shortcut and no second door.

## TODO

- [ ] ⚠ **`DocumentLine` — the architectural blocker above.** `prisma/` is LAW
      (G7), so it is a contract-change issue approved before a PR opens, not a
      quiet edit. Everything needed to write the issue is in that section: the
      model, the checksum, the projection that keeps the migration additive, and
      the `document.update-coding` variant it implies.
- [ ] **The capitalisation threshold has no per-practice home.** It is an
      accounting policy, not a rule of law, and it is currently a constructor
      argument defaulting to the platform figure (`PLATFORM_DEFAULT_CAPITALISATION_POLICY`,
      £1,000, `source: 'PLATFORM_DEFAULT'` so no card can present it as the
      practice's). Persisting it wants a `practices` column — LAW again — or a
      practice-settings row. Until then every firm is on our number and is told
      so.
- [x] ~~**No model is wired behind `coding-instructions.ts`.**~~ **DONE, 6 Sep
      2026** (review item 19) — `coding/bedrock-coding.ts`, selected by
      `EXTRACTOR`. Everything that TODO listed as needed is in: the §9.7 budget,
      a cassette corpus (`coding-replay-corpus.ts`), the model pin moved through
      `chat-framework/models.ts` to the judgment tier, and its own §9.8 eval
      family (`pnpm test:eval:coding` — 12 ladder cases + 5 second-opinion
      cases, replayed from `evals/recordings/coding-cassettes/`).
      `CODING_PROMPT_VERSION` is at `coding-instructions-2` and remains this
      module's own, so a coding rule still changes without dragging the chat
      eval gate in.
- [ ] **The escalation RATE is unmeasured, and it is the number the model pin
      rests on.** The blended guardrail (£0.02/document) holds while fewer than
      27% of documents reach the model rung; a document that does costs 3.81p.
      Every ingredient is already recorded — `document_events` writes a `code`
      stage row per document with outcome `suggested` or `escalated` — so this is
      a query and a dashboard line, not new instrumentation. Re-run
      `scripts/measure/coding-cost.ts` when the pin or the chart moves.
- [x] ~~**Nothing consumes the suggestion yet.**~~ Closed in two halves: the
      pipeline began calling `decide()` on 2 Sep 2026, and the LEARNED_HISTORY
      half — which reached no screen at all — on 6 Sep 2026 (item 48). The
      `DocumentPreview` panel renders both, verified live.
- [ ] **The "make it a rule?" follow-on has no caller.**
      `buildSupplierRuleProposal` / `proposeSupplierRule` are built and tested
      and nothing in the product invokes them, because this module publishes no
      controller. Item 48's optional half — *"You've coded Aldgate Meats to Food
      5 times — make it a rule?"* — is that call plus a surface, and the surface
      needs a contract operation (G7). Supplier memory now covers the behaviour
      it was wanted for; formalising a repeated treatment as a standing rule is
      the part still owed.
- [ ] ⚠ **THE A7/A9 HANDSHAKE THIS MODULE'S SEAM PROMISES IS NOT WIRED, and it
      is now visible to accountants.** `index.ts` names the export as consumer
      one: *"the VT emitter's `Analysis account` column must carry the ledger
      prefix — literally `Cost of sales: Purchases`. Map a document's
      `categoryCode` with `resolveAccount` + `analysisAccount`."* Nothing does.
      `exports-public-api/api/document-to-canonical.ts` passes
      `documents.category_code` straight through, so the column carries a bare
      `SUBSCRIPTIONS`, and VT type-guesses a bare code as a NUMBER rather than an
      account (§24.3.1). The emitter has always raised
      `analysis-account-unprefixed` for it, but that warning only ever appeared
      on a finished export nobody re-read.
      **It is now on the publish review card**, per document, because the entry
      preview (2 Sep 2026) is built by the real emitter and carries its warnings
      — so an accountant sees "no ledger prefix" *before* they release. That
      makes this the sharpest open item on this seam rather than a latent one.
      The fix is `ChartOfAccountsService.getChartOfAccounts` → `resolveAccount` +
      `analysisAccount` at the point `document-to-canonical.ts` builds
      `analysisAccount`; it changes what the export file contains, so it wants
      its own change and its own round-trip check, not a drive-by edit.
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
