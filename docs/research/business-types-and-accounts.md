# Business types and the accounts they use — HMRC, ATO, and the standards behind the coding rules

> **Status:** research reference. **This document changes no behaviour.** It records the sources
> behind `apps/api/src/modules/rules-suggestions/` and checks the code against them. Where code and
> source disagree, the disagreement is written up in §7 *Findings and recommendations* and the code
> is left alone — the module belongs to another lane and a silent change to a coding engine must be
> a deliberate, reviewed decision (G7, Governance §10).
>
> **Author:** research agent, 2026-09-03. **Citation rule:** every non-obvious claim carries a URL or
> a manual reference. Anything I could not source says **not verified** rather than being filled in.

## Contents

1. [Executive summary](#1-executive-summary)
2. [Business types and their charts of accounts](#2-business-types-and-their-charts-of-accounts)
3. [UK / HMRC](#3-uk--hmrc)
4. [Australia / ATO](#4-australia--ato)
5. [Bookish knowledge — the standards basis](#5-bookish-knowledge--the-standards-basis)
6. [Where a category genuinely cannot be decided](#6-where-a-category-genuinely-cannot-be-decided)
7. [What the code currently encodes](#7-what-the-code-currently-encodes)
8. [Findings and recommendations](#8-findings-and-recommendations)
9. [The line-item limitation](#9-the-line-item-limitation)

---

## 0. Inventory — every number, threshold, category list and rule the code encodes

*Written first, from the code alone, before any research. This is the list of claims §7 checks.*

**Files read:** `apps/api/src/modules/rules-suggestions/chart-of-accounts/{profiles,account,chart-of-accounts}.ts`,
`.../coding/{capital-revenue,escalation,authority,ai-suggestion,coding-instructions,supplier-coding.service}.ts`,
`.../CLAUDE.md`.

### 0.1 Structural constants

| Constant | Value | File |
|---|---|---|
| `BUSINESS_PROFILE_IDS` | `GENERAL_BUSINESS`, `SERVICES_WITH_STAFF`, `TRADE_AND_CONSTRUCTION`, `RETAIL_AND_HOSPITALITY` | `profiles.ts` |
| `LEDGERS` | `Sales`, `Cost of sales`, `Expenses`, `Fixed assets`, `Current assets` (5) | `account.ts` |
| `VAT_TREATMENTS` | `STANDARD`, `ZERO_OR_EXEMPT`, `OUTSIDE_SCOPE`, `BLOCKED`, `VARIES` | `account.ts` |
| `TAX_CONSEQUENCES` | `ALLOWABLE`, `DISALLOWABLE`, `CAPITAL` | `account.ts` |
| `CODING_AUTHORITIES` | `ACCOUNTANT_RULE` → `PRACTICE_DEFAULT` → `CLIENT_CONTEXT` → `LEARNED_HISTORY` → `AI_INFERENCE` | `authority.ts` |
| `RULE_TIER_PRECEDENCE` | `USER`, `PAYMENT_METHOD`, `SUPPLIER_CUSTOMER`, `ACCOUNT_DEFAULT` | `authority.ts` |
| `CODING_ESCALATION_REASONS` | 10, in severity order (see §6) | `escalation.ts` |
| `CODING_ADVISORIES` | 6: `FOREIGN_TAX_IN_COST`, `REVERSE_CHARGE_INCREASES_BASE`, `ANNUAL_FEE_MAY_BE_PART_PREPAID`, `PER_UNIT_THRESHOLD_APPLIED`, `THRESHOLD_COMPARED_WITHOUT_FX`, `NEW_SUPPLIER` | `escalation.ts` |
| `CODING_BASES` | 18 named bases | `capital-revenue.ts` |
| `CODING_PROMPT_VERSION` | `coding-instructions-1` | `coding-instructions.ts` |
| `HISTORY_WINDOW` | 200 (learned-history lookup bound) | `supplier-coding.service.ts` |

### 0.2 The core chart — 37 accounts

`Sales`: `SALES`, `OTHER_INCOME`.
`Cost of sales`: `COS_PURCHASES`.
`Expenses` (people): `WAGES_AND_SALARIES`, `EMPLOYER_NI_AND_PENSION`, `STAFF_WELFARE`, `TRAINING`.
`Expenses` (premises): `RENT`, `RATES_AND_WATER`, `LIGHT_HEAT_AND_POWER`, `REPAIRS_AND_MAINTENANCE`, `INSURANCE`.
`Expenses` (running): `MOTOR_EXPENSES`, `TRAVEL_AND_SUBSISTENCE`, `TELEPHONE_AND_INTERNET`, `SOFTWARE_AND_SUBSCRIPTIONS`, `HOSTING_AND_INFRASTRUCTURE`, `IT_SUPPORT_AND_MANAGED_SERVICES`, `SOFTWARE_IMPLEMENTATION`, `IT_EQUIPMENT_AND_CONSUMABLES`, `OFFICE_COSTS`, `ADVERTISING_AND_MARKETING`, `PROFESSIONAL_FEES`, `BANK_CHARGES`.
`Expenses` (separately identifiable): `BUSINESS_ENTERTAINING` (BLOCKED/DISALLOWABLE), `CHARITABLE_DONATIONS` (OUTSIDE_SCOPE/DISALLOWABLE), `POLITICAL_DONATIONS` (DISALLOWABLE), `FINES_AND_PENALTIES` (DISALLOWABLE), `DEPRECIATION` (DISALLOWABLE), `PRIVATE_USE` (BLOCKED/DISALLOWABLE).
`Fixed assets`: `FA_PLANT_AND_EQUIPMENT`, `FA_COMPUTER_EQUIPMENT`, `FA_FIXTURES_AND_FITTINGS`, `FA_MOTOR_VEHICLES` (VAT BLOCKED), `FA_SOFTWARE_LICENCES`, `FA_INSTALLATION_AND_COMMISSIONING`.
`Current assets`: `PREPAYMENTS` (taxConsequence `ALLOWABLE`, deliberately not `CAPITAL`).

**Profile additions.** `SERVICES_WITH_STAFF` (+5): `COS_MATERIALS_AND_CONSUMABLES`, `COS_SUBCONTRACTORS`, `COS_EQUIPMENT_HIRE`, `UNIFORMS_AND_PPE`, `LICENCES_AND_COMPLIANCE`.
`TRADE_AND_CONSTRUCTION` (+6): `COS_MATERIALS`, `COS_SUBCONTRACTORS_CIS` (VAT `VARIES`, reverse-charge note), `COS_PLANT_AND_TOOL_HIRE`, `TOOLS_AND_SMALL_EQUIPMENT`, `SITE_COSTS`, `UNIFORMS_AND_PPE`.
`RETAIL_AND_HOSPITALITY` (+6): `COS_STOCK_FOR_RESALE`, `COS_FOOD_AND_DRINK` (VAT `VARIES`), `COS_PACKAGING`, `CARD_AND_PLATFORM_FEES` (VAT `VARIES`), `CLEANING_AND_WASTE`, `LICENCES_AND_COMPLIANCE`.

**No `SUNDRY` / catch-all, by design.** Deliberately absent: internally-developed-software account (IAS 38.57 judgement), a professional-services profile.

### 0.3 Numeric thresholds and rates

| Number | Where | What it claims |
|---|---|---|
| **£1,000** (`thresholdPence: 100_000`, `GBP`) | `PLATFORM_DEFAULT_CAPITALISATION_POLICY` | Default capitalisation threshold, `source: 'PLATFORM_DEFAULT'`. Explicitly *"a common small-practice threshold … stated as a default, not as a standard"* |
| **10%** (`boundaryBandPercent`) | same | Within ±10% of threshold ⇒ `ON_THE_LINE` ⇒ escalate `THRESHOLD_BOUNDARY` |
| **two years** | `capital-revenue.ts` header, `FA_SOFTWARE_LICENCES.reviewNote`, `coding-instructions.ts` rule 4, basis `SUBSCRIPTION_TERM_UNDER_TWO_YEARS` | "HMRC BIM35805 puts software with a useful life under two years on the revenue side"; ≥2 years or perpetual ⇒ capital |
| **8.875%** | `ai-suggestion.ts`, `escalation.ts` | The example invoice's stated tax rate (US sales tax); used only as narrative for the arithmetic hard stop |
| **62.5% / 20.8% / 36%** | `ai-suggestion.ts`, module `CLAUDE.md` | Intuit/QuickBooks published categoriser accuracy: top-1, unseen-category, zero-shot |
| **~10 points** | `SECOND_CHOICE_CONFIDENCE = 0.1` | Published top-2 accuracy runs ~10pts above top-1 |
| **0.9 … 0.35** | `CONFIDENCE_BY_BASIS` | Display-only confidence per basis; anchored to the 62.5% figure |
| **0.1** | `NEW_SUPPLIER_CONFIDENCE_PENALTY` | New-supplier display penalty |
| **0.3** | `CONFIDENCE_FLOOR` | Nothing displayed below this |
| **1 + n pence** | `toleranceFor(lineCount)` | Arithmetic-reconciliation slack |
| **200** | `HISTORY_WINDOW` | Learned-history lookup bound |

### 0.4 The decision rules, as encoded

Branch order in `classifyLine()` **is** the rule (0 → 8):

0. `TAX_LINE` regex ⇒ `TAX_LINE` outcome, never a category. (`sales tax|use tax|state tax|gst|hst|pst|vat|consumption tax`)
1. `TRAINING` ⇒ `TRAINING`, REVENUE, basis `TRAINING_NEVER_CAPITAL`. Cited: IAS 16.19(c), IAS 38.69(b).
2. Support/managed service (specific words alone; generic words `support|maintenance|monitoring|warranty` only in an IT context) ⇒ `IT_SUPPORT_AND_MANAGED_SERVICES`, REVENUE.
3. Hosting/cloud/IaaS/colocation ⇒ `HOSTING_AND_INFRASTRUCTURE`, REVENUE, *"never capital, at any amount"*.
4. Software: **perpetual language** ⇒ threshold test ⇒ `FA_SOFTWARE_LICENCES` CAPITAL / `SOFTWARE_AND_SUBSCRIPTIONS` REVENUE if below / escalate if on the line. **Recurring language** ⇒ `SOFTWARE_AND_SUBSCRIPTIONS` REVENUE regardless of amount. **Neither** ⇒ escalate `SOFTWARE_TERM_UNKNOWN`.
5. Services: install **and** configure ⇒ escalate `MIXED_CAPITAL_AND_REVENUE`. Install only ⇒ `FA_INSTALLATION_AND_COMMISSIONING` CAPITAL if the document has capital hardware, else `SOFTWARE_IMPLEMENTATION` REVENUE. Configure only ⇒ escalate if capital hardware present, else `SOFTWARE_IMPLEMENTATION` REVENUE. Cited: IAS 16.17(d)–(e), IFRIC cloud agenda decisions.
6. Small IT before hardware ⇒ `IT_EQUIPMENT_AND_CONSUMABLES` REVENUE.
7. Hardware ⇒ the **only** place an amount decides anything. Per-unit test `net ≥ threshold × units` (integer, no division).
8. Keyword match on this client's own chart ⇒ whatever the chart says; else escalate `NO_MATCH_ON_CHART`.

Document-level (`suggestCoding`): no chart ⇒ `NO_CHART_OF_ACCOUNTS`; **arithmetic before classification** ⇒ `ARITHMETIC_MISMATCH`; any line escalation beats a coded majority; >1 distinct code with >1 treatment ⇒ `MIXED_CAPITAL_AND_REVENUE`, else `MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT`; no lines ⇒ supplier-name fallback ⇒ `NEW_SUPPLIER_NO_HISTORY` / `NO_LINE_DETAIL`.

### 0.5 Citations the code makes (the claims to verify)

| # | Claim as stated in code | Where |
|---|---|---|
| C1 | HMRC **BIM35805** — software with a useful life under two years is revenue | `profiles.ts`, `capital-revenue.ts`, `coding-instructions.ts`, `escalation.ts`, `ai-suggestion.ts` |
| C2 | **CAA 2001 s.71** — UK tax treats computer software as plant | same |
| C3 | **IFRIC agenda decision, March 2019** — a right to access supplier-hosted software is a service contract, not an intangible | `profiles.ts`, `account.ts`, `capital-revenue.ts` |
| C4 | **IFRIC cloud-arrangement agenda decisions** — configuration/customisation of supplier-hosted software is expensed | `profiles.ts`, `coding-instructions.ts` |
| C5 | **IAS 16.17(d)–(e)** — site preparation, installation/assembly and testing are directly attributable and capitalise into the asset | `profiles.ts`, `capital-revenue.ts`, `coding-instructions.ts` |
| C6 | **IAS 16.19(c)** and **IAS 38.69(b)** — staff training is expensed as incurred, never capitalised | same |
| C7 | **IAS 38.57** — six criteria for capitalising development spend | `profiles.ts`, module `CLAUDE.md` |
| C8 | **HMRC VATPOSS14600** — for a UK reverse charge, foreign tax forming part of the cost increases the value the charge is calculated on | `escalation.ts`, `ai-suggestion.ts`, `coding-instructions.ts` |
| C9 | There is **no statutory de minimis** for capitalisation in UK GAAP or IFRS | `capital-revenue.ts`, `escalation.ts`, `profiles.ts` |
| C10 | Business entertaining is disallowable for CT **and** its input VAT is blocked | `profiles.ts` |
| C11 | Commercial rent is exempt unless the landlord has opted to tax | `profiles.ts` |
| C12 | Insurance is VAT-exempt | `profiles.ts` |
| C13 | Input VAT on a car is blocked; on a commercial van it usually is not | `profiles.ts` |
| C14 | CIS domestic reverse charge: subcontractor invoice often carries no VAT for the customer to reclaim | `profiles.ts` |
| C15 | Most cold food bought in is zero-rated; hot and eat-in supplies are standard-rated | `profiles.ts` |
| C16 | Card processing is an exempt financial service; delivery-platform commission is standard-rated | `profiles.ts` |
| C17 | Foreign consumption tax (US sales tax, EU VAT, AU GST) is part of the cost and never reclaimable UK input VAT | `escalation.ts`, `coding-instructions.ts` |
| C18 | Charitable donations are relieved but not as a trading deduction | `profiles.ts`, `account.ts` |
| C19 | Intuit/QuickBooks categoriser: 62.5% top-1, 20.8% unseen category, 36% zero-shot; top-2 ≈ +10pts | `ai-suggestion.ts`, `CLAUDE.md` |
| C20 | **Repairs vs improvements** is the tier-1 UK judgement | `profiles.ts` `REPAIRS_AND_MAINTENANCE.reviewNote` |

**⚠ Nothing in the code mentions Australia except one word.** `GST` appears in the `TAX_LINE` regex and Australian GST is named in `escalation.ts` as an example of non-reclaimable foreign tax. **There is no ATO threshold, no instant asset write-off figure, no effective-life reference and no AU chart anywhere in this module.** That is itself the finding for §4 — see §8.

---

## 6. Where a category genuinely cannot be decided — the escalation cases

The module has **no bare-null path**. Every answer is a `SUGGEST` (code + confidence + named basis)
or an `ESCALATE` carrying one of ten reasons from a closed set (`coding/escalation.ts`). This section
records why each is an *honest refusal* rather than a failure, because the accountant now reads the
prompt on screen.

The set is in **severity order** and the document reports the worst reason found on any line
(`moreSevere()`, and `escalationSeverity()` is the array index — there is deliberately no second
table to fall out of sync).

| # | Reason | Why it is a refusal, not a failure | Grounded in |
|---|---|---|---|
| 1 | `ARITHMETIC_MISMATCH` | The document does not add up, so **no category is being assigned to the right number**. A hard stop before any classification runs. The example invoice: $52,550.00 subtotal at a stated 8.875% is $57,213.81; the document says $54,352.51 (an implied 3.43%). | Internal control principle, not a standard. `documentReconciles()` accepts three readings (gross lines / net lines + per-line tax / net lines + header tax) and fails only when **none** reconciles, so it does not manufacture a mismatch out of not knowing whether lines were quoted net or gross. Tolerance `1 + n` pence. |
| 2 | `NO_CHART_OF_ACCOUNTS` | Every code would be off-chart by construction. | Structural |
| 3 | `CODE_NOT_ON_CHART` | A near miss on a chart of accounts is an **invisible** error — food costs quietly become drink costs and the approver cannot see it happened. Refused, never fuzzy-matched. | The same stance `chat-framework/drafts.ts` takes for a chat-drafted rule |
| 4 | `NO_LINE_DETAIL` | Rule 1 is *line description beats supplier identity*. With neither, there is nothing to beat anything with. | §0.4 rule 1 |
| 5 | `SOFTWARE_TERM_UNKNOWN` | **The most consequential unknown on an IT invoice.** The same product name is capital when perpetual and revenue when annual, and the two invoices can be identical apart from one word. Inferring the term from the vendor is guessing with a citation attached. | §3 (BIM35805, CAA 2001 s.71) and §5 (IFRIC SaaS) |
| 6 | `MIXED_CAPITAL_AND_REVENUE` | One line covers both treatments and must be **split**. Picking the larger half would be picking by magnitude, which rule 2 forbids. | §5 (IAS 16.17 vs IFRIC configuration vs IAS 16.19 training) |
| 7 | `MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` | ⚠ **This one is not a limitation of the rules — it is the schema's.** The lines were classified successfully; `documents.category_code` is one nullable string and cannot hold the answer. The candidate codes travel with the escalation so the accountant sees the split that was found rather than an empty field. See §9. | Schema, not accounting |
| 8 | `THRESHOLD_BOUNDARY` | A per-unit amount within ±10% of the practice's threshold, or no amount to test. There is no statutory de minimis, so an item on the line is a **judgement, not a calculation** — a rule that resolved it by rounding would be inventing the policy it is meant to apply. | §5.9 |
| 9 | `NO_MATCH_ON_CHART` | Reported rather than approximated. A code chosen because it was the closest of a bad set is `CODE_NOT_ON_CHART`'s failure mode arrived at from the other direction. | Structural |
| 10 | `NEW_SUPPLIER_NO_HISTORY` | The terminal reason — the one that guarantees an answer when nothing else applied. A new supplier is always-review. | §24.4.1; accuracy ceiling in §0.3 / C19 |

**Why the set is closed.** A free-text reason cannot be rendered as a specific affordance, cannot be
counted and cannot be tested. A closed one can: `SOFTWARE_TERM_UNKNOWN` becomes *"is this a
subscription or a perpetual licence?"* with two buttons, and a regression that starts escalating
everything shows up as a shift in one histogram.

**Why the prompts say what would resolve it, not what went wrong.** `ESCALATION_PROMPTS` is written
to be rendered next to the empty field. *"This line does not say whether the licence is perpetual or
annual"* is a question someone answers in five seconds; *"could not determine category"* is not. That
distinction is the entire product difference between an escalation and a failure.

**The six advisories are the opposite move** — things worth saying about a coding that *was*
offered. They never block and never change the code: `FOREIGN_TAX_IN_COST`,
`REVERSE_CHARGE_INCREASES_BASE`, `ANNUAL_FEE_MAY_BE_PART_PREPAID`, `PER_UNIT_THRESHOLD_APPLIED`,
`THRESHOLD_COMPARED_WITHOUT_FX`, `NEW_SUPPLIER`. Each exists because the rule that produced the code
has a consequence somewhere **other than the category column** — a VAT return, a year-end journal, a
fixed-asset register, or an FX assumption nobody made.

---

## 9. The line-item limitation — the root cause of the original report

### 9.1 What is actually true today

Verified against the repository on 2026-09-03:

- `prisma/schema.prisma` line 607: `categoryCode String? @map("category_code")` on `Document`.
  **One nullable free-text string. No enum, no foreign key, no line-item model.**
- The only `*Line` model in the schema is `SupplierStatementLine` (statement reconciliation) —
  there is **no `DocumentLine`**.
- Line items exist only as **smuggled JSON**: `readStoredLines()` in
  `coding/supplier-coding.service.ts` parses `extractions.fields.lineItems` out of a `Json` column,
  because *"the `Extraction` row has no line-item column"*. A line with no readable description is
  dropped rather than passed on as an empty string.
- The export emitters **already** write **one row per analysis line**
  (`emitters/vt/vt-transaction-plus-emitter.ts`, `emitters/generic-csv/generic-csv-emitter.ts`;
  `collapseAnalysis()` was deleted). The mechanism exists and is fed a single category.

### 9.2 Why this is the root cause, not a side issue

The invoice that started this work needs **five different treatments on one document**:

| Line | Correct treatment | Why |
|---|---|---|
| Annual subscription | REVENUE — `SOFTWARE_AND_SUBSCRIPTIONS` | §3 / §5: right of access is a service |
| 2 × server @ $6,150 | CAPITAL — `FA_COMPUTER_EQUIPMENT` | per-unit threshold test |
| Licence, term not stated | **unanswerable** | escalates `SOFTWARE_TERM_UNKNOWN` |
| "Professional services — setup and configuration" | **splits** — part CAPITAL, part REVENUE | IAS 16.17 vs IFRIC configuration |
| Training | REVENUE, always | IAS 16.19 / IAS 38.69 |

**There is no value of a single string that is correct.** Two of the ten escalation reasons —
`MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` and `MIXED_CAPITAL_AND_REVENUE` — exist **because of the
schema, not because of the rules**. The lines were classified successfully and the answer could not
be written down. That is a materially different thing from the engine being unable to decide, and
the document should say so where an accountant can read it.

It also degrades the export twice over: a five-treatment invoice leaves as one row carrying one bare
category, and (separately, and already visible on the publish review card) that category has no
ledger prefix, so VT type-guesses it as a number rather than an account.

### 9.3 What per-line categorisation would require

The module's `CLAUDE.md` already carries a `DocumentLine` proposal. It is a real proposal rather
than a table because of four properties, and all four are load-bearing:

1. **A checksum enforced at the write site.** `Σ netPence + Σ taxPence` must equal
   `documents.total_pence` to within a penny per line (the same `1 + n` tolerance
   `documentReconciles()` already uses), and a write that does not balance is **refused**. Lines that
   do not sum to the document are worse than no lines: they look authoritative and quietly change a
   total.
2. **`documents.category_code` stays, and stays authoritative for a single-treatment document.** It
   becomes a *projection*: the single distinct line category, or `null` when there is more than one.
   Nothing that reads the column today changes — which is what makes the migration **additive**
   rather than a rewrite, and additive is the difference between a contract-change issue that can be
   approved and one that cannot.
3. **`document.update-coding` gains a line-scoped variant**, so a human corrects line 4 rather than
   the document, and the human lock (`LOCKED`, `documentLockFor`) becomes **per line**. Every
   correction is still an approved `ActionProposal` — Governance §10 is not relaxed anywhere.
4. **The export gains the row-per-line it was already built for**, and D43's source-document link is
   unchanged because every line resolves to the same document.

**What else it would touch, that the proposal does not yet spell out:**

- **The extraction contract.** `lineItems` currently rides inside `extractions.fields` as untyped
  JSON parsed defensively at read time. A real table means the extractor's output schema
  (`extraction/bedrock-extraction-schema.ts`) becomes the authority on line shape, and the
  defensive both-shapes parse in `readStoredLines()` (bare value *or* `{ value }` wrapper) becomes a
  migration concern rather than a permanent tolerance.
- **`hasCapitalHardware` becomes a stored fact rather than a derived one.** `classifyLine()` takes it
  in `LineContext` and computes it per call by scanning sibling lines
  (`evidence.lines.some(capitalisesAsHardware)`). With persisted lines, whether installation work
  capitalises depends on a sibling row that a human may since have re-coded — so the derivation has
  to re-run on any line edit, or the answer goes stale silently. **This is the subtlest consequence
  of the change and it is not currently written down anywhere.**
- **Per-line provenance and confidence**, so §13.3's "every value displays its provenance class"
  survives the move from document to line. The proposed model has these fields; the *surfaces* do
  not.
- **Idempotency and re-extraction.** `@@unique([documentId, ordinal])` gives a natural key, but a
  re-run of extraction that produces a different number of lines has to reconcile against human
  edits already made against ordinals. Deleting and re-inserting would silently destroy a human's
  per-line correction — which is the one thing the module's second guarantee forbids.
- **The `MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` escalation would largely disappear**, and
  `MIXED_CAPITAL_AND_REVENUE` would narrow to its genuine meaning: a *single line* that covers both
  treatments and needs splitting into two lines. That is a real accounting escalation and would
  survive. The other one is an artefact.

**Governance note.** `prisma/` is LAW (G7). This is a contract-change issue approved before a PR
opens, not a quiet edit. Everything needed to write that issue is in the module's `CLAUDE.md` plus
the five bullets above.

---

## 8b. Internal-source findings (checked against `docs/Source_Of_Truth.md`, not the web)

These are checks of the code against **this project's own governing document**, and both are real
divergences. Recorded here because they need no external verification.

### F-INT-1 — The capitalisation threshold is required by the SoT to be per-practice, and it is not persisted

SoT §24.4.6 (line 1272–1275) says, verbatim:

> *"Materiality needs a stated policy, not a guess. Capital-versus-revenue is Tier 1, and the
> practical answer practices use is an explicit capitalisation threshold. That threshold is a
> **per-practice setting** in ID, and it is what drives the fixed-asset-review flag — never a
> hard-coded number."*

**What the code does:** `CapitalisationPolicy` is a value passed as a constructor argument, which is
architecturally right and is exactly what "never a hard-coded number" asks for. But there is **no
per-practice storage**, so every practice runs on `PLATFORM_DEFAULT_CAPITALISATION_POLICY`
(£1,000, ±10%, `source: 'PLATFORM_DEFAULT'`). The module's own `CLAUDE.md` TODO states this
plainly and the `source` field is carried to the surface so no card can present our number as the
practice's — which is the honest interim, not a fix.

**Assessment:** the design is correct and the requirement is **unmet**. It wants a `practices`
column or a practice-settings row, which is LAW (G7) and therefore a contract-change issue.
`source: 'PRACTICE'` is already in the type, so the code change once the column exists is small.
**Verdict: not a defect in the rules — an unshipped requirement.** Priority is higher than it looks,
because §8's threshold band (±10% of £1,000 = £900–£1,100) is where `THRESHOLD_BOUNDARY`
escalations are generated, so the platform default is currently deciding how much review work every
practice gets.

### F-INT-2 — The SoT expects confidence to gate; the code deliberately refuses to let it

SoT §24.4.6 (line 1231–1232) says the tiers should drive *"the AI's confidence gating, the review
queue's ordering and the flags shown to the accountant"*.

**What the code does:** `ai-suggestion.ts` states the opposite as an invariant — *"⚠ The confidence
gates nothing … no branch in this repository may compare it to a number. It exists to be
displayed."* — inheriting `modules/extraction`'s rule that *thresholds come from eval measurements,
never from model self-reported confidence*.

**Assessment: the code is right and the SoT sentence is the one that should move.** A
self-reported confidence is not a measurement, and gating on one is how a categoriser with a 62.5%
ceiling (C19, see §7) produces silent wrong codings at "high confidence". The SoT's *other* two
clauses — queue ordering and flags shown — are satisfied by the tier metadata on the chart
(`taxConsequence`, `vatTreatment`, `reviewNote`), which is the correct mechanism for them. **I would
not change the code. I would raise a SoT wording amendment** so the next reader does not implement
the gate.

### F-INT-3 — The accuracy figures (C19) are internally consistent with the SoT

SoT §24.4.7 records *"roughly 62% top-1 accuracy"* from *"an incumbent's own research publication
rather than its marketing"*, splitting into **~79%** where the category is already seen in this
client's history and **~21%** where it is not, *"and near zero for pure nearest-neighbour
matching"*. It also records the two claims the code leans on: *"top-2 runs materially above top-1"*
and the warning that every vendor "99%" is **precision on the subset the system already judged
high-confidence**, not accuracy across all documents.

The code's `62.5% / 20.8% / 36%` therefore matches the SoT's `~62% / ~21%` on the two figures they
share; `36% zero-shot` is an additional figure the SoT does not carry. The internal chain is
consistent. **Whether the ultimate source says these numbers is a separate question** — see C19 in
§7, where it is marked according to what the external search found. The module `CLAUDE.md`'s claim
that its figures are *"worse than §24.4.7's"* is not quite right: 20.8% vs ~21% is the same number,
and 62.5% vs ~62% is the same number. Only the zero-shot 36% is new. Harmless, but it is a small
piece of internal folklore that has hardened into a comment.

⚠ **The most useful sentence in §24.4.7 is one the code does not cite, and should:** *"there is
**no published study of how often two competent bookkeepers agree** on expense categorisation.
Vendors claiming to beat human accuracy have no human baseline to beat."* That is the honest frame
for every escalation in §6 — a meaningful share of what looks like model error is genuine
professional disagreement, which is precisely why the design refuses rather than guesses.

### F-INT-4 — Australia is not in scope anywhere in the product, and the ATO material is comparative only

Checked 2026-09-03: **`docs/Source_Of_Truth.md` contains zero occurrences of "Australia", "ATO" or
"GST".** The root `CLAUDE.md` defines the product as *"a chat-first document-to-bookkeeping platform
for **UK accounting practices**"*. In the coding module, the only Australian trace is the word `gst`
inside the `TAX_LINE` regex and one mention of *"Australian GST"* in `escalation.ts` as an example
of a **foreign** consumption tax that must never reach a tax control account.

**This is the correct treatment for a UK product**, and it is worth stating explicitly so nobody
reads §4 of this document as an unimplemented requirement:

- Australian GST appearing on a document processed by this product is, by definition, **foreign tax
  on a UK client's purchase** — part of the cost, never reclaimable input VAT. The code says exactly
  that and says it in the right place.
- The ATO material in §4 is therefore **comparative research**, useful for two things only:
  (a) sanity-checking that the capital/revenue architecture is not accidentally UK-specific in a way
  that would block a future market, and (b) knowing what an AU expansion would actually cost.
- **⚠ The one thing §4 must not become is a set of thresholds someone half-implements.** An AU
  instant-asset-write-off figure hardcoded into a UK product would be worse than absent: it would
  look authoritative on a card. The `CapitalisationPolicy` value-not-constant design already
  generalises correctly — a jurisdiction would supply a different policy, not a different rule.

**Verdict: nothing to fix. §4 is documentation of a road not taken, and the thresholds in it are
recorded with dates precisely so a stale one is visibly stale.**

---

## 5. Bookish knowledge — the accounting-standards basis

This is what the code's capital-versus-revenue rule actually rests on. **The rule is stated
correctly; one of its citations is not.**

> **Method note.** IAS/IFRS full text is paywalled on ifrs.org. Verbatim paragraph text below was
> taken from the AASB's compiled standards (the AASB reproduces IASB text word-for-word with
> identical paragraph numbering; only cross-references are renamed) and from EUR-Lex's legally
> adopted IAS text. Agenda decisions, the Conceptual Framework and FRS 102 were verified from
> ifrs.org and FRC primary documents directly.

### 5.1 ⚠ IAS 16.17 — the code cites the wrong sub-paragraphs

The code says, in four places, *"site preparation, installation and assembly, and the cost of
testing that the asset works, are directly attributable costs — **IAS 16.17(d)–(e)**"*.

The actual lettering of IAS 16.17
([AASB 116, verbatim mirror of IAS 16](https://www.aasb.gov.au/admin/file/content105/c9/AASB116_08-15.pdf)):

| Letter | Text |
|---|---|
| (a) | costs of employee benefits arising directly from the construction or acquisition |
| **(b)** | **costs of site preparation** |
| (c) | initial delivery and handling costs |
| **(d)** | **installation and assembly costs** |
| **(e)** | **costs of testing whether the asset is functioning properly** |
| (f) | professional fees |

**So `(d)–(e)` covers installation/assembly and testing only — it does not cover site preparation,
which is (b).** The correct citation for the trio the code describes is **IAS 16.17(b), (d) and
(e)**, read with **IAS 16.16(b)** (*"any costs directly attributable to bringing the asset to the
location and condition necessary for it to be capable of operating in the manner intended by
management"*), which is the paragraph that actually makes them part of cost.

⚠ **A second, separate problem with 17(e).** *Property, Plant and Equipment — Proceeds before
Intended Use (Amendments to IAS 16)*, issued May 2020, **deleted** the old requirement to deduct
net proceeds of items sold during testing; such proceeds and their costs now go to profit or loss
(new IAS 16.20A). Effective for periods beginning on or after **1 January 2022** (IAS 16.81N).
[IFRS project page](https://www.ifrs.org/projects/completed-projects/2020/property-plant-and-equipment-proceeds-before-intended-use/) ·
[Commission Regulation (EU) 2021/1080](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32021R1080).
The code does not quote the old wording, so it is not wrong here — but anyone extending it should
not reach for a pre-2022 copy of the standard.

**The rule the code implements is nonetheless correct.** `FA_INSTALLATION_AND_COMMISSIONING`
capitalising into an asset that exists on the same document is exactly what IAS 16.16(b) and
17(b)/(d)/(e) require. Only the citation string is wrong.

### 5.2 IAS 16.19(c) — right letter, slightly overstated

Verbatim (same source): *"19 Examples of costs that are not costs of an item of property, plant and
equipment are: … **(c) costs of conducting business in a new location or with a new class of
customer (including costs of staff training)**; and (d) administration and other general overhead
costs."*

**The letter is right.** The nuance: 19(c) mentions training only as an example *within* "conducting
business in a new location or with a new class of customer". It is not, on its own, a blanket
"training is always expensed" rule. The blanket rule is **IAS 38.69(b)**.

**Recommended wording** (a documentation fix, not a behaviour change): *"training costs are not
directly attributable costs of PPE (IAS 16.19(c)) and are expensed as incurred (IAS 38.69(b))"*.
The code already cites both together everywhere, so the pairing is right — it is only the
implication that 19(c) alone carries the general rule that is loose.

### 5.3 IAS 38.69(b) — correct

Verbatim ([AASB 138](https://www.aasb.gov.au/admin/file/content105/c9/AASB138_08-15.pdf)): *"69 …
Other examples of expenditure that is recognised as an expense when it is incurred include: (a)
expenditure on start-up activities…; **(b) expenditure on training activities**; (c) … advertising
and promotional activities…; (d) … relocating or reorganising…"*

Also directly load-bearing for the whole service-contract argument, the chapeau of 69: *"In the case
of the supply of services, the entity recognises the expenditure as an expense **when it receives
the services**."* And 69A: services are received *"when they are performed by a supplier in
accordance with a contract"*, not when the entity uses them.

**`TRAINING_NEVER_CAPITAL` as a bright line is correct**, and it is one of the very few genuinely
bright lines in this area — the code's characterisation is accurate.

### 5.4 IAS 38.57 — correct, exactly six criteria, and mandatory

*"An intangible asset arising from development … **shall be recognised if, and only if**, an entity
can demonstrate all of the following:"* — (a) technical feasibility; (b) intention to complete and
use or sell; (c) ability to use or sell; (d) how it will generate probable future economic benefits;
(e) availability of adequate technical, financial and other resources; (f) ability to measure the
expenditure reliably. ([AASB 138](https://www.aasb.gov.au/admin/file/content105/c9/AASB138_08-15.pdf))

Six, as the code says. Note **"shall … if, and only if"** — under IAS 38 capitalisation is
*required* once all six are met, not optional. **The code's decision to omit an
internally-developed-software account is well-founded**: these are a judgement about a project, not
a fact on an invoice, and offering the code would invite a bespoke-development line to be
capitalised because an account existed for it.

### 5.5 The SaaS agenda decision — March 2019 confirmed

- **Title:** *"Customer's Right to Receive Access to the Supplier's Software Hosted on the Cloud
  (IAS 38 Intangible Assets)"*.
- **Date: final agenda decision published in the IFRIC Update of March 2019** —
  [ifrs.org](https://www.ifrs.org/news-and-events/updates/ifric/2019/ifric-update-march-2019/).
  **The code's repeated "March 2019" is correct.** (A tentative version circulated earlier; March
  2019 is the final.)
- **Conclusion:** a contract conveying only the right to *access* the supplier's application
  software over the term is a **service contract**, not a software intangible and not a lease —
  the customer does not control the software, because the supplier retains the decision-making
  rights over how and when it is updated and reconfigured, and over the infrastructure.
- **On prepayments:** *"If the customer pays the supplier before it receives the service, that
  prepayment gives the customer a right to future service and is an asset for the customer."*

This is the direct authority for `HOSTING_AND_INFRASTRUCTURE` and `SOFTWARE_AND_SUBSCRIPTIONS`
being incapable of capitalisation at any amount, and for `PREPAYMENTS` existing in `Current assets`
rather than as an intangible. **All three are correctly grounded.**

### 5.6 The configuration/customisation agenda decision — "April 2021" is right

- **Title:** *"Configuration or Customisation Costs in a Cloud Computing Arrangement (IAS 38)"*.
- **Date nuance:** the Committee finalised it at its **March 2021** meeting; under the Due Process
  Handbook it became final only after the IASB did not object at its **April 2021** meeting, and it
  was published in an **addendum to the March 2021 IFRIC Update** —
  [ifrs.org](https://www.ifrs.org/news-and-events/updates/ifric/2021/ifric-update-march-2021/).
  Citing it as April 2021 is conventional and correct. The code says only *"IFRIC cloud-arrangement
  agenda decisions"* (plural, undated) in most places, which is safe.
- **Conclusion:** the customer *"often would not recognise an intangible asset because it does not
  control the software being configured or customised"* — **unless** the activities create *"a
  resource controlled by the customer that is separate from the software"* (e.g. additional code the
  customer controls) meeting the IAS 38 identifiability and control tests.
- **Timing (IAS 38.68–70):** if the configuration services are **distinct** from the access service,
  expense as the supplier configures; if **not distinct**, expense over the contract term; if
  performed by a **third-party supplier**, expense when that third party performs.
- **The two capitalisation routes the decision does allow:** (i) a separately identifiable
  intangible the customer controls, and (ii) a **prepayment** where payment precedes the service.

**`SOFTWARE_IMPLEMENTATION` (expensed) is correctly grounded.** ⚠ But see §8, F-STD-2: the code
treats cloud configuration as *always* expensed, and the agenda decision says *"often would not"*
with a named exception. The exception is deliberately unavailable in the chart (no
internally-developed-software account) and such lines escalate — which is a defensible product
decision, but it is a narrowing of the standard, not a restatement of it.

### 5.7 The general principle — consuming a service acquires no asset

Grounded in the **Conceptual Framework for Financial Reporting (2018)**
([AASB verbatim adoption](https://www.aasb.gov.au/admin/file/content105/c9/Conceptual_Framework_05-19.pdf);
[IFRS Foundation project summary](https://www.ifrs.org/content/dam/ifrs/project/conceptual-framework/fact-sheet-project-summary-and-feedback-statement/conceptual-framework-project-summary.pdf)):

> **4.3** An asset is a present economic resource **controlled** by the entity as a result of past events.
> **4.4** An economic resource is a right that has the potential to produce economic benefits.
> **4.20** An entity controls an economic resource if it has the present ability to direct the use of
> the economic resource and obtain the economic benefits that may flow from it. Control includes the
> present ability to prevent other parties from directing the use…

Control is discussed at **4.19–4.25**. **Control is confirmed as the operative concept in both SaaS
agenda decisions** — the 2019 decision turns on the supplier retaining decision-making rights, the
2021 decision on whether the customer controls the software being configured. Read with IAS 38.69's
*"the entity recognises the expenditure as an expense when it receives the services"*, this is a
complete and correct basis for the code's rule.

**Verdict: the code states the principle correctly.** *"A right to ACCESS someone else's hardware or
software is a service contract; nothing is controlled, so there is no asset to recognise, at any
amount"* is an accurate statement of CF 4.3/4.20 as applied by IFRIC.

### 5.8 Prepayments — confirmed

**IAS 38.70** verbatim: *"…paragraph 68 does not preclude an entity from recognising a prepayment as
an asset when payment for services has been made in advance of the entity receiving those
services."* Both agenda decisions say the same explicitly. A prepayment is an asset — a right to
future service — but **not an intangible**.

**The code's `PREPAYMENTS` account is right**, including its deliberate `taxConsequence: 'ALLOWABLE'`
rather than `CAPITAL` (it is a timing account, not a fixed asset), and including the decision that
nothing suggests it automatically.

### 5.9 "No statutory de minimis in UK GAAP or IFRS" — confirmed

- **IAS 16 contains no quantitative threshold.** Recognition rests solely on the qualitative
  criteria in **IAS 16.7**.
  [ifrs.org IAS 16](https://www.ifrs.org/issued-standards/list-of-standards/ias-16-property-plant-and-equipment/)
- **FRS 102 (September 2024 edition) contains no occurrence of "de minimis"** and no monetary
  capitalisation threshold. Para **17.4**: *"An entity shall recognise the cost of an item of
  property, plant and equipment as an asset if, and only if: (a) it is probable that future economic
  benefits… will flow to the entity; and (b) the cost of the item can be measured reliably."*
  [FRS 102 September 2024 PDF](https://www.frc.org.uk/documents/7668/FRS_102_September_2024_tmKYWO6.pdf)
- **What permits an entity-set threshold is materiality, not a rule.** **IAS 8.8**: accounting
  policies *"need not be applied when the effect of applying them is immaterial. However, it is
  inappropriate to make, or leave uncorrected, immaterial departures… to achieve a particular
  presentation."* Materiality is entity-specific — **FRS 102 para 2.12**: *"Materiality is an
  **entity-specific** aspect of relevance."*
  [IFRS Practice Statement 2 *Making Materiality Judgements*](https://www.ifrs.org/issued-standards/list-of-standards/materiality-practice-statement/)
  is explicitly **non-mandatory**.

**Verdict: the code's most-repeated justification is correct, and the design that follows from it —
`CapitalisationPolicy` as a value with `source: 'PRACTICE' | 'PLATFORM_DEFAULT'` — is the right
response to it.** It is one of the strongest decisions in the module.

⚠ **The confusion to avoid, and the code does avoid it:** the UK's **Annual Investment Allowance**
(£1,000,000) lets a business deduct the full value of a qualifying item from profits before tax —
that is a **tax capital allowance**, not an accounting capitalisation threshold. Capital expenditure
remains capital in the accounts even when fully relieved for tax in year one.
[gov.uk AIA](https://www.gov.uk/capital-allowances/annual-investment-allowance)

### 5.10 FRS 102 — the UK small-company equivalents

For the audience this product actually serves, the mirrors are **Section 17 Property, Plant and
Equipment** and **Section 18 Intangible Assets other than Goodwill**.

- **FRS 102 17.10(b)** folds the IAS 16.17 examples into one sentence: directly attributable costs
  *"can include the costs of site preparation, initial delivery and handling, installation and
  assembly, and testing of functionality"*. ⚠ **For a UK-GAAP client this is a better citation than
  IAS 16.17 anyway** — it says the whole thing in one reference and avoids the lettering trap in
  §5.1 entirely.
- **FRS 102 17.11(c)** mirrors IAS 16.19(c) word-for-word, excluding staff training.
- **Development costs are a POLICY CHOICE under FRS 102, not a requirement.** Para **18.8H**: *"An
  entity **may** recognise an intangible asset arising from development… if, and only if…"* — the
  same six criteria as IAS 38.57. Para **18.8K** requires the policy, once adopted, to be applied
  consistently. **This is a real divergence from IAS 38.57's "shall".** The code's reasoning for
  omitting a development account holds under both, and is if anything *stronger* under FRS 102,
  because whether such a line capitalises depends on a policy the practice has adopted — which is
  even less a fact on an invoice.
- **Periodic Review 2024** ([FRC amendments, issued 27 March 2024](https://www.frc.org.uk/documents/7128/Amendments_to_FRS_102_and_other_FRSs.pdf)),
  effective **1 January 2026** and therefore **in force as at today's date**: no change to the
  18.8H/18.8K policy choice and no threshold introduced. Two changes worth knowing:
  - **New para 18.3B** — software **integral to hardware** (e.g. a machine's operating software) is
    treated as **PPE**; otherwise as an intangible. This mirrors IAS 38.4. ⚠ **This is directly
    relevant to the code and is not currently reflected anywhere in it** — see §8, F-STD-3.
  - Section 2 rewritten to align with the 2018 Conceptual Framework; new para **2.33** carries the
    control-based asset definition into FRS 102.
  - The headline Periodic Review changes (Section 20 on-balance-sheet leases, Section 23 revenue)
    do not affect this rule.

---

## 3. UK / HMRC

*All pages fetched live 2026-09-03 unless noted. `legislation.gov.uk` was unreachable from the
research environment, so statutory text is verified via HMRC's own manuals where possible and marked
**not verified** where not.*

### 3.1 ⚠ BIM35805 and the two-year test — the code's most-repeated citation is HALF right

**Page:** [BIM35805 — Capital/revenue divide: computer software: application of general principles](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35805)

**Claim A — "software with a useful life under two years is revenue".** *Approximately right, but
it is a one-way Inspector's concession, not a test.* Verbatim: *"In any event, where software is
expected to have a useful economic life of less than two years Inspectors will accept that the
expenditure is revenue."* [BIM35810](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35810)
puts it as an instruction to staff: *"You should not contend that software with an expected useful
life of less than two years is capital."*

**Claim B — "a perpetual licence, or one with a term of two years or more, is capital". ⚠ THIS IS
WRONG.** Neither BIM35805 nor BIM35810 says it. **The two-year rule does not operate in reverse.**
The actual capital test in BIM35805 is functional and enduring-nature:

> *"The first question to be asked here is whether the licence is a capital asset in the trade of the
> licensee. In broad terms a licence is a capital asset if it has a sufficiently enduring nature"*

— and the page expressly contemplates the opposite of the code's claim: benefits may be
*"sufficiently transitory to stamp the payment as revenue **even though the licence granted is for
an indefinite period**."*

**So a perpetual licence can still be revenue.** See §8, F-UK-1.

**On periodic/annual payments the code is right**, and BIM35805 says so directly: *"Payments of this
kind are revenue. The timing of deductions is governed by correct accounting practice which normally
requires the rentals to be spread over the useful life of the software in accordance with the
accruals basis."* BIM35810 adds that relief follows GAAP *"over the shorter of the useful life of
the asset or the term of the licence"*.

**⚠ A scope caveat the code does not carry at all.**
[BIM35801](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35801): for
**companies**, software normally falls within the **CTA 2009 Part 8 intangible fixed assets
regime** — which is accounts-based, so the capital/revenue divide is largely irrelevant — except
where excluded or where a **CTA 2009 s.815 election** is made. The BIM358xx analysis therefore
mainly bites for **unincorporated** businesses and the excepted company cases. Since this product's
clients include limited companies, this is a material qualification. See §8, F-UK-2.

**Related pages:** [BIM35815](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35815)
website costs, with the shop-window analogy — *"The cost of constructing the window is capital; the
cost of changing the display from time to time is revenue"* (relevant to
`ADVERTISING_AND_MARKETING`'s `website design` keyword, which currently expenses everything);
[BIM35820](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35820) in-house
development.

### 3.2 CAA 2001 s.71 — correct in substance

[CA23410 — "Computer software and rights are plant"](https://www.gov.uk/hmrc-internal-manuals/capital-allowances-manual/ca23410),
under the heading CAA01/S71: *"Treat computer software as plant whether or not it would normally be
regarded as plant. You should also treat capital expenditure incurred on the right to use or
otherwise deal with computer software as plant"* — including software delivered electronically with
no physical medium.

⚠ **Note the precision, which the code slightly loses:** s.71 deems software and rights to use
software to be plant **for capital expenditure**. It does not make revenue licence payments capital.
Citing s.71 as a reason a licence *is* capital inverts the logic — s.71 tells you what allowance
applies **once you have already decided the expenditure is capital** on BIM35805 principles.

The statutory text at [CAA 2001 s.71](https://www.legislation.gov.uk/ukpga/2001/2/section/71) is
**not verified** directly (legislation.gov.uk unreachable); HMRC's manual states the effect.
ss.72–73 (disposal events, limit on disposal values) are covered at
[CA23420](https://www.gov.uk/hmrc-internal-manuals/capital-allowances-manual/ca23420) and
[CA23430](https://www.gov.uk/hmrc-internal-manuals/capital-allowances-manual/ca23430).

### 3.3 Capital versus revenue generally — the BIM35000 series

**Entry point:** [BIM35000 — contents](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35000)
(BIM35001 introduction · BIM35200 role of accountancy · BIM35300 general themes · BIM35400 tangible
assets · BIM35500 intangible assets · BIM35700 IP · BIM35800 computer software · BIM35900 cases).

**The leading authority**, quoted verbatim at
[BIM35010](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35010) — Viscount Cave
in **Atherton v British Insulated and Helsby Cables Ltd [1925] 10TC155**:

> *"…when an expenditure is made, not only once and for all, but with a view to bringing into
> existence an asset or an advantage for the **enduring benefit of a trade**… treating such an
> expenditure as properly attributable not to revenue but to capital."*

[BIM35301](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35301) adds **CIR v
Carron Company [1968] 45TC18** (Lord Reid: the nature of the advantage obtained is what matters).

**Law Shipping and Odeon** are at
[BIM35450 — asset bought in a defective condition](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35450):
*Law Shipping* — ship unusable until repaired, purchase price reduced accordingly → capital;
*Odeon Associated Theatres v Jones (1971)* — cinemas operable for years, price not reduced →
revenue. And the practical test: *"if you would have treated the repairs as revenue if ownership had
not changed, then the repairs are normally revenue when expended by the new owner."*

### 3.4 ⚠ There is NO two-year test for repairs

The research brief for this document asked about *"the two-year test for repairs"*. **No such test
exists.** Checked:
[BIM46901](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim46901),
[BIM46910](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim46910) (the
"entirety"), [BIM46915](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim46915)
(improvements), [BIM46925](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim46925)
(changing technology), [BIM46935](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim46935),
[BIM46900 contents](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim46900),
[PIM2020](https://www.gov.uk/hmrc-internal-manuals/property-income-manual/pim2020),
[PIM2030](https://www.gov.uk/hmrc-internal-manuals/property-income-manual/pim2030). **None contains
any two-year or other time-based test.**

The actual repairs tests are:

| Test | Source |
|---|---|
| Repair vs replacement of **the "entirety"** | BIM46910 |
| **Improvement** — *"If the taxpayer alters or improves the asset then it is not a repair"* | BIM46915 |
| **Same job as before** — *"the work is a repair and not an improvement if after the work is carried out, the asset can just do the same job as before"* | BIM46925 |
| *"a question of fact and degree"* | PIM2030 |

**The only two-year rule anywhere in this area is the software useful-life concession in
BIM35805/BIM35810.** ✅ **Good news for the code: it never claims a two-year repairs test.**
`REPAIRS_AND_MAINTENANCE.reviewNote` correctly frames it as *"an improvement is capital, not an
expense"*, which is BIM46915. The confusion was in the brief, not the codebase — recorded here so
the next person does not import it.

### 3.5 Plant and machinery, AIA and full expensing — position at 3 September 2026

- **Buildings/structures exclusion (CAA 2001 s.21, List A):**
  [CA22010](https://www.gov.uk/hmrc-internal-manuals/capital-allowances-manual/ca22010) — walls,
  floors, ceilings, doors, windows, mains services etc.; with assets *"listed in CAA01/S23 as not
  affected by the statutory exclusion"* (List C, CA22030). CAA 2001 s.11 general conditions —
  **not verified** (legislation.gov.uk unreachable).
- **Integral features (s.33A):**
  [CA22320](https://www.gov.uk/hmrc-internal-manuals/capital-allowances-manual/ca22320) — exactly
  five: electrical (incl. lighting) systems; cold water systems; space/water heating, ventilation,
  air cooling/purification; lifts, escalators and moving walkways; external solar shading. *"Only
  assets that are on the list are integral features."* Special rate pool.
- **Annual Investment Allowance: £1,000,000.**
  [gov.uk](https://www.gov.uk/capital-allowances/annual-investment-allowance) — *"The AIA amount is
  £1 million"*; most plant and machinery; **business cars excluded**. Manual outline
  [CA23081](https://www.gov.uk/hmrc-internal-manuals/capital-allowances-manual/ca23081)
  (CAA01/S38A–38B, S51A–51N). £1m has applied since 1 Jan 2019; the live page shows no end date.
- **Full expensing:**
  [gov.uk](https://www.gov.uk/capital-allowances/full-expensing) — *"Only **companies** can claim
  full expensing and the 50% first-year allowance"*; assets must be bought from 1 April 2023, be
  **new and unused**, and **not be a car**. 100% (main rate) or 50% (special rate) in year of
  purchase. **Made permanent** at Autumn Statement 2023 —
  [technical consultation](https://www.gov.uk/government/publications/full-expensing/autumn-statement-2023-permanent-full-expensing-technical-consultation):
  *"At Spring Budget 2023, the government announced full expensing from 1 April 2023 to 31 March
  2026. At Autumn Statement 2023, the government announced that full expensing would be made
  permanent"*, legislated in Finance Act 2024. The live page today shows no end date.

⚠ **Not verified:** the consulted-on extension of full expensing to **leased** assets, and anything
announced at Autumn Budget 2025. Both should be checked manually before this document is relied on
for a capital-allowances claim. **None of this affects the code**, which correctly makes no capital
allowances claim at all — it only decides which ledger a cost lands in.

### 3.6 Allowable versus disallowable

**The general rule.** [BIM37000](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim37000)
— **ITTOIA 2005 s.34** (income tax) and **CTA 2009 s.54** (corporation tax): not deductible unless
*"incurred wholly and exclusively for the purposes of the trade, profession or vocation."*
Statutory background at [BIM37010](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim37010).

| Code claim | Verdict | Source |
|---|---|---|
| **C10** Business entertaining disallowable for tax **and** input VAT blocked | ✅ **Both halves confirmed** | Direct tax: [BIM45000](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim45000), **ITTOIA 2005 s.45** / **CTA 2009 s.1298** — *"expenditure on business entertainment or gifts is not allowable as a deduction against profits, even if it is a genuine expense of the trade"*. VAT: [VIT43200](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit43200), blocked by **VAT (Input Tax) Order 1992, SI 1992/3222, art. 5**. A limited exception exists for entertaining **overseas** customers |
| **C18** Charitable donations relieved but not as a trading deduction | ✅ **Confirmed for companies** | [CTM09005](https://www.gov.uk/hmrc-internal-manuals/company-taxation-manual/ctm09005) — *"CTA10/S189 (1) and (2) allow the deduction of qualifying charitable donations from a company's **total profits**"* (CTA 2010 Part 6). Capped at total profits; relief in the period of payment. For **unincorporated** traders donations generally fail wholly-and-exclusively ([HS222](https://www.gov.uk/government/publications/how-to-calculate-your-taxable-profits-hs222-self-assessment-helpsheet/hs222-how-to-calculate-your-taxable-profits-2026)); narrow exceptions for gifts of stock/small gifts at [BIM45072](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim45072) (ITTOIA 2005 s.47, CTA 2009 s.1300) |
| Political donations disallowable | ✅ Confirmed | [BIM42528](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim42528) — *"You should disallow payments to political funds, contributions to party funds, and expenses of candidates at elections etc."* Narrow exception: **Morgan v Tate & Lyle Ltd [1954] 35TC367** |
| Fines and penalties disallowable | ✅ Confirmed | [BIM42515](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim42515) — **CIR v von Glehn (1920) 12TC232**, **McKnight v Sheppard (1999) 71TC419** (Lord Hoffmann: a fine's *"purpose is to punish the taxpayer"*). ⚠ *Compensatory* damages may be deductible; interest/penalties on UK taxes at [BIM42520](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim42520) |
| Depreciation disallowable | ✅ Confirmed | [HS222 §6](https://www.gov.uk/government/publications/how-to-calculate-your-taxable-profits-hs222-self-assessment-helpsheet/hs222-how-to-calculate-your-taxable-profits-2026) — non-allowable: *"Depreciation of equipment, cars and so on"*; claim capital allowances instead. Statutory basis ITTOIA 2005 s.33 / CTA 2009 s.53 **not verified** directly |

### 3.7 VAT

| Code claim | Verdict | Source |
|---|---|---|
| **C14** CIS domestic reverse charge — subcontractor invoice carries no VAT for the customer to reclaim | ✅ **Confirmed** | [VAT domestic reverse charge technical guide](https://www.gov.uk/guidance/vat-reverse-charge-technical-guide): applies where the customer is UK VAT-registered, the services are within CIS, standard- or reduced-rated, and the customer has not confirmed end-user/intermediary status. *"Suppliers must not enter any output tax on sales under the reverse charge"*; the customer *"must add the VAT charged to the output tax total"*; the invoice must state the reverse charge applies. ⚠ **Citation nuance:** [Notice 735](https://www.gov.uk/guidance/the-vat-domestic-reverse-charge-procedure-notice-735) covers mobile phones, computer chips, wholesale gas/electricity, emissions allowances, telecoms and renewable-energy certificates — for **construction** it points to the separate guidance. Cite the technical guide, not Notice 735 |
| **C8** VATPOSS14600 — foreign tax increases the reverse-charge value | ✅ **CONFIRMED VERBATIM.** The single most load-bearing citation in the module, and it is right | [VATPOSS14600 — Reverse charge: valuation](https://www.gov.uk/hmrc-internal-manuals/vat-place-of-supply-services/vatposs14600): *"the value of any supplies made using the reverse charge provisions is the total amount paid, **including any taxes levied abroad**, converted into sterling."* Corroborated by [Notice 741A §5](https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a): *"This includes any taxes levied abroad."* |
| Place of supply, B2B general rule | ✅ Confirmed | [VATPOSS06300](https://www.gov.uk/hmrc-internal-manuals/vat-place-of-supply-services/vatposs06300) — B2B = where the customer belongs (VATA 1994 s.7A); [VATPOSS06400](https://www.gov.uk/hmrc-internal-manuals/vat-place-of-supply-services/vatposs06400) — B2C = where the supplier belongs. Reverse-charge series: [VATPOSS14000](https://www.gov.uk/hmrc-internal-manuals/vat-place-of-supply-services/vatposs14000) (14100 intro · 14200 law · 14300 scope · 14400 input tax · 14500 time of supply · **14600 valuation** · 14700 registration). [VATPOSS14300](https://www.gov.uk/hmrc-internal-manuals/vat-place-of-supply-services/vatposs14300): *"The customer accounts for the output tax as if they had made the supply themselves. The VAT may also be recovered as input tax subject to the normal rules"* (VATA 1994 s.8). B2C digital services taxed where the consumer is located — [gov.uk digital services](https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers) |
| **C13** Input VAT blocked on cars, usually not on commercial vans | ✅ Confirmed | [VIT52100](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit52100) — the block *"acts as a proxy for the taxation of private use"*; exceptions for stock in trade, *"taxi hire; self drive hire or driving instruction"*, and cars *"used exclusively for a business purpose and… not made available for private use"*. [VIT51500](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit51500) — other vehicles recoverable when used for business; insignificant private use ignored |
| **C12** Insurance is VAT-exempt | ✅ Confirmed | [Insurance (VAT Notice 701/36)](https://www.gov.uk/guidance/insurance-notice-70136) — *"Insurance transactions are exempt from VAT"* (VATA 1994 Sch 9 Group 2) |
| **C11** Commercial rent exempt unless opted to tax | ✅ Confirmed | [VAT Notice 742A §1.2](https://www.gov.uk/guidance/opting-to-tax-land-and-buildings-notice-742a) — *"Supplies of land and buildings, such as freehold sales, leasing or renting, are normally exempt from VAT"*; once opted, *"all the supplies you make of your interest in the land or buildings will normally be standard-rated"* |
| **C15** Cold takeaway zero-rated; hot and eat-in standard-rated | ✅ Confirmed | [VAT Notice 709/1](https://www.gov.uk/guidance/catering-takeaway-food-and-vat-notice-7091) §§1.3, 2.1, 4.1 — *"cold takeaway food and drink is zero-rated, as long as it's not of a type that's always standard-rated (such as potato crisps, sweets and some beverages including bottled water)"*. [VFOOD4220](https://www.gov.uk/hmrc-internal-manuals/vat-food/vfood4220) — hot = above ambient air temperature, plus the five tests; incidental warmth (fresh bread) stays zero-rated |
| **C16** Card processing is an exempt financial service | ⚠ **TOO LOOSE — see §8, F-UK-3** | [VATFIN2450](https://www.gov.uk/hmrc-internal-manuals/vat-finance-manual/vatfin2450): after **Bookit Ltd (C-607/14)** and **National Exhibition Centre Ltd (C-130/15)**, *"fees charged for card processing services that enable a customer to pay by debit or credit card are **taxable** and do not qualify for exemption"*. Core money-transfer services remain exempt (VATA 1994 Sch 9 Group 5 item 1). The "merchant acquiring is exempt" proposition specifically: **not verified** on a current HMRC page. Notice 701/49 returned 404 on three slug variants — **not verified**; cite VATFIN instead. Delivery-platform commission standard-rated by default liability (VATA 1994 s.4) — no platform-specific HMRC page found, **not verified beyond the default rule** |
| **C17** Foreign consumption tax is never reclaimable UK input VAT | ✅ Confirmed in substance | [VIT12100](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit12100) — a condition of deduction is that *"the supply took place in the UK"*, so US sales tax or EU VAT charged by an EU supplier can never be UK input tax. Separate overseas refund schemes exist: [gov.uk](https://www.gov.uk/guidance/claim-vat-refunds-from-eu-countries-after-brexit) — *"UK and Isle of Man businesses can claim refunds of VAT from countries abroad… you will need to follow the procedure set out by the country"*. VATA 1994 s.24(1) **not verified** directly |

---

*(research sections 1, 2, 4, 7 and 8 below)*
