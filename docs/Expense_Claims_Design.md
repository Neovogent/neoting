# Employee expense claims — design document

**Status: DRAFT, awaiting Shakib's sign-off. Nothing here is built.**
Review item 50 (`docs/reviews/MUBASHIR_REVIEW_NOTES.md`), whose brief says the
deliverable is *"a design document for Shakib's sign-off first, not a PR"*.
Item 50's other half — hiding the unbuilt tab — **shipped separately** and is
recorded in §8.

Author: 7 Sep 2026. Governing documents: SoT v1.6 §24 (ID), Engineering
Governance v1.6 §10 (the ActionProposal spine) and §11.2 (server-side
enforcement), `docs/Access_and_Approval_Matrix.md` (items 39 + 66).

---

## 0. The one-paragraph summary

An expense claim is **not a new kind of document**. It is an ordinary purchase
document with one extra fact attached: *somebody other than the company paid for
it*. That single fact changes exactly two things downstream — **who gets
credited** (the employee, not the bank) and **what the bank statement will later
show** (one reimbursement payment, possibly covering many receipts, not
per-receipt lines). Everything else — intake, extraction, coding, D46 flagging,
review, approval, export — is the pipeline that already exists.

The recommendation this document argues for is therefore **narrow**: add a
claimant to a document, point the canonical export row's creditor at them, teach
the bank lane to expect a reimbursement, and reuse the rest. The alternative — a
parallel `ExpenseClaim` aggregate with its own lifecycle, its own approvals and
its own export path — is what the synthetic UI already mocks, and §7 explains why
it should not be what gets built.

---

## 1. The accounting research

### 1.1 What a claim actually is, in double entry

A UK small company records an employee- or director-paid expense at the **date on
the receipt**, not the date it is reimbursed. The credit does not go to the bank,
because no company money has moved yet. It goes to a **liability**: the employee
is a creditor of the company until they are paid back.

**On the claim (receipt date):**

| | Debit | Credit |
|---|---|---|
| Expense nominal (net) | £X | |
| Input VAT (if a valid VAT receipt is held) | £V | |
| Employee / director creditor | | £X + £V |

**On the reimbursement (bank payment date):**

| | Debit | Credit |
|---|---|---|
| Employee / director creditor | £X + £V | |
| Bank | | £X + £V |

Two consequences, and the second is the one with teeth:

1. **The expense and the input VAT are recognised at receipt date.** A claim
   submitted in October for a September receipt belongs in September, and — the
   part that reaches this product — in the **September VAT quarter**. The
   canonical row's `date` must stay the document date, exactly as it is today.
2. **The bank statement never shows the receipt.** It shows the reimbursement —
   and one payment routinely settles a whole month of receipts from one person.
   The bank-matching lane must expect a payment that explains **N documents at
   once**, against a creditor, not one line per receipt.

