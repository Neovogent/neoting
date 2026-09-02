# How Dext decides a document's category — and what would make ours efficient

Status: research in progress (drafted 2026-09-03)
Author: research agent
Scope: mechanism research + design recommendation. No application code changed.

> Sourcing rule used throughout: every non-obvious claim carries a URL. Where no
> source was found the text says **not verified** rather than filling the gap
> from plausibility.

---

## Executive summary

_(to be completed)_

---

## 1. The decision mechanism

Dext does **not** have one categorisation algorithm. It has an **ordered stack of
overrides**, and the machine-learning model sits at the *bottom* of it as the
fallback that fills in whatever deterministic rules did not already set.

Their own words, from the automation overview article:

> "When more than one rule applies to the same item and the same field, Dext
> follows this order:
> - Dext AI Assist guidance - highest priority
> - User rules
> - Payment method rules
> - Supplier and customer rules
> - Account-level defaults - lowest priority
>
> **Auto-categorisation fills in the category field only if no supplier rule has
> already set one.**"
> — [Rules and automation in Dext](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)

And from the auto-categorisation article itself:

> "When Auto-categorisation is enabled, Dext uses machine learning to analyse
> your previously categorised items and automatically apply the most relevant
> category to new documents. **If you've set up supplier rules, Dext will apply
> those rules first when assigning categories.**"
> — [How Dext auto-categorises your Costs items](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)

### The full ladder, highest priority first

| # | Rung | Nature | Source |
|---|------|--------|--------|
| 0 | Category manually pre-selected in the **Mobile App** before submission | Human input at capture | [416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items) — "that manually chosen category will take priority… even if a supplier rule exists" |
| 1 | **Dext AI Assist** guidance rules | Natural-language account guidance, LLM-driven | [416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext) — "It takes priority over other automation features, including supplier and customer rules, auto-categorisation, and basic extraction." |
| 2 | **User rules** | Deterministic, per uploading user (payment method / project only) | [416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext) |
| 3 | **Payment method rules** | Deterministic, per payment method (publishing behaviour) | [416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext) |
| 4 | **Supplier / customer rules** | Deterministic, per supplier record | [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext) |
| 5 | **Auto-categorisation (ML)** | Learned from *this account's* past coding | [416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items) |
| 6 | **Account-level defaults** | Static fallback | [416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext) |

Adjacent to the ladder, **Smart Suggestions** recommend values for *project* and
*description* fields — explicitly not the category — "based on document content
and your past coding behaviour", and "if auto-apply is on, Smart Suggestions
won't apply to a field that already has a value set by a supplier, customer, or
user rule"
([416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)).

### The single most important structural fact

**All rules fire after extraction, not during it.**

> "All rules are applied automatically after Dext finishes extracting data from a
> document."
> — [416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)

Extraction and coding are two separate stages. Extraction produces fields; a
deterministic rule layer then overwrites them; ML fills the gaps; auto-publish
then decides whether a human ever sees it. This is the same shape as our
pipeline, which is a useful confirmation that our architecture is not eccentric.

### Auto-categorisation is a three-state account setting, not always-on

> "Under Auto-categorisation, choose one of the following options:
> - **Always** – Dext automatically categorises Costs items based on your past
>   categorisation behaviour (machine learning).
> - **Supplier rules** – Dext only applies categories when a supplier rule is set.
> - **Never** – Dext will not apply any category automatically, even if a supplier
>   rule exists."
> — [416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)

That middle option is the tell. A meaningful share of Dext's professional users
evidently want **deterministic rules only, with the ML switched off**. Dext ships
the ability to run the market-leading product as a pure rules engine. That is
strong evidence that the rules layer — not the model — is what accountants
actually trust, and it directly de-risks a roadmap that invests in supplier
memory before investing in a better model.

### Is the learning cross-client or global?

