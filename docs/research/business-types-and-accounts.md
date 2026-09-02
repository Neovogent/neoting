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

## 4. Australia / ATO — comparative only

> ⚠ **Read F-INT-4 first.** **Nothing in this product is scoped to Australia.** The root `CLAUDE.md`
> defines Neoting as a platform *"for UK accounting practices"*; `docs/Source_Of_Truth.md` contains
> zero occurrences of "Australia", "ATO" or "GST". Verified again by grep on 2026-09-03: the only
> Australian traces in `modules/rules-suggestions` are the token `\bgst\b` inside the `TAX_LINE`
> regex (`coding/capital-revenue.ts:231`) and the words *"Australian GST"* in three comment blocks
> naming it as an example of **foreign** consumption tax. **There is no AU threshold, no
> instant-asset-write-off figure, no effective-life reference and no AU chart of accounts anywhere
> in the module.**
>
> This section is therefore **comparative and forward-looking research**, requested by the product
> owner. It answers two questions and no others: *is the capital/revenue architecture accidentally
> UK-specific in a way that would block a future market?* and *what would an AU expansion actually
> cost?* **Nothing here describes a capability the product has.** Every figure carries its date so
> that a stale one is visibly stale.
>
> **Method note.** `ato.gov.au` returns **HTTP 403 at the Akamai edge** to this environment, so ATO
> guidance was retrieved through a text proxy that does reach it; every ATO URL cited is the real
> canonical one and QC numbers are given so the live page can be found. **All legislation was
> retrieved directly from `legislation.gov.au`** (OData API and compilation text), including the
> authorised amending Acts, and the parliamentary passage from `aph.gov.au`. **`austlii.edu.au` and
> JADE were unreachable** (403 / CAPTCHA), so every case quotation below is taken from an ATO ruling
> quoting the judgment rather than from the law report — which is arguably the better source for
> *the ATO's position*, but means the law-report pagination is **not independently verified**.
> A failed fetch of an ATO URL is **not** evidence that the page does not exist.

### 4.1 ⚠ The instant asset write-off became PERMANENT eight days ago

**This is the single most important fact in this section, and it is eight days old as at today's
date (2026-09-03).**

| Income year | Threshold | Authority |
|---|---|---|
| 2023–24 | $20,000 | Act No. 52/2024, Sch 1 (assent 28 Jun 2024) |
| 2024–25 | $20,000 | Act No. 29/2025, Sch 4 (assent 27 Mar 2025) |
| 2025–26 | $20,000 | Act No. 72/2025, Sch 7 (assent 4 Dec 2025) |
| **2026–27 onward** | **$20,000 — permanent** | **Treasury Laws Amendment (Tax Reform No. 2) Act 2026 (No. 71, 2026), Sch 2 — assent 26 Aug 2026** |

