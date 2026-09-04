# How Dext decides a document's category — and what would make ours efficient

Status: research in progress (drafted 2026-09-03)
Author: research agent
Scope: mechanism research + design recommendation. No application code changed.

> Sourcing rule used throughout: every non-obvious claim carries a URL. Where no
> source was found the text says **not verified** rather than filling the gap
> from plausibility.

---

## Executive summary

**Dext has no categorisation algorithm. It has an ordered stack of overrides, and
the machine-learning model sits at the bottom of it.** Extraction runs first and
produces fields; a deterministic rule layer then overwrites them — AI Assist
guidance, then user rules, then payment-method rules, then supplier rules — and
the model only fills in a category that no rule has already set. Account-level
defaults catch whatever is left. The most telling detail is a setting, not a
feature: auto-categorisation is three-state, and one of the three states is
*"Supplier rules — Dext only applies categories when a supplier rule is set"*.
The market leader ships the ability to run itself as a pure rules engine with the
ML switched off, because a meaningful share of professional users want exactly
that. Our engine already has the same shape, and ours is the stricter one: Dext
puts its LLM layer *above* explicit rules, we put ours below. That is the
defensible position for an audited product and it should not change.

**A correction, in Dext, is training data and nothing else — unless the human
separately chooses to make it a rule.** Nobody presses "teach me"; the act of
coding is the signal, the model stays silent until it has watched you for a while,
and nothing is recoded retrospectively unless the accountant explicitly ticks
*Apply to all inbox items*, which is scoped to unpublished documents only. AI
Assist adds a more legible second half: accept and dismiss are first-class events
with attached reasons, every guidance rule carries triggered/applied/dismissed
counts drillable to the documents, and a **Generate** button mines a client's
history into human-readable rules the accountant can edit. The lesson worth taking
is that the rules are the artefact and the model authors them. **In our product, a
correction currently does less than that.** We compute the learned-history answer
and throw it away, and we write `createRuleDeferred: true` onto a document event
that nothing reads. We built supplier memory, tested it, and unplugged it.

**On line items — the verdict for PR #247 — build the line-item data model, and do
not build line-level machine learning.** Build it third in sequence, behind
`document.split` and behind the cheap wins, at roughly one contract cycle plus
10–15 engineer-days. The gap is real: Dext's item carries per-line category, tax
rate and tracking, and we have one nullable `category_code` column. But the
economics are unusually in our favour and the argument should be made that way —
Dext meters line extraction as a separate chargeable pass, whereas our lines fall
out of the model call we already make, are parsed, and are classified in memory
before being discarded for want of anywhere to put them. **We are not proposing to
build line extraction; we are proposing to stop discarding it.** What ranks it
third rather than first is that automatic per-line *coding* is barely solved even
at Dext: three verified vendors, none of them predicting a per-line category, and
the two that code lines automatically both do it from rules a human authored. The
day-one harm is also smaller than the architectural harm — an accountant meeting a
five-treatment invoice today gets an honest escalation naming the candidates, not
a wrong answer. The urgency is client-dependent and nobody has measured it; one
hour counting multi-category documents in the first client's actual pile is worth
more than any further argument. What must not happen either way is the middle
position: lines stored without the checksum, or a per-line category without a
per-line human lock. Both are worse than the escalation we ship today.

**The three best things to build, by value for effort, cost under a week
combined.** **R1 — show the learned-history answer (0.5–1 day)** is a defect, not
a feature request. The answer is computed and then discarded at
`coding-advice.ts:88`, so a supplier the client has coded by hand five times
produces a document that lands in To Review with an empty category and no sentence
at all. That is the highest value per hour in this document. **R2 — offer the
supplier rule at the moment of the correction (2–3 days)** is the brief's first
question and the answer is yes: all three verified vendors ship it, in three
different places, and none of them infers it. We have already built the contract
field, the payload builder and the executor, and connected none of them — with the
caveat that the review card must render the flag, because approving a rule you
were never shown is not a review. **R3 — carry `secondChoice` across the browser
boundary (2–4 hours)** publishes a runner-up that is already computed, already
stored and already in the contract, and that no competitor offers at all.

**One decision genuinely needs the owner rather than an engineer: cross-client
learning is a tenancy question before it is a product one.** Nothing in R1 through
R9 crosses a tenant boundary at all, and that should be stated plainly in the
issue, because "learning" is the word that makes people nervous. Where the
boundary does get touched — copying a chart between a practice's clients, or
practice-level rules — Dext's shape is the one to adopt: knowledge crosses as
*authored text* in explicit, opt-in tiers, never as pooled training data, and
practice-level changes apply to new items only. A practice already has lawful
access to all its clients, so a practice-authored rule leaks nothing; a model
trained on pooled client documents is a different proposition entirely, and Dext
ships the former while never claiming the latter. The hard line to ratify is that
there is no pooled corpus across `businessId` or `practiceId`, and no aggregate
derived from one client's documents and read while serving another, however
anonymised — "suppliers like this are usually coded to X" is a pooled model
wearing a different noun.

One caution that costs nothing to observe. Dext's homepage claims 99.9% accuracy
for documents "captured and categorised", and its own help centre makes that joint
claim impossible: auto-categorisation abstains until it has watched you, can be
switched off entirely, routinely fails to auto-publish for want of a category, and
is the thing a separate paid AI product exists to improve. Treat 99.9% as an
extraction figure that drifted across a conjunction. Our own position — capped at
~90% for repeat suppliers and nothing above 85% claimable at document level — is
already the better-calibrated one, and §7 confirms it rather than softening it.

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

Dext's terminology maps one-to-one onto ours:

> "In Dext, **a category represents a line in your chart of accounts** - the
> classification you assign to a cost or sale to record it correctly."
> — [How to manage categories in Dext](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)

### Connected: the ledger owns the chart, Dext is read-only

> "When your account is connected to accounting software, your chart of accounts
> syncs to Dext automatically… **All changes - adding, editing, or removing
> categories - must be made in your accounting software.** Dext checks for updates
> **every 48 hours**, but you can sync at any time by selecting **Reload** on the
> Categories page."
> — [377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)