The help centre consistently describes the training signal in the second person
and singular: "**your** previously categorised items", "how **you've** coded
similar items in the past", "**your** past categorisation behaviour". There is no
help-centre statement that the model learns across customers, and no statement
that it does not.

**Not verified**: whether Dext's auto-categorisation model is trained
per-account, per-practice, or on a pooled cross-tenant corpus. Nothing in the
public help centre resolves it. Do not put a cross-client-learning claim into a
roadmap justification on the strength of the marketing site.

---

## 2. What a correction actually does

This was the highest-value question and the answer is more interesting than a
simple yes.

**A correction feeds the ML model, and nothing else — unless the user
additionally chooses to make it a rule.**

Evidence for the model being fed by your corrections:

> "Dext reviews: the details on that document, and **how you've categorised
> similar items in the past**. Based on this analysis, Dext automatically assigns
> a suitable category."
> — [416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)

> "**Auto-categorisation does not begin immediately.** Dext needs time to observe
> how you categorise items manually before it starts applying categories
> automatically. Once enough data has been collected, the system will begin
> auto-categorising new Costs items."
> — [416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)

Two things follow that matter a great deal for us:

1. **There is a deliberate cold-start period.** Dext, with far more data than we
   will have, still tells users the model stays silent until it has watched them
   code. It does not guess early. Any design of ours that leans on an AI rung
   from document one is making a *bolder* claim than the market leader makes.
2. **The correction signal is behavioural, not explicit.** Nobody presses "teach
   me". The act of coding is the training data.

**A correction does not retroactively recode anything.** Rules are forward-only
by default:

> "They apply to new items only - rules don't apply retroactively to items already
> in the inbox, **except coding rules (category, payment method, and similar
> fields) when you choose Apply to all inbox items** from the item details page."
> — [416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)

So retrospective application exists, but it is **opt-in, explicit, and scoped to
the inbox** — i.e. only to documents not yet published. Dext never reaches back
into published data. That is a design constraint we should copy verbatim,
because it maps exactly onto our *Published means released for export* rule: once
a document is out of the door, a rule change must not silently alter it.

**Not verified**: whether a single correction on its own creates or promotes a
supplier rule automatically. The documentation describes rule creation as a
user-initiated act ("Click **Set Supplier Rules**"), which implies it does not —
but no article states the negative explicitly.

**Not verified**: how many corrections are "enough data", or whether the model is
retrained continuously, nightly, or in batches.

### The newer answer: Dext AI Assist turns corrections into an explicit feedback loop

Since Dext shipped **AI Assist**, the correction story has a second, much more
legible half. AI Assist is a separate paid agent layer that sits *above* the
whole rules stack, and its documentation is unusually explicit about learning:

> "It learns how you and your team work… **Over time, it learns from your
> decisions and corrections to improve accuracy and consistency.**"
> — [What is Dext AI Assist?](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)

> "You can accept or dismiss suggestions at any time. **Dismissing a suggestion
> allows you to provide feedback, which is used directly for future
> improvements.**"
> — [500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)

So: a rejection is a first-class event with an attached reason, not a silent
discard. That is a design we should copy directly — see Recommendation R3.

And critically, **Dext has a button that converts your history into explicit,
editable rules**:

> "If no guidance exists yet, select **Generate** to let Dext AI Assist create
> guidance automatically **based on your current data and workflows**.
> **Note:** Generate can only be used once. After the initial set of guidance is
> created, the button is greyed out. The ability to regenerate updated guidance is
> planned for a future update."
> — [Dext AI Assist: Account guidance](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)

Read that carefully. The market leader's answer to "how do I bootstrap
automation for a client I already have data for" is: **mine the history, emit
human-readable rules, and let the accountant edit them**. Not "train a model
silently". The rules are the artefact; the model authors them. That is the single
most transferable idea in this entire research exercise.

The "can only be used once" caveat is Dext admitting the feature is half-built.
That is an opening.

### Every guidance rule is measured