For a **director**, the creditor is the **director's loan account**. A claim puts
the DLA *in credit* (the company owes the director), which is the harmless
direction: [CTA 2010 s455](https://www.gov.uk/directors-loans/you-owe-your-company-money)
bites on an **overdrawn** account — a director owing the company — so a claim
never creates a s455 charge on its own. It can, however, *reduce* an existing
overdrawn balance, which is precisely why the accountant needs claims posted to
the DLA rather than to a generic "expenses payable" bucket. HMRC's own
[Directors' Loan Accounts Toolkit](https://assets.publishing.service.gov.uk/media/62bae39bd3bf7f6630492270/Directors-Loan-Account-Toolkit-2022.odt)
lists mis-posted expense reimbursements among its risk areas.

**Design consequence:** the creditor account is a **per-claimant** setting, not a
constant. One nominal for staff ("Creditors: Expenses payable"), a *named* DLA per
director ("Creditors: Director's loan — J Smith"). §4.2 puts it on the member
record.

### 1.2 Input VAT — the rule that decides what we may claim

The company may reclaim the input VAT on an employee-paid expense **when it
reimburses the actual cost and holds a valid VAT invoice or receipt**. HMRC:

> *"You should decide whether the supply is legitimately paid for by the employer
> for the purpose of the business. If it clearly is then input tax should be
> recovered."*
> — [VIT13400](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit13400)

> *"If the business pays the actual cost of the supplies [it] can claim the input
> tax incurred."*
> — [VAT Notice 700 §12.1.1](https://www.gov.uk/guidance/vat-guide-notice-700)

And the hard stop, which is the whole reason §1.3 recommends what it does:

> *"A business cannot claim VAT when a fixed allowance is paid to an employee even
> if tax invoices are held"* — because *"no supply is made to the business"*.
> — [VIT42500](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit42500),
> and Notice 700 §12: *"If you pay an employee a flat rate for subsistence
> expenses [you] cannot claim as input tax any VAT incurred on those expenses"*

So: **actual cost + valid receipt → reclaimable. Flat allowance → not
reclaimable, whatever paperwork exists.** This maps onto the product exactly. The
pipeline this product runs is *"a receipt arrived, read it"* — an actual cost with
a document behind it — which is the reclaimable case and the one ID should serve.
The flat-rate case has no document to photograph and is a payroll calculation, not
a receipt.

Evidence quality is already handled: HMRC accepts a **less detailed (simplified)
VAT invoice** for supplies of £250 or less
([VIT31000](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit31000)),
which is what almost every claimed receipt is, and D46 already flags a document
that is not acceptable evidence without blocking it. **No new evidence gate is
needed** — a claim with an unreadable or non-VAT receipt is a D46 flag on a
document, which is a mechanism that exists.

### 1.3 Mileage and subsistence flat rates — **out of ID scope. Recommended, explicitly.**

Item 50's brief asked for this to be said rather than discovered later. Saying it,
with the reason:

**Mileage (Approved Mileage Allowance Payments).** The published rates
([Travel — mileage and fuel rates and allowances](https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances)):

| Vehicle | First 10,000 business miles | Thereafter |
|---|---|---|
| Cars and vans | **55p** (from tax year 2026/27; 45p for 2011/12 – 2025/26) | 25p |
| Motorcycles | 24p | 24p |
| Bicycles | 20p | 20p |

Three reasons it does not belong in ID:

1. **There is no document.** Mileage is a distance times a rate. This product's
   entire spine — intake, extraction, D46 flagging, the bank match, the D43 source
   link on every exported row — is built on *a document existing*. A mileage claim
   has nothing to photograph, nothing to extract, and no source document to link
   from the exported row, which is a **D43 violation by construction**, not an
   omission.
2. **VAT is a different calculation.** The AMAP payment itself carries no
   reclaimable input tax (§1.2). What *is* reclaimable is the VAT on the fuel
   element, computed from HMRC's **advisory fuel rates** and supported by fuel
   receipts covering the amount — a second rate table, a second calculation, and a
   receipt requirement that has nothing to do with the receipt being claimed.
3. **The rates are live data.** The car rate had been 45p since 2011/12 and changed
   to 55p for 2026/27 — during this project. A flat-rate feature is a rate table
   someone must maintain, per tax year, forever, and a stale table produces a
   **silently wrong number in somebody's books**. That is the class of failure this
   product tries hardest not to have.

**Subsistence benchmark scale rates**
([EIM05231](https://www.gov.uk/hmrc-internal-manuals/employment-income-manual/eim05231),
[EIM05230](https://www.gov.uk/hmrc-internal-manuals/employment-income-manual/eim05230))
fall out for the same reasons: they are flat rates with the same VAT block, they
carry qualifying-condition logic (5-hour and 10-hour absence tests, one meal
claimed once), and receipt checking for them was *abolished* — so the one artefact
this product knows how to handle is the one HMRC no longer requires.

**Recommendation: ID supports receipted, actual-cost claims only.** A mileage or
per-diem line is entered by the accountant in their own software, as it is today.
If it is ever wanted, it is a distinct feature — a calculator with a maintained
rate table and an explicit D43 exemption — not a variant of this one.
**Ruling wanted: ⚖A.**

---

## 2. The VT export shape

### 2.1 What the exporter emits today, and why a claim is not that

`apps/api/src/modules/exports-public-api` targets VT Transaction+ via
**`Transaction ▸ Journal ▸ Import…`**, data format *"Payments list/purchase
invoices list"*, seven positional columns, no header row — verified against a real
VT installation in A10 and against VT's published documentation in review item 37
([Importing a journal](https://www.vtsoftware.co.uk/transplushelp/importing-a-journal.html)).
The columns:

| | Column | A purchase invoice today | A bank payment today |
|---|---|---|---|
| A | Bank account name/supplier's name | the **supplier** | the **bank account** |
| B | Paid to/invoice details | reference · D43 code · URL · provenance | same |
| C | Gross amount | gross | gross |
| D | Input VAT | VAT | VAT |
| E | Net amount | net (one row per analysis line) | net |
| F | Net amount for VAT purposes | net | net |
| G | Analysis account name | `Ledger: Nominal` | the contra account |

The reviewer's objection is correct: **the current exporter emits purchase-invoice
rows, and a claim is not one.** A claim posted as a purchase invoice credits the
*supplier* — so the books would say the company owes Shell £40, when the company
owes *Jane* £40 and Shell has already been paid.

### 2.2 The finding: **no new format, no new emitter shape**

VT derives the double entry from the data format plus **which account Column A
names**. The same *"Payments list/purchase invoices list"* format already serves
both purchase invoices and bank payments in this exporter (`VT_DATA_FORMAT_BY_KIND`)
— the difference is only whether Column A holds a supplier or a bank account. So:

**A claim row:**

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| **the claimant's creditor account** — `Creditors: Director's loan — J Smith` | **supplier name** · reference · D43 code · URL · provenance | gross | VAT | net | net | `Ledger: Nominal` |

which posts Dr expense + Dr input VAT, Cr claimant — §1.1's first table, exactly.

**The reimbursement row needs nothing new at all.** It is already what
`buildBankRows` emits for a bank payment: Column A = the bank account, Column G =
the contra account. Point that contra at the claimant's creditor account and it
posts Dr claimant, Cr bank — §1.1's second table. **One statement line, one row,
clearing however many claims it covers.** The "one payment, many claims" problem
the brief warns about is not an export problem; it is a *matching* problem (§6.3).

**What this costs, concretely:** `api/document-to-canonical.ts:143` today reads
`party === 'CUSTOMER' ? customerName : supplierName`. A claim makes that the
claimant's creditor account and moves the supplier into the Column B details
string. The emitter (`vt-transaction-plus-emitter.ts`) is **untouched** — which
also means the publish review card and the file stay the same code, the property
that file's header insists on.

### 2.3 Two risks to design around, both known

- **Column B length.** It carries reference · code · URL · provenance today and was
  observed importing whole at **104 characters**; VT publishes no field-length
  limit for details fields (checked again for this document, 7 Sep 2026).
  Prepending a supplier name adds ~20–30. Under a documented limit of nothing, but
  it is the second time that cell has grown, and it is the cell D43 rung 1 lives
  in. Mitigation: append the supplier to the existing `reference` value rather than
  adding a fifth part, and leave `assertVtEntryDetailsSafe` exactly where it is.
- **Supplier mapping.** VT's Converter saves a mapping per Column A string, and A10
  measured **Auto Assign resolving 1 of 8** — a real one-off session per account.
  Claims add one account **per claimant**, not per supplier, so the cost is small
  and bounded, but the export screen's existing "you will map these on first
  import" note should count claimants too.

**Rejected alternative: VT's generic Journal format** (Column A account, B entry
details, C debit, D credit — the one format VT documents publicly). It would
express a claim exactly, but it means a second emitter shape, a second file kind, a
second data format in the how-to, and a preview card that no longer shares code
with the file. It buys nothing §2.2 does not.

---

## 3. Fit to the spine — where a claim meets Review → Approve

Governance §10 is not negotiable: no state change outside the ActionProposal path.
The question item 50 raises is *which tier*, and item 66's ratified matrix answers
it by asking **whose signature does this carry**.

There are two distinct acts and they land in different places.

**Act 1 — the client's own approval ("the business says Jane really did buy
this").** This happens in the *client portal*, between the client's super admin and
their own staff. It is not a practice-side proposal at all: it does not touch the
practice's books, it releases nothing, and the approval matrix governs practice
actors. **Outside the matrix**, the same way `ClientApprovalView`'s existing
client-side approvals are. It is a state on the document, recorded with who and
when.

**Act 2 — the practice releasing it for export.** Already `publish.batch`, already
**tier 1**, already D44's super-admin-only rule. Nothing new.

**The one genuinely new practice-side act: setting or changing a claimant.**
Attaching a claim to a document changes **which account gets credited** — a coding
decision in the strictest sense. `document.update-coding` is **tier 1 whole**,
under item 66's ⚖5 ruling (a): every coding change waits for the super admin,
whatever field it touches. Adding `claimantId` to that payload puts it in tier 1
**automatically and correctly**, with no new proposal kind, no new tier argument,
and no new entry in `assert-can.ts`'s tier-1 list — which is pinned whole and
sorted by a test, so a promotion nobody meant fails there rather than shipping.

**Recommendation: no new proposal kind.** `claimantId` becomes a tier-1 field on
the existing `document.update-coding` payload table, alongside `categoryCode` and
`totalPence`. **Ruling wanted: ⚖B.**

The claim mark arriving *at upload* is a different matter: intake is tier 3
(`x-nt-side-effect: ingest`), ratified in item 66's six groups, and a mark from the
client is a **claim about the document**, not a coding decision by the practice. It
arrives as data on the upload, exactly as item 11's note does, and the accountant
confirms or corrects it through the tier-1 path above. That is also what makes the
mark safe to accept from a client at all.

---

## 4. Permission — the client's super admin grants it

### 4.1 The existing model, and what extends cleanly

Package F (#263) and items 41/42 shipped the portal member model this extends. A
`PortalPerson` carries `access` (`WorkspaceRole`) plus two capability booleans —
`canSendDocuments` and `canSeeTotals` — with `PortalPeople.canManagePeople` saying
whether *this* session may edit the roster (`BUSINESS_ADMIN` and `USER_ADMIN`
only). Item 42 gave that roster a `PATCH`, so a capability granted in error is
correctable. **A third boolean, `canSubmitExpenseClaims`, is the same shape in the
same three places** — the invite request, the update request and the person
response.

Default: **false**. Unlike sending documents, which is the point of the portal,
being able to obligate the company to pay you back is a grant, not a baseline.

### 4.2 The claimant's creditor account lives here too

§1.1 needs a per-claimant creditor nominal (staff → a shared creditors account; a
director → their own named DLA). The natural home is the same member record, set by
the **accountant** rather than by the client — it is a chart-of-accounts decision,
and the client's super admin has no business choosing which nominal their staff post
to. That is a field on the practice-side view of the member, not on the portal-side
`PortalPersonUpdateRequest`.

**Consequence, and it is why §9's delta carries a new refusal code:** a claim from a
member with no creditor account cannot be exported — `document-to-canonical.ts` would
have nothing for Column A. It should refuse the way a missing category already
refuses (`document-missing-category`), with its own reason, rather than guessing an
account. **Never invent a nominal.**

### 4.3 ⚠ A pre-existing gap this feature must not be built on top of

**`canSendDocuments` is stored and editable but never checked on the upload path.**
Grepped 7 Sep 2026: it appears in `portal-people.service.ts`,
`portal-people-authority.ts` and `portal-business-profile.service.ts` — the roster's
own read and write — and **nowhere in `portal-upload.service.ts` or the portal
controller**. A member with the box unticked can still upload.

That is Governance §11.2's exact prohibition: *"a UI that merely hides the button is
not an implementation of this"*. It matters here because `canSubmitExpenseClaims`
would be the *third* capability on a mechanism where the second is
presentation-only, and a permission to obligate the company to pay someone is a
worse one to leave unenforced.

**Recommendation: fix `canSendDocuments`'s enforcement first, as its own small
change, and build the third capability on the enforced mechanism.** It is a guard in
the upload service against the session's `contactId` row — one place, because every
portal upload routes through it. Flagged here rather than folded in silently: it is
a permission fix, and the repo's own rule is to stop and ask on those.
**Ruling wanted: ⚖C.**

---

## 5. Submission — the mark rides the upload as data

`PortalUploadRequest` gains one nullable boolean, `expenseClaim`. The Upload tab
(`LivePortalUpload`) and the Capture tray (`LivePortalCapture`) both offer the tick
at send time, and both already pass through `onUpload`, which carries item 11's
`note` — the same seam, the same trust posture:

**The mark is data, never instructions.** It is a boolean, so it cannot be anything
else — the cheap version of item 11's rule. The *claimant* is **not** taken from the
request at all: it is `PortalSessionFacts.contactId`, resolved server-side from
`otp_sessions.contact_id`, which item 43 (#260) established as already present on
both own-portal sign-in routes. **No claims widening is needed** — the same finding
item 43 recorded.

Three refusals, all server-side:

1. **`contactId === null` → the mark is refused.** A chase session sets it null
   deliberately, because a chase link is forwardable and *"a guess in an audit column
   is worse than an absence"*. A claim without a claimant is meaningless (item 50's
   own words), so the chase portal can never mark one. This is not a limitation to
   work around; it is the right answer.
2. **`canSubmitExpenseClaims === false` → refused**, on §4.3's enforced mechanism.
3. **D46 still governs the document itself.** An unacceptable receipt is flagged,
   never blocked — including a claimed one. The claim mark is not an evidence gate
   and must not become one.

The mark is recorded on the provenance event alongside item 43's composed display
filename, so the accountant's card reads *"Claimed by {member} ({business})"* the way
it already reads *"Captured by …"*.

---

## 6. Surfaces

### 6.1 The practice app

- **Costs tab.** A claimed document is a cost like any other and appears there from
  the moment it lands, not from approval. Item 50's *"and in the cost"* — the
  distinction is *who paid*, and that is a badge on the row, not a separate list.
  The claimant is shown; an unset creditor account (§4.2) shows as a warning on the
  row rather than staying hidden until export refuses.
- **Expense Claims tab.** Comes back — this is the condition on which it returns
  from §8's hiding rule. Its content is **claims grouped by claimant**: the same
  documents, grouped by who is owed, with a running total per person and what has
  been reimbursed. It is a *view*, not a second store.
- **Bank tab.** §6.3.

### 6.2 The client portal

The claimant needs to see their own claim's status (item 50 §5). The portal's
document list (item 18) already renders per-document status; a claimed document
shows the claim's own state alongside it. **What the portal must never show is a
figure a `canSeeTotals: false` member may not see** — and a claimant is frequently
exactly that member. Their *own* claim total is theirs to see; the company's figures
are not. That distinction is enforced server-side in the portal read, never filtered
in the browser.

### 6.3 The bank lane — the part with teeth

The reimbursement is a single statement line, payable to a person, that explains **N
documents**. Today the match model is one document ↔ one transaction.

The honest position: **this is the largest piece of the build, and it is a real
extension of the matching model, not a reuse.** Three things follow.

1. The unexplained-transaction list must not chase a reimbursement. A payment to an
   employee is not a missing supplier invoice, and chasing the client for "the
   receipt for your £212 payment to J Smith" is exactly the confidently wrong output
   item 25 was about.
2. Matching a reimbursement to a set of claims is a **confirmation of a set**, and
   `bank.confirm-match` is tier 2 (*"asserts a document explains a bank line; wrong
   is re-ruled"*). A set-valued match is the same act over more rows and should stay
   tier 2 — but say so deliberately rather than by inheritance.
   **Ruling wanted: ⚖D.**
3. The sum must reconcile to the penny, in integer pence, and a **partial**
   reimbursement (£200 paid against £212 of claims) must be representable rather than
   refused — part-payments are ordinary. This is the piece most likely to be
   underestimated.

**Recommendation: build §§1–5 and 6.1–6.2 first; the reimbursement match is a
second, separately-scoped change.** A claim that exports correctly and is matched by
hand is a working feature with a manual step. A matching model rushed into the bank
lane is a defect in the surface the whole product's reconciliation stands on.

---

## 7. What NOT to build, and why

The synthetic UI (`ClientExpenseClaims.tsx`, ~1,100 lines) models a claim as a
first-class aggregate: `ExpenseClaim { claimant, period, items[], status }` with its
own six-state lifecycle — `draft → submitted → internally-approved → approved →
reimbursed`, plus `rejected`. It is good demo material and it is **not the
recommendation**, for three reasons:

1. **It duplicates the spine.** `internally-approved → approved` is a second
   approval ladder running beside Review → Approve, over the same documents, and
   Governance §10 already owns that ladder. Two ladders means two audit trails and a
   question — *which one is the record?* — with no good answer.
2. **A claim's own status is derivable.** *Submitted* = the mark exists. *Approved* =
   the documents are Ready. *Reimbursed* = a matched reimbursement covers them.
   Storing what is derivable buys drift.
3. **The grouping is a period, and a period is a view.** "Jane's September claim" is
   a filter over claimed documents. Making it a stored aggregate means deciding what
   happens when an October receipt is claimed late — a question the derived view does
   not have to answer.

**Recommendation: one field on a document (`claimantId`), one field on a member
(`expenseCreditorAccount`), one capability. The Expense Claims tab is a grouped view
over documents.** `ExpenseClaimStatus` becomes derived rather than stored.
**Ruling wanted: ⚖E.**

---

## 8. Phase 0, shipped — the tab is hidden live

Item 50 A, done and merged alongside this document.

`ClientDetailView.tsx` gained one rule: **a tab that cannot read anything from the
server is absent live and present synthetic.** One filtered list feeds both the tab
strip and the `fromSlug` address resolution, so live `/clients/{id}/expense-claims`
falls to Overview rather than being a hidden surface you can still deep-link into —
the pattern `AppContext.availableTabs` already established for the capability matrix.

**The audit found exactly one such surface.** `api/slices.ts` names it: of the seven
slices in `SliceName`, `expenseClaims` is the only one nothing ever asks the API for,
so it reports `'seed'` in every build. Every other client tab reads a slice that
hydrates — the Chases tab picks its live or seed shape rather than hiding, which is
the correct behaviour for a surface that *does* work. On the main nav, `SIDEBAR_TABS`
has no unwired member: its gate is the capability matrix (item 39), not build mode.
The tour's `expense-claims` step needs no change; `TourProvider` is already
synthetic-only.

---

## 9. Contract delta — batched, LAW, not applied

Per repo `CLAUDE.md` G7, written here rather than into `packages/contracts` or
`prisma/`:

| # | Where | Change |
|---|---|---|
| 1 | `PortalPerson`, `PortalPersonInviteRequest`, `PortalPersonUpdateRequest` | `canSubmitExpenseClaims: boolean`, default **false** |
| 2 | `contacts` (prisma) | `can_submit_expense_claims Boolean @default(false)`; `expense_creditor_account String?` |
| 3 | `PortalUploadRequest` | `expenseClaim: boolean \| null` — data, never instructions; refused when `contactId` is null or the capability is off |
| 4 | `documents` (prisma) | `claimant_contact_id String?` — nullable FK to `contacts`; null means "the company paid" |
| 5 | `DocumentUpdateCodingPayload` | `claimantId: string \| null` — **tier 1** by item 66 ⚖5(a), no new proposal kind |
| 6 | `Document` response | `claimant: { id, name } \| null` |
| 7 | Practice-side member view | `expenseCreditorAccount: string \| null`, accountant-set (§4.2) |
| 8 | Export refusal reasons | `document-missing-claimant-account` |
| 9 | *(separate, §4.3)* | none — enforcing `canSendDocuments` is code, not contract |

Deliberately **not** in the delta: any `ExpenseClaim` resource, any claim lifecycle
enum, any new proposal kind, any set-valued match shape (§6.3 is its own scoped
change).

---

## 10. Rulings wanted before Phase 2 starts

| | Question | Recommendation |
|---|---|---|
| **⚖A** | Mileage and subsistence flat rates in ID? | **No** — §1.3. No document, no D43 link, VAT blocked, live rate tables. |
| **⚖B** | New proposal kind for a claim, or `claimantId` on `document.update-coding`? | **The existing kind** — §3. Tier 1 automatically, no new tier argument. |
| **⚖C** | Fix `canSendDocuments`'s missing server enforcement first? | **Yes**, as its own change — §4.3. It is a permission fix, so it is your call. |
| **⚖D** | Set-valued reimbursement match — tier 2 like `bank.confirm-match`? | **Tier 2**, said deliberately — §6.3. |
| **⚖E** | Stored `ExpenseClaim` aggregate, or a derived view over documents? | **Derived** — §7. |
| **⚖F** | Build order: claims first, reimbursement matching second? | **Yes** — §6.3. |

---

## Sources

- [VIT13400 — input tax on supplies to employees](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit13400)
- [VIT42500 — subsistence, and the fixed-allowance block](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit42500)
- [VIT31000 — acceptable evidence for claiming input tax](https://www.gov.uk/hmrc-internal-manuals/vat-input-tax/vit31000)
- [VAT guide (Notice 700)](https://www.gov.uk/guidance/vat-guide-notice-700)
- [Travel — mileage and fuel rates and allowances](https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances/travel-mileage-and-fuel-rates-and-allowances)
- [EIM05230 / EIM05231 — subsistence benchmark scale rates](https://www.gov.uk/hmrc-internal-manuals/employment-income-manual/eim05231)
- [Director's loans: if you owe your company money (s455)](https://www.gov.uk/directors-loans/you-owe-your-company-money)
- [HMRC Directors' Loan Accounts Toolkit](https://assets.publishing.service.gov.uk/media/62bae39bd3bf7f6630492270/Directors-Loan-Account-Toolkit-2022.odt)
- [VT Transaction+ — importing a journal](https://www.vtsoftware.co.uk/transplushelp/importing-a-journal.html)