A manual refresh pulls everything at once: "categories, suppliers, customers, tax
codes, bank accounts, projects or tracking categories, and purchase orders"
([How to refresh your accounting software data in Dext](https://help.dext.com/en/articles/209127-how-to-refresh-your-accounting-software-data-in-dext)).

### Unconnected: Dext supplies a default chart, fully editable, CSV in and out

> "If your account isn't connected to accounting software, Dext provides a
> **default category list** you can use as is or customise… **Import from CSV**…
> Format your CSV with two columns: Category name and Category code… To export
> your full category list, select **Export to CSV**."
> — [377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)

This is precisely our position — we derive a chart from the intake questionnaire
because there is no ledger connection — and Dext treats it as a first-class,
supported mode rather than a degraded one. It also groups charts into reusable
**category groups** with **templates**: "select **Manage groups**, then
**Duplicate group**. Enter a name, choose a template from the **Copy from**
dropdown"
([377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)).

### Two features we do not have, and both directly raise categorisation accuracy

**Hide, do not delete.** "Admin users can **hide** individual categories so they
don't appear in the category dropdown on items. Turn the toggle in the **Visible**
column to off. **This only affects visibility in Dext** - it doesn't change
anything in your accounting software"
([377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)).
Plus per-user **list visibility groups**
([448394](https://help.dext.com/en/articles/448394-how-to-manage-list-visibility-groups-in-dext)).
Shrinking the candidate set is the cheapest accuracy improvement in any
classification problem, and it costs a toggle.

**Copy a chart between clients.** "If you're accessing a client account, you can
**copy categories from another account you manage**. This **adds** the categories
from the source account to the client's current list - **it doesn't remove any
existing categories**"
([377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)).
Additive-only, practice-scoped, and note the safety property: copying can never
destroy the target's chart.

### When a rule names an account that no longer exists

There is no article that answers this head-on for the ordinary case. What Dext
documents is the *migration* case, and its answer is **an explicit mapping wizard,
not silent breakage**:

> "The **Merge Lists** tool lets you map your existing list items - such as
> categories and taxes - to the list items from your new accounting software.
> **This preserves any rules set up for suppliers and customers**, and keeps the
> categories previously applied to your items, so they continue to work after the
> change. […] Your old items appear on the left. Use the dropdown on the right to
> select the matching item from your accounting software."
> — [How to merge lists when changing your accounting software](https://help.dext.com/en/articles/596019-how-to-merge-lists-when-changing-your-accounting-software)

And separately, the FAQ admits rules can be quietly clobbered by the ledger:

> "If you're connected to accounting software, check if you've set up rules for the
> supplier/customer there - **these will often overwrite the rules in Dext when we
> sync the data every 48 hours.**"
> — [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)

**Not verified**: what Dext does to a supplier rule whose category is deleted in
the ledger between syncs — whether the rule is deactivated, flagged, or silently
fails. The auto-publish troubleshooting list implies the *document* just stops
being auto-published because "Required fields (such as the Category) couldn't be
completed automatically"
([377051](https://help.dext.com/en/articles/377051-how-to-use-auto-publish-in-dext)),
but that is an inference, not a statement.

---

## 7. The accuracy claims

### What Dext claims

The homepage carries a single number, twice:

> "receipts, invoices, and expenses are automatically **captured and categorised
> with 99.9% accuracy**"
>
> "Dext's AI **extracts key data with 99.9% accuracy**, categorises it, and syncs it
> to your accounting software automatically"
>
> "**DEXT BY NUMBERS · 99%** … Market-leading accuracy means you can trust your data."
> — [dext.com/en](https://dext.com/en)

### Read those three sentences against each other

They are not consistent, and the inconsistency is the finding.

- The second sentence attaches 99.9% to **extraction** — "extracts key data with
  99.9% accuracy, **categorises it**" — categorisation is a separate clause with
  no number.
- The first sentence attaches it to **"captured and categorised"** jointly. That
  is the claim that does not survive contact with their own help centre.
- The "DEXT BY NUMBERS" tile says 99%, not 99.9%, with no unit at all.

### Why the joint claim cannot be true, from Dext's own documentation

1. Auto-categorisation is **off by default until the model has watched you**:
   "Auto-categorisation does not begin immediately. Dext needs time to observe how
   you categorise items manually"
   ([416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)).
   A system that abstains at the start cannot be 99.9% accurate on everything.
2. Auto-categorisation can be **switched off entirely** — the "Never" setting
   ([416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)).
3. Documents routinely fail to auto-publish because "**Required fields (such as
   the Category) couldn't be completed automatically**"
   ([377051](https://help.dext.com/en/articles/377051-how-to-use-auto-publish-in-dext)).
4. They sell a **separate paid AI agent** whose entire pitch is improving
   categorisation ([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)).
   You do not sell that against a 99.9%-accurate incumbent feature.

**Verdict: treat 99.9% as an OCR field-extraction figure that marketing has
allowed to drift across the "and categorised" conjunction.** No methodology, no
denominator, no definition of "accurate", no third-party audit is published
anywhere I could find.

**Not verified**: what the 99.9% measures — characters, fields, documents,
which fields, on what corpus, post-human-correction or pre. **Not verified**:
whether Dext has ever published a categorisation accuracy figure. I found none.

### The only figure Dext ships that is actually measurable

The per-guidance **triggered / applied / dismissed** counts
([701659](https://help.dext.com/en/articles/701659-dext-ai-assist-review-suggestion-performance)).
That is an *agreement rate*, per rule, in your own account, on your own documents
— which is a far more honest instrument than a global percentage, and it is the
one we should copy. Note carefully what it does *not* measure: whether the
accountant was right.

### Our own position is already better calibrated

Our Source of Truth §24.4.7 caps what may be claimed at ~90% for repeat suppliers
(explicitly attributing it to "rules and memory, not the model"), ~60–70% top-1
for genuinely new suppliers, and states **"No number above 85% document-level is
to be claimed to a client, in the product, or in a demo."** Our own module
documentation cites Intuit's published research — QuickBooks' production
categoriser at 62.5% top-1, 20.8% on an unseen category, 36% zero-shot for a new
company — and concludes "Every vendor '99%' in this market is OCR *extraction*,
not categorisation."

**That analysis is correct and this research confirms it.** Do not soften it.

---

## 8. Competitors for contrast

### Hubdoc (Xero) — supplier configurations only, no learning, no line items

Hubdoc's entire help centre is 65 articles
([support.hubdoc.com/api/v2/help_center/en-us/articles.json](https://support.hubdoc.com/api/v2/help_center/en-us/articles.json)).
**Not one of them describes machine learning, auto-categorisation, confidence, or
suggestions.** For a product owned by Xero and positioned against Dext, that
silence is meaningful.

What it does have is the supplier-rule pattern, called *configurations*:

> "**Configurations are rules and settings you apply that determine how the
> document will be published.** […] If you configure a document's fields while
> publishing it, you have the option to **save the configuration to apply to all
> future documents for the same supplier**. If you configure the fields on the
> supplier level, they will automatically be applied to all their future
> documents."
> — [Configurations explained](https://support.hubdoc.com/hc/en-us/articles/16659762446605-Configurations-explained)

**That middle sentence is Recommendation R1, already shipped by a competitor.**
Code the document once, tick a box, and every future document from that supplier
is coded. It is offered *at the moment of publishing* — the moment the human has
just made the decision and it is cheapest to capture.

Per-supplier settings include auto-publish ("**Auto-sync**"), **Publish As**
transaction type, **Tax Rate**, and the destination field set
([Customise configurations by supplier](https://support.hubdoc.com/hc/en-us/articles/16568850613261-Customise-configurations-by-supplier)).

**On line items, Hubdoc is explicit and it is the same answer as Dext's Smart
Split:**

> "**Hubdoc doesn't automatically extract line item data from a document.** You
> need to enter this information manually **or save the line items in any
> configured supplier rules you have set up.**"
> — [About data extraction](https://support.hubdoc.com/hc/en-us/articles/16660084462477-About-data-extraction)

Two independent vendors, the same conclusion: **stored per-supplier line
templates beat per-line extraction for recurring documents.**

Other transferable details:
- Minimum viable extraction is exactly our mandatory set: "To successfully complete
  data extraction, a document must include a **date, supplier name and total
  amount**" ([16660084462477](https://support.hubdoc.com/hc/en-us/articles/16660084462477-About-data-extraction)).
- Duplicate detection gates automation: "If you've set up automatic publishing for
  a particular supplier, any potential **duplicate** documents from that supplier
  **aren't automatically published**"
  ([16660084462477](https://support.hubdoc.com/hc/en-us/articles/16660084462477-About-data-extraction)).
  A second, orthogonal reason to hold a document back from automation.
- Date ambiguity is resolved by falling back rather than guessing: "If the date
  format based on the organisation's currency results in a **future date**, we'll
  automatically use the other format"
  ([16660084462477](https://support.hubdoc.com/hc/en-us/articles/16660084462477-About-data-extraction)).
- Rules are forward-only: "Changes are applied on a **moving forward basis**"
  ([16568850613261](https://support.hubdoc.com/hc/en-us/articles/16568850613261-Customise-configurations-by-supplier)).
- There is a per-document audit trail
  ([View a document's audit trail in Hubdoc](https://support.hubdoc.com/hc/en-us/articles/16695107301389-View-a-document-s-audit-trail-in-Hubdoc)).
  _(This citation was a bare, slug-less URL in the earlier draft; the article id
  was recovered from the help centre's own JSON index on 3 Sep 2026, which also
  confirms the 65-article count above — `articles.json?per_page=100` returns 65
  with `next_page: null`.)_

### AutoEntry (Sage) — **verified, and it is the most interesting of the three**

_Gap closed 3 Sep 2026. The earlier draft of this section said AutoEntry was
unverified because no base URL had been found. It runs the same Intercom help
centre as Dext — identical `robots.txt`, identical `/en/?q=` search endpoint — so
`help.autoentry.com/en/?q=<terms>` works exactly as `help.dext.com` does._

AutoEntry differs from both other vendors on categorisation mechanism in two ways
that matter to us, and it is the only one of the three that ships **deterministic
per-line coding driven by the line's own text**.

**1 · "Remember" is a Yes/No asked inline, at the moment of coding.**

> "When you select a supplier, Category and VAT codes on an invoice, you can use
> the **Remember** option. This will automate the selection next time you process
> an invoice for that supplier. […] Once you select a supplier, Category and Tax
> code, AutoEntry will activate the Remember option. **Remember: Yes** — Click Yes
> to save these selections as a **default for that supplier**. […] **Remember: No**
> — If the current selection will only apply as a one-off, click No."
> — [Remember supplier, Category and VAT codes](https://help.autoentry.com/en/articles/1312934-remember-supplier-category-and-vat-codes)

Note the shape: not a settings screen, not a background inference — an **explicit
binary asked at the point of decision**, with "one-off" as a first-class answer.
That is R2, and it is the third of three verified vendors to ship it.

One refinement neither Dext nor we have: **the remembered coding is keyed per tax
rate.** *"When there's a VAT summary, AutoEntry will also remember the individual
selections per VAT rate"*, with the limit stated honestly — *"AutoEntry can only
allow one set of Remembered codes per VAT percentage… A new code for the same
percentage will replace the initial one"*
([1312934](https://help.autoentry.com/en/articles/1312934-remember-supplier-category-and-vat-codes)).
A supplier who sells at 20% and 0% gets two remembered codings, not one.

**2 · Line item rules — condition-based per-line coding, and it reads the line.**

> "You can create **Line item rules** to assign VAT and Category codes
> automatically when line items meet specific rules for a given supplier. You can
> base these rules on **full or partial descriptions or price value**. This setting
> will **override any memorised settings** set up under the supplier settings. […]
> Select **All** or **Any**… Select the rule **type** on either **Description** or
> **Unit Price**. Select the **condition**: equal, contain, begin with or end
> with… Select the relevant **Category account, VAT code and Tracking Category**
> you want to apply when the exact condition occurs. […] **Priorities**: Move a
> rule up or down the list to define the order of the rules. AutoEntry will check
> the rules from top to bottom."
> — [Line item rules](https://help.autoentry.com/en/articles/1890473-line-item-rules)

**This is a materially better answer than Dext's Smart Split** and it changes the
§5 conclusion in one respect. Smart Split does not read the invoice at all — it
imposes a stored template on whatever total was extracted. AutoEntry's line item
rules *match on the line's own description* and code accordingly, with All/Any
composition and a user-controlled priority order.

It is still **not machine learning**. It is a human-authored condition rule
evaluated top-to-bottom — closer to our own `capital-revenue.ts` keyword
classifier than to a model, and explicitly scoped to one supplier. The conclusion
that **no verified vendor predicts a per-line category** survives; what changes is
that the best shipped alternative is richer than §5 suggested.

**3 · Supplier settings mirror Dext's coding template, with the same per-supplier
metering instinct.** *"Capture Line Items — This option is deactivated by
default. When you enable this option, the system will extract all the line items
for all future invoices uploaded for this supplier"*, with company settings
overriding the supplier default
([Supplier settings](https://help.autoentry.com/en/articles/1890281-supplier-settings)).
Same per-supplier opt-in as Dext, arrived at independently. The same page carries
per-supplier currency, default due date, default date format, default description,
payment account and **Auto-Publish** — *"Once you add a set of Category and VAT
codes to a supplier… you can enable the Auto-Publish option"*, i.e. auto-filing is
gated on an authored per-supplier coding, exactly as §4 found for Dext.

**4 · Hide, do not delete — a second vendor ships R6b.**

> "You can use the visibility toggle to hide Mileage rates, VAT/Tax, Category and
> Expense Category codes… This **deactivates them from the dropdown menus** in
> your invoices or expenses, but **they remain on your Manage Lists page**."
> — [Hide VAT, Category, Expense Category codes and Mileage rates](https://help.autoentry.com/en/articles/4810843-hide-vat-category-expense-category-codes-and-mileage-rates)

There is a matching *Hide a Supplier Account*
([4799701](https://help.autoentry.com/en/articles/4799701-hide-supplier-account))
and an "Is visible" toggle on the supplier record itself
([1890281](https://help.autoentry.com/en/articles/1890281-supplier-settings)).

**5 · No machine learning is described anywhere.** A help-centre search for
`machine learning accuracy` returns ten articles, every one of which is about
proxy configuration, Sage 50 sync errors or handwriting on documents
([help.autoentry.com/en/?q=machine+learning+accuracy](https://help.autoentry.com/en/?q=machine+learning+accuracy)).
No auto-categorisation article, no learning claim, no confidence score, no
accuracy figure. That is the same silence Hubdoc's 65-article help centre keeps.

**Two of the three verified competitors describe no learned categorisation at
all.** Dext is the only one that does, and §1 shows Dext lets customers switch it
off and run on rules alone. This is the strongest single conclusion in the
competitive half of this document.

### Xero Smart Document Capture — **not verified**

`central.xero.com` is JS-rendered as the brief warned. A headless-Chrome render of
a guessed article slug returned an empty DOM, and without a working search I could
not locate the canonical article. **No claim is made about Smart Document
Capture's categorisation mechanism, line-item support, or learning behaviour.**

`productideas.xero.com` was available as a negative-evidence source but its `/api/`
path is `Disallow`ed by
[robots.txt](https://productideas.xero.com/robots.txt), and the HTML surface is
JS-rendered; I did not obtain a citable, vote-counted feature request. **No
community-reported evidence is presented for Xero.**

### What the contrast establishes

Across the three vendors I could verify:

| | Dext | Hubdoc | AutoEntry | Our engine |
|---|---|---|---|---|
| Per-supplier coding defaults | Yes, rich | Yes | Yes, rich (+ **per VAT rate**) | Yes (`rules`, exact-match) |
| "Save this as a rule" at the point of coding | Yes (checkbox on item details) | **Yes, at publish time** | **Yes — inline Yes/No prompt** | **No trigger exists** |
| Learned per-client categorisation | Yes (ML, cold-start) | No | **No** | Built; **suppressed at `coding-advice.ts:88`** |
| Confidence score exposed | No | No | No | Yes, display-only |
| Auto-file without a human | Yes (auto-publish) | Yes (Auto-sync) | Yes (per-supplier Auto-Publish) | No — and correctly so |
| Line items extracted automatically | Yes, metered, per-supplier | **No** | Yes, per-supplier, off by default | Yes, free — inside the one model call |
| Per-line categories in the data model | Yes | Via supplier template only | Yes | **No** |
| Automatic per-line *coding* | Blind template (Smart Split), or authored LLM guidance | Supplier template only | **Condition rules on the line's own text** | Classified in memory, **cannot be written down** |
| Hide an account from the picklist | Yes | Not documented | Yes | **No** |
| Stated reason when it cannot decide | No (generic troubleshooting list) | No | No | **Yes, closed enum of 10** |

Three things fall out of that table.

**The second row is unanimous.** All three vendors capture the rule at the moment
the human decides, and each does it slightly differently — a checkbox, a
save-on-publish option, an inline Yes/No. We are the only one with no trigger at
all, and we are the only one that has already built the payload builder for it.
That is R2, and three-for-three is as strong as competitive evidence gets.

**The penultimate-but-one row is where we are unexpectedly ahead on cost and
behind on storage.** We get line items free inside a model call we already pay
for, while two of the three vendors meter or refuse them — and we are the only one
of the four with nowhere to put a per-line answer. That asymmetry is the whole
argument in §10.6.

**The last row is ours alone**, and it is a genuine differentiator that no
competitor has bothered with. Protect it.

---

## 9. Dext versus our engine, mechanism by mechanism

Our engine lives at
`/Users/mubasshir/neoting/apps/api/src/modules/rules-suggestions/` (note: there is
no top-level `chart-of-accounts/` module — it is
`rules-suggestions/chart-of-accounts/`). The production entry point is
`/Users/mubasshir/neoting/apps/api/src/modules/extraction/coding-advice.ts`,
called from `extraction-pipeline.ts:461`.

| Mechanism | Dext | Us | Read |
|---|---|---|---|
| **Order of authority** | AI Assist guidance → user → payment method → supplier/customer → **ML** → account default ([416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)) | accountant rules (USER > PAYMENT_METHOD > SUPPLIER_CUSTOMER > ACCOUNT_DEFAULT) → practice defaults → *client context (unfilled)* → learned history → AI inference (`authority.ts`, `supplier-coding.service.ts:243`) | **Same shape, ours is stricter.** Dext puts its LLM layer *above* explicit rules; we put ours below. Ours is the defensible position for an audited product and should not change. |
| **Rules fire when** | After extraction ([416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)) | After extraction, inside one scoped transaction (`supplier-coding.service.ts:238–241`) | Same. Our single-transaction read is better — Dext gives no such guarantee. |
| **Supplier matching** | Rule keyed to a supplier *entity*; matching method **not verified**; a merge tool exists, implying duplicates are common ([596019](https://help.dext.com/en/articles/596019-how-to-merge-lists-when-changing-your-accounting-software)) | `rule.scopeKey === supplierName`, **exact string equality, character for character** (`supplier-coding.service.ts:262–276`). A normalised key exists (`supplier-key.ts`, 8 tests) and is used for *history* but never for *rules*; mismatches are collected into `nearMissRuleScopeKeys` and **never honoured** | **Our worst silent-failure class.** A rule that is written, reviewed, approved and never fires. See R4. |
| **One rule sets** | Category, tax rate, due date, payment method, paid status, description, currency, publish behaviour, Smart Split, line extraction ([216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)) | `sets.categoryCode` only in practice; `conditions` is stored and **evaluated by nothing** | Gap, but not urgent. Category is the expensive decision. |
| **Learned memory** | ML over the account's own history; deliberate cold-start ([416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)) | `loadHistory` scans the most recent **200** documents per call, filters to `HUMAN_CONFIRMED` only, normalises supplier keys **in process** (`supplier-coding.service.ts:544–583`). Only counts human codings — "a category a rule applied is not evidence" | Ours is philosophically better (a rule's own output can never inflate its own consensus) and operationally worse (200-row window, no index). **And it never reaches a document** — see next row. |
| **Does memory actually code?** | Yes | **No.** `coding-advice.ts:88` — `if (result.decision.outcome !== 'REVIEW') return null;` — discards every `CODE`, including `LEARNED_HISTORY`. The only thing that codes is the pipeline's own single-tier exact-match query at `extraction-pipeline.ts:444–452` | **The headline defect.** We built supplier memory, tested it (37 tests), and unplugged it. See R2. |
| **What a correction does** | Feeds the ML; optionally applied to inbox items via a checkbox; AI Assist "learns from your decisions and corrections" ([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)) | Writes `documents.category_code` and a new `HUMAN_CONFIRMED` extraction row (`update-coding.ts:98–125`). That makes the document **locked** and **visible to `loadHistory`**. It records `createRuleDeferred: true` on the event — **a seam nothing consumes** | We have the signal and throw away the action. See R1. |
| **Correction → rule** | User-initiated ("Click **Set Supplier Rules**"); Hubdoc offers it at publish time as a checkbox ([Configurations explained](https://support.hubdoc.com/hc/en-us/articles/16659762446605-Configurations-explained)) | `buildSupplierRuleProposal` exists, is correct, keys on the exact spelling from a real document, reports unmatched spellings, and has **zero production callers** (`rule-proposal.ts`, 12 tests) | The work is done. It needs a trigger and a button. See R1. |
| **Retrospective application** | Opt-in checkbox, **inbox only**, never published items ([216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)) | Not offered | Copy Dext's constraint exactly — it maps onto *Published = released for export*. |
| **Rejection** | First-class: dismiss with feedback, counted per rule ([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist), [701659](https://help.dext.com/en/articles/701659-dext-ai-assist-review-suggestion-performance)) | **Does not exist.** No dismiss endpoint, no UI control. `Suggestion.acceptedAt` / `dismissedAt` / `decidedByUserId` are written by nothing | We are blind to our own error rate. See R3. |
| **Confidence** | **Never shown** | `number` in 0..1 from a fixed `CONFIDENCE_BY_BASIS` table (`ai-suggestion.ts:146–171`), floor 0.3, −0.1 for a new supplier. Display-only, enforced in four separate places: "no branch in this repository may compare it to a number" | **Ours is better and the discipline is right.** Showing a calibrated basis-derived number beats hiding it; gating on it would be worse than either. Do not change the gating rule. |
| **Second choice** | Not offered | Computed, stored, in the OpenAPI contract — and **dropped at the browser boundary** (`apps/web/src/api/document-detail.ts:227–240` does not carry it) | Free accuracy, currently unshipped. See R6. |
| **When it cannot decide** | Leaves it in the inbox; reason available only as a generic help-article list ([377051](https://help.dext.com/en/articles/377051-how-to-use-auto-publish-in-dext)) | Escalates with a **closed enum of ten reasons in severity order**, plus a one-sentence prompt written to say what would *resolve* it (`escalation.ts:38–177`). Changes no state; the document simply stays TO_REVIEW | **We are clearly ahead.** Neither verified competitor does this. Protect it and market it. |
| **Arithmetic before classification** | Not documented. Dext ships a **known rounding defect** on percentage tax rates across lines and tells users to fix it by hand ([416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext)) | Hard stop: `if (!documentReconciles(evidence)) return escalation('ARITHMETIC_MISMATCH', …)` before any classification (`ai-suggestion.ts:287`); floats in money slots are dropped, never rounded | **Our integer-pence non-negotiable is a competitive advantage, not overhead.** |
| **Line items** | Full per-line model: category, tax rate, tracking, merge/unmerge/group. Extraction is metered per-supplier and yields **no category**. Smart Split templates lines deterministically. AI Assist can code lines from authored guidance, on top of paid extraction | `documents.category_code String?` — one nullable free-text column, no line table. Lines are smuggled into `extractions.fields.lineItems` and read by `readStoredLines`. `suggestCoding` classifies every line **in memory**, then escalates `MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` / `MIXED_CAPITAL_AND_REVENUE` because the answer **cannot be written down** | Our own `escalation.ts:97–107` says it plainly: "This is not a limitation of the rules; it is the schema's." See R5. |
| **Chart of accounts** | Synced from the ledger every 48h, read-only when connected; editable + CSV import/export when not; **hide** toggle; per-user visibility groups; copy between clients ([377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)) | Derived from the intake questionnaire, seeded once into `reference_syncs`, **never overwritten**, no external sync (D42/D47 removed the ledger connection), **no editing surface at all** — the module publishes no controller | Our never-overwrite invariant is right. The missing editing surface is a real hole, and `prisma/seed.ts` writes a legacy questionnaire shape so every seeded demo client falls to `NO_PROFILE`. See R7. |
| **Off-chart code** | **Not verified** | Refused in three independent places, never fuzzy-matched — `CODE_NOT_ON_CHART` / `OFF_CHART_CODE_REFUSED`. An accountant's explicit rule may name an off-chart code; the ledger prefix is then surfaced as `null` rather than guessed | Correct. "Fuzzy-matching a chart of accounts is how a client's food costs quietly become drink costs." |
| **Auto-file without a human** | Yes — auto-publish, gated by an authored rule, not by a score. Fails closed on missing fields or a suspicious document. **Approval workflow always outranks it** ([416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext), [615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)) | No. Every state change is an ActionProposal with Review → Approve; Ready → Published is super-admin only (D44); *Published* asserts nothing about a ledger (D42) | Dext arriving independently at "human approval outranks all automation" is external validation of our constraint. |
| **Cross-client knowledge** | Three authored, opt-in tiers: Dext-authored **Core guidance**, practice-authored **Shared guidance**, per-client **Account guidance** ([701546](https://help.dext.com/en/articles/701546-dext-ai-assist-core-guidance), [701638](https://help.dext.com/en/articles/701638-dext-ai-assist-shared-guidance), [615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)) | `Rule.businessId` is **required**; there is no `practiceId` on `rules`. Learning is `businessId`-scoped only. Chart copying between clients does not exist | Dext's model is the tenancy-safe one and is the shape to adopt if we adopt anything. See R10 — and read the tenancy warning there before the product argument. |
| **The AI rung** | Genuinely a model (AI Assist), plus a genuine ML categoriser | **No model is wired.** `coding-instructions.ts` builds the prompt, the tool schema and a strict Zod parse; `TASKS.codingSuggestion` in `chat-framework/models.ts` names `anthropic.claude-sonnet-4-6` and is **referenced by nothing**. What runs is a deterministic keyword/threshold engine wearing `provenance: 'AI_SUGGESTED'` | This matters enormously for the cost argument in R2: supplier memory is not competing with a model, it is competing with a regex table. |
| **Provenance shown to the user** | Tooltip on auto-categorised values; ✨ on AI Assist values with the explanation **and the rule that fired** ([416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items), [500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)) | SoT §13.3 requires human-confirmed / deterministic / AI-suggested to be visible everywhere; the suggestion carries `basis`, `note`, `advisories` and `sourceRuleId` | Parity of intent. Make sure the *rule that fired* is actually rendered — that is the part Dext does well. |
| **Measurement** | Per-rule triggered / applied / dismissed, drillable ([701659](https://help.dext.com/en/articles/701659-dext-ai-assist-review-suggestion-performance)) | Nothing. No acceptance rate, no dismissal capture | See R3 and R8. |

---

## 10. Recommendations, ranked

Ranked by **value for effort**, not by architectural importance. The biggest
hole in the product (no line-item model) is eighth on this list, and §10.8
explains why that is the right place for it rather than a failure of nerve.

Effort figures are engineer-days for one competent engineer who has read the
module. "LAW cycle" means a contract-change issue approved by Shakib before a PR
opens (`prisma/`, `packages/contracts`) — calendar time, not engineering time,
and it is the reason two items are ranked below cheaper ones that deliver less.

Every recommendation below has been checked against the four non-negotiables.
None writes `documents.category_code`, none makes a document Ready from a
suggestion, all money stays integer pence, all state changes stay on the
Review → Approve path, and §10.10 is the only one that touches a tenant boundary.

---

### R1 — Show the learned-history answer. It is computed and then thrown away.

**Effort: 0.5–1 day. No LAW change. Highest value per hour in this document.**

This is a defect, not a feature request, and it was not previously named.

`coding-advice.ts:88` reads:

```ts
if (result.decision.outcome !== 'REVIEW') return null;
```

For a document a **rule** coded, that line is exactly right and must not change —
a suggestion beside an explicit instruction is pressure to second-guess it, and
the file argues the point well. But `decide()` also returns `outcome: 'CODE'` on
the `LEARNED_HISTORY` rung (`supplier-coding.service.ts:313–331`), and *that*
`CODE` reaches the same discard.

Trace what the accountant sees. A client has coded Nisbets to `FOOD_PURCHASES`
by hand five times. A sixth Nisbets invoice arrives. No rule exists, so
`extraction-pipeline.ts`'s exact-match query finds nothing and
`documents.category_code` stays null. `decide()` answers `CODE` /
`LEARNED_HISTORY` with the sentence *"This client has coded Nisbets to
FOOD_PURCHASES 5 times, by hand."* `adviseCoding` returns `null`. **The document
lands in To Review with an empty Category and no sentence at all** — the exact
bug the `AI_INFERENCE` rung was switched on to fix, still live on the one rung
where the product has the strongest possible evidence short of a rule.

The market leader's entire ML rung is this signal. §1's ladder puts
auto-categorisation at rung 5, learning from *"your previously categorised
items"*, and §2 shows Dext deliberately waits until it has watched you code
before it will speak
([416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items)).
We do the watching, reach the answer, and then suppress it.

**The fix.** In `adviseCoding`, keep the discard for `LOCKED` and for a `CODE`
whose authority is `ACCOUNTANT_RULE` or `PRACTICE_DEFAULT`; for a `CODE` whose
authority is `LEARNED_HISTORY`, map it to a `SUGGEST` carrying
`basis: 'CLIENT_PRIOR_CODING'` and the existing sentence as `note`.

Three reasons this is cheap:

- **`basis` is an open `type: string` in the contract, not an enum**
  (`openapi.yaml:5192–5195` — "The named rule behind the answer", with
  *examples*, not `enum`). A new basis value is not a contract change.
- The stored shape, the read projection, the strip-from-`fields` guard and the
  browser view all already exist and are parsed both ways.
- `DocumentPreview.tsx`'s `acceptSuggestion` already routes a tap through
  `parseCodingDraft` into the ordinary `document.update-coding` proposal. Nothing
  new is needed on the accept path.

**Second half of the same fix, same day's work.** `decide()` requires
`history.categoryCodes.length === 1` before it will answer. A supplier coded
nine times to `FOOD_PURCHASES` and once, in error, to `SUNDRY_EXPENSES` falls to
`REVIEW` with *"coded to more than one account before"*. That sentence is a good
sentence and should stay — but it should sit **beside a suggestion of the
majority code**, not instead of one. Dext's ML would answer the majority without
hesitating. Suggest the majority, name the count and the minority in the note,
and leave the outcome `REVIEW`.

⚠ **Do not promote either case to `CODE`.** A change of treatment is worth a
person looking at, the escalation copy already says so, and promoting it would
put a category on a document without a human — which the non-negotiables forbid
and which §4 shows Dext also refuses to do on anything but an authored rule.

---

### R2 — Offer the supplier rule at the moment of the correction

**Effort: 2–3 days. No LAW change to the payload. This is the brief's first
question and the answer is yes.**

**The evidence is unusually strong because all three verified vendors ship it, in
three different places, and none of them infers it.**
Dext's supplier rule is not a category rule but a whole coding template —
category, tax rate, due date, description, publish behaviour, Smart Split, line
extraction ([216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)) —
authored from the item details page with an *Apply to all inbox items* checkbox.
Hubdoc offers the same thing at the moment of publishing: *"If you configure a
document's fields while publishing it, you have the option to **save the
configuration to apply to all future documents for the same supplier**"*
([Configurations explained](https://support.hubdoc.com/hc/en-us/articles/16659762446605-Configurations-explained)).
AutoEntry asks it as an inline binary the instant the codes are chosen —
*"Remember: Yes… save these selections as a default for that supplier"* against
*"Remember: No… if the current selection will only apply as a one-off"*
([1312934](https://help.autoentry.com/en/articles/1312934-remember-supplier-category-and-vat-codes)).

That is the moment to ask. The human has just made the decision, it is in their
head, and the marginal cost of capturing it is one tick.

⚠ **Copy AutoEntry's wording rather than Dext's.** Offering "one-off" as an
explicit, equally-weighted second answer is better than an unticked checkbox: it
makes the *absence* of a rule a decision the accountant took, rather than one
they failed to notice. Our review card then records which they chose.

**We have already built every piece of this and connected none of them.**

| Piece | State |
|---|---|
| `createRuleFromCorrection` on `UpdateCodingPayload` | **In the contract**, `openapi.yaml:5608–5614`, with the intent spelled out: *"One-tap rule creation from a correction… The rule is created under this same approval; it never activates from an unapproved correction."* |
| The executor's handling of it | `update-coding.ts:138` writes `createRuleDeferred: true` onto a `document_events` detail — a marker nothing reads |
| `buildSupplierRuleProposal` | Built, 12 tests, correct, keys on the exact spelling, reports unmatched spellings. **Zero production callers** |
| `rule.create` executor | Built and proven end to end (METH S13, #142) |
| The review card | **Does not render the flag** — `render-summary.ts:60–71` renders field changes only |

**What to build, in order:**

1. A checkbox in `CodingProposalModal`, **unticked by default**, worded as the
   consequence rather than the mechanism: *"Code future documents from Nisbets to
   Food purchases."* Dext requires the human to author the rule; nothing infers
   one, and §2 could find no evidence that a single correction ever creates a rule
   on its own. Default-on would be a standing instruction created by inattention.
2. **`render-summary.ts` must render it.** This is not polish — it is the
   Review → Approve rule. A reviewer who approves a correction and thereby creates
   a rule they were never shown has not reviewed the state change. The precedent
   is two cases above it in the same switch: `document.route` renders
   `{ label: 'Teach router', value: 'Always route this sender here' }`. Copy that
   shape exactly.
3. The executor writes the `rules` row in the same transaction when the flag is
   set — which is what the contract's own description already promises. Reuse
   `buildSupplierRulePayload(scopeKey, categoryCode)` rather than composing the
   payload by hand.

⚠ **`scopeKey` must be the supplier's exact spelling from this document**, not a
normalised or title-cased one. `rule-proposal.ts`'s header is emphatic about this
and it is the failure R4 exists to catch: a rule that is written, renders
correctly, is approved by a human, and then never fires.

**One thing to copy verbatim from Dext and one to refuse.**

*Copy:* retrospective application as an **explicit checkbox scoped to unpublished
documents only** — *"They apply to new items only… except coding rules… when you
choose Apply to all inbox items"*
([416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)).
That maps precisely onto *Published means released for export*: once a document
is out of the door a rule change must not reach it. Build it as a second,
separately-ticked option, or omit it for ID — but if it is ever built, the
inbox-only scope is not negotiable.

*Refuse:* Dext's 48-hour ledger sync that **silently overwrites user-authored
rules** ([216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)).
We have no ledger connection under D42, so we inherit none of it — but whatever
we build must make the *provenance* of a rule value visible, or we acquire the
bug class the moment a v1 adapter lands.

---

### R3 — Carry `secondChoice` across the browser boundary

**Effort: 2–4 hours. No LAW change. It is already in the contract.**

The runner-up is computed in `ai-suggestion.ts`, stored, and published in
`openapi.yaml:5220–5231` with its own justification: *"Published top-2 accuracy
runs about ten points above top-1, which is the cheapest accuracy an interface
can buy."* `apps/web/src/api/document-detail.ts`'s `CodingSuggestionView` does
not carry the field, so the browser never sees it. The only current reference in
`apps/web` is `secondChoice: null` in a test fixture.

Render it as a second, visually subordinate tap. Neither Dext nor Hubdoc offers
a runner-up at all, so this is free differentiation as well as free accuracy.

The ten-point figure is quoted from our own contract and module documentation.
**Not verified**: the primary source for it. Do not put the number in customer-
facing copy until someone has re-derived it — see §11 Q6.

---

### R4 — Surface the near-miss rule instead of discarding it

**Effort: 1 day (surface only). No LAW change.**

`decide()` collects `nearMissRuleScopeKeys` — rules whose scope key normalises to
this document's supplier but does not match it character-for-character — and
returns them on every decision. Nothing renders them.

This is our worst silent-failure class: an accountant writes a rule, reads a
correct review card, approves it, and the rule never fires. Nothing reports it.
The accountant concludes the feature does not work.

**Do not fix this by loosening the match.** Two reasons, and the second is the
stronger:

1. `decide()` deliberately matches the way `extraction-pipeline.ts` matches. If
   this service matched loosely it would claim a coding the pipeline will not
   apply — a disagreement invisible until the export is wrong.
2. Fuzzy supplier matching is the same class of error as fuzzy chart matching,
   which we refuse in three places for a reason our own `escalation.ts` states
   well: *"a near miss is not a small error — it is an invisible one."*

**Dext's answer to name variance is not fuzzy matching either — it is an explicit
human-resolved mapping.** They ship a *Merge Lists* tool
([596019](https://help.dext.com/en/articles/596019-how-to-merge-lists-when-changing-your-accounting-software))
precisely because duplicate supplier entities happen, and it *"preserves any
rules set up for suppliers and customers"*. The existence of a merge tool is the
admission that text→entity matching is a distinct and non-trivial step (§3).

So: render the near miss as a warning on the document (*"A rule exists for
'NISBETS LTD' but this document says 'Nisbets Ltd.' — the rule will not fire"*)
and offer a `rule.create` proposal for the second spelling, using
`unmatchedSpellings`, which `buildSupplierRuleProposal` already returns for
exactly this purpose. Two rules, both exact, both approved. That is Dext's
answer arrived at honestly rather than a regex.

---

### R5 — Capture accept and dismiss. It is the only accuracy instrument we can have.

**Effort: 2–3 days. No LAW change — the columns exist.**

`Suggestion.acceptedAt`, `dismissedAt` and `decidedByUserId` are in the schema
and are written by nothing. There is no dismiss endpoint and no dismiss control.
**We are blind to our own error rate**, and §7 established that no vendor
publishes a categorisation accuracy figure worth anything, so nobody else's
number will fill the gap.

§2 found that Dext treats a rejection as a first-class event with an attached
reason — *"Dismissing a suggestion allows you to provide feedback, which is used
directly for future improvements"*
([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)) —
and §2/§7 found the instrument they actually ship: **triggered / applied /
dismissed per rule, drillable to the documents**
([701659](https://help.dext.com/en/articles/701659-dext-ai-assist-review-suggestion-performance)).

Build the same three counters, and segment them by the two dimensions we have
that Dext does not:

- **by `basis`** — so *"keyword match on chart"* and *"subscription term under
  two years"* are measured separately rather than averaged into a meaningless
  aggregate;
- **by `escalationReason`** — the closed enum of ten. A regression that starts
  escalating everything is one histogram away from visible, which is exactly what
  `escalation.ts`'s header says the closed set is for.

⚠ **Be precise about what this measures**, in the UI copy as well as internally.
It is an **agreement rate with the accountant**, not correctness. §7 makes the
point about Dext's counters and it applies identically to ours. A practice that
codes everything to one account will show us a 99% agreement rate.

⚠ **A dismissal must not be a state change.** Dismissing a suggestion changes no
document field, moves no state, and writes no category — it stamps a column on
the suggestion. That is ingest-class at most, and it should be a `POST` on the
suggestion, never an ActionProposal, because there is nothing for a human to
approve about a human's own opinion.

---

### R6 — Chart of accounts: fix the profile, then add visibility. Do not build copying yet.

**Effort: 1 day of engineering across both, plus one LAW cycle for the seed.**

§6 identified two features Dext has that we lack and that directly raise
accuracy. Ranked, with a third item that outranks both and was not on that list.

**R6a — the seeded profile, first, and it is not close.**
`prisma/seed.ts` writes a legacy questionnaire shape with no `businessActivity`,
so `readBusinessProfile` returns null and **every seeded demo client falls to
`NO_PROFILE`** and gets the generic chart. The suggestion rung then reports
*"this client has no business-type profile"* on every document in every demo.
This is a one-field change with a disproportionate effect on suggestion quality
and on how the product presents. It is blocked only by process, not by
difficulty: `prisma/` is LAW, so it needs a contract-change issue.

**R6b — hide, do not delete. Two of the three verified vendors ship it.**
*"Admin users can hide individual categories so they don't appear in the category
dropdown on items"*
([377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)),
plus per-user list-visibility groups
([448394](https://help.dext.com/en/articles/448394-how-to-manage-list-visibility-groups-in-dext)).
AutoEntry has the same toggle and states the property that makes it safe — the
codes *"remain on your Manage Lists page"*, so hiding is not deleting and nothing
historical breaks
([4810843](https://help.autoentry.com/en/articles/4810843-hide-vat-category-expense-category-codes-and-mileage-rates)).
**Shrinking the candidate set is the cheapest accuracy improvement available in
any classification problem**, and here it is cheaper than usual: the chart lives
in `reference_syncs.payload` as JSON that this module writes and parses itself,
so adding a `hidden` boolean per account **needs no migration and no LAW cycle**.
Only the accountant-facing endpoint to toggle it is a contract change — and that
endpoint is owed anyway (§24.4.1 says the chart is *"owned and edited by the
accountant thereafter"* and no operation exists).

**R6c — copy a chart between clients. Defer.** Dext's version is additive-only
and cannot destroy the target's chart
([377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)),
which is the right safety property and the one to copy if it is ever built. But
ID has one client. Copying charts between clients is a feature whose value is
linear in the number of clients and is currently zero. See §10.7 for the tenancy
reading — it is the *safe* kind of cross-client feature, which is why it is
deferred on value rather than refused on principle.

---

### R7 — Implement `document.split`. It is the cheap 80% of the line-item problem.

**Effort: 3–5 days. The contract kind already exists.**

`document.split` is one of the two executors in the registry that throws
`ProposalNotImplementedError`. The kind is typed off the generated payload model
and named in the contract; only the effect is missing.

**Dext's answer to "two transactions on one image" is not line items** — it is
splitting the document: *"Splitting divides a single costs or sales item into 2
separate items. Both items keep the full document image from the original, but
you can set different categories and amounts for each"*
([416731](https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext)).

That is a far cheaper way to get two categories out of one image than a line
model, it needs no schema change, and it covers the commonest real case. It also
composes correctly with D43: both halves resolve to the same source document, so
the capability link is unchanged.

Two constraints to build in from §5, both of which Dext enforces and one of which
it gets wrong:

- **The halves must sum to the original total**, refused at the write site if
  they do not. Dext enforces the equivalent for line items at exactly our gate:
  *"You must resolve this before publishing or marking the item as ready"*
  ([416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext)).
- **Integer pence throughout, and no percentage split.** Dext ships a documented
  rounding defect on percentage tax rates across lines and tells users to fix it
  by hand. Our money rule is why we would not ship that bug; do not introduce a
  percentage affordance that recreates it.

---

### R8 — `DocumentLine`. Build it, but third in the sequence, and never the ML.

**Effort: one LAW cycle plus 10–15 days. This is the answer to PR #247 and it has
its own section below (§10.6).**

---

### R9 — Supplier workflow notes

**Effort: 1–2 days. Almost free, and it is the human-in-the-loop analogue of a
rule.**

A free-text instruction pinned to a supplier that renders on every future
document from them: *"Enter any short instruction you want users to follow, such
as 'Always fill in the invoice number' or 'Verify tax rate before publishing'"*
([216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext)).

§3 called this "a very cheap feature with a very high ratio of value to effort"
and that judgement holds. It standardises a judgement that **cannot** be
automated instead of pretending it can, which is a stance this product already
takes everywhere else. It ranks below R1–R7 only because none of our escalations
are waiting on it.

⚠ It is client free text rendered back to a practice user. It is not untrusted in
the injection sense (a practice member authored it), but it must never reach a
model prompt without `wrapUntrusted`, and it must never reach an account name —
the rule `chart-of-accounts` already applies to `businessActivity`.

---

### R10 — Cross-client knowledge: adopt Dext's shape, and not for ID

**Effort: LAW cycle plus 5–8 days. Recommended shape, deferred timing.**

**Read §10.7 before the product argument.** This is a tenancy question first.

If practice-level rules are ever built, build Dext's three-tier authored-text
model and nothing else
([701546](https://help.dext.com/en/articles/701546-dext-ai-assist-core-guidance),
[701638](https://help.dext.com/en/articles/701638-dext-ai-assist-shared-guidance),
[615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)):
platform-authored compliance guidance, practice-authored shared rules applied to
selected clients, and per-client rules. Copy their guardrail too — *"Updates to
Shared guidance apply automatically to all linked clients, but apply to new items
only"* — so a practice-level change cannot retroactively rewrite twelve clients'
books.

`Rule.businessId` is required and `rules` has no `practiceId`, so this is a LAW
change. With one paying client it buys nothing. Defer, but record the shape now
so that nobody invents a different one under time pressure later.

---

### Deliberately **not** recommended

A list of things not to build is part of the deliverable, and each of these would
look reasonable in a planning meeting.

| Do not build | Why |
|---|---|
| **A confidence threshold that gates anything** | §10.4 below. Dext, the market leader, exposes no confidence score at all and gates on a per-rule human decision instead. Our display-only discipline — *"no branch in this repository may compare it to a number"* — is better than both alternatives. |
| **Line-level ML prediction** | §5. Dext has not solved it either: its per-line coding is a deterministic template or an LLM executing a rule a human wrote, metered twice and reviewed as a batch. |
| **Pooled cross-tenant training** | §10.7. Dext's cross-client knowledge is *authored text*, not pooled data, and its own data statement is carefully silent about internal training rather than denying it. |
| **Fuzzy supplier matching** | R4. Two vendors both answer name variance with explicit human-resolved mappings. |
| **Auto-publish / auto-apply** | D44 reserves release for the super admin and Governance §10 has no exception. Note that Dext's own automation stops here too: *"If an item is subject to an approval workflow, it won't auto-publish"* ([416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext)), and AI Assist — which outranks every other automation feature — does not outrank an approval workflow ([615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)). |
| **Retroactive recoding of published documents** | Both vendors are forward-only, and it collides with *Published means released for export*. |

---

### 10.1 · Should accepting a suggestion offer to create a supplier rule?

**Yes. R2. It is the second-highest-value item in this document and every piece
of it is already built.**

The §3 evidence is that the unit of automation in this market is the supplier and
the payload is the entire coding decision — and that the offer is made at the
moment the human decides, not in a settings screen they will never visit. Hubdoc
puts it at publish time, Dext puts it on the item details page with a
retrospective checkbox beside it.

Two qualifications, both from the research rather than from caution:

- **Offer it on the correction, not only on the acceptance of a suggestion.** The
  signal that matters is *a human chose this category*, and that is the same event
  whether they tapped our suggestion or typed over it. `update-coding` is already
  the single path for both.
- **Default it off.** §2 could find no evidence that any vendor creates a rule
  from a single correction automatically, and the documentation consistently
  describes rule creation as a user-initiated act ("Click **Set Supplier
  Rules**"). **Not verified** that Dext never does so silently — but the balance
  of evidence, and the fact that a standing rule is the most consequential thing
  in this subsystem, both point the same way.

### 10.2 · Should corrections feed anything, and what?

**Yes — exactly three things, and one of them is deliberately not a model.**

§2's distinction between *a rule* and *a training signal* is load-bearing here,
because we currently have only one of the two mechanisms and no model at all.

| A correction should feed | Status | Which it is |
|---|---|---|
| **The learned-history rung** | Already does, automatically | A training signal — behavioural, not explicit. `update-coding` writes a `HUMAN_CONFIRMED` extraction row; `loadHistory` reads it. Nobody presses "teach me", exactly as in Dext (§2). |
| **A supplier rule, on explicit opt-in** | Seam exists, nothing consumes it | A rule — deterministic, forward-only, human-authored, visible on a review card. R2. |
| **The accept/dismiss counters** | Columns exist, nothing writes them | Measurement, not learning. R5. |

**It should feed no model, because there is no model.** `TASKS.codingSuggestion`
names `anthropic.claude-sonnet-4-6` in `chat-framework/models.ts` and is
referenced by nothing; what runs behind `provenance: 'AI_SUGGESTED'` is a
deterministic keyword and threshold engine. A "feed the model" work item today
would have no model to feed.

Two properties of the history feed are worth defending explicitly because both
are better than the market and both look like bugs to a casual reader:

- **Only human-confirmed codings count.** A category a rule applied is not
  evidence. Feeding a rule's own output back in would make one approved decision
  look like a growing consensus. Dext's documentation gives no indication either
  way; ours is the defensible position.
- **Deletion and archiving retract evidence retroactively.** Deletion is very
  often the correction itself — the misfiled, the wrong client's, the duplicate
  coded to the wrong account. A recommendation may only rest on the file as it
  stands now. The audit trail is untouched and is a different artefact.

### 10.3 · Would per-client supplier memory outperform the AI rung at a fraction of the cost?

**Yes, decisively — and the comparison is even more lopsided than it looks,
because the "AI rung" is not currently a model.**

The quantitative case, with its weakest link named:

| | Learned supplier memory | The `AI_INFERENCE` rung as built | A real model rung |
|---|---|---|---|
| Accuracy claimable | ~90% on repeat suppliers, attributed by SoT §24.4.7 to *"rules and memory, not the model"* | Bounded by keyword coverage of the client's chart; unmeasured | ~60–70% top-1 on genuinely new suppliers (§24.4.7); independently published production numbers are worse — 62.5% top-1, 20.8% on an unseen category, 36% zero-shot for a new company |
| Marginal cost per document | One indexed query | Zero — it is a regex and threshold table | ~0.6–1.0p per SoT §16's intended blend; measured comparable rungs run 1.26–1.34p |
| Cold start | Needs one prior human coding | None | None |
| Explainable to an accountant | *"You coded them this way five times"* | *"Keyword match on chart"* | A model's account of itself |

So memory buys roughly **+20 to +30 accuracy points on the repeat-supplier share
at zero marginal cost**, while a model rung buys at most the 60–70% band on the
new-supplier tail at roughly a penny a document. Dext reached the same conclusion
structurally: §1's "Supplier rules" setting lets a customer run the market-leading
product as a **pure rules engine with the ML switched off**, and a meaningful
share of professional users evidently choose it.

⚠ **The denominator is the missing number and it decides everything.** The whole
argument turns on what share of a real UK bookkeeping stream is repeat suppliers,
and **that is not verified** — no vendor publishes it and we have no production
data. Intuition says it is high for a cleaning agency with a stable supplier list;
intuition is not a measurement. R5's counters, segmented by `basis`, would answer
it from our own data within a month of real use. That is a second reason to build
R5 early.

⚠ **The 62.5% / 20.8% / 36% figures** are quoted from this repository's own module
documentation, which attributes them to Intuit's published research on QuickBooks'
production categoriser. **The primary URL is not verified** in this session — see
§11 Q6. The *direction* is corroborated by everything in §7: no vendor publishes a
categorisation accuracy figure, and every published "99%" resolves to extraction.

**The practical consequence for the roadmap:** R1 is the cheapest accuracy
improvement available because the memory already works and is being suppressed at
one line. Building a model rung before rendering the memory rung would be buying a
penny a document to replace something free that we already own.

### 10.4 · Confidence thresholds — what we should do

**Nothing. Keep the display-only rule exactly as written, and do not add a
threshold when eval calibration lands either.**

§4 is the most transferable finding in the document. Dext exposes no confidence
score anywhere in categorisation, and gates automation on an **Application mode**
a named human chooses per rule — *Manual review* or *Auto-apply*
([615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)).
The question is never *"is the model 92% sure"*; it is *"has a named human decided
this specific rule is safe to run unattended"*. That is explainable in a review and
attributable to a person, which a score is not.

What we should do instead, in three parts:

1. **Keep the display-only invariant.** It is enforced in four places and the
   rule — *no branch in this repository may compare it to a number* — should stay
   exactly that absolute. Showing a calibrated basis-derived number beats hiding
   it; gating on it would be worse than either.
2. **Gate on `authority` and `escalationReason`, which are enumerable, testable
   and already exist.** Our escalation with a written reason is the mechanism Dext
   reaches for and does not have: they leave the document in the inbox and offer a
   *support-article list* of "common reasons"
   ([377051](https://help.dext.com/en/articles/377051-how-to-use-auto-publish-in-dext)).
   We put the reason on the document, from a closed set of ten, in severity order,
   with a sentence saying what would resolve it. **This is our clearest
   differentiator against both verified competitors and it should be protected and
   marketed, not quietly generalised.**
3. **Copy the fail-closed behaviour, which we already have.** Dext's abstention
   conditions are exactly the ones we would want — essential fields missing, item
   suspicious, required fields including the Category not completable. It does not
   invent a category to satisfy a rule. Neither do we, and `ARITHMETIC_MISMATCH`
   as a hard stop *before* classification goes further than anything Dext
   documents.

One Dext pattern worth copying cheaply if AI Assist-style automation is ever
added: the trial guardrail. *"Each client is limited to 50 applied suggestions"*
([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)) — a
hard cap on how much an unproven agent can change before a human re-engages.

### 10.5 · Provenance is table stakes and we are one render away from parity

Not a ranked recommendation because it is smaller than one, but it belongs here.

Every automated value in Dext says what put it there: a tooltip on
auto-categorised values, and a ✨ on AI Assist values where *"Hover over the
suggestion to view the full explanation **and the guidance used to generate
it**"* ([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)).

Our suggestion carries `basis`, `note`, `advisories` and `sourceRuleId`, and SoT
§13.3 requires the provenance class to be visible everywhere. **Check that
`sourceRuleId` is actually rendered as a link to the rule that fired.** Naming the
rule is the part Dext does well and the part most likely to have been dropped on
the way to the browser — `secondChoice` already was (R3).

### 10.6 · The line-item gap — the verdict for PR #247

**Verdict: build the line-item *data model*. Do not build line-level machine
learning. Build it third, behind `document.split` and behind R1–R5, and expect it
to cost one LAW cycle plus 10–15 engineer-days.**

The reasoning has four steps and the third is the one that decides the ranking.

**1 · One category per document is not the market leader's model, and the gap is
real.** Dext's item carries a line-item collection where each line has its own
category, tax rate and tracking fields
([416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext)).
We have `documents.category_code String?` — one nullable column and no line
table. Our own `escalation.ts` states the consequence in its own words:
`MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` exists because *"this is not a limitation
of the rules; it is the schema's."* The lines were classified successfully and
**the answer could not be written down.**

**2 · We are already paying for the lines and discarding the answer — and this is
where our economics differ from Dext's in our favour.** Dext meters Line Item
Extraction in credits because it is a separate, chargeable extraction pass, and
gives manual line creation away free
([377044](https://help.dext.com/en/articles/377044-how-to-use-line-item-extraction-in-dext)).
§5 read that, correctly, as evidence that line extraction is expensive to run and
that per-supplier opt-in is the economically correct design **for Dext**.

It is not our design, because **our lines fall out of the single model call we
already make.** The extractor returns line items today — the S5 cost measurement
records three of them on a born-digital invoice inside the same 1.34p read — they
ride in `extractions.fields.lineItems`, `readStoredLines` parses them, and
`suggestCoding` classifies every one of them in memory. Then the result is thrown
away, because there is nowhere to put it.

So the marginal cost of *having* per-line data is approximately zero for us and
material for Dext. The only missing component is storage. That is an unusually
favourable position and it should be stated plainly in the issue: **we are not
proposing to build line extraction. We are proposing to stop discarding it.**

**3 · But automatic per-line *coding* is barely solved even at Dext, and that is
why this ranks eighth rather than first.** §5 established the whole picture:

- Automatic line extraction yields **no category and no tax rate** — it is an
  OCR/structure feature, not a coding feature.
- The only *deterministic* per-line coding is **Smart Split**, which does not read
  the invoice at all: it applies a stored per-supplier template to whatever total
  was extracted ([416726](https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext)).
- The two are **mutually exclusive per supplier** — *"If Extract line items is
  enabled for the supplier, you'll need to turn it off before adding a Smart Split
  rule."* That exclusivity is the tell. If Dext could code extracted lines by ML
  there would be no reason to force the choice.
- The 2026 AI Assist line-item support *can* set a category per line — but it is
  **guidance-driven, not learned** (the accountant writes the natural-language
  rule), it **requires paid Line Item Extraction underneath it**, and it is
  **reviewed as an all-or-nothing batch**
  ([500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist)).
- Hubdoc reaches the same place from the other direction: *"Hubdoc doesn't
  automatically extract line item data… You need to enter this information
  manually **or save the line items in any configured supplier rules you have set
  up**"* ([About data extraction](https://support.hubdoc.com/hc/en-us/articles/16660084462477-About-data-extraction)).

- AutoEntry goes furthest of the three and is still not predicting anything: its
  **Line item rules** match on the line's own description or unit price
  (`contain`, `begin with`, `end with`, `equal`), compose with All/Any, are ordered
  by hand, and assign Category + VAT + Tracking per line
  ([1890473](https://help.autoentry.com/en/articles/1890473-line-item-rules)). A
  human writes every one of them, per supplier.

**Three independent vendors, none of them predicting a per-line category.** The
two that code lines automatically do it from rules a human authored — a blind
template in Dext's case, a text condition in AutoEntry's. Nobody has shipped "read
the real lines and predict a category for each one" as an automatic feature. We
should not be the first to try, and the roadmap should not carry a line item that
implies we will.

**4 · The user-visible harm today is smaller than the architectural harm, and
that asymmetry is what sets the rank.** An accountant meeting a five-treatment
invoice today does not get a wrong answer — they get an escalation naming the
candidate codes and a sentence saying the lines need splitting. That is honest,
and it is better than what either competitor shows. The harm is downstream:

- **The export is the sole egress under D42**, and
  `exports-public-api` already emits *one row per analysis line* — the mechanism
  exists and is being fed a single category. A five-treatment invoice exports as
  one line whatever the emitter can do.
- The escalations are permanent rather than resolvable. The product can describe
  the problem forever and never let anyone record the answer.

#### The sequence, with costs

| # | Step | Cost | Why here |
|---|---|---|---|
| 1 | **`document.split`** (R7) | 3–5 days, no schema change | The contract kind exists and throws `ProposalNotImplementedError`. Covers "two transactions photographed together" and the coarse two-treatment invoice. Dext ships exactly this as a separate, simpler answer to the same problem ([416731](https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext)). |
| 2 | **`DocumentLine` table + per-line coding** | **One LAW cycle + 10–15 days** | The real fix. The design is already written in `rules-suggestions/CLAUDE.md`: the model, the checksum, the projection that keeps the migration additive, and the `update-coding` variant it implies. |
| 3 | **Per-supplier line rules — AutoEntry's shape, not Dext's** | 5–8 days, only after 2 | ⚠ Build *condition rules on the line's own description* ([1890473](https://help.autoentry.com/en/articles/1890473-line-item-rules)), **not** Smart Split's blind percentage template. AutoEntry's version reads the line; Dext's does not read the invoice at all. Ours would also be the natural home for `capital-revenue.ts`'s existing classifiers, which already match on line text. Needs somewhere to write lines, so it cannot precede 2. Defer until a real client asks. |
| 4 | **Line-level ML** | — | **Do not build.** No verified vendor predicts a per-line category; the two that code lines automatically both do it from human-authored rules. |

#### What the 10–15 days at step 2 actually contains

Naming the parts, because "add a table" understates it by about half:

- **The migration and the Prisma model.** Additive, per the existing proposal.
- **⚠ A new RLS policy, and this is the part that goes wrong quietly.**
  `document_lines` is a tenant table and must join the `direct_tables` RLS loop
  with FORCE ROW LEVEL SECURITY. The `backfill-import-fingerprints` lesson in
  `apps/api/CLAUDE.md` is the precedent worth re-reading before starting: a query
  that misses the scoped path against an RLS table **returns an empty list and does
  not error**. A line table wired up wrong looks exactly like an invoice with no
  lines.
- **The checksum, enforced at the write site.** `Σ netPence + Σ taxPence` must
  equal `documents.total_pence`. Lines that do not sum to the document are worse
  than no lines — they look authoritative and quietly change a total. Integer
  pence throughout; Dext's documented percentage-tax rounding defect
  ([416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext))
  is the bug our money rule exists to prevent, and it is the single clearest place
  where a non-negotiable is a competitive advantage rather than overhead.
- **A balancing row.** Both Dext mechanisms have one — *"Add remaining balance"*
  manually and an automatic balancing line under Smart Split. Without it the
  checksum is a wall rather than a workflow.
- **Migrating the smuggled `extractions.fields.lineItems` into the table**, and
  keeping `readStoredLines` working for rows written by older releases.
- **`documents.category_code` becomes a projection** — the single distinct line
  category, or null when there is more than one. This is what keeps the migration
  additive: nothing that reads the column today changes.
- **A line-scoped `document.update-coding` variant** (contract change) so a human
  corrects line 4 rather than the document, and **the human lock becomes per
  line**.
- **`document-to-canonical.ts` gains the row-per-line it was built for.** D43 is
  unaffected: every line resolves to the same source document.
- **Retiring two escalation reasons from the "cannot" set to the "can" set** —
  `MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` and `MIXED_CAPITAL_AND_REVENUE` stop being
  terminal and become per-line answers. Both have tests that will need to change,
  which is the point of having them.

#### The honest counter-argument, which the owner should weigh

**The first paying client is a cleaning agency.** Multi-treatment invoices —
Amazon Business, an IT reseller's mixed hardware-and-subscription bill, a utility
split across capital and revenue — are the daily reality of an IT or construction
client and a monthly event for a cleaning agency. The urgency of step 2 is
therefore **client-dependent, and nobody has measured it**. See §11 Q1: one hour
spent counting multi-category documents in the first client's actual pile is worth
more than any further argument in this section.

If that count is low, steps 1 and 3 of R1–R5 deliver more accuracy per day of
work than step 2 does, and step 2 should be scheduled for the release after the
one that wins the client. If the count is high, step 2 moves above R5.

**What should not happen either way** is the middle position: shipping a
half-built line model that stores lines without the checksum, or a per-line
category without the per-line human lock. Both are worse than the current honest
escalation.

### 10.7 · What crosses a tenant boundary — read before R6c or R10

**Nothing in R1 through R9 crosses a tenant boundary at all.** Every one of them
operates inside a single `businessId`: the learned history is `businessId`-scoped
by `loadHistory`'s `where`, `Rule.businessId` is required, the chart lives on a
`reference_syncs` row reached through `integration.businessId`, and the
accept/dismiss counters are per suggestion on a scoped document. This should be
stated in the issue rather than assumed, because "learning" is the word that makes
people nervous and none of the learning proposed here leaves the client.

Two recommendations touch the practice level, and the distinction §2 drew is the
one that governs both.

**§2's conclusion, restated because it is the whole basis:** Dext propagates
knowledge across clients as **authored text** — Core guidance written by Dext,
Shared guidance written by the practice, Account guidance written by the client's
accountant — in three explicit, opt-in tiers, none of which mixes one client's
documents into another's model
([701546](https://help.dext.com/en/articles/701546-dext-ai-assist-core-guidance),
[701638](https://help.dext.com/en/articles/701638-dext-ai-assist-shared-guidance),
[615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance)).
A practice already has lawful access to all of its clients, so a practice-authored
*rule* crossing between them leaks nothing the practice did not already know. A
*model* trained on pooled client documents is a completely different proposition,
and Dext ships the former while never claiming the latter.

**If R6c (copy a chart between clients) is built, what crosses is:**

| Crosses | Does not cross |
|---|---|
| A list of account codes and names, authored by the practice or seeded by us | Any document, extraction, supplier name, amount, line description or coding history |
| Only within one `practiceId`, only on an explicit act by a practice member who can already see both clients | Anything between practices, ever |
| Additively — Dext's copy *"adds the categories from the source account… it doesn't remove any existing categories"* | Nothing is deleted in the target, so the act cannot destroy a client's chart |

**If R10 (practice-level rules) is built, what crosses is:** a `rules` row
authored by a named practice member, containing a supplier scope key and a
category code, applied to businesses within that same practice. **What does not
cross:** documents, extractions, learned history, line descriptions, amounts,
confidence values, aggregate statistics, or anything derived from one client's
document stream. And copy Dext's guardrail — updates apply to **new items only**,
so a practice-level change cannot retroactively rewrite twelve clients' books
([701638](https://help.dext.com/en/articles/701638-dext-ai-assist-shared-guidance)).

**Three hard lines, and they are not negotiable by a product argument:**

1. **No pooled training corpus across `businessId`, and none across `practiceId`
   either.** Not because it would not work — because §2 established that the
   market leader does not do it, its own data statement is *carefully silent*
   about internal cross-customer training rather than denying it, and we would be
   making a stronger claim than the incumbent while carrying a stricter RLS model.
2. **No aggregate that is derived from one client's documents and read while
   serving another**, however anonymised. "Suppliers like this are usually coded
   to X" is a pooled model wearing a different noun. If such a thing is ever
   wanted, it must be *authored* by a human who can see the source data and
   *reviewed* before it applies — which is precisely Dext's Shared guidance, and
   is why their shape is the one to adopt.
3. **Every query still goes through `scopedDb(ctx)`.** A practice-level rule does
   not become a reason to widen a scope; it becomes a `practiceId` column with its
   own RLS predicate, which is a LAW change and a security review, not a feature
   flag.

⚠ **Not verified**, and it matters to anyone tempted to argue from Dext's example:
whether Dext's older, non-AI-Assist auto-categorisation model is trained
per-account, per-practice or on a pooled cross-tenant corpus. The help centre is
consistently second-person singular — *"your previously categorised items"* — and
states neither. Their AI Assist data statement rules out *third-party* model
training only. **Do not put a cross-client-learning claim into a roadmap
justification on the strength of the marketing site.**

---

## 11. Open questions needing the owner's decision

These are decisions, not research gaps. Each one blocks or re-ranks something
above, and none of them can be settled by more reading. Where I have a
recommendation I have given it; the point of the section is that the choice is
not mine.

**Q1 · How many of the first client's documents genuinely need more than one
category?** *Blocks: the rank of R8.* This is the single most valuable hour
anyone could spend on this document. Take the cleaning agency's actual pile,
count the invoices that would need two or more accounts, and divide. Under ~5%,
R8 sits where it is and `document.split` (R7) absorbs the cases. Over ~20%, R8
moves above R5 and the LAW cycle should be opened this week. *My guess is that it
is low for a cleaning agency and high for the second client if they are a trade
or IT business — but it is a guess, and §10.6 should not be decided on one.*

**Q2 · Is a dismissal an ingest-class write or an ActionProposal?** *Blocks: R5.*
I recommend **ingest-class**: dismissing a suggestion changes no document field,
moves no state and writes no category — it stamps `dismissedAt` on a row that is
already an opinion. But it touches the Governance §10 fence, the fence is
absolute by design, and "it is obviously fine" is how fences erode. Needs a
one-line ruling, and it is exactly the sort of thing that should be ratified
rather than assumed.

**Q3 · What `provenance` does a learned-history suggestion carry?** *Blocks: R1.*
The contract says of `CodingSuggestion.provenance`: *"Always `AI_SUGGESTED`,
whatever rule actually decided it"* (`openapi.yaml:5188–5190`). A suggestion that
says *"you coded them this way five times"* is not an AI opinion — it is a
deterministic count of the client's own decisions, and SoT §13.3's three
provenance classes exist precisely to keep those apart. Two defensible answers:
keep `AI_SUGGESTED` and lean on `basis` to carry the truth (no contract change,
mildly dishonest label), or emit `DETERMINISTIC` (honest, and a documentation
change to that description). **I lean to `DETERMINISTIC`**, because an accountant
who learns that "AI suggested" sometimes means "you did this yourself" will stop
trusting the label on the documents where it does mean a model.

**Q4 · Does the R2 rule checkbox default off, and may a practice change the
default?** *Blocks: R2.* I recommend **off, with no practice-level override**, and
AutoEntry's explicit Yes/No wording rather than a checkbox (§10.1). An override
that let a practice default it on would let one setting turn every correction into
a standing rule, which is a lot of consequence for a toggle nobody re-reads.

**Q5 · Does retrospective rule application ship in ID at all?** *Blocks: R2's
scope.* Dext's *Apply to all inbox items* is opt-in and scoped to unpublished
items. It is genuinely useful and it is genuinely the highest-blast-radius thing
in R2. **I recommend omitting it from ID** and adding it once R5's counters show
what rules actually do. If it does ship, inbox-only is not negotiable.

**Q6 · Who re-derives the accuracy numbers before any of them reach a customer?**
*Blocks: nothing technical; blocks marketing copy and the demo script.* Three
figures are quoted in this repository and none is verified to a primary URL in
this session: Intuit's 62.5% / 20.8% / 36%, the "top-2 runs about ten points above
top-1" claim in the contract, and SoT §24.4.7's own ~90% / 60–70% bands. §7's
conclusion — that every vendor "99%" in this market is extraction, not
categorisation — is solid and independently supported. The specific percentages
are not, and the SoT's own rule (*"No number above 85% document-level is to be
claimed to a client, in the product, or in a demo"*) is the right posture until
someone owns the re-derivation.

**Q7 · Where does the capitalisation threshold live?** *Blocks: nothing in this
list, but it is quietly wrong today.* It is a `CapitalisationPolicy` constructor
argument defaulting to the platform figure with `source: 'PLATFORM_DEFAULT'`, so
**every firm is currently on our number** and is told so. There is no statutory de
minimis in UK GAAP or IFRS — it is the practice's own accounting policy. Persisting
it needs a `practices` column or a practice-settings row, i.e. a LAW cycle. The
question for the owner is whether one accountant's disagreement with £1,000 is a
launch blocker or a fast-follow.

**Q8 · When the accountant can finally edit the chart, does an edit ever touch
existing documents?** *Blocks: R6's endpoint design.* I recommend **no —
forward-only**, matching both the rule behaviour of all three vendors and our own
*Published means released for export*. Renaming an account should not silently
change what a January export said. But hiding an account that documents are
already coded to needs a defined answer, and "the code stays, it just leaves the
picklist" is the one I would pick (it is what both Dext and AutoEntry do).

**Q9 · What majority does R1's second half require before it will suggest?**
*Blocks: R1's second half only.* Nine-to-one is obvious. Two-to-one is not, and
three-to-two is a coin toss dressed as data. I recommend a floor of **three prior
codings and a two-thirds majority**, with the count and the minority always named
in the note so the accountant can overrule it in one glance — but this is a
product judgement about how confident a sentence is allowed to sound, and it
should be made deliberately rather than picked by whoever writes the branch.

**Q10 · At what client count do practice-level rules become worth a LAW cycle?**
*Blocks: R10.* Zero value at one client. The shape is settled (§10.7) and should
not be reinvented under time pressure later; the timing is the owner's.

**Q11 · Does R5's agreement rate ever become a customer-facing number?** *Blocks:
nothing; prevents a mistake.* It is an **agreement rate, not an accuracy rate**,
and §7 shows how easily that distinction is lost — it is the same slippage that
turned Dext's extraction figure into "captured and categorised with 99.9%
accuracy". A practice that codes everything to one account will show a 99%
agreement rate. **I recommend it stays internal**, and that if it is ever shown
outward it is labelled *"suggestions you accepted"* rather than anything with the
word accuracy in it.

**Q12 · A human who confirms a value without changing it leaves no trace.**
*Known, recorded, small — but it interacts with R5.* `document.update-coding`
short-circuits on an empty change set, so no `HUMAN_CONFIRMED` extraction row is
written and `documentLockFor` sees nothing. Once R5 counts acceptances, "the
accountant looked at it and agreed" becomes a signal worth having, and today it is
indistinguishable from "nobody looked". Closing it is a change to that executor's
idempotency branch in `validation-dedupe`. The question is whether R5 needs it in
scope or can ship without it. *I think it can ship without it — accepting a
suggestion always changes a null category to a code, so the accept path does write
a row. Only confirmation of an already-coded document is invisible.*

---

## Appendix: sources consulted

Every URL cited in the body, grouped by origin. Article numbers are given because
the body cites most of them by number alone after first mention. Verification
status follows the sourcing rule at the top of this document: where the body says
**not verified**, this appendix says so too and does not quietly upgrade it.

### Dext help centre (`help.dext.com`) — 19 articles, all retrieved and quoted

| Article | Title | What it supports here |
|---|---|---|
| [416713](https://help.dext.com/en/articles/416713-rules-and-automation-in-dext) | Rules and automation in Dext | The priority ladder (§1); "all rules are applied automatically after Dext finishes extracting"; forward-only rules and the *Apply to all inbox items* exception (§2); approval workflow outranking auto-publish (§4) |
| [416739](https://help.dext.com/en/articles/416739-how-dext-auto-categorises-your-costs-items) | How Dext auto-categorises your Costs items | The ML rung; the Always / Supplier rules / Never three-state setting; the cold-start passage; mobile-app pre-selection winning outright; the second-person-singular training language (§1, §2, §7) |
| [216125](https://help.dext.com/en/articles/216125-how-to-use-supplier-and-customer-rules-in-dext) | How to use supplier and customer rules in Dext | What one supplier rule can set; scoping; listing and bulk editing; the 48-hour ledger sync that silently overwrites user-authored rules (§3) |
| [500051](https://help.dext.com/en/articles/500051-what-is-dext-ai-assist) | What is Dext AI Assist? | The paid agent layer above the rules stack; "learns from your decisions and corrections"; dismissal-with-feedback; AI Assist line-item coding; the data statement that rules out *third-party* training only (§2, §4, §5) |
| [615879](https://help.dext.com/en/articles/615879-dext-ai-assist-account-guidance) | Dext AI Assist: Account guidance | Account-tier guidance; the one-shot **Generate** button that mines history into editable rules; guidance history / change log (§2, §4, §10.7) |
| [701546](https://help.dext.com/en/articles/701546-dext-ai-assist-core-guidance) | Dext AI Assist: Core guidance | Dext-authored, read-only, regional-compliance tier (§2, §10.7) |
| [701638](https://help.dext.com/en/articles/701638-dext-ai-assist-shared-guidance) | Dext AI Assist: Shared guidance | Practice-authored tier; clients cannot edit; updates apply to **new items only** (§2, §10.7) |
| [701659](https://help.dext.com/en/articles/701659-dext-ai-assist-review-suggestion-performance) | Dext AI Assist: Review suggestion performance | Triggered / applied / dismissed counts per rule, drillable to documents — the only measurable figure Dext ships (§2, §7, R5) |
| [377051](https://help.dext.com/en/articles/377051-how-to-use-auto-publish-in-dext) | How to use auto-publish in Dext | Filing without a human; failing closed on missing required fields; the generic troubleshooting list that stands in for a stated reason (§4, §7) |
| [377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext) | How to manage categories in Dext | Ledger-synced read-only chart when connected; editable chart + CSV in/out when not; the **hide** toggle; copying categories between clients, additively (§6, R6) |
| [416723](https://help.dext.com/en/articles/416723-how-to-manually-create-line-items-in-dext) | How to manually create line items in Dext | The per-line data model — category, tax rate, tracking per line; *Add remaining balance*; the documented percentage-tax rounding defect (§5, §10.6) |
| [377044](https://help.dext.com/en/articles/377044-how-to-use-line-item-extraction-in-dext) | How to use line item extraction in Dext | Automatic line extraction yields no category and no tax rate; it is metered in credits while manual line creation is free (§5, §10.6) |
| [416726](https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext) | How to use Smart Split in Dext | The stored per-supplier percentage template that never reads the invoice; the automatic balancing line; mutual exclusivity with line extraction (§5, §10.6) |
| [416731](https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext) | How to split an item in Dext | The coarser escape hatch — splitting the document rather than the line. The direct precedent for R7 `document.split` |
| [630283](https://help.dext.com/en/articles/630283-how-to-group-line-items-in-dext) | How to group line items in Dext | Line grouping as a manual workflow constraint Dext lives with (§5) |
| [416744](https://help.dext.com/en/articles/416744-uploading-your-supplier-list-into-dext) | Uploading your supplier list into Dext | Bulk supplier import — rule scoping and bootstrap (§3) |
| [596019](https://help.dext.com/en/articles/596019-how-to-merge-lists-when-changing-your-accounting-software) | How to merge lists when changing your accounting software | The supplier-merge tool, cited as evidence that duplicate supplier records are common enough to need one (§3, §9, R4) |
| [209127](https://help.dext.com/en/articles/209127-how-to-refresh-your-accounting-software-data-in-dext) | How to refresh your accounting software data in Dext | The ledger refresh path behind the read-only chart (§6) |
| [448394](https://help.dext.com/en/articles/448394-how-to-manage-list-visibility-groups-in-dext) | How to manage list visibility groups in Dext | Per-user visibility groups over the category list (§6, R6) |

**Search endpoint, cited as negative evidence:**
[`help.dext.com/en/?q=confidence`](https://help.dext.com/en/?q=confidence) — returns
nothing describing a user-visible confidence score. §4's finding that Dext exposes
no confidence score rests on this absence, and is stated in the body as an absence
rather than as a denial.

### Dext marketing site

- [dext.com/en](https://dext.com/en) — the three mutually inconsistent accuracy
  sentences analysed in §7 ("captured and categorised with 99.9% accuracy",
  "extracts key data with 99.9% accuracy, categorises it", and the "DEXT BY
  NUMBERS · 99%" tile). **Not verified**: what the 99.9% measures — characters,
  fields, documents, which fields, on what corpus, pre- or post-correction — and
  **not verified** whether Dext has ever published a categorisation accuracy
  figure at all. §7 draws a conclusion *about the inconsistency*, not from the
  number.

### Hubdoc (Xero) — `support.hubdoc.com`

| Source | What it supports here |
|---|---|
| [Help-centre article index (`articles.json`)](https://support.hubdoc.com/api/v2/help_center/en-us/articles.json) | The 65-article count, and the finding that **not one** article describes machine learning, auto-categorisation, confidence or suggestions. Retrieved 3 Sep 2026 with `?per_page=100`, returning 65 and `next_page: null` |
| [16659762446605 — Configurations explained](https://support.hubdoc.com/hc/en-us/articles/16659762446605-Configurations-explained) | Supplier configurations; save-the-configuration-at-publish-time, the competitor precedent for R2 |
| [16568850613261 — Customise configurations by supplier](https://support.hubdoc.com/hc/en-us/articles/16568850613261-Customise-configurations-by-supplier) | Per-supplier Auto-sync, Publish As, Tax Rate; "changes are applied on a moving forward basis" |
| [16660084462477 — About data extraction](https://support.hubdoc.com/hc/en-us/articles/16660084462477-About-data-extraction) | "Hubdoc doesn't automatically extract line item data"; the mandatory date / supplier / total set; duplicates blocking auto-publish; date-ambiguity fallback (§8, §10.6) |
| [16695107301389 — View a document's audit trail in Hubdoc](https://support.hubdoc.com/hc/en-us/articles/16695107301389-View-a-document-s-audit-trail-in-Hubdoc) | Per-document audit trail. Note recorded in §8: this was a bare, slug-less URL in an earlier draft and the article id was recovered from the JSON index on 3 Sep 2026 |

### AutoEntry (Sage) — `help.autoentry.com`

Verified 3 Sep 2026. §8 records how: AutoEntry runs the same Intercom help centre
as Dext, with an identical `robots.txt` and an identical `/en/?q=` search endpoint,
so `help.autoentry.com/en/?q=<terms>` resolves the same way `help.dext.com` does.
An earlier draft had marked this vendor unverified.

| Article | Title | What it supports here |
|---|---|---|
| [1312934](https://help.autoentry.com/en/articles/1312934-remember-supplier-category-and-vat-codes) | Remember supplier category and VAT codes | The inline **Remember: Yes / No** prompt at the moment of coding — the wording R2 recommends copying in preference to Dext's checkbox |
| [1890473](https://help.autoentry.com/en/articles/1890473-line-item-rules) | Line item rules | Deterministic per-line coding driven by the line's own description or unit price (`contain` / `begin with` / `end with` / `equal`, All/Any, hand-ordered). The shape §10.6 step 3 recommends over Smart Split |
| [1890281](https://help.autoentry.com/en/articles/1890281-supplier-settings) | Supplier settings | Per-supplier defaults including per-VAT-rate coding, line extraction off by default, per-supplier auto-publish |
| [4810843](https://help.autoentry.com/en/articles/4810843-hide-vat-category-expense-category-codes-and-mileage-rates) | Hide VAT, category, expense category codes and mileage rates | The second vendor shipping *hide, do not delete* on the chart (§6, R6b) |
| [4799701](https://help.autoentry.com/en/articles/4799701-hide-supplier-account) | Hide supplier account | The same pattern applied to suppliers |

**Search endpoint, cited as negative evidence:**
[`help.autoentry.com/en/?q=machine+learning+accuracy`](https://help.autoentry.com/en/?q=machine+learning+accuracy)
— no article describes learned categorisation or publishes an accuracy figure.
§8's "two of the three verified competitors describe no learned categorisation at
all" rests on this absence.

### Xero Smart Document Capture — **not verified, and no claim is made**

- [`productideas.xero.com/robots.txt`](https://productideas.xero.com/robots.txt) —
  the only Xero URL cited anywhere in this document, and it is cited to record why
  the vendor could **not** be researched: the `/api/` path is `Disallow`ed and the
  HTML surface is JS-rendered.
- `central.xero.com` is named in §8 but **no URL is cited** and none was
  successfully retrieved; a headless-Chrome render of a guessed article slug
  returned an empty DOM.

§8 therefore makes **no claim** about Smart Document Capture's categorisation
mechanism, line-item support or learning behaviour, and presents no
community-reported evidence for Xero. The comparison table in §8 has three vendor
columns, not four, for this reason.

### Our own repository — read directly, not cited by URL

All paths are relative to `/Users/mubasshir/neoting/`. The engine under discussion
is `apps/api/src/modules/rules-suggestions/` (there is no top-level
`chart-of-accounts/` module — it is `rules-suggestions/chart-of-accounts/`), and
the production entry point is
`apps/api/src/modules/extraction/coding-advice.ts`, called from
`extraction-pipeline.ts:461`.

| File | What it supports here |
|---|---|
| `coding-advice.ts` (esp. `:88`) | The R1 defect — `if (result.decision.outcome !== 'REVIEW') return null;` discards every `CODE`, including `LEARNED_HISTORY` |
| `supplier-coding.service.ts` (`:243`, `:262–276`, `:313–331`) | The authority order; exact-string rule matching; the `CODE` / `LEARNED_HISTORY` outcome that R1 recovers |
| `authority.ts` | The rung ordering compared against Dext's ladder in §9 |
| `extraction-pipeline.ts` (`:444–452`, `:461`) | The single-tier exact-match query that is the only thing currently coding a document |
| `escalation.ts` (`:38–177`) | The closed enum of ten escalation reasons; `MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT` and its own words — *"this is not a limitation of the rules; it is the schema's"* |
| `supplier-key.ts` | The normalised key used for history but never for rules — the R4 near-miss class |
| `rule-proposal.ts` | `buildSupplierRuleProposal` / `buildSupplierRulePayload`, built with 12 tests and zero production callers (R2) |
| `update-coding.ts:138` | `createRuleDeferred: true` written onto a `document_events` detail that nothing reads |
| `render-summary.ts:60–71` | Renders field changes only — why the R2 rule flag would today be approved unseen |
| `ai-suggestion.ts` (`:287`) | Where `secondChoice` is computed and stored (R3) |
| `apps/web/src/api/document-detail.ts` | `CodingSuggestionView`, which does not carry `secondChoice` across the browser boundary (R3) |
| `DocumentPreview.tsx` | `acceptSuggestion` routing a tap through `parseCodingDraft` into `document.update-coding` |
| `coding-instructions.ts` | The prompt, tool schema and strict Zod parse for a model call that is not wired |
| `chat-framework/models.ts` | `TASKS.codingSuggestion` naming `anthropic.claude-sonnet-4-6`, referenced by nothing |
| `capital-revenue.ts` | Existing classifiers that already match on line text — the natural home for §10.6 step 3 |
| `document-to-canonical.ts`, `exports-public-api` | The row-per-analysis-line export mechanism currently fed a single category |
| `prisma/seed.ts` | The legacy questionnaire shape that drops every seeded demo client to `NO_PROFILE` (R6) |
| `rules-suggestions/CLAUDE.md` | The pre-existing `DocumentLine` design — model, checksum, additive projection |
| `apps/api/CLAUDE.md` | The `backfill-import-fingerprints` precedent: a query that misses the scoped path against an RLS table returns an empty list and does not error |
| `packages/contracts` `openapi.yaml` (`:5188–5190`, `:5192–5195`, `:5220–5231`, `:5608–5614`) | `provenance` always `AI_SUGGESTED`; `basis` as an open string rather than an enum; the `secondChoice` field and its ten-point justification; `createRuleFromCorrection` and its stated intent |
| `docs/Source_Of_Truth.md` | §13.3 (three provenance classes), §16 (cost blend), §24.4.7 (~90% repeat / 60–70% new, and the 85% claim ceiling); D40–D49 |
| `docs/Engineering_Governance.md` | §10, the ActionProposal / Review → Approve fence that Q2 turns on |

### Claims with no source

Listed rather than hunted down, per the sourcing rule. None of them is load-bearing
for a recommendation, but a reader should know they are unsupported.

1. **How a Dext supplier rule *matches* a supplier.** §3 calls this out as "**not
   verified — and this is a real gap**": no help-centre article states whether
   matching is exact, normalised or fuzzy. This matters because R4 is entirely
   about our own exact-match behaviour and Dext's approach cannot be used as a
   precedent either way.
2. **The "top-2 accuracy runs about ten points above top-1" figure.** Quoted from
   our own `openapi.yaml` and module documentation; §10.3 and R3 both record that
   **the primary source is not verified in this session**. R3's recommendation
   stands without it — carrying a stored field across an API boundary is worth
   doing regardless — but the number must not reach customer-facing copy. See Q6.
3. **Intuit's 62.5% top-1 / 20.8% unseen-category / 36% zero-shot figures.**
   Attributed in §7 to "our own module documentation cites Intuit's published
   research", with no URL to the research itself. Q6 names this as one of three
   unverified figures in the repository.
4. **SoT §24.4.7's own ~90% and 60–70% bands.** Internally authored; no external
   derivation is cited. Q6 covers this too.
5. **The S5 cost measurement (three line items inside a 1.34p read; comparable
   rungs at 1.26–1.34p).** An internal measurement referenced in §10.3 and §10.6
   with no linked artefact in this document. It is the basis for the claim that
   line items are already paid for, which is the economic core of §10.6 — worth a
   pointer to the measurement record when the PR #247 issue is written.
6. **Dext's 48-hour ledger sync interval.** §6 and §9 both state the chart is
   re-synced "every 48h". [377036](https://help.dext.com/en/articles/377036-how-to-manage-categories-in-dext)
   and [209127](https://help.dext.com/en/articles/209127-how-to-refresh-your-accounting-software-data-in-dext)
   support that a periodic sync exists and can be refreshed on demand; the
   specific 48-hour figure is not separately evidenced in the quoted material.
7. **"Neither Dext nor Hubdoc offers a runner-up at all"** (R3). A negative claim
   from absence of documentation rather than from a statement, and weaker than the
   confidence-score absence in §4 because no search endpoint was cited for it.

Additionally, the following are marked **not verified** in the body and are
recorded here so the appendix does not imply otherwise: whether Dext's
auto-categorisation model is trained per-account, per-practice or on a pooled
cross-tenant corpus (§1, §2, §10.7 — the AI Assist data statement rules out
*third-party* training only and is carefully silent on internal cross-customer
training); whether a single correction can create or promote a supplier rule
without a user acting (§2); how many corrections constitute "enough data", and the
retraining cadence (§2); whether a practice can define a supplier rule once and
push it to many clients (§3); whether the rule set can be exported (§3); what Dext
does to a supplier rule whose category is later deleted in the ledger (§6); and
what happens to an off-chart code (§9).