> "Each guidance rule — including Core guidance and Shared guidance items applied
> to your account — shows counts for **suggestions triggered, applied, and
> dismissed**. […] Select any count to open a preview of the exact items where the
> guidance was triggered, applied, or dismissed."
> — [Dext AI Assist: Review suggestion performance](https://help.dext.com/en/articles/701659-dext-ai-assist-review-suggestion-performance)

Triggered / applied / dismissed, per rule, drillable to the documents. This is
the accuracy instrument Dext actually ships — note that it measures *rules*, not
the model, and it measures *agreement with the accountant*, not correctness.
There is also a per-rule change log: "Guidance history lets you track what
changed, when it changed, and who made the update"
([615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)).

### Cross-client knowledge exists — but as authored text, not pooled training data

This is the finding that most directly touches our tenancy non-negotiable. Dext
propagates knowledge across clients in **three explicit, opt-in tiers**, none of
which involve mixing one client's documents into another's model:

| Tier | Authored by | Scope | Editable by client? | Source |
|---|---|---|---|---|
| **Core guidance** | Dext | Regional law/compliance (e.g. HMRC); free, opt-in per client | No — read-only | [701546](https://help.dext.com/en/articles/701546-dext-ai-assist-core-guidance) |
| **Shared guidance** | The practice | Applied to all or selected clients of that practice | No — "Clients can use Shared guidance, but can't edit it" | [701638](https://help.dext.com/en/articles/701638-dext-ai-assist-shared-guidance) |
| **Account guidance** | The client / their accountant | That one account | Yes | [615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance) |

> "Core guidance is a library of guidance items, already set up by Dext, designed
> around standard business activities shaped by **regional law and compliance
> standards — for example, HMRC requirements in the UK**. It's free of charge and
> read-only."
> — [701546](https://help.dext.com/en/articles/701546-dext-ai-assist-core-guidance)

> "Shared guidance is only available to accountants and bookkeepers with a Dext
> Practice account. It lets Admins create guidance rules centrally in Practice
> settings and apply them to **all or selected clients**."
> — [701638](https://help.dext.com/en/articles/701638-dext-ai-assist-shared-guidance)

**This is the tenancy-safe shape of "cross-client learning" and we should adopt
this shape rather than inventing one.** A practice already has lawful access to
all of its clients; a practice-authored *rule* crossing between them leaks
nothing that the practice did not already know. A *model* trained on pooled
client documents is a completely different proposition. Dext ships the former
and, in its published material, never claims the latter.

Note also the guardrail Dext puts on shared guidance:

> "Updates to Shared guidance apply automatically to all linked clients, **but
> apply to new items only** — existing Inbox items won't be updated."
> — [701638](https://help.dext.com/en/articles/701638-dext-ai-assist-shared-guidance)

A practice-level rule change cannot retroactively rewrite twelve clients' books.

**Not verified**: whether Dext's older, non-AI-Assist auto-categorisation model
is trained per-tenant or on pooled data. AI Assist's data statement — "Data is
not used to train external AI models. Processing is done under enterprise
agreements. Data remains within Dext's secure infrastructure"
([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)) — rules
out third-party model training but is carefully silent about Dext's own internal
cross-customer training. Do not read it as a denial.

---

## 3. Supplier rules in detail

### What one rule can set

A single supplier rule is not a category rule — it is a **coding template**:

> "With Supplier or Customer Rules, you can set default values for: Category ·
> Invoice due date · Tax rate · Payment method · Paid/Unpaid status · Description
> · Currency"
> — [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)

Plus, per the overview article, **publishing behaviour**, **Smart Split** and
**Line Item Extraction** are also carried on the supplier rule
([416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)).

This is the point most competitors miss and it is worth stating plainly: **the
unit of automation is the supplier, and the payload is the entire coding
decision** — category *and* tax rate *and* description *and* whether to split it
*and* whether to publish it without a human. One click on the second document
from a supplier removes the entire cognitive load of the third onwards.

### Scoping

Rules are **per Dext account** (i.e. per client business), set by an Admin:

> "**Important:** You need to be an Admin user to create and manage
> Supplier/Customer Rules."
> — [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)

**Not verified**: whether a practice can define a supplier rule once and push it
across all its client accounts. No help-centre article describes a
practice-level or cross-client rule library. Absence of documentation is weak
evidence, but for a feature this marketable, silence is telling.

### Matching

**Not verified — and this is a real gap.** No help-centre article states how a
supplier on an incoming document is matched to a supplier record: exact string,
fuzzy, alias table, or bank descriptor. What *is* documented is that suppliers
are a **first-class list you can pre-populate**:

> "Uploading your supplier list into Dext"
> — [416744](https://help.dext.com/en/articles/416744-uploading-your-supplier-list-into-dext)

The existence of an upload path, of a per-supplier "Rules page", and of a merge
tool for changing accounting software
([596019](https://help.dext.com/en/articles/596019-how-to-merge-lists-when-changing-your-accounting-software))
tells us the rule is keyed to a **supplier entity record**, not to a raw string on
the document. Matching text→entity is therefore a distinct, and evidently
non-trivial, step — Dext ships a *merge* tool precisely because duplicate
supplier entities happen.

### Listing, editing, bulk editing

Yes to all three, and bulk edit is a headline capability:

> "Go to Costs > Suppliers. Tick the checkboxes next to the suppliers you want to
> update. Click **Bulk Edit** in the top-left corner. Select and apply your rules."
> — [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)

With one documented limit: "Specific fields linked to accounting integrations may
be unavailable to edit in bulk"
([216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)).

**Export** of rules: **not verified**. No article describes exporting the rule set.

### Two workflow details worth stealing

**Retrospective application is a checkbox on the rule, not a background job.**

> "When setting a new rule from the Item Details page, mark the **Apply to all
> inbox items** checkbox to apply it to existing documents."
> — [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)

**Supplier-level workflow notes** — a free-text instruction pinned to a supplier
that shows on every future document from them:

> "Enter any short instruction you want users to follow, such as 'Always fill in
> the invoice number' or 'Verify tax rate before publishing'. Once saved, the
> workflow note automatically displays on the Item Details page for all items
> from that supplier."
> — [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)

That is a very cheap feature with a very high ratio of value to effort, and it is
the human-in-the-loop analogue of a rule: it standardises a judgement that cannot
be automated rather than pretending it can.

### Rules can be silently overwritten by the accounting system

> "If you're connected to accounting software, check if you've set up rules for
> the supplier/customer there - **these will often overwrite the rules in Dext
> when we sync the data every 48 hours.**"
> — [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)

A 48-hour sync that overwrites user-authored rules is a known source of "why did
my rule reset?" support tickets — it appears in their own FAQ under exactly that
heading. Design note for us: whatever we build must make the *provenance* of a
rule value visible, or we inherit this bug class.

## 4. Confidence and automation

### Does Dext expose a confidence score? No.

Searching the help centre for `confidence` returns nothing about
categorisation — the only hits are an unrelated browser extension article and
"Dext Payments supplier shields"
([help.dext.com/en/?q=confidence](https://help.dext.com/en/?q=confidence)).
Across every automation article read for this report — auto-categorisation,
supplier rules, rules and automation, auto-publish, AI Assist and all three
guidance articles — **no numeric confidence, percentage, or score is ever shown
to the user.**

This is negative evidence from a well-maintained help centre, not proof of
absence. But it is consistent and it is decisive for our purposes: **the market
leader does not gate automation on a model confidence score.**

### What it gates on instead: a per-rule human decision

Automation is controlled by an **Application mode** the human chooses when
authoring the rule:

> "Choose the **Application mode** — **Manual review** or **Auto-apply**."
> — [615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)

> "You can set each rule to **Manual review** — so AI Assist recommends
> suggestions for you to accept or dismiss — or **Auto-apply**, so suggestions are
> applied automatically."
> — [500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)

The threshold is not "is the model 92% sure"; it is "**has a named human decided
that this specific rule is safe to run unattended**". That is a far better fit
for an audited, accountable workflow than a score, because it is explainable in a
review and attributable to a person. It is also, not incidentally, compatible
with our Review → Approve non-negotiable in a way that a confidence threshold is
not.

### Does anything file without a human? Yes — auto-publish — and it fails closed

Auto-publish will push an item to the accounting software with no human touch,
scoped at supplier, customer, payment-method or whole-account level
([How to use auto-publish in Dext](https://help.dext.com/en/articles/377051-how-to-use-auto-publish-in-dext)).

But the **abstention conditions are documented and they are exactly the ones we
would want**:

> "Why might an item not be auto-published even if rules are set? Common reasons
> include:
> - **Essential fields couldn't be extracted, or the item was flagged as suspicious**
> - The item type is listed as an exception for Auto-publish
> - **Required fields (such as the Category) couldn't be completed automatically**"
> — [377051](https://help.dext.com/en/articles/377051-how-to-use-auto-publish-in-dext)

So Dext's behaviour when unsure is: **do not guess, do not publish, leave it in
the inbox for a human.** It does not invent a category to satisfy a rule. That is
the same instinct as our escalate-with-a-reason design — Dext just does not
surface the reason as a structured, enumerable value. It offers a support-article
list of "common reasons", which is a strictly worse experience than an explicit
reason on the document, and is a place where we can be better cheaply.

### Human approval always wins over automation

Two separate articles state this, which suggests it is a load-bearing invariant
for them:

> "If an item is subject to an approval workflow, **it won't auto-publish** - it
> stays in the inbox until the approval is completed, even if an auto-publish rule
> applies."
> — [416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)

> "When guidance publishes a document automatically, any approval workflow that
> also applies to that document **takes priority** — Dext holds the document for
> approval instead of publishing it straight away."
> — [615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)

Note the direction of precedence. AI Assist outranks *every other automation
feature*, but it does **not** outrank a human approval workflow. Automation
priority and governance priority are two different ladders, and the governance
one is absolute. That is precisely our Review → Approve rule, arrived at
independently by the market leader, and it is a strong external validation of a
constraint that might otherwise look like drag.

### Automation is auditable after the fact

> "Open the item and go to the **History** tab. If it was published manually,
> you'll see: 'This item was published manually and archived by [user name]'. If
> it was published automatically: '**This item was published via autopublish and
> archived by Dext**'."
> — [377051](https://help.dext.com/en/articles/377051-how-to-use-auto-publish-in-dext)

Every automated value is also visually marked at the point of use:

- Auto-categorised values carry a tooltip: "Hover over the category displayed next
  to the item. If Dext applied it automatically, you'll see a tooltip confirming it
  was auto-categorised"
  ([416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)).
- AI Assist values carry a sparkle: "A ✨ sparkle icon indicates that the value
  comes from the agent. **Hover over the suggestion to view the full explanation
  and the guidance used to generate it**"
  ([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)).

**Provenance-on-hover is table stakes.** Every automated field says who or what
put it there, and for AI Assist, *which rule* and *why*. If we auto-fill anything
without that, we are behind.

### Trial guardrail worth noting

> "During the free trial… **Each client is limited to 50 applied suggestions.**"
> — [500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)

A hard cap on how much an unproven agent can change before a human re-engages.
Cheap, and a good pattern for our own rollout.

## 5. Line items

**The precise answer: yes, Dext categorises individual lines of one invoice
differently — but its *machine learning* does not. Per-line categories come from
a human, or from a deterministic split rule, never from the auto-categorisation
model.**

That distinction is the whole answer and it is worth being exact about, because
it changes what "closing our line-item gap" actually means.

### The data model supports per-line categories

> "Use manual line items in Dext to split a receipt, bill, or invoice into
> multiple rows with **different categories, customers, tax rates, or tracking
> fields**. […] For each line item, you can: Enter a description · Select a
> **Category** · Assign Customer, Product/service, or tracking fields · Choose a
> **Tax rate** · Set Quantity and Unit price"
> — [How to manually create line items in Dext](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext)

So one document, many categories, many tax rates. Structurally solved.

### But automatic *extraction* of lines does not produce a category

> "For each extracted line, Dext captures: Description · Total amount · Tax
> amount (**Tax codes and tax rates are not extracted**) · Quantity"
> — [How to use Line Item Extraction in Dext](https://help.dext.com/en/articles/377044-how-to-use-line-item-extraction-in-dext)

Category is conspicuously absent from that list, as is the tax rate. Line Item
Extraction is an **OCR/structure feature, not a coding feature**. It gives you
rows; you still have to code them.

### The only automatic per-line *coding* is Smart Split, and it is deterministic

> "Use Smart Split to automatically divide transactions from specific suppliers or
> customers into **predefined** line items […] **Fixed amount rules**: Specify an
> exact amount, assign a description and category […] **Percentage rules**:
> Specify a percentage of the total, a line item is created using that percentage,
> with a description and category."
> — [How to use Smart split in Dext](https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext)

Smart Split does not read the invoice. It applies a *stored template* — £200 to
Rent, £100 to Phone, remainder balancing — to whatever total was extracted. It is
a supplier rule that happens to emit several rows.

### The two features are mutually exclusive per supplier

> "**Note:** If Extract line items is enabled for the supplier, you'll need to
> turn it off before adding a Smart Split rule."
> — [416726](https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext)

This is the tell. If Dext could code extracted lines by ML, there would be no
reason to force the choice. The exclusivity says: *either* we read the real lines
off the page and you code them, *or* we ignore the real lines and impose your
template. The market leader has **not** solved "read the lines and predict a
category for each one".

### Constraints Dext lives with, all of which we will meet

- **Totals must reconcile before the document can move on.** "The sum of all rows
  must equal the item total. If there's a difference, Dext shows an **Out by**
  value at the bottom of the screen. You must resolve this **before publishing or
  marking the item as ready**."
  ([416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext))
  Note that this is enforced at exactly the same gate we enforce: *ready* and
  *publish*.
- **Rounding on percentage tax rates is a real, documented defect they never
  fixed** — they wrote a help article telling users to work around it by hand:
  "a percentage-based tax rate - such as 5% or 20% - causes the combined tax
  across your line items to differ slightly from the item-level tax total. This is
  a **rounding effect** common on multi-line invoices, not a data entry mistake.
  To resolve it, switch the affected rows to **Extracted amount** and enter the
  correct tax figure manually."
  ([416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext))
  Our integer-pence rule is the reason we would not ship this bug. It is worth
  saying out loud that our non-negotiable is a *competitive advantage* here, not
  just hygiene.
- **A balancing row is the escape hatch.** "Add remaining balance… Dext creates a
  new line item for the remaining amount… automatically labelled **Remaining
  balance**."
  ([416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext))
  Smart Split does the same automatically: "If the sum of the line items doesn't
  exactly match the total amount, Smart Split adds a line to balance it out."
  ([416726](https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext))
- **Lines can be merged and unmerged non-destructively**, and grouped by
  description or tax percentage
  ([416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext),
  [How to group line items](https://help.dext.com/en/articles/630283-how-to-group-line-items-in-dext)).
- **50 lines maximum per Smart Split rule**
  ([416726](https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext)).
- **Smart Split silently no-ops on a £0 total**: "Smart Split only works if we can
  extract the Total Amount… If the total is £0, the rule won't apply"
  ([416726](https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext)).

### Line extraction is metered — which tells you what it costs them

> "Line Item Extraction uses **credits** from your subscription allowance (in all
> regions except France). Credits are shared across all documents processed, reset
> at the start of each billing period, and don't roll over. […] **Manual line item
> creation is free of charge.**"
> — [377044](https://help.dext.com/en/articles/377044-how-to-use-line-item-extraction-in-dext),
> [416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext)

Dext charges per line-extracted document and gives manual splitting away. Two
readings, both useful to us: line extraction is genuinely expensive to run, and
Dext does not believe it is valuable enough to bundle. Either way, **turning line
extraction on per-supplier rather than globally is the economically correct
design**, and we should copy the per-supplier opt-in rather than extracting lines
for everything.

Also worth noting: line extraction is unsupported for **statements and remittance
advice** ([377044](https://help.dext.com/en/articles/377044-how-to-use-line-item-extraction-in-dext)) —
sensible, since those are not the transaction.

### And there is a coarser escape hatch: split the *document*

> "Splitting divides a single costs or sales item into **2 separate items**. Both
> items keep the full document image from the original, but you can set different
> categories and amounts for each."
> — [How to split an item in Dext](https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext)

For the common "two transactions were photographed together" case, Dext's answer
is not line items at all — it is cloning the document into two items sharing one
image, with a back-link. That is a much cheaper way to get two categories out of
one image than a line-item model, and it may be the right first move for us.

### The 2026 update: AI Assist *can* code lines — via authored guidance, at a price

This qualifies the answer above and must be stated, because it is the market
leader's current frontier:

> "**Line item support** lets AI Assist create, update, group, and split line
> items… With line item support, you can write guidance to:
> - Create line items based on conditions in the document…
> - **Update existing line items** - automatically set the description, amount,
>   tax, quantity, **category**, customer, project, property, or income source
>   **per line**.
> - Group or split line items…"
> — [What is Dext AI Assist?](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)

So per-line category automation exists. But note three heavy qualifications:

1. **It is guidance-driven, not learned.** The accountant writes the natural-language
   rule ("Write guidance for line item scenarios in the same place as your other
   AI Assist guidance"). It is an LLM executing an authored instruction over
   extracted lines — not a model that infers per-line categories unprompted.
2. **It is stacked on top of paid extraction.** "**Line item support requires Line
   Item Extraction (LIX)**, whether free allowance or a prepaid bundle."
   ([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist))
   Two metered layers before you get a coded line.
3. **It is reviewed as a batch, not silently applied.** "When AI Assist has line
   item suggestions, a notification appears in the LINE ITEMS section of the item
   details page. Select **Review** to open the *Line items - suggested changes*
   panel, where you can **Accept changes** to apply all suggestions, or **Dismiss**
   to reject them and optionally provide feedback."
   ([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist))

### The precise verdict for our roadmap

- **One category per document is *not* the market leader's model.** Dext's item
  has a line-item collection, each line carrying its own category and tax rate.
  If we are one `categoryCode` per document with no line model, we are behind on
  data model, and that gap will surface the first time a client sends an Amazon
  Business invoice or a utility bill split across capital and revenue.
- **But automatic per-line *coding* is barely solved even at Dext.** It arrived
  only with a paid AI add-on, it requires the user to write the rule, it is
  metered twice, it is mutually exclusive with the older template-based approach,
  and it is reviewed as an all-or-nothing batch.
- **Therefore**: build the *line-item data model* (high value, closes a real
  correctness gap, unblocks everything). Do **not** build line-level ML
  prediction. The evidence says the market leader tried and landed on
  "human writes a rule, LLM executes it, human accepts the batch". See R5.

## 6. Chart of accounts

_(to be completed)_

## 7. The accuracy claims

_(to be completed)_

## 8. Competitors for contrast

_(to be completed)_

---

## 9. Dext versus our engine, mechanism by mechanism

_(to be completed)_

---

## 10. Recommendations, ranked

_(to be completed)_

---

## 11. Open questions needing the owner's decision

_(to be completed)_

---

## Appendix: sources consulted

_(to be completed)_