**It is enacted law, not a proposal.** Announced in the 2026–27 Budget on 12 May 2026 and given
assent on **26 August 2026**. Schedule 2 amends the ITAA 1997 *itself* rather than adding another
sunsetting transitional provision — the operative instruction is *"Omit `$1,000`, substitute
`$20,000`"* across **ss 328-170, 328-180, 328-210(1), 328-215(4), 328-250 and 328-253**.
No bill on this remains before Parliament.
[Act No. 71 of 2026, full text](https://www.legislation.gov.au/C2026A00071/latest/text)

⚠ **A commencement quirk that looks like a gap and is not.** Schedules 1–4 of the Act commence
**1 October 2026**, but the Schedule 2 application clause applies the $20,000 figure to assets
first used or installed ready for use **on or after 1 July 2026**. The consequence for anyone
reading the statute today: **the 1 July 2026 ITAA 1997 compilation still shows `$1,000`**, because
the substitution has not yet commenced. Reading the compilation without reading the amending Act
gives the wrong answer for the whole of the current income year. This is precisely the failure mode
this document exists to catch.

**Eligibility** (ATO QC 61417, and Div 328 ITAA 1997):

- Aggregated turnover **under $10 million** (not the $50m figure that applied to the 2020–21 era
  temporary full expensing / earlier IAWO tiers — that generosity is gone).
- The business must **elect to apply the simplified depreciation rules** in ITAA 1997 Div 328.
  The write-off is not free-standing; it is a feature of the small-business pool regime.
- The limit applies **per asset**, so multiple assets each under $20,000 each qualify.
- **New and second-hand assets both qualify.**
- The asset must be **first used or installed ready for use** in the income year.

⚠ **Two eligibility details a coding engine would plausibly get wrong, and both are traps:**

1. **The *entire* cost must be below the limit, even where only a business-use portion is
   deductible.** ATO, verbatim: *"While you can only claim the taxable purpose portion as a
   deduction, **the entire cost of the asset must be less than the relevant limit**."* And on
   trade-ins: *"work out the full cost using the asset's purchase price **before any trade-in credit
   is applied**."* A rule that tested the *claimed* figure, or the net-of-trade-in figure, would let
   ineligible assets through — and both are exactly the figure that appears on an invoice.
2. **The threshold is GST-**exclusive** for a GST-registered business and GST-**inclusive** for one
   that is not** — ATO: if not registered, *"you include the GST amount you paid on the asset in the
   asset's cost."* So the same invoice can pass or fail the test depending on a fact about the
   **buyer** that is nowhere on the document. This is structurally the same shape as the UK's "is
   this practice's threshold £500 or £1,000" problem — see F-INT-1 — and it is the reason a
   jurisdiction must supply a *policy value*, never a constant.
3. ⚠ **A separate car limit overrides the whole thing.** ITAA 1997 **s 40-230** caps the first
   element of cost of a passenger car, and the same figure caps the GST credit at one-eleventh of
   the limit. **The 2026–27 car limit is `not verified`** — see §4.7; the last confirmed figure is
   **$69,674**, which applied to **both 2024–25 and 2025–26**.

**Pooling, for completeness** (Subdiv 328-D): assets at or above the limit go to the **general small
business pool** — **15%** in the first year, **30%** thereafter (ss 328-185, 328-190) — and
**s 328-210** allows the whole pool to be deducted when its balance is below the threshold, which
**also rises to $20,000**. The **five-year lock-out rule** in s 328-175(10) remains on the statute
book but is **suspended**: Sch 2 items 16–17 of the 2026 Act extend the "increased access year"
window to **30 June 2027**.

### 4.2 ⚠ Effective life — the annual ruling series has STOPPED

This is the trap for anyone who researched this area more than a year ago and cites from memory.

- **TR 2022/1 is the LAST effective-life ruling.** The ATO's long-running annual *TR 20xx/1* series
  has been discontinued (ATO QC 50914). There is no TR 2023/1, TR 2024/1, TR 2025/1 or TR 2026/1
  effective-life ruling to cite, and inventing one is easy because the pattern is so regular.
- **The operative instrument is now a legislative determination**, not a ruling: the **Income Tax
  Assessment (Effective Life of Depreciating Assets) Determination 2025**, **`F2025L01097`**, made
  **2 September 2025** by a Deputy Commissioner under **s 40-100(1) ITAA 1997**, registered and in
  force from **15 September 2025**, with Schedule 1 **repealing the 2015 determination** and
  Schedule 2 carrying Effective Life Tables **A** (industry-specific, ANZSIC headings, which takes
  precedence) and **B** (general).
  [legislation.gov.au F2025L01097](https://www.legislation.gov.au/F2025L01097)
- ⚠ **The ATO states the practice change explicitly**: effective lives were *"previously also
  published in tables attached to taxation rulings … a practice that ended with the withdrawal of
  TR 2022/1. The ATO now uses an on-demand approach"* (ATO QC 50914, last updated 17 Nov 2025).
  **`TR 2026/1` exists but is a different ruling entirely** — rental property income and deductions.
  Citing it for effective life would be a confident, plausible, wrong citation.

**Concrete lives** (Determination 2025, Schedule 2 **Table B**), for the asset classes this product
actually sees: **desktop computers 4 years · laptops and tablets 2 years · servers 4 years ·
computer monitors 4 years · network equipment 5 years · office desks 20 years · office chairs 10
years**. ⚠ At a $20,000 write-off threshold a small business entity expenses essentially all of
these immediately anyway — **effective life matters only for non-SBE clients or assets ≥ $20,000**,
which is a useful scoping fact.

**The statutory frame:** **s 40-95 ITAA 1997** gives the taxpayer a *choice* — use the
Commissioner's determination for the asset, or **self-assess** effective life on the facts.
**s 40-100** is the Commissioner's determination power; **s 40-102** carries the statutory caps that
override both (the regime that forces, e.g., a shorter life on certain assets regardless of the
table).

**In-house software** is the case most relevant to this product's domain:

- Statutory effective life **5 years** — **ITAA 1997 s 40-95(7), table item 8**, confirmed in the
  compilation in force at 1 July 2026 (previously 4 years, for software acquired before 1 July
  2015). ⚠ Because in-house software sits in that table, **s 40-105 self-assessment is unavailable**
  (s 40-105(4)(a)): the five years is **mandatory**, prime cost. This is a genuine structural
  difference from the UK, where useful life is an accounting judgement.
- The **software development pool** (**Subdiv 40-E**, ss 40-450 to 40-460) is available for
  expenditure on **developing** in-house software — and s 40-450(1) Note is explicit that it is **not**
  available for *acquiring* software or a right to use it. Deduction profile is fixed by **s 40-455**:
  **Nil / 30% / 30% / 30% / 10%** over five years. ⚠ Electing the pool **forfeits the instant asset
  write-off** for that software (s 328-175(7)(b), (8)).
- ⚠ **A periodic subscription is a revenue expense, and the authority is a ruling about websites.**
  There is **no ATO ruling specifically on SaaS or cloud** — I searched
  [TR 2016/3](https://www.ato.gov.au/law/view/document?docid=TXR/TR20163/NAT/ATO/00001)
  (*deductibility of expenditure on a commercial website*, 14 Dec 2016) and it contains **no
  occurrence of "SaaS", "Software as a Service" or "cloud"**. It is nonetheless the closest binding
  authority, and it is squarely on point: **¶15** *"Expenditure on 'off-the-shelf' software product
  that is **licensed periodically is a revenue expense**"*; **¶17** *"**Periodic operating,
  registration, web hosting and licensing fees are revenue expenses** deductible over the period to
  which the expense relates."* Contrast **¶14** — off-the-shelf software that enhances the
  profit-yielding structure is capital and may be in-house software under Div 40.

**This is a genuinely useful comparative result.** Australia reaches the same destination as
§5.5's IFRIC March 2019 agenda decision and §3.1's BIM35805 — *a subscription to use someone else's
software is a period expense* — by a **third, completely different route**: the periodicity of the
payment, ruled on in the context of websites, rather than a control-based asset test (IFRIC) or a
useful-life concession (HMRC). **Three jurisdictions, three unrelated mechanisms, one answer.**

That is the strongest available evidence that the code's
`SOFTWARE_AND_SUBSCRIPTIONS`-is-always-revenue rule is **not accidentally UK-specific** — it is the
one rule in the module that three independent tax systems agree on. ⚠ Note the contrast with
F-UK-1: the *subscription* direction is robust across jurisdictions, while the *perpetual ⇒ capital*
direction is the one that is wrong even in the UK.

### 4.3 Capital versus revenue — the same question, different case law

| Concept | Australia | UK equivalent (§3) |
|---|---|---|
| General deduction | **s 8-1 ITAA 1997** (positive limbs + negative limbs, incl. the capital exclusion) | ITTOIA 2005 s.34 / CTA 2009 s.54, *wholly and exclusively* (BIM37000) |
| The leading test | ***Sun Newspapers Ltd v FC of T* (1938) 61 CLR 337** — Dixon J's **three matters**: the character of the advantage sought; the manner in which it is to be used/enjoyed; the means adopted to obtain it. Framed as **profit-yielding structure versus its operation** | ***Atherton v British Insulated and Helsby Cables* [1925] 10TC155** — *enduring benefit of a trade* (BIM35010) |
| Repairs | **s 25-10 ITAA 1997**, elaborated by **TR 97/23** (still current, not withdrawn) | BIM46900 series / PIM2020 (§3.4) |
| "Blackhole" capital expenditure | **s 40-880** — 5-year straight-line write-off for business capital expenditure not otherwise deductible | *No UK equivalent.* A genuine structural difference |

⚠ **The one substantive divergence a coding engine would have to encode separately is the
initial-repairs rule — and the two jurisdictions do not merely differ, they expressly disagree.**

[**TR 97/23**](https://www.ato.gov.au/law/view/document?docid=TXR/TR9723/NAT/ATO/00001) (issued
3 December 1997; **still current — no withdrawal notice exists, and `TR 97/23W` returns 404**),
**para 59**: expenditure on an initial repair *"in remedying defects, damage or deterioration in
existence at the date of acquisition, is capital expenditure and is not, therefore, deductible under
section 25‑10."* Para 60 adds the two conditions: the defect *"existed at the time of acquisition"*
and *"did not arise from the operations of the person who incurs the expenditure."*

⚠ **Para 61 is the paragraph that matters, and it is the opposite of the UK rule:**

> *"It is immaterial whether at the time of acquisition the taxpayer was aware of the condition of
> the property, including its need for repair. **It is also immaterial whether the purchase price
> (or lease rentals) reflected the need for repairs.** We consider that the English Court of Appeal
> decision in* **Odeon Associated Theatres Ltd v. Jones** *[1972] 1 All ER 681 **is not authority in
> Australia for a contrary view**. … Initial repair expenditure relates to the establishment of the
> profit-yielding structure. It is capital expenditure and is not deductible under section 25‑10."*

**Compare §3.3 directly.** The UK's rule at
[BIM35450](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35450) is built on
***Law Shipping*** and ***Odeon*** — the very case the ATO names and rejects — and turns on exactly
the fact Australia calls immaterial: whether the purchase price was reduced to reflect the
condition. HMRC's practical test is *"if you would have treated the repairs as revenue if ownership
had not changed, then the repairs are normally revenue when expended by the new owner."*

**So: in the UK a post-acquisition repair on an asset bought at an unreduced price is normally
revenue; in Australia the same expenditure is capital regardless of the price paid.** This is the
sharpest jurisdictional conflict found anywhere in this document. It is not a threshold that could
be parameterised — **a single "initial repair" branch cannot serve both**, because the two systems
take opposite positions on the same authority. Any future AU work must scope this rule, not share
it.

*(⚠ The Australian "entirety" doctrine is attributed by TR 97/23 ¶37 principally to* **Lindsay v FC
of T (1960) 106 CLR 377***, not to* W Thomas & Co *— worth noting because the latter attribution is
a common error. The ATO cites both* Western Suburbs Cinemas *(1952) 86 CLR 102 and* Lindsay *as the
leading Australian repair cases at ¶109.)*

⚠ **There is no Australian two-year software concession** analogous to BIM35805/BIM35810. The
`SUBSCRIPTION_TERM_UNDER_TWO_YEARS` basis in `capital-revenue.ts` is a **UK-only artefact** and
would be meaningless on an Australian document. Under §3.1 it is already half wrong for the UK
(F-UK-1); it would be wholly inapplicable in Australia.

### 4.4 GST — and why an Australian GST line on a UK client's invoice is a dead end

| Point | Position | Note |
|---|---|---|
| Rate | **10%** — *"a broad-based tax of 10% on most goods, services and other items sold or consumed in Australia"* | ✅ |
| Registration threshold | **$75,000** GST turnover; **$150,000** for non-profit bodies; **any turnover** for taxi/limousine/ride-sourcing | ✅ Registration required within **21 days**; an **ABN is a prerequisite** |
| **Input-taxed** supplies | Financial supplies; selling or renting residential premises. *"You **can't** claim GST credits for the GST included in the price of your 'inputs'"* | ✅ Div 40. Structurally the UK's **exempt** |
| **GST-free** supplies | Most basic food, some health/education/childcare, exports, water/sewerage, precious metals, **sales of businesses as going concerns** | ✅ Div 38. *"You **can still claim** credits"* — structurally the UK's **zero-rated** |
| Tax invoice | Required on request within 28 days unless the sale is **$82.50 (incl GST) or less**; sales of **$1,000 or more** must also show the **buyer's** identity or ABN | ✅ Seven required particulars; eInvoicing via **Peppol** satisfies the "intended to be a tax invoice" test |
| Input tax credits | **4-year** limit, running from the lodgment due date of the BAS for the period in which the credit could first have been claimed | ✅ *"We have **no discretion** to extend the 4-year credit time limit"* |
| BAS cycles | **Monthly** if turnover ≥ $20m · **quarterly** if < $20m · **annually** if voluntarily registered | ✅ |
| Reverse charge (Div 84) | ⚠ **`not verified`** | I asserted in an earlier draft that Div 84 bites only where the purchase is *not fully creditable*, which would make it materially narrower than the UK's B2B general rule (§3.7, VATPOSS06300). **That was not confirmed** and is removed rather than softened |
| Low-value imported goods | ⚠ **`not verified`** | The A$1,000 point-of-sale rule was not confirmed in this pass |
| No-ABN withholding | *"withhold **the top rate of tax**"* — the ATO page states **no percentage** | ⚠ The commonly quoted **47%** is **`not verified`** |

⚠ **The finding that matters for the product as it stands today — stated more carefully than in my
first draft.** A UK business cannot recover Australian GST **through HMRC**: §3.7's **VIT12100**
establishes that a condition of deduction is that *"the supply took place in the UK"*, so Australian
GST can never be UK input tax. Recovery, if it existed at all, would have to run through the
**Australian** system — registration in Australia — not through a UK return.

⚠ **I previously wrote that there is "no 13th-Directive equivalent" and that simplified registration
"confers no ABN and no input tax credits". Neither was verified, and both are withdrawn.** The
sourced position is narrower and sufficient: **for a UK client the amount is not UK input VAT, and
nothing on a UK VAT return can recover it.**

**The code is therefore right.** `escalation.ts` and `capital-revenue.ts` say Australian GST is
*"part of the cost of what was bought and is never reclaimable UK input VAT"* — which is exactly the
verified proposition, no more and no less. The `FOREIGN_TAX_IN_COST` advisory is the correct
treatment. ✅

### 4.5 Australian business structures — the comparative table

| Structure | Tax treatment | Return | Identifier |
|---|---|---|---|
| **Sole trader** | Personal marginal rates; business income on the individual return | Individual return, business schedule | TFN + ABN |
| **Partnership** | **Transparent** — lodges a return, pays no tax; partners taxed on distributions | Partnership return + partner individual returns | Partnership TFN + ABN |
| **Company** | Separate legal entity; flat company rate; **imputation/franking credits** on distributions | Company return | TFN + **ACN** + ABN |
| **Trust** | Transparent where income is distributed; trustee assessed on undistributed income | Trust return + beneficiary returns | TFN + ABN |

**Rates, verified from the statute rather than the ATO site.** The ATO's own "Company tax rates"
page is still titled *"from 2001–02 to 2025–26"* and publishes no 2026–27 table, so the
***Income Tax Rates Act 1986*, compilation No. 66, in force from 1 July 2026** is the better source:

- **s 23** — company tax is **25%** for a *base rate entity*, **30%** otherwise.
- **s 23AA** — a base rate entity has **aggregated turnover under $50 million** *and* **no more than
  80%** of assessable income as *base rate entity passive income* (s 23AB: dividends and franking
  credits, *"interest …, royalties and rent"*, net capital gains, and flow-through amounts).
- **s 12(9)** — a trustee assessed under **ITAA 1936 s 99A** on undistributed income is taxed at
  **45%**.

⚠ **Note the $50m here is a *different* $50m from the one in §4.1.** The base-rate-entity test uses
$50m; the instant asset write-off uses the **$10m** small-business-entity test in s 328-110. Two
turnover thresholds, both live, both $10m/$50m-shaped, governing different concessions — a
well-placed trap for anyone building an AU rules engine.

**Identifiers**, per [ASIC](https://asic.gov.au/for-business/registering-a-company/steps-to-register-a-company/australian-company-numbers/):
an **ACN is 9 digits, issued by ASIC** on registration; an **ABN is 11 digits, issued by the ATO**,
and covers *"any type of business, including sole traders and partnerships as well as companies"*.
Usefully for document processing: *"A company's ABN is often **the same as the ACN but with 2 extra
numbers at the beginning**."* Corporations Act **s 153** requires the ACN (or ABN) to appear on
**invoices and statements of account** — so it is a field an extractor can rely on being present.
⚠ The **TFN** distinction is the structural one: a sole trader *"[uses] your individual tax file
number (TFN) to lodge tax returns"*, whereas a partnership *"needs its own ABN and tax file
number"*, as do companies and trusts. ⚠ Return form **NAT numbers** are **`not verified`** — refer to
returns by name.

The UK/AU mapping is close for sole trader and partnership, and **materially different for the
company**: Australia's dividend imputation has no UK counterpart, and there is **no Australian
equivalent of the LLP** as a distinct filing entity.

⚠ **The ATO publishes no canonical chart of accounts.** It fixes only the **return labels** — e.g.
company return item 6 breaks expenses into *Cost of sales · Superannuation · Bad debts · Lease ·
Interest · Depreciation · Repairs and maintenance · All other expenses*. Ledger categorisation
below that is the taxpayer's choice.
**Flagged honestly: the "no canonical chart" conclusion is an inference from the absence of such a
publication, not a sourced positive statement — `not verified` as a positive claim.**

**This is the same structural answer as the UK's** (§2: SA103F boxes and the Companies Act formats
are *return and filing* shapes, not charts of accounts), which is a genuinely reassuring result for
the architecture: in **both** jurisdictions the chart is the practice's choice and only the
*mapping out* is prescribed. `profiles.ts`'s stance — *"there is no mandated UK chart of accounts …
the seed is a starting point, never a claim of correctness"* — generalises without amendment.

### 4.6 What an AU expansion would actually cost — the honest estimate

**Cheap, because the architecture already generalises:**

- `CapitalisationPolicy` as a **value** with a `source` field (§5.9) is exactly the right shape. A
  jurisdiction supplies a different policy, not a different rule. **This is the single best
  decision in the module for portability** and it was made for an unrelated reason (no statutory
  de minimis in UK GAAP or IFRS).
- The five `LEDGERS`, the `CODING_AUTHORITIES` ladder, the ten escalation reasons and the
  arithmetic hard stop are all jurisdiction-neutral.
- The subscription-is-revenue rule survives intact (§4.2), by a different route.

**Expensive, and each of these is a real piece of work:**

| What | Why |
|---|---|
| `VAT_TREATMENTS` | `STANDARD / ZERO_OR_EXEMPT / OUTSIDE_SCOPE / BLOCKED / VARIES` is a **UK VAT** vocabulary. AU needs *GST-free* vs *input-taxed* as **distinct** members — collapsing them into `ZERO_OR_EXEMPT` destroys the credit-entitlement difference, which is the whole point of the distinction |
| `TAX_CONSEQUENCES` | `ALLOWABLE / DISALLOWABLE / CAPITAL` maps acceptably, but "capital" in AU immediately implies a Div 40 effective life and possibly a Div 328 pool, which the model has nowhere to put |
| `SUBSCRIPTION_TERM_UNDER_TWO_YEARS` | UK-only. Must not fire on an AU document |
| Initial repairs | §4.3 — a genuinely different rule, not a different threshold |
| Reverse charge | §4.4 — different trigger, cannot share a branch |
| The whole chart | CIS, the domestic reverse charge, the cold/hot food zero-rate boundary and the car input-VAT block (§2, §3.7) are **UK statutory artefacts**. `TRADE_AND_CONSTRUCTION` and `RETAIL_AND_HOSPITALITY` would need rebuilding from AU rules, not translating |

**Verdict: the engine ports; the content does not.** That is the right way round, and it is worth
knowing before anyone proposes it.

### 4.7 ⚠ The AU finding for §7 and §8: absent, not stale

**Checked by grep, 2026-09-03.** The code encodes **no Australian threshold of any kind**. There is
therefore **nothing stale to correct** — which is the *best* possible answer, and materially better
than the alternative. Had the module carried a `$20,000` figure it would have been:

- correct for 2023–24 and 2024–25,
- correct for 2025–26,
- and — until **26 August 2026, eight days ago** — carrying a sunset that had not yet been
  legislated away, in a product with no mechanism to notice.

**The lesson generalises past Australia.** The threshold moved by an Act that received assent eight
days before this document was written, with a commencement date **after** the income year it applies
to, so that the current statutory compilation shows the *wrong* number. Any jurisdiction figure
hardcoded in this repository would need a review cadence nobody has committed to.

⚠ **And there is a second, sharper illustration in the same section: the car limit.** ITAA 1997
**s 40-230** caps the first element of cost of a passenger car and is **indexed annually**; the same
figure caps the recoverable GST at one-eleventh of it. **The 2026–27 figure could not be
established**, with direct access to the ATO and to `legislation.gov.au`, after **eight distinct
attempts** — the ATO's rate index carries no car-limit page, the "Assets and exclusions" table stops
at 2025–26, and the *Guide to depreciating assets 2027* is not yet published. Last confirmed:
**$69,674**, which applied to **both 2024–25 and 2025–26**.

⚠ **Do not compute it from CPI.** The 2025–26 indexation factor was **0.997 — below 1.0 — and the
limit did not fall**, because indexed amounts are not reduced. A naive extrapolation would produce a
plausible, confident, wrong number. **This is the single best argument in this document against
hardcoding jurisdiction figures**: a threshold that changes every year, whose current value is not
reliably published at the time the year is already two months old, and whose obvious derivation is
booby-trapped.

**Recorded as F-AU-1 in §8: do not add AU figures to this codebase; if AU is ever in scope,
thresholds arrive as dated policy *data* with a named review owner, never as constants.**

---

## 2. Business types and their charts of accounts

> **Method note for this section.** The web-search budget for this session was exhausted before this
> section was researched, and the delegated research agent died on an API error. Everything below was
> therefore verified by **fetching known primary URLs directly**. Two consequences, stated up front:
> **`legislation.gov.uk` is confirmed unreachable** from this environment (it returns an empty body,
> not an error — the same symptom the predecessor recorded in §3), and **`web.archive.org` is
> blocked outright**, so no Wayback fallback was available for the pages that returned 403.
> Everything I could not reach is marked **not verified** and named.

### 2.0 ⚠ The headline finding: the code has no legal-form axis at all

**This is the most important thing in this section, and it is a finding, not a description.**

`BUSINESS_PROFILE_IDS` has exactly four members — `GENERAL_BUSINESS`, `SERVICES_WITH_STAFF`,
`TRADE_AND_CONSTRUCTION`, `RETAIL_AND_HOSPITALITY` — and **every one of them is a trade vertical.
None of them is a legal form.** Verified against `chart-of-accounts/profiles.ts` and against the
contract: `BusinessContextQuestionnaire` in `packages/contracts/openapi.yaml` (line 6857) has exactly
six properties — `businessActivity` (required), `typicalSuppliers`, `typicalCosts`, `hasEmployees`,
`usesSubcontractors`, `notes`. **There is no `legalForm`, no `entityType`, no company-number field,
and nothing anywhere else in the product captures one** (grepped across
`modules/clients-team-settings`, `prisma/schema.prisma` and `packages/contracts`, 2026-09-03).

That is a deliberate and defensible design — the contract says so explicitly: *"Free text on
purpose. A dropdown of industries would be cheaper to store and worth less to a model than one
honest sentence about what the business actually does."* And for the **operating expense** half of a
chart of accounts it is the right call, because a plumber's costs are a plumber's costs whether the
plumber trades through a company or not.

⚠ **But the two axes are genuinely orthogonal, and the second one is missing.** Trade vertical
determines *cost of sales and the operating expenses*. **Legal form determines how the business's
own money leaves it** — and that is where every account the chart lacks lives:

| Legal form | The accounts it needs that no trade vertical implies | Present in the code? |
|---|---|---|
| Sole trader | **Drawings** (capital account, not an expense) | ❌ |
| Partnership | **Partners' current and capital accounts**, profit-share allocation | ❌ |
| Limited company | **Directors' remuneration**, **directors' loan account**, **dividends**, **corporation tax charge**, share capital | ❌ |
| LLP | **Members' remuneration charged as an expense** vs **profit allocated to members** | ❌ |
| Charity | The **SoFA** in place of a P&L; **fund accounting** as a dimension | ❌ |

**Assessment.** This is **not** a defect in ID, and I would not open it as one. Every account above
is a **year-end and equity** account, and ID codes *purchase documents* — a receipt or a supplier
invoice, never a dividend voucher or a drawings journal. The chart is a picklist for coding incoming
documents, and for that job the omission is correct.

⚠ **It becomes a defect the moment two things happen**, and both are on the roadmap: an accountant
gains the ability to **edit the chart** (§24.4.1, an open TODO in the module's `CLAUDE.md`), or the
chart is used to seed anything that looks like a **trial balance or a set of accounts**. At that
point a chart with no `DIRECTORS_REMUNERATION` and no `DIVIDENDS` is not a starting point, it is a
wrong one. **Recorded as F-BT-1 in §8.**

### 2.1 Sole trader — and the form that is the closest thing the UK has to a mandated chart

**Source: the SA103F form itself, tax year 2025–26**, downloaded and text-extracted 2026-09-03:
[SA103F 2026 (PDF)](https://assets.publishing.service.gov.uk/media/69c2635b13101e9908704b36/SA103F_2026.pdf)
· [publication page](https://www.gov.uk/government/publications/self-assessment-self-employment-full-sa103f)
(page last updated 6 April 2026). Form footer: `SA103F 2026 … HMRC 12/25`.

**There is no mandated UK chart of accounts** — `profiles.ts` says so and §4.5 confirms Australia is
the same. But the SA103F expense boxes are the nearest thing that exists, because **every
unincorporated business's expenses must eventually be summarised into exactly these fourteen
lines.** So this is the single most useful benchmark for the core chart, and it maps almost
perfectly:

| Box | Label, verbatim from the form | Core chart account(s) |
|---|---|---|
| 17 | Cost of goods bought for resale or goods used | `COS_PURCHASES` |
| **18** | **Construction industry – payments to subcontractors** | ⚠ `COS_SUBCONTRACTORS_CIS` — **profile-only** (see below) |
| 19 | Wages, salaries and other staff costs | `WAGES_AND_SALARIES`, `EMPLOYER_NI_AND_PENSION`, `STAFF_WELFARE` |
| 20 | Car, van and travel expenses | `MOTOR_EXPENSES`, `TRAVEL_AND_SUBSISTENCE` |
| 21 | Rent, rates, power and insurance costs | `RENT`, `RATES_AND_WATER`, `LIGHT_HEAT_AND_POWER`, `INSURANCE` |
| 22 | Repairs and maintenance of property and equipment | `REPAIRS_AND_MAINTENANCE` |
| 23 | Phone, fax, stationery and other office costs | `TELEPHONE_AND_INTERNET`, `OFFICE_COSTS` |
| 24 | Advertising and business entertainment costs | `ADVERTISING_AND_MARKETING`, `BUSINESS_ENTERTAINING` |
| **25** | **Interest on bank and other loans** | ❌ **NO ACCOUNT** |
| 26 | Bank, credit card and other financial charges | `BANK_CHARGES` |
| **27** | **Irrecoverable debts written off** | ❌ **NO ACCOUNT** |
| 28 | Accountancy, legal and other professional fees | `PROFESSIONAL_FEES` |
| 29 | Depreciation and loss or profit on sale of assets | `DEPRECIATION` |
| 30 | Other business expenses | *(the catch-all the code deliberately refuses to have)* |

Income boxes: **15** turnover, **16** other business income, **16.1** trading income allowance →
`SALES`, `OTHER_INCOME`. Net profit/loss: **47 / 48**. Capital allowances: **49–57** (49 AIA;
50 at 18%; 51 at 6%; 52 zero-emission goods vehicle; 52.1 zero-emission car; 53 SBA; 53.1 Freeport
and Investment Zones SBA; 54 electric charge-point; 55 100% and other enhanced; 56 on sale or
cessation; 57 total).

⚠ **Two real gaps, both confirmed by grep against `profiles.ts` (51 distinct codes across all four
profiles, 2026-09-03):**

1. **Box 25 — interest on bank and other loans has no account.** `BANK_CHARGES` is not it, and
   conflating them is not harmless: bank *charges* are a service cost, loan *interest* is a finance
   cost, they sit in different places in a P&L, and for a company interest engages the corporate
   interest restriction. A loan-interest debit today has nowhere correct to go and will be coded to
   `BANK_CHARGES` by keyword or escalate as `NO_MATCH_ON_CHART`.
2. **Box 27 — irrecoverable debts written off has no account.** Lower priority for ID, because a bad
   debt is a **journal**, not a purchase document, and ID codes purchase documents. Box 25 is not
   like that: a lender's interest statement is a document a client photographs and sends.

**Recorded as F-BT-2 in §8**, with box 25 as the actionable half.

⚠ **The genuinely interesting structural point is the second column of the form.** Boxes **32–45**
are a parallel *"Disallowable expenses"* column mirroring boxes 17–30 one-for-one, with box 46 the
total. **HMRC's model is one account per cost with a disallowable amount beside it. The code's model
is `taxConsequence: 'ALLOWABLE' | 'DISALLOWABLE' | 'CAPITAL'` as a flag on the account.** These are
two encodings of the same fact, and the code's is the better one for its purpose: box 24 lumps
*advertising* and *business entertaining* onto one line even though the first is allowable and the
second is disallowable in full (§3.6, C10) — the taxpayer is expected to disentangle them into box
39. **The code splits them into `ADVERTISING_AND_MARKETING` and `BUSINESS_ENTERTAINING` at source,
which is strictly better than the form it feeds.** That deserves recording as a positive: §0.2's
"separately identifiable" group is not taxonomy for its own sake, it is box 39 done in advance.

**Other sole-trader facts, verified:**

- **The £90,000 turnover test is printed on the form itself**: *"If your annual turnover was below
  £90,000, you may just put your total expenses in box 31"* — i.e. below that figure the fourteen-way
  analysis is optional and a single total will do. This is the same figure as the VAT registration
  threshold; the form does not say they are linked and I have **not verified** that they are formally
  tied.
- **Cash basis is now the default, and the form proves it structurally.** Box **10** reads: *"If you
  used **traditional accounting rather than cash basis** to calculate your income and expenses, put
  'X' in the box."* **It is an opt-out box for accruals, which means cash basis is the standing
  assumption.** [gov.uk cash basis](https://www.gov.uk/simpler-income-tax-cash-basis) describes it as
  *"the standard way to record your income and expenses if you're a sole trader or partnership
  without corporate partners"* and confirms *"Some businesses cannot use cash basis, for example,
  limited companies."* ⚠ **The exact tax year from which it became the default is `not verified`** —
  neither page states it. (It is widely understood to be 2024–25; I could not source that today and
  will not assert it.)
- **Trading income allowance** has its own box (16.1) on the form. The **£1,000** figure is
  **not verified** — I could not reach the allowances page within budget.
- **Simplified expenses / flat rates** (mileage, use of home, living at business premises):
  **not verified** for 2026–27. I did not reach
  `https://www.gov.uk/simpler-income-tax-simplified-expenses`. **Do not quote 45p/25p from this
  document.**

⚠ **Why the cash-basis default matters to this module more than it looks.** Under the cash basis a
cost is recognised **when paid**. `PREPAYMENTS` — the code's fifth ledger, `Current assets`, and the
`ANNUAL_FEE_MAY_BE_PART_PREPAID` advisory that goes with it — is an **accruals** concept. For a cash-basis
sole trader an annual subscription paid in advance is simply deductible when paid, and the advisory,
while never wrong (it never changes a code), is telling the accountant about a journal that will not
exist. Not a defect; worth knowing before anyone makes that advisory louder.

### 2.2 Partnership

Structurally a sole trader's chart plus an allocation layer. What differs:

- **Partners are not employees.** Partners' "salaries" and interest on capital are **appropriations
  of profit**, not `WAGES_AND_SALARIES`. A chart that offers only `WAGES_AND_SALARIES` invites a
  partner drawing to be coded as staff cost — which overstates expenses and understates taxable
  profit for every partner.
- **Per-partner capital and current accounts**, and a profit-sharing ratio that allocates the result.
- **Tax transparency:** the partnership files an SA800 and pays no tax; each partner returns their
  share on SA104. **URLs and box detail: `not verified`** — I did not reach the SA800/SA104 pages
  within budget. The structural points above are standard and are not sourced here.
- Cash basis applies to partnerships too, but only those **"without corporate partners"** — verbatim
  from the gov.uk cash basis page above.

### 2.3 Limited company

**The size thresholds changed for periods beginning on or after 6 April 2025** (the Companies
(Accounts and Reports) (Amendment and Transitional Provision) Regulations 2024). Verified on the
live gov.uk guidance, 2026-09-03:
[Micro-entities, small and dormant companies](https://www.gov.uk/annual-accounts/microentities-small-and-dormant-companies)

| | Turnover | Balance sheet total | Employees |
|---|---|---|---|
| **Micro-entity** | *"a turnover of £1 million or less"* | *"£500,000 or less on its balance sheet"* | *"10 employees or less"* |
| **Small** | *"a turnover of £15 million or less"* | *"£7.5 million or less on its balance sheet"* | *"50 employees or less"* |

Any **two of the three** must be met. ⚠ The gov.uk page **does not state the effective date** of the
uplift, and `legislation.gov.uk` is unreachable, so the "periods beginning on or after 6 April 2025"
commencement is **not verified** from a primary source — only the *figures* are verified, and they
are the post-uplift ones. The **medium-company** thresholds (£54m / £27m / 250) are **not verified**
— the page does not carry them.

**What a company's chart has that a sole trader's does not:**

| Account | Why it cannot be borrowed from the sole-trader chart |
|---|---|
| **Directors' remuneration** | A director *is* an employee for this purpose, so it is a genuine P&L expense — the opposite of a partner's drawing. Getting this wrong inverts the profit |
| **Directors' loan account** | A balance-sheet account with its own tax consequences (s.455 charge, benefit-in-kind on beneficial loans). A director's personal spend on a company card belongs here, **not** in `PRIVATE_USE` |
| **Dividends** | **Not an expense at all** — a distribution of post-tax profit. The most expensive single miscoding available to a small company |
| **Corporation tax charge** | Has no sole-trader analogue; income tax is personal |
| **Share capital / reserves** | Equity structure |

⚠ **`PRIVATE_USE` is a sole-trader concept and the chart applies it to everyone.** For an
unincorporated business, private use is a disallowance/adjustment. For a company the identical
transaction is a **director's loan** or a **benefit in kind** — a different account, a different
return, and potentially a P11D. The code's `PRIVATE_USE` (VAT `BLOCKED`, tax `DISALLOWABLE`) is
correct for the sole trader and **misleading for the company**, and with no legal-form axis (§2.0)
nothing can tell them apart. **This is the sharpest practical consequence of F-BT-1** and is the
reason I would rank it above the missing equity accounts.

**Reporting frameworks:** FRS 102 for small and above; **FRS 105** *"The Financial Reporting Standard
applicable to the Micro-entities Regime"* for micro-entities, with very short prescribed formats
([FRC](https://www.frc.org.uk/library/standards-codes-policy/accounting-and-reporting/uk-accounting-standards/frs-105/)).
⚠ The Companies Act **profit and loss account Formats 1 and 2** (SI 2008/410 Sch 1; SI 2008/409 for
small companies) are **not verified** — `legislation.gov.uk` unreachable. Their existence and
general shape are standard knowledge and are stated here without a source. The **CT600** return
itself: **not verified**.

**The tax-scope caveat that is already in §3.1 and belongs here too:** per
[BIM35801](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35801), for
**companies** software normally falls in the **CTA 2009 Part 8 intangible fixed assets regime**,
which is accounts-based — so the BIM35805 capital/revenue analysis the code leans on hardest
*mainly bites for unincorporated businesses*. **The code's most-cited rule is weakest precisely for
the client type it cannot identify.** See F-UK-2.

### 2.4 LLP

**Current edition: the Statement of Recommended Practice — Accounting by Limited Liability
Partnerships 2026 ("LLPs SORP"), published by the CCAB on 3 November 2025.**
[ccab.org.uk](https://www.ccab.org.uk/statement-of-recommended-practice-accounting-by-limited-liability-partnerships-llps-sorp-2026/)
· [CCAB SORP page](https://www.ccab.org.uk/values/sorp-llps/). CCAB states its aim is to *"deal with
issues that are specific to LLPs and ensure that, as far as possible, LLPs present financial
statements that are comparable with those of other entities."*
⚠ **The effective date (which accounting periods it applies to) is `not verified`** — neither CCAB
page states it, and I did not open the SORP PDF itself. Given it is the post-Periodic-Review-2024
edition and FRS 102's amendments are effective 1 January 2026 (§5.10), a 2026 alignment is the
obvious inference, **but it is an inference and I am not asserting it.**

**The one thing that makes an LLP structurally unlike anything else**, and it is a real charting
problem: **members' remuneration divides in two** — amounts that are **charged as an expense in
arriving at profit** (broadly, where the member has no discretion to avoid them) and **profit
allocated to members** (below the line). The corollary is that members' interests must be classified
as **debt or equity**, and an LLP's balance sheet can therefore show what looks like a large
liability to its own members. ⚠ **The SORP paragraph references for this are `not verified`** — the
CCAB pages carry no detail and I did not fetch the document. **The proposition itself is standard
and long-standing; treat the description as sound and the citation as owed.**

LLPs file accounts at Companies House like a company, and are taxed transparently like a
partnership. That combination — company-style filing, partnership-style tax — is why neither the
sole-trader chart nor the company chart fits.

### 2.5 Charity — the one where "chart of accounts" is the wrong shape entirely

**Current edition: the Charities SORP 2026.** Verified from the Charity Commission's own guidance
page, updated 19 December 2025:
[CC15d publication page](https://www.gov.uk/government/publications/charity-reporting-and-accounting-the-essentials-november-2016-cc15d)
— *"Guidance has been updated to reflect the introduction of SORP 2026 which applies to accounting
years starting on or after 1 January 2026"*, and the CC15d guidance itself now applies to
*"accounting periods starting on or after 1 November 2016 and before 1 January 2026"*, with *"New
guidance … published in 2026 for accounting periods starting on or after 1 January 2026."*
**So SORP 2026 is in force as at today's date.** ⚠ `charitysorp.org` returns **403 Forbidden** to
automated retrieval and `web.archive.org` is blocked, so the SORP's own full title and publisher
line are **not verified**.

**Why a charity is not a chart-of-accounts variant but a different structure:**

1. **A Statement of Financial Activities (SoFA) replaces the profit and loss account.** It is not a
   renamed P&L. Income is analysed by **source** — donations and legacies; charitable activities;
   other trading activities; investments; other — and expenditure by **purpose**: raising funds;
   charitable activities; other. **A charity does not report "expenses by nature" at the top level
   at all.** The entire `Expenses` ledger in §0.2 is organised by nature — rent, wages, insurance,
   motor. That is the *wrong axis* for a SoFA.
2. **Support costs are apportioned across activities.** A single electricity bill does not land in
   one place; it is allocated across charitable activities and raising funds on a stated basis. **One
   document, N destinations, by policy** — which the code cannot express even for the simple case
   (see §9: `documents.category_code` is one nullable string).
3. ⚠ **Fund accounting is a DIMENSION, not a category.** Every transaction carries a fund —
   unrestricted, restricted or endowment — **orthogonally to its expense category**. A restricted
   grant's spend is *both* "charitable activities — premises" *and* "restricted fund", and the second
   is a legal constraint on the money, not a description of it. **There is no field anywhere in this
   product that could carry it**: not `categoryCode`, not `ledger`, and not the proposed
   `DocumentLine` in §9.3.

**Verdict: a charity is out of scope for this chart and should be said to be, explicitly.** Adding
"a charity profile" to `BUSINESS_PROFILE_IDS` would be the worst available outcome — it would look
like support for a structure the data model cannot represent. **Recorded as F-BT-3.** The honest
position is that a charity client is served today by `GENERAL_BUSINESS` producing a nature-based
picklist that an accountant then re-maps by hand into a SoFA, and nothing in the product should
imply otherwise.

⚠ **The charity accounting and audit thresholds are `not verified`.** I attempted the CC15c page
(withdrawn), the CC15d publication page (no figures), two CC15d full-text slug variants (**404**),
`https://www.gov.uk/running-charity/managing-charity-finances` (**404**),
`https://www.gov.uk/government/collections/accounting-and-reporting-guidance-for-charities`
(**404**), `legislation.gov.uk` Charities Act 2011 s.145 (**empty body — unreachable**) and
`charitysorp.org` (**403**). Six failures on the same fact. **The receipts-and-payments,
independent-examination and audit thresholds are therefore deliberately omitted from this document
rather than recalled from memory.** They are stable, widely published figures and a practitioner can
find them in a minute; an unsourced figure in a document whose whole value is that its figures are
sourced is worse than a gap.

### 2.6 The trade verticals the code actually profiles

Selection is keyword matching over `businessActivity` and `typicalCosts`, in a **fixed**
`PROFILE_SELECTION_ORDER` so a tie resolves identically on every run. `GENERAL_BUSINESS` has
`matches: []` — *"it is where selection LANDS, never something it matches"*. Verticals are
**additive**: never replacements.

| Profile | Keywords (verbatim, `profiles.ts`) | The statutory artefact that earns it |
|---|---|---|
| `SERVICES_WITH_STAFF` | clean · janitorial · housekeeping · facilities · maintenance · care · domiciliary · security · guarding · landscap · gardening · grounds · window · laundry | None — this one is **commercial**, not statutory. Consumables, subcontracted labour and equipment hire are simply invisible in a general chart. *"The first paying client is a cleaning agency"* |
| `TRADE_AND_CONSTRUCTION` | build · construct · plumb · electric · roof · joiner · carpent · plaster · decorat · scaffold · groundwork · heating engineer · tiling · renovation · refurbish | **CIS** and the **domestic reverse charge** |
| `RETAIL_AND_HOSPITALITY` | shop · retail · store · cafe · café · coffee · restaurant · takeaway · catering · bakery · deli · `bar ` · pub · salon · barber · hairdress · hospitality · kiosk · market stall | **The cold/hot, takeaway/eat-in zero-rate boundary** |

**Construction is the strongest case of the three, and the SA103F confirms it independently.**
**Box 18 of the sole-trader return is a dedicated line: *"Construction industry – payments to
subcontractors"*.** HMRC gives payments to CIS subcontractors their own box out of fourteen — no
other trade gets that. So the code's `COS_SUBCONTRACTORS_CIS` is not a nicety; it is the account that
fills a box HMRC prints on the form.

⚠ **And that produces a genuine, checkable defect.** `COS_SUBCONTRACTORS_CIS` exists **only** in the
`TRADE_AND_CONSTRUCTION` profile. A client whose `businessActivity` misses all fifteen keywords —
*"we fit kitchens"*, *"shopfitting"*, *"solar panel installation"*, *"drainage"* — gets
`GENERAL_BUSINESS` and **has no CIS account at all**, while still being fully within CIS and fully
within the reverse charge. A CIS subcontractor invoice for such a client codes to
`COS_PURCHASES` or escalates. **Recorded as F-BT-4.** The fix is not more keywords, which is a
treadmill; it is that CIS applicability is a **fact about the client** (are they a contractor or
subcontractor for CIS?) that the questionnaire could ask in one boolean, exactly as it already asks
`usesSubcontractors`.

**CIS rates, verified 2026-09-03**
([gov.uk, subcontractor guidance](https://www.gov.uk/what-you-must-do-as-a-cis-subcontractor/how-payments-work)):
registered — *"a contractor must deduct 20% from your payments and pass it to HM Revenue and Customs
(HMRC)"*; unregistered — *"If you do not register for the scheme, contractors must deduct 30% from
your payments instead"*; **gross payment status** — deductions are not taken at all (the page frames
it as an alternative to advance deduction and states no percentage, so **0% is a description, not a
quoted rate**).

**What counts as construction**, verbatim from
[gov.uk CIS overview](https://www.gov.uk/what-is-the-construction-industry-scheme): work to *"a
permanent or temporary building or structure"* and *"civil engineering work like roads and
bridges"*, including site preparation, demolition and dismantling, building work, alterations,
repairs and decorating, installing systems for heating, lighting, power, water and ventilation, and
cleaning interiors after construction work. **Excluded**: architecture, surveying, scaffolding hire
*without labour*, carpet fitting, material manufacturing and delivery, and non-construction site
work. ⚠ **"Scaffolding hire without labour" is excluded but `scaffold` is a profile keyword** — a
scaffolding-hire business would be given a CIS account it may never need. Harmless (a picklist entry,
not a coding), but it shows keyword matching standing in for a legal test.

**Retail and hospitality** is earned by the VAT boundary alone, and §3.7's C15/C16 already verify it:
cold takeaway zero-rated, hot and eat-in standard-rated (Notice 709/1, VFOOD4220), and
`CARD_AND_PLATFORM_FEES` carrying VAT `VARIES` because card processing is **taxable** post-*Bookit*
while delivery-platform commission is standard-rated (§3.7 C16, and F-UK-3 for the code's looseness
there). ⚠ **VAT retail schemes** (point of sale, apportionment, direct calculation) and the **Flat
Rate Scheme** (including the 16.5% limited-cost-trader rate and the £150k/£230k thresholds) are
**not verified** — not reached within budget. **A flat-rate-scheme client's input VAT treatment
differs on essentially every purchase document**, so this is a real gap in the research rather than
a tidy-up, and it is noted as such in §8.

⚠ **Hospitality tipping / troncs** (Employment (Allocation of Tips) Act 2023): **not verified**.

**Professional services has no profile, deliberately**, and I agree with the reasoning: software,
subscriptions, professional fees, travel and training are all core accounts. The one thing a
professional-services chart genuinely wants that the core lacks is **work in progress / unbilled
revenue** — but WIP is a **year-end journal**, not a purchase document, so it is correctly out of
scope for the same reason drawings and dividends are.

### 2.7 What actually differs, in one table

| Axis | Sole trader | Partnership | Ltd company | LLP | Charity |
|---|---|---|---|---|---|
| Operating expense categories | \<--------------------- **substantially identical; driven by trade, not by form** ---------------------\> | | | | ⚠ analysed by **purpose**, not nature |
| Top-level statement | P&L | P&L + allocation | P&L (CA 2006 format) | P&L + members' division | **SoFA** |
| How profit reaches the owner | Drawings (capital) | Profit share (capital) | **Salary (expense)** + **dividend (distribution)** | **Split**: expense *and* allocation | n/a — no owners |
| Owner's personal spend on a business card | `PRIVATE_USE` | Partner's current a/c | **Director's loan a/c** | Member's account | Never acceptable |
| Tax | Income tax, personal | Transparent | **Corporation tax, entity-level** | Transparent | Largely exempt; not VAT-exempt |
| Default accounting basis | **Cash basis** | **Cash basis** (no corporate partners) | Accruals only | Accruals | Accruals over threshold |
| Extra dimension on every transaction | — | Partner | — | Member | ⚠ **Fund** |

**The one-sentence answer to the section's question.** *Expense* categories differ by **trade**, and
the code models that well with four profiles. *Income*, *equity* and *appropriation* categories
differ by **legal form**, and the code models that not at all — which is correct for coding purchase
documents and becomes wrong the moment the chart is used for anything else.

---

## 7. What the code currently encodes — the verdict column

**§0 is the raw inventory, written from the code before any research. This is the verdict.** Every
row carries one of:

| Mark | Meaning |
|---|---|
| ✅ **Confirmed** | Verified against a primary source, cited in §3, §4 or §5 |
| 🟡 **Imprecise** | The rule is right; the citation or the framing is not |
| ⚠ **Wrong** | The code's claim contradicts the source. Correct value given, code unchanged |
| ⬜ **Unsourced — correctly** | No external source exists. A product judgement, and legitimately so |
| ⬛ **Unsourced — owed** | A judgement presented as though it had a basis, or one that should be stated |
| ❌ **Stale** | Was right, has been overtaken |

### 7.1 The twenty citations (§0.5, C1–C20)

| # | Claim | Verdict | Where verified |
|---|---|---|---|
| **C1** | BIM35805 — software with useful life under two years is revenue | 🟡 **HALF RIGHT — the most-repeated citation in the module** | §3.1. The under-two-years half is confirmed verbatim, *but it is a one-way Inspector's concession, not a test*, and the code's reverse inference (perpetual or ≥2 years ⇒ capital) **is not in the source and is contradicted by it**. → **F-UK-1** |
| **C2** | CAA 2001 s.71 — computer software is plant | 🟡 **Right in substance, inverted in use** | §3.2, CA23410. s.71 deems software plant **for capital expenditure**; it does not make a licence payment capital. Citing it as a *reason* something is capital inverts the logic. Statutory text **not verified** (legislation.gov.uk unreachable) |
| **C3** | IFRIC March 2019 — right to access hosted software is a service contract | ✅ **Confirmed, including the date** | §5.5 |
| **C4** | IFRIC — cloud configuration/customisation is expensed | 🟡 **Narrowed** | §5.6. The decision says *"often would not"* with a named exception (a separate resource the customer controls); the code treats it as always. Defensible product choice, not a restatement → **F-STD-2** |
| **C5** | IAS 16.17(d)–(e) — site preparation, installation, testing | ⚠ **WRONG SUB-PARAGRAPHS** | §5.1. Site preparation is **(b)**. Correct: **IAS 16.17(b), (d), (e)** read with **16.16(b)** → **F-STD-1** |
| **C6** | IAS 16.19(c) + IAS 38.69(b) — training expensed | ✅ **Confirmed** (19(c) slightly overstated alone; the pairing the code always uses is right) | §5.2, §5.3 |
| **C7** | IAS 38.57 — six criteria | ✅ **Confirmed** — exactly six, and *"shall … if and only if"* | §5.4 |
| **C8** | VATPOSS14600 — foreign tax increases the reverse-charge value | ✅ **CONFIRMED VERBATIM** — the single most load-bearing citation in the module | §3.7 |
| **C9** | No statutory de minimis in UK GAAP or IFRS | ✅ **Confirmed** (IAS 16.7, FRS 102 17.4, IAS 8.8, FRS 102 2.12) | §5.9 |
| **C10** | Business entertaining disallowable **and** input VAT blocked | ✅ **Both halves confirmed** | §3.6 |
| **C11** | Commercial rent exempt unless opted to tax | ✅ Confirmed | §3.7 |
| **C12** | Insurance VAT-exempt | ✅ Confirmed | §3.7 |
| **C13** | Input VAT blocked on cars, usually not vans | ✅ Confirmed | §3.7 |
| **C14** | CIS domestic reverse charge — no VAT for the customer to reclaim | ✅ Confirmed | §3.7. ⚠ Cite the technical guide, **not** Notice 735 |
| **C15** | Cold takeaway zero-rated; hot / eat-in standard-rated | ✅ Confirmed | §3.7 |
| **C16** | Card processing is an exempt financial service | ⚠ **TOO LOOSE** — post-*Bookit*/*NEC*, card-processing fees are **taxable** | §3.7 → **F-UK-3** |
| **C17** | Foreign consumption tax never reclaimable UK input VAT | ✅ **Confirmed twice over** | §3.7 (VIT12100, UK side) **and now §4.4 (Australian side — no refund route exists either)** |
| **C18** | Charitable donations relieved, not a trading deduction | ✅ Confirmed for companies (CTM09005, CTA 2010 Pt 6); for unincorporated traders they generally fail wholly-and-exclusively | §3.6 |
| **C19** | Intuit/QuickBooks: 62.5% top-1, 20.8% unseen category, 36% zero-shot; top-2 ≈ +10pts | ✅ **CONFIRMED — primary source located** | §7.2 below. This one was open when §0 was written |
| **C20** | Repairs vs improvements is the tier-1 UK judgement | ✅ Confirmed, **and the code is cleaner than the brief that commissioned it** — there is no two-year repairs test and the code never claims one | §3.4 |

### 7.2 ✅ C19 — the source, found and read

**The source is `arXiv:2506.09234v1`, *"Transaction Categorization with Relational Deep Learning in
QuickBooks"*, Dong, Jonnalagedda, Gao, Acharya, Kissa, Flores, Chawla and Das, submitted **10 June
2025**, most authors affiliated **"Intuit, Mountain View CA 94043, USA"**.**
[abstract](https://arxiv.org/abs/2506.09234) · [full text](https://arxiv.org/html/2506.09234v1)

**All three of the code's figures are confirmed to two decimal places**, and the module's `CLAUDE.md`
description of them as *"published research rather than marketing"* is accurate — this is an
engineering paper reporting its own production baseline:

| Code's figure | Paper | Table |
|---|---|---|
| 62.5% top-1 | **62.49** — *Lynx*, Few Shot | Table 1 |
| 20.8% unseen category | **20.84** — Top-1 on *Historical Unseen* categories, i.e. *"present in the overall dataset but unseen to that company's history"* | Table 2 |
| 36% zero-shot | **36.07** — *Shorthair*, Zero Shot | Table 1 |
| top-2 ≈ +10 points (`SECOND_CHOICE_CONFIDENCE = 0.1`) | **68.67 → 78.97 = +10.30 points** (Rel-Cat, Few Shot) | Table 1 |

**✅ The `SECOND_CHOICE_CONFIDENCE = 0.1` design decision is vindicated exactly.** Offering a second
choice wherever there was a runner-up buys about ten points, and the paper measures it at 10.30.
This is the best-grounded number in the module.

⚠ **Two framing corrections, neither of which changes a behaviour, both of which change a sentence:**

1. **The three figures are not one system's three settings.** *Shorthair* is *"a population model
   that employs contrastive learning and Word2Vec embeddings"*; *Lynx* is *"built on top of
   Shorthair … a logistic regression model customized to a company"*. So **62.49 and 36.07 are two
   different models**, not one model measured two ways. The code and `CLAUDE.md` present them as
   *"Intuit/QuickBooks published categoriser accuracy: top-1, unseen-category, zero-shot"*, which
   reads as one system. **Correct statement:** *"the personalised production model scores 62.5%
   top-1; the population model, which is what a brand-new company gets, scores 36.1%."* That is
   actually a **sharper** statement of the cold-start risk (SoT §21) than the one the code makes.
2. ⚠ **The paper's own new model reaches 68.67% top-1**, and the whole point of the paper is that
   the 62.5% baseline is beatable. **Designing to 62.5% remains the right call** — it is the
   *production* figure, and Rel-Cat's 68.67 is a research result on Intuit's own data with Intuit's
   own graph — but the module should not imply 62.5% is a ceiling for the field. It is a floor that
   has already been raised in the same document it is cited from.

**F-INT-3 is confirmed and can be closed:** the code's `62.5 / 20.8 / 36` and the SoT §24.4.7's
`~62 / ~21` are the same numbers, both traceable to this paper. The module `CLAUDE.md`'s claim that
its figures are *"worse than §24.4.7's"* remains wrong — they are the same figures — and the
zero-shot 36% is simply an extra one the SoT does not carry. **Recorded as F-AI-1**, a
documentation correction only.

### 7.3 The numeric constants (§0.3)

| Number | Verdict | Basis |
|---|---|---|
| **£1,000** capitalisation threshold | ⬜ **Unsourced — and correctly so.** ✅ §5.9 confirms there is **no** statutory de minimis in IFRS or UK GAAP, so no source can exist. The code says exactly this and marks it `source: 'PLATFORM_DEFAULT'` | ⚠ But **F-INT-1**: the SoT requires it to be per-practice and it is not persisted |
| **±10%** boundary band | ⬛ **Unsourced — owed a sentence.** Nothing external could support it and nothing needs to; it is the width of a review band. But unlike the £1,000 it carries **no `source` field and no comment saying it is arbitrary**, so a reader may assume it has a basis. It decides how much `THRESHOLD_BOUNDARY` review work every practice gets | **F-TH-1** |
| **two years** (software) | 🟡 **Half confirmed, half wrong** | §3.1 / C1 → **F-UK-1** |
| **8.875%** | ⬜ n/a — narrative only, the example invoice's stated rate | §6 |
| **62.5 / 20.8 / 36** | ✅ **Confirmed** (62.49 / 20.84 / 36.07) | §7.2 |
| **0.1** `SECOND_CHOICE_CONFIDENCE` | ✅ **Confirmed** — measured +10.30 points | §7.2 |
| **0.9 … 0.35** `CONFIDENCE_BY_BASIS` | ⬜ **Unsourced — correctly.** Display-only, and **F-INT-2** establishes it must never gate. A number that decides nothing needs no source | |
| **0.1** new-supplier penalty | ⬜ Unsourced — correctly. Display-only | |
| **0.3** `CONFIDENCE_FLOOR` | ⬜ Unsourced — correctly. Display-only | |
| **1 + n pence** tolerance | ⬜ Engineering tolerance, no source applicable. Deliberately generous: §6 shows `documentReconciles()` accepts three readings and fails only when none reconciles | |
| **200** `HISTORY_WINDOW` | ⬜ Engineering bound, stated as such in the module TODO | |

### 7.4 The category lists (§0.2)

| List | Verdict | Basis |
|---|---|---|
| 5 `LEDGERS` | ⬜ **Unsourced — correctly, and now confirmed twice.** §2 establishes there is **no mandated UK chart of accounts** (as `profiles.ts` already claims) and §4.5 finds **the ATO publishes none either**. The chart is legitimately the practice's choice | |
| 37 core accounts | ✅ **Benchmarked and sound.** Maps cleanly onto **12 of the 14 SA103F expense boxes** | ⚠ **F-BT-2**: box **25** *interest on bank and other loans* and box **27** *irrecoverable debts written off* have **no account** |
| Absence of a `SUNDRY` catch-all | ✅ **Correct, and it is the one place the code is stricter than HMRC** — SA103F box 30 *is* a catch-all (*"Other business expenses"*), and the code refuses to have one | §2.1 |
| The separately-identifiable group | ✅ **Better than the form it feeds** — SA103F box 24 merges advertising with entertaining and expects the taxpayer to disentangle them into disallowable box 39; the code splits them at source | §2.1, §3.6 |
| `VAT_TREATMENTS` (5) | ✅ Correct **for the UK** | ⚠ §4.6: would not port to AU — *GST-free* and *input-taxed* must be distinct members |
| `TAX_CONSEQUENCES` (3) | ✅ Correct. Structurally it is SA103F's disallowable column expressed as an account flag | §2.1 |
| `SERVICES_WITH_STAFF` (+5) | ⬜ **Unsourced — correctly.** This profile is commercial, not statutory: no source could confirm it | §2.6 |
| `TRADE_AND_CONSTRUCTION` (+6) | ✅ **Confirmed, and independently corroborated** — SA103F prints CIS its own box (18) out of fourteen | ⚠ **F-BT-4**: `COS_SUBCONTRACTORS_CIS` exists only in this profile, so a CIS business that misses the keywords has no CIS account |
| `RETAIL_AND_HOSPITALITY` (+6) | ✅ Confirmed on the food boundary (C15) | ⚠ `CARD_AND_PLATFORM_FEES` — see **F-UK-3** |
| No professional-services profile | ✅ **Correct.** The only thing such a chart wants that the core lacks is WIP, which is a year-end journal, not a purchase document | §2.6 |
| No internally-developed-software account | ✅ **Correct, and stronger than the code argues.** Under **FRS 102 18.8H** capitalisation is a **policy choice** (*"may"*), not IAS 38.57's *"shall"* — so for a UK small company it depends on a policy the practice adopted, which is even less a fact on an invoice | §5.4, §5.10 |
| **No legal-form axis at all** | ⚠ **The structural gap** — four profiles, all trade verticals; no sole trader / company / LLP / charity dimension anywhere in the product | §2.0 → **F-BT-1** |

### 7.5 The decision rules (§0.4, branch order 0–8)

| Branch | Verdict |
|---|---|
| 0 · `TAX_LINE` regex ⇒ never a category | ✅ **Confirmed, and §4.4 strengthens it.** Foreign consumption tax is cost, permanently — there is no UK route (VIT12100) *and* no Australian route for a UK claimant |
| 1 · Training ⇒ revenue, always | ✅ **Confirmed.** IAS 38.69(b) is a genuine bright line (§5.3); FRS 102 17.11(c) mirrors it |
| 2 · Support/managed services ⇒ revenue | ✅ Sound. A service acquires no asset (CF 4.3/4.20, IAS 38.69 chapeau — §5.7) |
| 3 · Hosting/cloud ⇒ revenue, *"never capital, at any amount"* | ✅ **Confirmed** (IFRIC March 2019, §5.5). And §4.2 shows Australia reaches the same answer by a different mechanism |
| 4 · Software: recurring ⇒ revenue | ✅ **Confirmed** — BIM35805 is explicit that periodic payments are revenue |
| 4 · Software: perpetual ⇒ threshold test ⇒ capital | ⚠ **The reverse inference is WRONG.** BIM35805 contemplates the opposite: benefits may be *"sufficiently transitory to stamp the payment as revenue even though the licence granted is for an indefinite period."* → **F-UK-1** |
| 4 · Term unknown ⇒ escalate | ✅ **The single best decision in the module.** §6 is right that this is the most consequential unknown on an IT invoice, and F-UK-1 makes it *more* important, not less: since perpetual does not reliably mean capital, guessing the term would compound two errors |
| 5 · Install ⇒ capital into the asset; configure ⇒ expensed; both ⇒ escalate | ✅ **Rule correct**, ⚠ **citation wrong** (F-STD-1) and ⚠ **the configure half is narrowed** (F-STD-2) |
| 6 · Small IT before hardware ⇒ revenue | ⬜ Product judgement. Correct given the threshold is a policy |
| 7 · Hardware — per-unit test `net ≥ threshold × units` | ✅ **Sound, and the arithmetic is right**: integer, no division, so no float and no rounding. ⚠ §4.1 notes AU applies its threshold to the **whole cost even where only part is claimed** — a different rule, were AU ever in scope |
| 8 · Keyword match on the client's own chart, else escalate | ✅ Correct. Refusing a near miss (§6, `CODE_NOT_ON_CHART`) is right — a near miss on a chart is an invisible error |
| Doc-level: arithmetic **before** classification | ✅ **Correct and important.** No category is assigned to a number that is not the right number |
| Doc-level: escalation beats a coded majority | ✅ Correct |
| Doc-level: `MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` | ⚠ **A schema artefact, not an accounting rule** — §9 |

### 7.6 Scoreboard

Of the twenty citations: **thirteen confirmed**, **four imprecise**, **two wrong**, **one
(C19) confirmed against a primary source located during this pass**.
Of the eleven numeric constants: **two externally confirmed**, **eight unsourced by design and
legitimately so**, **one owed a sentence**.
**Nothing in the module is stale**, and — see §4.7 — the reason for that is partly that it encodes no
jurisdiction figures beyond the UK at all.

**The overall picture is a module whose rules are substantially right and whose citations are the
weaker half.** Every error found is in a citation string or a framing sentence; **not one of them
changes what the code does on a document**, with the single exception of F-UK-1, which changes what
the code *should* do on a perpetual licence.

---

## 8. Findings and recommendations

**Nineteen findings.** Every one carries the correct value and its source, and **none of them was
acted on — no code was changed.** `modules/rules-suggestions` belongs to another lane, and a silent
behavioural change to a coding engine must be a deliberate, reviewed decision (G7, Governance §10).
Several of these are one-line documentation fixes; **two are not**, and those two want an issue.

The internal findings **F-INT-1 … F-INT-4** are written up in full in **§8b** and are not repeated
here; they appear in the priority table and in the recommendations.

### 8.1 Priority order

| # | Finding | Class | Changes a coding? | Priority |
|---|---|---|---|---|
| 1 | **F-UK-1** — perpetual licence ⇒ capital is not what BIM35805 says | ⚠ Wrong | **Yes** | **P1** |
| 2 | **F-BT-1** — no legal-form axis; `PRIVATE_USE` is wrong for a company | ⚠ Gap | **Yes** | **P1** |
| 3 | **F-BT-4** — `COS_SUBCONTRACTORS_CIS` exists only in one profile | ⚠ Gap | **Yes** | **P1** |
| 4 | **F-INT-1** — capitalisation threshold not per-practice (SoT §24.4.6) | ⚠ Unmet requirement | Indirectly | **P1** |
| 5 | **F-STD-1** — IAS 16.17 wrong sub-paragraphs | ⚠ Citation | No | **P2** |
| 6 | **F-UK-3** — card processing is taxable, not exempt | ⚠ Citation | No (VAT flag is `VARIES`) | **P2** |
| 7 | **F-UK-2** — BIM358xx mainly bites for unincorporated businesses | ⚠ Scope | No | **P2** |
| 8 | **F-STD-3** — FRS 102 18.3B, software integral to hardware, unreflected | ⚠ Gap | Potentially | **P2** |
| 9 | **F-BT-2** — no account for loan interest (SA103F box 25) | ⚠ Gap | **Yes** | **P2** |
| 10 | **F-STD-2** — cloud configuration narrowed from *"often would not"* to *always* | 🟡 Narrowing | No | **P3** |
| 11 | **F-AI-1** — C19 presented as one model's three numbers; it is two models | 🟡 Framing | No | **P3** |
| 12 | **F-TH-1** — the ±10% band carries no `source` and no "this is arbitrary" note | ⬛ Owed | No | **P3** |
| 13 | **F-BT-3** — a charity cannot be represented; say so explicitly | ⚠ Scope | No | **P3** |
| 14 | **F-AU-1** — never hardcode a jurisdiction threshold | ⬜ Policy | No | **P3** |
| 15 | **F-INT-2** — SoT expects confidence to gate; the code refuses. **The code is right** | ✅ SoT amendment | No | **P3** |
| 16 | **F-INT-3 / F-AI-1** — accuracy figures internally consistent **and now externally sourced** | ✅ Closed | No | Close |
| 17 | **F-INT-4** — Australia out of scope everywhere. Correct | ✅ No action | No | Close |
| 18 | **F-BT-2b** — no account for irrecoverable debts (SA103F box 27) | ⬜ Accept | No | Won't fix |
| 19 | **§5.2** — IAS 16.19(c) alone does not carry the general training rule | 🟡 Wording | No | **P3** |

### 8.2 P1 — the four that matter

#### ⚠ F-UK-1 · A perpetual licence is not automatically capital

**Where:** `capital-revenue.ts` branch 4; `coding-instructions.ts` rule 4; `FA_SOFTWARE_LICENCES`;
the `SUBSCRIPTION_TERM_UNDER_TWO_YEARS` basis; module `CLAUDE.md` (*"Perpetual ⇒ capital"*).

**What the code claims:** software with a useful life under two years is revenue; **a perpetual
licence, or one with a term of two years or more, is capital** — cited to HMRC BIM35805.

**What BIM35805 actually says.** The first half is right and is a **one-way concession**:
*"where software is expected to have a useful economic life of less than two years Inspectors will
accept that the expenditure is revenue"*, and [BIM35810](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35810)
instructs staff *"You should not contend that software with an expected useful life of less than two
years is capital."*

**The second half is not in the source, and the source contemplates its opposite.** The actual test
is functional: *"a licence is a capital asset if it has a sufficiently enduring nature"* — and
benefits may be *"sufficiently transitory to stamp the payment as revenue **even though the licence
granted is for an indefinite period**."*
[BIM35805](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35805)

**Correct rule:** *under two years ⇒ revenue (a safe harbour). Two years or more, or perpetual ⇒
**not determined by the term** — it turns on enduring nature, which is a judgement.*

**What I would change.** Not the branch, and not to "escalate everything perpetual" — that would
flood the queue and most perpetual licences over the threshold genuinely are capital. I would:

1. **Fix the citation and the prose.** `coding-instructions.ts` rule 4 and the `capital-revenue.ts`
   header currently state a rule HMRC does not have. That prose is what a model is shown and what an
   accountant reads in a `reviewNote`; a wrong rule stated confidently is the thing this module is
   otherwise excellent at avoiding.
2. **Rename the basis.** `SUBSCRIPTION_TERM_UNDER_TWO_YEARS` is accurate for the revenue direction
   and is the *only* direction the two-year test supports. The capital direction should carry a
   different basis name — it is resting on enduring nature and the threshold, not on the term.
3. **Add the enduring-nature caveat to `FA_SOFTWARE_LICENCES.reviewNote`**, which is exactly the
   surface designed to carry it.

⚠ **This raises the value of `SOFTWARE_TERM_UNKNOWN`, it does not lower it.** §6 calls it *"the most
consequential unknown on an IT invoice"* and that is now more true: since neither direction of the
two-year test is a clean answer for a long-term licence, inferring the term from the vendor would
compound a guess with a rule that does not hold.

#### ⚠ F-BT-1 · No legal-form axis — and `PRIVATE_USE` is the sharp end of it

**Where:** `BUSINESS_PROFILE_IDS` (four trade verticals, no legal form);
`BusinessContextQuestionnaire` (`openapi.yaml` line 6857 — six properties, none of them entity type);
`PRIVATE_USE` in the core chart.

**The finding.** Full analysis in §2.0 and §2.3. The chart has no `DIRECTORS_REMUNERATION`,
`DIRECTORS_LOAN_ACCOUNT`, `DIVIDENDS`, `DRAWINGS`, `PARTNERS_CURRENT_ACCOUNT` or corporation-tax
account, and nothing in the product records whether a client is a sole trader, a company, an LLP or
a charity.

**Most of that is correct for ID and I would not change it** — those are equity and year-end
accounts, and ID codes purchase documents.

⚠ **The exception is `PRIVATE_USE`, and it is a live miscoding today.** It is a **sole-trader**
concept (VAT `BLOCKED`, tax `DISALLOWABLE`). For a limited company the identical transaction — a
director putting personal spend on the company card — is a **director's loan account** movement or a
**benefit in kind**: a balance-sheet entry with a potential CTA 2010 s.455 charge and a P11D, not a
disallowed expense. Coding it to `PRIVATE_USE` produces a P&L disallowance where the correct answer
is a balance-sheet debit, and **the practice's own director's loan reconciliation will not find it**.

**What I would change**, cheapest first:

1. **Immediately, and it costs nothing:** amend `PRIVATE_USE.reviewNote` to say that for an
   incorporated client the entry is normally a director's loan account movement, not a disallowable
   expense. The `reviewNote` mechanism already exists precisely for tier-1 judgements.
2. **Then**, propose **one optional enum on `BusinessContextQuestionnaire`** — `legalForm`:
   `SOLE_TRADER | PARTNERSHIP | LIMITED_COMPANY | LLP | CHARITY | OTHER`. That is a
   `packages/contracts` change and therefore **LAW (G7) — a contract-change issue before a PR**. It
   is additive and optional, so it does not break the D47 invite path that made the questionnaire
   optional in the first place. I would argue for it on the strength of `PRIVATE_USE` alone; the
   equity accounts are a bonus and a later stage.
3. **Do not** add a `CHARITY` profile to `BUSINESS_PROFILE_IDS` — see F-BT-3.

#### ⚠ F-BT-4 · A CIS business that misses fifteen keywords gets no CIS account

**Where:** `COS_SUBCONTRACTORS_CIS` exists **only** in `TRADE_AND_CONSTRUCTION.additions`.

**The finding.** Profile selection is keyword matching over free text. *"We fit kitchens"*,
*"shopfitting"*, *"solar panel installation"*, *"drainage contractor"* match none of the fifteen
keywords, land on `GENERAL_BUSINESS`, and get **no CIS account at all** — while being fully within
CIS and fully within the domestic reverse charge.

**Why this is P1 and not a nicety.** The module's own file header calls the reverse charge *"a
§24.4.6 tier-3 error that lands straight on a VAT return"*. A CIS subcontractor invoice for such a
client codes to `COS_PURCHASES` — which carries `vatTreatment: 'STANDARD'`, whereas
`COS_SUBCONTRACTORS_CIS` carries `VARIES` **with a reverse-charge note**. So the failure mode is not
a missing picklist entry; it is **a reverse-charge invoice presented as an ordinary standard-rated
purchase**, with the advisory that would have flagged it silently absent.

And SA103F corroborates the significance independently: **HMRC gives CIS subcontractor payments
their own box (18) out of fourteen.** No other trade gets one.

**What I would change.** **Not more keywords** — that is a treadmill, and the `scaffold` keyword
already shows the limits of the approach (scaffolding hire *without labour* is expressly outside
CIS, per [gov.uk](https://www.gov.uk/what-is-the-construction-industry-scheme), yet `scaffold` selects
the CIS profile). CIS applicability is a **fact about the client**, not an inference from a sentence.
The questionnaire already asks `usesSubcontractors: boolean`. I would propose a sibling
`withinCIS: boolean` — one optional field, additive, contract-change issue — and make
`COS_SUBCONTRACTORS_CIS` conditional on it rather than on the trade profile. Until then, the interim
is a `reviewNote` on `COS_PURCHASES` naming the reverse charge.

**CIS rates for the write-up**, verified 2026-09-03: **20%** registered, **30%** unregistered, gross
payment status = no deduction ([gov.uk](https://www.gov.uk/what-you-must-do-as-a-cis-subcontractor/how-payments-work)).

#### ⚠ F-INT-1 · The capitalisation threshold is required to be per-practice and is not persisted

Full write-up in **§8b**. **Nothing in the research changes the assessment and one thing sharpens
it:** §5.9 confirms there is **no statutory de minimis in IFRS or UK GAAP** — IAS 16 rests solely on
IAS 16.7's qualitative criteria, FRS 102 17.4 the same, and what permits a threshold at all is
**materiality**, which FRS 102 para 2.12 says is *"an **entity-specific** aspect of relevance."*

**So the SoT's "per-practice, never a hard-coded number" is not a product preference — it is the only
treatment consistent with the standards.** A single platform figure applied to every practice is,
strictly, a materiality judgement made by the software vendor on the accountant's behalf. The code's
`source: 'PLATFORM_DEFAULT'` field is the right interim because it prevents the number being
presented as the practice's, but it does not make the number right.

**What I would change:** persist it. `source: 'PRACTICE'` is already in the type, so the code change
is small once a column exists. A `practices` column is **LAW (G7)** → contract-change issue.
**Priority is higher than it looks**: the ±10% band around £1,000 (£900–£1,100) is where every
`THRESHOLD_BOUNDARY` escalation is generated, so the platform default currently decides how much
review work every practice does.

### 8.3 P2 — citation and scope corrections

#### ⚠ F-STD-1 · IAS 16.17 — the code cites (d)–(e) for three things, one of which is (b)

Full analysis §5.1. **Correct citation: IAS 16.17(b) [site preparation], (d) [installation and
assembly], (e) [testing]**, read with **IAS 16.16(b)**.
[AASB 116 — verbatim mirror](https://www.aasb.gov.au/admin/file/content105/c9/AASB116_08-15.pdf)

Appears in four places (`profiles.ts`, `capital-revenue.ts`, `coding-instructions.ts`, module
`CLAUDE.md`). **The rule is right; only the string is wrong.**

⚠ **My recommendation is not simply to fix the letters.** For this product's actual audience — UK
small companies and unincorporated businesses on FRS 102 — **FRS 102 17.10(b) is the better
citation**, because it says the whole thing in one reference: directly attributable costs *"can
include the costs of site preparation, initial delivery and handling, installation and assembly, and
testing of functionality"*. One reference, no lettering trap, and it is the framework the client's
accounts are actually prepared under.
[FRS 102 September 2024](https://www.frc.org.uk/documents/7668/FRS_102_September_2024_tmKYWO6.pdf)

#### ⚠ F-UK-3 · Card processing fees are taxable, not exempt

**What the code says** (`CARD_AND_PLATFORM_FEES`, C16): card processing is an exempt financial
service.

**What HMRC says.** [VATFIN2450](https://www.gov.uk/hmrc-internal-manuals/vat-finance-manual/vatfin2450):
after ***Bookit Ltd* (C-607/14)** and ***National Exhibition Centre Ltd* (C-130/15)**, *"fees charged
for card processing services that enable a customer to pay by debit or credit card are **taxable**
and do not qualify for exemption."* Core money-transfer services remain exempt (VATA 1994 Sch 9
Group 5 item 1).

**Mitigating, and it is why this is P2 not P1: the account's `vatTreatment` is already `VARIES`**, so
the code does not actually assert a recovery position on a document. It is the **explanatory prose**
that is wrong, and that prose is what a reviewer reads.

**What I would change:** correct the note to *"card processing fees are generally taxable
post-*Bookit*; core money-transfer services remain exempt; delivery-platform commission is
standard-rated"*, and cite VATFIN2450. ⚠ **Do not cite Notice 701/49** — it returned **404 on three
slug variants** and is **not verified**.

#### ⚠ F-UK-2 · The module's most-cited authority mainly applies to unincorporated businesses

[BIM35801](https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim35801): for
**companies**, software normally falls within the **CTA 2009 Part 8 intangible fixed assets
regime**, which is **accounts-based** — so the capital/revenue divide is largely irrelevant — except
where excluded or where a **CTA 2009 s.815 election** is made.

**The consequence is uncomfortable and worth stating plainly: the BIM35805 analysis the code leans
on hardest is weakest exactly for limited companies, and the code cannot tell whether a client is
one** (F-BT-1). The two findings compound.

**What I would change:** nothing behavioural. Under Part 8 the tax answer follows the accounts, and
the code's accounting answer (IFRIC/IAS 38/FRS 102) is the one that then drives it — so the *outcome*
is usually right even though the *cited reason* does not apply. I would add the caveat to the
`capital-revenue.ts` header so nobody builds a company-specific rule on a manual page that does not
govern companies.

#### ⚠ F-STD-3 · FRS 102 18.3B — software integral to hardware is PPE, and the code does not know it

**New para 18.3B**, introduced by the **Periodic Review 2024**
([FRC amendments, 27 March 2024](https://www.frc.org.uk/documents/7128/Amendments_to_FRS_102_and_other_FRSs.pdf)),
**effective 1 January 2026 and therefore in force today**: software **integral to hardware** (e.g. a
machine's operating software) is treated as **PPE**; otherwise as an intangible. Mirrors IAS 38.4.

**What the code does:** software keywords route to `FA_SOFTWARE_LICENCES` (intangible) or
`SOFTWARE_AND_SUBSCRIPTIONS`; hardware routes to `FA_COMPUTER_EQUIPMENT` / `FA_PLANT_AND_EQUIPMENT`.
**There is no branch for software that is part of the machine.** Embedded firmware, a CNC
controller, a till's operating software, a medical device's software — all read as "software" and
route away from the asset they belong to.

**What I would change:** this is a genuine rule gap, but a **rare** one at ID volumes and one where
the evidence is usually on the same document as the hardware. The cheapest correct behaviour is
already available: `hasCapitalHardware` is computed in `LineContext`, and a software line on a
document that also carries capital hardware is exactly the ambiguity `MIXED_CAPITAL_AND_REVENUE`
exists for. I would **escalate rather than build a branch** — consistent with how the module already
handles the install/configure split.

#### ⚠ F-BT-2 · No account for loan interest

SA103F box **25** *"Interest on bank and other loans"* has no counterpart in the 51 codes.
`BANK_CHARGES` (box 26) is a different box on the form and a different thing in a P&L: bank
*charges* are a service cost, loan *interest* is a finance cost. A lender's interest statement is a
document a client photographs and sends, so it will arrive.

**What I would change:** add `INTEREST_PAYABLE` to the core chart — `Expenses`,
`vatTreatment: 'OUTSIDE_SCOPE'` (interest is not a supply for VAT), `taxConsequence: 'ALLOWABLE'`.
This is chart **data**, not schema, and is the cheapest fix in this document.

**Box 27 (irrecoverable debts) I would deliberately not add** — a bad debt is a year-end journal,
never a purchase document, and adding an account nothing can ever suggest is picklist clutter.

### 8.4 P3 — framing, wording and things to write down

| Finding | Recommendation |
|---|---|
| **F-STD-2** — cloud configuration | §5.6: the agenda decision says *"often would not"* recognise an intangible, **with a named exception** (a separate resource the customer controls). The code says *always expensed*. **I would keep the behaviour** — the exception needs an internally-developed-software account the chart deliberately lacks (§5.4), and such lines escalate — but **say in the prose that it is a deliberate narrowing**, not a restatement of the standard |
| **F-AI-1** — C19 framing | §7.2. Restate as *"the personalised production model scores 62.5% top-1; the population model, which is what a brand-new company gets, scores 36.1%"* — two models, not one. Note the same paper's successor reaches **68.67%**, so 62.5% is a production baseline, not a field ceiling. Also correct the module `CLAUDE.md`'s *"worse than §24.4.7's"* — they are the same figures |
| **F-TH-1** — the ±10% band | Unlike the £1,000 it carries **no `source` field and no comment saying it is arbitrary**. It decides how much review work a practice gets. Add one sentence at the declaration: *no external source supports this; it is the width of a review band, chosen, and it should move with measurement* |
| **F-BT-3** — charities | §2.5. A charity's SoFA analyses expenditure by **purpose**, support costs are **apportioned across activities**, and **fund** (unrestricted/restricted/endowment) is a **dimension** no field in this product — including the proposed `DocumentLine` — can carry. **State the exclusion explicitly** in `profiles.ts`, the way the file already states why professional services has no profile. ⚠ **Do not add a charity profile.** It would look like support for a structure the data model cannot represent |
| **F-AU-1** — jurisdiction thresholds | §4.7. The AU instant asset write-off became **permanent at $20,000 on 26 August 2026** — eight days before this document — by an Act that commences **1 October 2026** while applying from **1 July 2026**, so the current statutory compilation still reads `$1,000`. **The code encodes no AU figure and that is the best possible outcome.** If AU is ever in scope, thresholds arrive as **dated policy data with a named review owner**, never as constants — the `CapitalisationPolicy` value-not-constant design already generalises correctly |
| **F-INT-2** — confidence gating | §8b. **The code is right and the SoT sentence should move.** Raise a SoT wording amendment to §24.4.6 so the next reader does not implement the gate. §7.2 now gives the empirical backing: a production categoriser at 62.5% top-1 gating on self-reported confidence is how silent wrong codings happen |
| **F-INT-3** | **Closed.** Externally sourced in §7.2 |
| **F-INT-4** | **Closed.** No action; §4 is written as comparative research and says so |
| **§5.2** — IAS 16.19(c) | Recommended wording: *"training costs are not directly attributable costs of PPE (IAS 16.19(c)) and are expensed as incurred (IAS 38.69(b))"*. The code already cites both together everywhere, so only the implication that 19(c) alone carries the general rule is loose |

### 8.5 What is NOT wrong — worth recording, because it is most of the module

A findings list reads as a fault list. It is not. Verified sound and, in several places, better than
it needed to be:

- **The capital/revenue architecture.** `CapitalisationPolicy` as a **value** with a `source` field
  is the correct response to there being no statutory de minimis (§5.9), and it is the reason §4.6
  concludes the engine would port to another jurisdiction even though its content would not.
- **Every VAT claim except one** (C10–C15, C17) confirmed against HMRC manuals and notices.
- **C8 / VATPOSS14600 confirmed verbatim** — the most load-bearing citation in the module.
- **The escalation design.** Ten reasons, closed set, severity-ordered, prompts phrased as what
  would resolve them. §6's argument stands, and §7.2's accuracy figures are its empirical
  justification.
- **Refusing a `SUNDRY` catch-all** — stricter than SA103F, which *has* one (box 30).
- **Splitting entertaining from advertising** — SA103F merges them (box 24) and expects the taxpayer
  to disentangle them into box 39. The code does it at source.
- **`TRAINING_NEVER_CAPITAL`** — a genuine bright line, correctly identified as one of very few.
- **Omitting an internally-developed-software account** — and the reasoning is *stronger* than the
  code argues, because FRS 102 18.8H makes capitalisation a **policy choice** where IAS 38.57 makes
  it mandatory.
- **No two-year repairs test anywhere in the code** (§3.4) — the confusion was in the research brief,
  not the codebase.
- **Arithmetic before classification**, and `documentReconciles()` accepting three readings before
  declaring a mismatch.
- **`SECOND_CHOICE_CONFIDENCE = 0.1`** — measured at +10.30 points in the source paper (§7.2).

### 8.6 ⚠ What remains unverified, and why

Listed so the next reader does not mistake absence for absence of doubt. **Nothing below was filled
in from plausibility.**

| Item | Why not verified |
|---|---|
| **Charity accounting / audit thresholds** | **Six separate failures on the same fact**: CC15c (withdrawn), CC15d publication page (no figures), two CC15d full-text slugs (404), `running-charity/managing-charity-finances` (404), the charity guidance collection (404), `legislation.gov.uk` Charities Act 2011 s.145 (empty body), `charitysorp.org` (**403**) |
| **Charities SORP 2026 full title and publisher** | `charitysorp.org` returns **403** to automated retrieval and `web.archive.org` is **blocked**, so there was no fallback. The *effective date* — periods starting on or after **1 January 2026** — **is** verified, from the Charity Commission's CC15d page updated 19 Dec 2025 |
| **LLP SORP 2026 effective date and paragraph references** | CCAB's two pages give title (*Accounting by Limited Liability Partnerships 2026*) and publication date (**3 November 2025**) but no effective date and no detail. I did not open the SORP PDF. The members'-remuneration split is described from standing knowledge and **the citation is owed** |
| **Companies Act P&L Formats 1 and 2; CT600; medium-company thresholds** | `legislation.gov.uk` unreachable (empty body, not an error). The micro and small **figures** are verified from live gov.uk; their **6 April 2025 commencement** is not |
| **Trading allowance £1,000; simplified expenses / mileage rates** | Not reached within the fetch budget. ⚠ **Do not quote 45p/25p from this document** |
| **The tax year cash basis became the default** | Neither the SA103F form nor the gov.uk cash-basis page states it. The *fact* of the default is verified structurally (box 10 is an **opt-out** for traditional accounting; gov.uk calls cash basis *"the standard way"*) |
| **VAT retail schemes; Flat Rate Scheme incl. the 16.5% limited-cost-trader rate and £150k/£230k** | Not reached. ⚠ **A material gap**: an FRS client's input VAT treatment differs on essentially every purchase document |
| **Employment (Allocation of Tips) Act 2023 / troncs** | Not reached |
| **SA800 / SA104 partnership pages** | Not reached; §2.2's structural points are unsourced standing knowledge |
| **CAA 2001 s.71, s.11; ITTOIA 2005 s.33; CTA 2009 s.53; VATA 1994 s.24(1)** | `legislation.gov.uk` unreachable throughout. HMRC manuals state the effect and are cited instead |
| **Notice 701/49** | **404 on three slug variants** (predecessor). Cite VATFIN2450 instead |
| **Full expensing extended to leased assets; Autumn Budget 2025 measures** | Predecessor could not verify. Neither affects the code, which makes no capital-allowances claim |
| **"The ATO publishes no canonical chart of accounts"** | An **inference from absence**, flagged as such in §4.5, not a sourced positive statement |

**Method note on the two blocked hosts.** `legislation.gov.uk` returning an **empty body rather than
an error** is the dangerous failure of the two — a careless fetch reads as "no content found" rather
than "unreachable". Recorded here because the predecessor hit it in §3 and I hit it again in §2:
**it is the environment, not the pages.**

---

## 1. Executive summary

*One page. Written last, deliberately. Section numbers are this document's own; the sections appear
in the order they were researched, not in numerical order.*

**What this document is.** A check of `apps/api/src/modules/rules-suggestions/` against primary
sources — HMRC manuals, IFRS/IASB and FRC standards, Australian legislation, and the research paper
the module's accuracy figures come from. **It changes no behaviour and no code.** Where code and
source disagree the disagreement is written up as a finding with the correct value; the module
belongs to another lane and a silent change to a coding engine must be a deliberate, reviewed
decision (G7, Governance §10).

**The headline.** *The rules are substantially right. The citations are the weaker half.* Of the
twenty citations the code makes, **thirteen are confirmed**, four are imprecise, **two are wrong**,
and one — the accuracy figures — was unsourced until this pass and is now confirmed against the
primary paper. **Only one error changes what the code should do on a real document.**

### The five things worth knowing

1. ⚠ **The module's most-repeated citation is half right.** The code says *"a perpetual licence, or
   one of two years or more, is capital — HMRC BIM35805"*. **BIM35805 does not say that, and
   contemplates the opposite**: benefits may be *"sufficiently transitory to stamp the payment as
   revenue even though the licence granted is for an indefinite period."* The under-two-years half
   **is** right, but it is a one-way Inspector's concession, not a two-way test. **F-UK-1, P1.**

2. ⚠ **`PRIVATE_USE` is wrong for a limited company, and the product cannot tell which clients are
   companies.** All four business profiles are *trade verticals*; there is **no legal-form axis
   anywhere** — not in the chart, not in the intake questionnaire, not in the schema. For a sole
   trader a director-equivalent's personal spend is a disallowable private-use adjustment; for a
   company the same transaction is a **director's loan account** movement with a possible s.455
   charge. Today both get the same code. **F-BT-1, P1.**

3. ⚠ **A construction client whose description misses fifteen keywords gets no CIS account** —
   because `COS_SUBCONTRACTORS_CIS` lives only in the `TRADE_AND_CONSTRUCTION` profile. *"We fit
   kitchens"* lands on the general chart, and a reverse-charge subcontractor invoice then codes to
   `COS_PURCHASES` (`vatTreatment: 'STANDARD'`) with the reverse-charge note absent — the module's
   own header calls that *"a tier-3 error that lands straight on a VAT return"*. CIS status is a
   fact to ask for, not a keyword to guess. **F-BT-4, P1.**

4. ✅ **The accuracy figures are real, and the second-choice design is measurably right.** The source
   is **arXiv:2506.09234**, *Transaction Categorization with Relational Deep Learning in QuickBooks*
   (Intuit, 10 June 2025). 62.5% → **62.49**, 20.8% → **20.84**, 36% → **36.07**. And
   `SECOND_CHOICE_CONFIDENCE = 0.1` — the bet that offering a runner-up buys about ten points — is
   measured in the paper at **+10.30**. Two framing corrections in §7.2: the figures are **two
   different production models**, not one model's three settings, and the same paper's successor
   model reaches **68.67%**, so 62.5% is a baseline, not a ceiling.

5. ⚠ **Australia is not in scope anywhere in the product, and §4 must not be read as though it
   were.** The code encodes **no Australian threshold of any kind** — and that is the *best* outcome,
   not a gap. The instant asset write-off became **permanent at $20,000 on 26 August 2026**, eight
   days before this document, by an Act that **commences 1 October 2026** while applying from
   **1 July 2026** — so the current statutory compilation still reads **$1,000**. Any hardcoded
   jurisdiction figure would have needed a review cadence nobody has committed to. **F-AU-1.**

### How business types actually differ — the one-sentence answer

**Expense categories differ by *trade*; income, equity and appropriation categories differ by *legal
form*.** The code models the first well, with four profiles and a chart that maps cleanly onto
**12 of the 14 SA103F expense boxes** — and is in two places *better* than the form it feeds, because
it refuses a catch-all (SA103F box 30 has one) and splits entertaining from advertising (SA103F box
24 merges them). It models the second **not at all**, which is correct for coding purchase documents
and becomes wrong the moment the chart is used for anything else. **A charity is a different shape
again** — a SoFA analysed by *purpose*, support costs apportioned across activities, and **fund** as
a *dimension* that no field in this product, including the proposed `DocumentLine`, can carry.
**§2 recommends saying so explicitly and not adding a charity profile.**

### The two gaps that are not the rules' fault

- **`documents.category_code` is one nullable string with no line-item model.** The invoice that
  started this work needs **five treatments on one document**. Two of the ten escalation reasons
  exist **because of the schema, not the rules**: the lines were classified successfully and the
  answer could not be written down. **§9.**
- **The capitalisation threshold has no per-practice home.** The SoT requires it to be per-practice;
  §5.9 confirms *why* — there is **no statutory de minimis in IFRS or UK GAAP**, and what permits a
  threshold at all is **materiality**, which FRS 102 2.12 calls *"an entity-specific aspect of
  relevance"*. A single platform figure is a materiality judgement made by the vendor. **§8b F-INT-1.**

Both are **LAW (G7)** and want a contract-change issue, not a PR.

### Where to go next

| You want | Read |
|---|---|
| What the code encodes, raw | **§0** |
| The verdict on each of those, marked confirmed / imprecise / wrong / unsourced | **§7** |
| Everything to act on, in priority order, with the correct value and what I would change | **§8** |
| What could not be verified, and why | **§8.6** |

⚠ **Several hosts were unreachable and this shapes what could be checked.**
`legislation.gov.uk` returns an **empty body rather than an error** — the dangerous failure, because
a careless fetch reads it as "no content" instead of "unreachable" — so all UK statutory text is
verified via HMRC's manuals or marked **not verified**. `web.archive.org` is blocked outright, so
there was no fallback for the pages that returned 403. `ato.gov.au` 403s at the edge (reached via a
text proxy), and `austlii.edu.au`/JADE were unreachable, so **every Australian case quotation is
taken from an ATO ruling quoting the judgment**, not from the law report. **Nothing in this document
was filled in from plausibility; §8.6 lists every gap by name.**
