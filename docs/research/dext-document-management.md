# Dext document management — reference for Neoting document-list implementation

> **STATUS: COMPLETE.** All ten sections researched and written. Claims marked
> **not verified** are gaps in the vendors' own documentation, not gaps in this
> research — they are recorded deliberately rather than filled from plausibility,
> and there are 66 of them. Do not read "not verified" as "feature absent"; read
> it as "do not build against this without checking".

Research date: 2026-09-02. Primary subject: **Dext Prepare** (formerly Receipt
Bank) document list / Inbox / Costs screens. Comparators: **Hubdoc**,
**AutoEntry**, **Xero Files**.

Sourcing rule used throughout: every non-obvious claim carries a URL. Where no
source was found, the line reads **not verified** rather than being filled in
from plausibility.

---

## 0. Executive summary

**One paragraph.** Dext Prepare's document list is built around a **five-state
lifecycle** (Processing → Inbox → *To review* / *Ready* → Approvals → Archive)
with a parallel, permanent **ingest ledger** called Submission History that
records every document ever submitted regardless of what later happened to it.
Delete is **soft for Costs and Sales items** — recoverable from Submission
History with **no documented time limit** — but **hard for Vault files and
supplier statements**, and **hard for expense claims** (though deleting a claim
*releases* rather than destroys its member documents). There is **no Trash tab**;
recovery lives on the ingest-ledger screen. **Archive is a separate, automatic,
reversible destination**, not a euphemism for delete. Preview is a **full page,
side-by-side image and fields**, with rotate/zoom/fullscreen/download and a
`Ctrl/⌘ + J/K` next/previous loop — but **no documented multi-page navigation**.
The one thing Neoting must categorically refuse is **Clear Publishing Data**: a
user-facing action that erases the record that a document was already released
downstream.

**The comparators do not agree with Dext, or with each other.** Three products,
three delete models: **AutoEntry hard-deletes** ("once you delete a document, you
can't retrieve it") with no bulk delete, a mandatory rejection-reason picker and
a guard forcing Unpublish → Reject → Delete
([AE 4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement),
[AE 8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice));
**Hubdoc soft-deletes into a real Trash folder with drag-to-restore, plus an
explicit "Empty Trash" permanent purge**
([Hubdoc, archived](https://web.archive.org/web/20231004123423/https://support.hubdoc.com/hc/en-us/articles/16695595279629-Delete-a-document));
**Dext soft-deletes with no purge at all**. Critically, **not one of the three
publishes a recovery time limit** — the "deleted items kept for 30 days" that
everyone assumes is standard in this category does not appear in any of their
documentation. On retention the spread is even wider: **Dext, 10 days after
cancellation and only on written request; AutoEntry, 13 months with a warning
email; Hubdoc/Xero, no number at all**
([xero.com/legal/terms](https://www.xero.com/legal/terms/)). There is no industry
consensus to copy, so Neoting must choose deliberately — and any specific,
honest commitment beats the entire field.

**Xero Files could not be verified.** Xero Central is JavaScript-rendered and
returns no article text to any fetcher; the old Hubdoc help domain no longer
resolves. Hubdoc facts here come from Wayback captures of its former Zendesk KB
(last revised June 2023) whose article slugs match today's Xero Central ones.
Xero Files claims are limited to what the public API spec proves — it has
`deleteFile` and **no restore endpoint**, which is *consistent with* hard delete
but does not prove UI behaviour. See §8.2–8.3 for the full caveat.

### The ten findings that matter

1. **Delete is soft, but the bin is an ingest ledger, not a Trash folder.**
   Submission History holds every submission forever with a Status column
   (Inbox / Archive / Deleted / Merged / duplicate) and a per-row **Restore**.
   Deleting changes status; it never removes the submission record. §1
2. **Dext ships three contradictory delete semantics** across object types, and
   its own help centre contradicts itself on whether deleting an archived item
   is permanent. Do not cite "Dext soft-deletes" as a single fact. §1.4, §9
3. **No stated recovery window.** Unlike Xero's and Google's "30 days", Dext
   makes no time commitment on restore, and no user-facing permanent-delete
   exists. §1.3, §1.4
4. **Archive ≠ delete, and archiving is mostly automatic** (on publish, on
   adding to an expense claim, optionally on CSV/PDF export). Users rarely
   archive by hand, so the working list stays clean without anyone tidying it. §5.1
5. **"Clear Publishing Data" is the anti-pattern.** Dext models "already
   released" as an erasable tag, then asks the user to manually delete the
   downstream transaction to compensate. Neoting must refuse this. §3.5, §10
6. **Publish and export are unconfirmed; merge and delete are confirmed.** Dext
   guards the reversible operations and waves through the irreversible one. §3.2
7. **Split is an amount split, not a page split** — both halves keep the whole
   image. Easy to misread, and there is no `Unsplit`. §5.6
8. **Merge is the best-designed operation in the product**: preview-and-edit
   confirmation, a semantic-mismatch warning, losing items preserved in the
   ledger with a *Merged* status, and a real **Unmerge**. §5.5
9. **Retention is weaker than it markets.** "At least 10 years while your
   subscription is active", but contractually Dext may destroy customer data
   **ten days after termination** unless you write in. §6.4
10. **"Published" in Dext means "pushed into a ledger"** — the exact meaning
    Neoting's glossary forbids. Every Dext document read by the implementation
    team needs this translation applied. §3.4

### Fastest orientation for an implementer

Read three articles and you have 80% of it:
[the Actions menu](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext)
(the complete bulk verb set),
[Submission History](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext)
(the delete/restore model), and
[the Item details page](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext)
(the viewer and the tab structure).

---

## 1. Delete semantics

### 1.1 Dext: delete is soft, but the recovery surface is *not* a Trash

This is the single most important finding, and it is not the shape most people
assume.

- Delete is offered from the Actions menu on a multi-select in the Costs inbox,
  Expense claims and Sales inbox: "Delete selected items from your inbox.
  Deleted items remain recoverable through the Submission History page."
  ([416718](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext))
- **There is no "Trash" or "Deleted items" folder as a peer tab of Inbox and
  Archive.** Recovery happens on a different screen entirely — **Submission
  History** — which is an *ingest ledger*, not a bin. It shows "every cost,
  sale, supplier statement, and vault file submitted to a Dext account — in one
  place", listing items "regardless of their current status: Inbox, Archive,
  Deleted, Merged, or marked as confirmed duplicates"
  ([105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext)).
- Deleted items are found there via an **"Only deleted items" checkbox** in
  advanced search, and restored with a per-row **Restore** button that returns
  the item to the Inbox ([105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext)).

The design consequence is that in Dext, *deletion never destroys the submission
record*. The row survives in the ingest ledger forever; only its status changes.
That is the correct instinct and Neoting should copy it (§10).

### 1.2 What cannot be restored

- **Supplier statements and Vault files cannot be restored from Submission
  History if removed**
  ([105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext)).
  So Dext's soft-delete guarantee is **per-workspace, not global** — Costs and
  Sales are recoverable; Vault and Supplier statements are not. Any implementer
  copying "Dext soft-deletes" without this caveat would be copying a guarantee
  Dext does not actually make everywhere.

### 1.2b Delete means three different things in Dext

Pulling the threads together, Dext ships **three incompatible delete semantics**
in one product:

| Object | Delete behaviour | Source |
|---|---|---|
| **Costs / Sales items** | Soft. Restorable from Submission History, no stated time limit. | [105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext) |
| **Supplier statements / Vault files** | Not restorable once removed. | [105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext) |
| **Expense claims (the container)** | "The claim itself is **permanently removed and cannot be restored**" — but the member items are **not** deleted; they "are automatically returned to the **Costs inbox**". | [105940](https://help.dext.com/en/articles/105940-how-to-delete-an-expense-claim) |

The expense-claim case is the most instructive. Dext distinguishes **deleting a
grouping** from **deleting the documents in it**, and defaults to preserving the
documents. Deleting a container releases its members rather than cascading. That
is the correct default and Neoting should adopt it explicitly for any grouping
object (batch, submission, claim, export run).

Dext's suggested recovery for a wrongly deleted claim is manual re-creation:
find the returned items via Advanced Search (date, supplier, category, amount)
and re-add them to a new claim
([105940](https://help.dext.com/en/articles/105940-how-to-delete-an-expense-claim)).

### 1.3 Recovery window

- **No time limit or retention window for restoring a deleted Costs/Sales item
  is documented.** ([105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext))
  There is no "recoverable for 30 days" promise of the kind Xero and Google make.
  Treat "indefinite while the subscription is live" as the *implied* behaviour —
  but it is **not verified** as an explicit commitment.

### 1.4 Permanent delete

- **A separate, user-initiated "permanently delete / empty trash" action is not
  documented** in Submission History
  ([105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext)).
  There appears to be no way for a user to purge an item's record on demand.
- **Vendor self-contradiction (flagged):** the Archive article states users can
  delete archived items and that "deletion is permanent and differs from
  unarchiving"
  ([416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext)),
  while the Actions menu and Submission History articles both say deleted items
  remain recoverable
  ([416718](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext),
  [105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext)).
  Most likely reading: "permanent" in the Archive article means *permanent from
  the point of view of the Archive tab* (it will not come back by unarchiving),
  not *irrecoverable*. But Dext's own documentation does not reconcile these, and
  an implementer should not assume either. See §9.

### 1.5 What blocks deletion

- **Published items are not blocked from deletion**, which is the surprising
  part. Dext's model is the reverse: publishing moves an item to the Archive
  ([416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext)),
  and a separate action, **Clear Publishing Data**, exists precisely so that
  "Dext will no longer detect that the item has already been published"
  ([416718](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext)).
  Dext therefore lets users *erase the evidence that an export happened* rather
  than locking the item. Neoting must refuse this (§10).
- **A locked-accounting-period does NOT block delete in Dext — and this is now
  reasonably well established, not merely unverified.** Dext's only lock-date
  feature is the **Lock date history check**, which "tracks changes to lock dates
  in your client's **Xero or QuickBooks Online** account and alerts you when lock
  dates are missing or out of sync with filing dates"
  ([278973](https://help.dext.com/en/articles/278973-using-the-lock-date-history-check)).
  It is a **monitoring/alerting** feature over the *accounting software's* lock
  dates — amber when the Reporting Period Lock Date is outdated or unset, red
  when "Accounts have been filed with Companies House, but End of Year Lock Date
  has not been set in Xero" — and it is gated behind Practice Essentials /
  Practice Advanced plans with the **Data Health & Insights** add-on.
  **Dext has no concept of a period lock over its own documents.** Nothing in
  Dext prevents you from editing, deleting or republishing a document dated
  inside a filed period.

  This is a real gap for a UK practice product, and an opportunity: Neoting
  owning its *own* period lock — one that blocks Approve and Delete on documents
  dated inside a locked period, while never blocking ingest — would be
  differentiating rather than merely competitive. See §10.6.
- Refusal wording — what the product literally says when it declines a delete:
  **not verified**. No help article quotes an error string.

### 1.6 A meta-finding: Dext barely documents delete at all

Repeated searches of the Dext help centre for delete/restore/recover return **no
dedicated article on deleting a Costs or Sales item**. The only articles are
"How to delete an **Expense Claim**"
([105940](https://help.dext.com/en/articles/105940-how-to-delete-an-expense-claim))
and the passing mentions in the Actions menu and Submission History articles.
Compare the Archive, which has **two** dedicated articles.

The entire documented specification of Dext's core delete behaviour is **one
sentence**: "Delete selected items from your inbox. Deleted items remain
recoverable through the Submission History page."

Two implications:

1. Anything in this section beyond that sentence is inference, and is marked as
   such. Do not let the length of this write-up suggest the underlying evidence
   is thick — it is not.
2. **Neoting should document delete better than Dext does.** In a product where
   an accountant is trustee of someone else's statutory records, "what happens
   when I press delete, and can I undo it" deserves a page, not a clause. This is
   a cheap differentiator.

---

## 2. Preview / document viewer

All from the **Item details page**
([105676](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext))
unless stated. Dext does not use a modal lightbox — the preview *is* a full page,
which is a deliberate and, I think, correct choice for a review-heavy workflow.

### 2.1 Layout

- **Side-by-side by default**: document image viewer on the **left**, data
  management tabs on the **right**. Dext describes the page as "a complete view
  of a submitted document and all associated data".
- Right-hand side is **tabbed**: **Details**, **History**, **Messages**, and
  **Item Notes** (notes appear "as its own tab or as a field in the Details tab"
  depending on settings).

### 2.2 Image controls — confirmed present

- **Rotate** left or right
- **Zoom** in and out
- **Download** the image file
- **Full screen**

### 2.3 Image controls — confirmed ABSENT from the documentation

The article does not mention any of the following. Treat as **not verified**, and
specifically do not assume Dext has them:

- **Multi-page navigation** within the viewer (page 1 of N stepper) — not
  verified. This is a real gap in the docs given Dext explicitly handles
  multi-page documents elsewhere (Split, Smart Split).
- **Download as PDF vs download original** as two distinct choices — not
  verified at the item level. Only a single "Download" of the image is
  documented here. (Bulk export *does* distinguish CSV / PDF / ZIP — §3.)
- Next/previous document **buttons** — not verified. But see 2.4: the keyboard
  path exists.

### 2.4 Keyboard shortcuts — next/previous without leaving the viewer

Dext does ship a real reviewer keyboard loop
([551293](https://help.dext.com/en/articles/551293-are-there-keyboard-shortcuts-in-dext)):

| Windows | Mac | Action | Scope |
|---|---|---|---|
| `Ctrl + P` | `⌘ + P` | Publish the current item | Item details (Costs/Sales) |
| `Ctrl + A` | `⌘ + A` | Archive the current item | Item details (Costs/Sales) |
| `Ctrl + J` | `⌘ + J` | Go to the **previous** inbox item | Item details (Costs/Sales) |
| `Ctrl + K` | `⌘ + K` | Go to the **next** inbox item | Item details (Costs/Sales) |
| `Ctrl + Shift + B` | `⌘ + Shift + B` | Collapse/expand sidebar | Anywhere |
| `Shift` + click checkbox | same | Select a **range** of items | Anywhere with checkboxes |

So: **yes, you can move to the next document without leaving the viewer**, via
`Ctrl/⌘ + J/K`. That is the whole review ergonomics story — open one document,
never return to the list.

Two warnings for implementers:

1. Dext has **overridden `Ctrl/⌘ + P` (browser print) and `Ctrl/⌘ + A` (select
   all)**. That is user-hostile. `⌘ + A` inside a text field where an accountant
   wants to select the contents of an amount box, and instead the document
   archives, is a genuinely bad outcome. Do not copy these bindings.
2. `Shift`-click range selection on checkboxes is table stakes and cheap. Copy it.

### 2.5 Actions available from the detail view

Primary action buttons at the top of the page: **Flag**; **Publish / Request
approval / Move to Ready** (a single context-dependent primary action); **Add to
expense claim**; **Split**; **Archive**; **Move to** (Sales, Supplier statements,
Vault, etc.).

Note what is *not* a top-level button: **Delete**. Deletion is a bulk-list verb in
Dext, not a detail-view verb — at least per this article. That asymmetry is
probably deliberate friction; **not verified** as intentional.

Other behaviour:
- **Autosave**: "Any changes you make are saved automatically" in the Details tab.
  There is no explicit Save button and therefore no explicit save ceremony.
- **Role-gated actions**: "You only see actions that are relevant to your role and
  permissions." Admin-only actions include **Extract line items**, **Publish**,
  and **Add to expense claim**.
- **Inline status messaging** for a failed publish or an item rejected during
  approval.

### 2.6 Field inventory (useful as a straw-man schema)

- **Item details**: Document owner, Type, Date, Supplier/Customer, Document
  reference, Category, Description, **Item ID (read-only unique identifier)**,
  Due date (invoices only), Projects/tracking categories.
- **Amount**: Currency, Total amount, Tax and tax amount, Net amount.
- **Payment**: Paid toggle, Payment method, Publish to, Publish as (Xero only).
- **Line items**: extraction, manual creation, customisation, editing.

The read-only, user-visible **Item ID** is worth stealing outright: it is the
handle a bookkeeper quotes to support, and it appears again as a *search filter*
(§4) and as a *Submission History column* (§1). One stable public identifier,
surfaced everywhere.

---

## 3. Bulk operations

### 3.1 The Dext Actions menu — the canonical bulk verb set

The Actions menu appears in the **Costs inbox, Expense claims, and Sales inbox
once you select one or more items**
([416718](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext)).
This is the single most useful artefact in this research: it is the complete,
vendor-blessed list of what an accountant can do to a document from a list.
Verbatim actions:

| Action | Dext's own description | Notes |
|---|---|---|
| **Export** | "Export selected items in different formats" | CSV, PDF, ZIP |
| **Request Approval** | bulk approval requests for multiple items or expense claims at once | ties into approval workflows |
| **Merge** | "Merge 2 or more items into 1" | **Costs and Sales only** |
| **Bulk Edit** | "Bulk edit selected items to update certain fields at once" | e.g. Category across many items |
| **Move to** | move items to another workspace: Sales, Supplier statements, or Vault | see §5 |
| **Send by Email** | "Send selected items by email directly from the inbox" | sends both PDF and CSV to an address |
| **Move to Archive** | "Removes the selected items from your active Inbox and stores them in the Archive" | not a delete |
| **Clear Publishing Data** | removes publish detection so "Dext will no longer detect that the item has already been published" | enables republication |
| **Flag** | "Flag selected items to add visual context in your inbox" | colour + label |
| **Delete** | "Delete selected items from your inbox." | **Deleted items remain recoverable through the Submission History page** |
| **Backup** | push selected documents to connected cloud storage | Dropbox / Google Drive / OneDrive / Everial ([377041](https://help.dext.com/en/articles/377041-how-to-back-up-your-documents-in-dext)) |
| **Add flags / Remove flags** | bulk flag application and removal | ([522481](https://help.dext.com/en/articles/522481-how-to-use-flags-to-organise-your-inbox)) |
| **Unarchive** | bulk restore from the Archive tab | ([416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext)) |

Two structural observations worth carrying into design:

1. Dext separates **Archive** (organisational, reversible, first-class) from
   **Delete** (recoverable, but exiled to a different screen). They are distinct
   verbs in the same menu — a user is never forced to delete in order to get
   something out of the working list.
2. **Clear Publishing Data** exists as an explicit, named, user-facing action.
   Dext models "has been published" as a *flag on the item that can be cleared*,
   not as an immutable fact. See §10 — Neoting should refuse this shape.

### 3.2 Which operations confirm

Sparse evidence, so this is mostly an honest list of gaps:

- **Delete (expense claim)** — **confirmed to have a confirm step**: "Click
  **Actions** at the top, then choose **Delete**. Confirm the action by clicking
  **Delete**"
  ([105940](https://help.dext.com/en/articles/105940-how-to-delete-an-expense-claim)).
  The **exact dialog wording is not documented — not verified.**
- **Merge** — **confirmed**, and it is the richest confirmation in the product: a
  full **merge screen** with document preview and editable combined details, and
  "a warning may appear if items have differing amounts, dates, or users"
  ([416737](https://help.dext.com/en/articles/416737-how-to-merge-items-in-dext)).
- **Unarchive of a published item** — **confirmed**: a two-option prompt
  (Clear publishing data / Keep publishing data) with an explicit duplicate risk
  warning ([416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext)).
- **Clear publishing data** — **confirmed**: the republish flow says "Tick
  *Clear publishing data* and confirm"
  ([416728](https://help.dext.com/en/articles/416728-how-to-republish-an-item)).
- **Publish and Export** — "the documentation does not mention any confirmation
  dialogs or warning messages before publishing or exporting occurs"
  ([416716](https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext)).
  So Dext appears to treat **publish as unconfirmed** while confirming merge and
  delete. For Neoting that is exactly backwards (§10).
- **Delete (Costs/Sales items)**, **Archive**, **Bulk Edit**, **Move to**,
  **Flag**, **Send by Email** — confirmation behaviour **not verified**.

### 3.3 Bulk limits

- **PDF export: up to 250 items per export**
  ([416716](https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext)).
  This is the only hard numeric bulk limit documented anywhere in the collection.
- **ZIP** is recommended "for large batches" and "preserves original file
  formats"; **CSV** supports "default or customizable field formats"
  ([416716](https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext)).
- Maximum multi-select size, and pagination limits: **not verified**
  ([105789](https://help.dext.com/en/articles/105789-the-costs-inbox)).

### 3.4 Publish vs export — Dext's own distinction

Important for Neoting because Neoting uses the word *published* differently
([416716](https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext)):

- **Publish** = "Sends extracted item data along with the document image to your
  connected accounting software (like Xero or Sage). This is a **one-way
  transfer into your accounting system**."
- **Export** = "Downloads items from Dext for storage or sharing elsewhere."

**So in Dext, "published" means "pushed into a ledger" — precisely the meaning
Neoting's glossary forbids.** Anyone reading Dext documentation while building
Neoting must translate: Dext's *publish* ≈ Neoting's *export*; Neoting's
*published* has no Dext equivalent at all (Dext's nearest analogue is the
optional **Ready** state).

**Publish gating**: an item must be **Ready**, which requires three mandatory
fields — **Category, Supplier, Total amount**. Items in **To review** cannot be
published
([416716](https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext)).
A three-field completeness gate before release is a good, cheap, legible rule.

**After publishing**, "a copy of the published item is kept in the Archive tab
for easy reference". Whether published items remain editable or deletable is
**not specified — not verified**.

### 3.5 The republish loop, in full

([416728](https://help.dext.com/en/articles/416728-how-to-republish-an-item))

- On publishing, "Dext attaches a **tag** preventing duplicate publication".
  **Clear publishing data removes this tag.**
- **You cannot republish without clearing publishing data first.** The tag is a
  hard gate.
- Dext's instructions begin with a manual, out-of-band step: "**delete the
  previously published version of the item** [in your accounting software] to
  avoid creating duplicates". The user is asked to reconcile two systems by hand.
- Needed "if an item was published incorrectly, needs changes, or shows an
  error".
- **Permission-gated**: "Only Admin users or those with publishing permissions"
  may do this.

Assessment: the *idea* — a tag that blocks double-release — is right. The
implementation is wrong, because the tag is erasable by the user and the
compensating action in the downstream system is manual and unverified. The
system cannot tell the difference between "this was never published" and "someone
cleared the flag". That ambiguity is fatal for Neoting's source-document
traceability requirement.

---

## 4. Search, filters, sorting, column selection

Sources: [105914](https://help.dext.com/en/articles/105914-how-to-search-through-the-inbox-and-archive)
and [105716](https://help.dext.com/en/articles/105716-managing-table-columns-and-density-in-inbox-archive-and-approvals).

### 4.1 Search

- One box, searching "**across all document fields**" — **including text within
  the document images** (i.e. the OCR layer is indexed, not just the extracted
  fields). This is a meaningful capability bar: a bookkeeper can find a document
  by a word that was never extracted into a field.
- **Matching fields are highlighted in purple** in the results. Cheap, and it
  answers "why did this row match?" without the user asking.
- Handles **partial words and similar matches** (fuzzy).
- The **same search and filter apparatus works on the Archive**: "You can search
  and filter the Archive the same way as your inbox"
  ([416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext)).
  One search implementation, many scopes.

### 4.2 Filters — the standard panel

Dext's filters are overwhelmingly **binary pairs**, which is a distinctive and
copyable pattern: every filter is "has X / hasn't X" rather than a dropdown.

| Dimension | Values |
|---|---|
| Document status | Ready / To review |
| Tax | With tax / Without tax; With tax rate / Without tax rate |
| Category | With category / Without category; Auto-categorised / Manually categorised |
| Currency | Default currency / Foreign currency |
| Read status | Read / Unread |
| Publication | Published / Unpublished |
| Flag | Flagged / Unflagged |
| Ownership | Mine / Not mine |
| Notes | With note / Without note |
| Document state | Merged / Not merged; With duplicates / Without duplicates |
| Payment | Paid / Unpaid |
| Matching | Match / Non-match |
| Billing | Rebillable / Not rebillable |
| Expense claims | Added to expense claim / Not added |
| Quality | **With extraction warnings / Without extraction warnings** |

Note the last one especially. "Show me everything the extractor was unsure
about" is a first-class filter, not a hidden diagnostic. That is exactly the
queue an accountant wants on a Monday morning.

### 4.3 Advanced search — additional dimensions

All of the above, plus: search term (text/phrase within documents), Supplier
name, **Amount (price range)**, **Date / Due date with relative shortcuts
("Last 7 days", "Last 30 days")**, **Upload / Publish / Export dates**, Document
reference, **Item ID**, Type (invoice, receipt, credit note, …), Currency code,
User / Submitted by, **Submission method**, Customer, Projects / Tracking
categories, Category, Expense claim.

Three separate lifecycle timestamps are individually filterable — **upload,
publish, export**. Dext treats these as three distinct events with three
distinct dates. Neoting should too (§10).

**Not verified**: amount-range syntax, **saved searches**, and **sorting**. The
search article does not describe sorting at all, and the columns article
"does not address column reordering, resizing, or sorting capabilities". So:
**Dext's column sorting behaviour is not documented.** Do not assume it exists;
equally do not assume it does not — it is simply unevidenced.

### 4.4 Columns and density

Configured from a **Table settings icon in the top-right corner**, toggling
columns on/off then **Apply**. Applies to **Inbox, Archive, and Approvals**.

- **Default columns**: User, Date, Supplier, Category, Total, Payment, Match,
  Customer, Type.
- **Optional columns**: Submitted by, Due date, Document reference, Base total,
  Description, Tax, Tax rate, Paid, Project/Tracking Category lists, **Item ID**,
  **Submission method**, Note/Message, **Upload date**, **Export date**,
  **Publish date**.
- **Density**: three settings — **Wide / Medium / Narrow**.
- **Per-user, not per-account**: "These settings apply only to your user account
  and won't affect other users in your organisation." Plus a **Reset** button.
- Approvals tab columns **differ based on connected accounting software**.

The per-user persistence and the Reset button are both small and both correct.
Density-as-a-setting is a genuine accessibility/throughput lever for people who
live in this screen eight hours a day.

---

## 5. Organisational features

### 5.1 Archive — a first-class destination, not a synonym for delete

([416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext),
[416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext))

- "The Archive is where Dext stores documents that have been **processed**." It is
  a **tab** inside Costs, Sales, Expense claims and Supplier statements — i.e. the
  Archive is scoped per workspace, not one global bin.
- **Items arrive automatically**, which is the important part. Archiving is
  mostly a *consequence*, not a chore:
  - Costs and Sales items archive **after publishing**
  - Costs items archive when **added to an expense claim**
  - Supplier statements archive when **marked as reconciled**, or manually
  - **Optionally, items auto-archive after CSV/PDF export** — admin-configurable
- **Unarchive exists.** But: "if connected to accounting software, unarchiving
  published items prompts decisions about clearing publishing data." So Dext
  couples un-archive to the publish-state question and asks the user. That prompt
  is the right instinct (don't silently resurrect a published item) attached to
  the wrong answer (offering to forget the publish).
- **Fully searchable/filterable, same as the inbox.**
- Archiving is configurable at
  **Business settings → Automation → Archiving**, with independent toggles for
  archive-after-publish, archive-after-adding-to-expense-claim, and
  archive-after-CSV/PDF-export
  ([416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext)).
- **Manual archive**: tick the checkbox in the Inbox and select **Archive**, or
  use the Archive button on the item details page. **Unarchive** works the same
  way from the Archive tab and **supports bulk**
  ([416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext)).

**The unarchive prompt, in full** — this is the one place Dext confronts the
publish-state problem head-on. Unarchiving a published item connected to
accounting software offers exactly two options
([416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext)):

1. **Clear publishing data** — "Allows republishing as a new transaction but
   **may create duplicates in your accounting system**"
2. **Keep publishing data** — "Prevents republishing and displays a publishing
   error"

Dext is being honest here: it tells the user the first option risks duplicating
the transaction downstream. But it still offers it, and it makes the *user*
adjudicate a data-integrity question at 4pm on a Friday. §10 argues Neoting
should not put this choice in front of anyone.

Whether archived items can be **edited**: **not verified**. Whether they can be
**deleted**: the Archive article says yes and calls it permanent
([416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext));
the archive/unarchive article "does not specify" — see the contradiction in §1.4
and §9.

### 5.2 Flags — shared, labelled, filterable, bulk-appliable

([522481](https://help.dext.com/en/articles/522481-how-to-use-flags-to-organise-your-inbox))

- **Five coloured flags.** "Orange is enabled by default and can't be switched
  off. All other colours are hidden until you toggle them on."
- Each flag has **a colour, a customisable label, and a visibility toggle**.
  Admin-authored labels are the point: examples Dext itself gives are
  **"Waiting on client response"** and **"Do not process"**.
- **Account-wide, not per-user.** Only Admins configure them in Business
  settings, but "**all users can add and remove flags on items**". This is the
  right split: a *controlled vocabulary* set by the practice, freely *applied* by
  staff. Compare free-text tags, which decay into synonyms within a month.
- **Filterable** via Advanced search; "only flags set to visible appear as filter
  options".
- **Bulk apply and bulk remove**, via "Add flags"/"Remove flags" in the Actions
  menu.
- Coverage caveat: custom colours apply only to Costs and Sales — "the expense
  claims inbox only shows the orange flag".

### 5.2b Tags and folders — they exist, but only in Vault

Important correction to the obvious reading: **Dext does have tags and folders,
but not in Costs or Sales.** They are a **Vault** feature
([339544](https://help.dext.com/en/articles/339544-how-to-use-vault-in-dext)):

- **Folders**: users create custom folder structures.
- **Tags**: "Tags help you classify and locate your files faster." Tags support
  **auto-apply rules** and **descriptions**, and **practice users can create
  reusable tag templates** across clients.
- Vault holds documents that are not transactions — insurance, tax filings,
  engagement letters, MOTs, tenancy agreements, payroll documents, year-end bank
  statements. **Max 100MB per file**; overall storage cap **not verified**
  (a "Using Vault: Upgrade Storage and AI Credits" article implies paid
  expansion).
- **No data extraction from Vault files is documented — not verified.**
- Vault files can be **flagged or deleted**, but §1.2 establishes they are
  **not restorable** from Submission History. Deleting a Vault file is the most
  dangerous single action in Dext, and it has the least documentation.

So Dext's real organisational split is: **transactional documents get flags
(controlled vocabulary), non-transactional documents get folders and tags (free
form).** That is a defensible line, and it maps onto Neoting: transaction
documents feeding export need a disciplined vocabulary; a client's engagement
letter does not. Reusable **tag templates across clients** at the practice level
is a good idea worth stealing if Neoting ever adds a non-transactional store.

Within Costs and Sales there is **no free-text tag system** — flags and notes
only.

### 5.3 Notes and messages — two different things

- **Item Notes**: a tab or Details-tab field
  ([105676](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext)),
  and filterable via **With note / Without note**, with a **Note/Message**
  column available (§4).
- **Item Messaging** is separate and is the client-query channel
  ([416724](https://help.dext.com/en/articles/416724-how-to-use-item-messaging-in-dext)):
  - Accountants and bookkeepers **initiate**; the **document owner** receives.
  - **Hard dependency**: "You can only send a message if the document owner has
    the **Dext mobile app installed**." Delivery is push notification plus an
    in-app bell/Communications screen.
  - The Messages tab is "only available to accountants and bookkeepers and the
    client accounts they manage".
  - Whether messages appear in the item audit trail: **not addressed / not
    verified**. Whether you can filter the inbox specifically by "has message":
    **not verified** (there is a Note/Message *column*, and a With/Without *note*
    filter, but the article does not confirm a message-specific filter).

**Assessment**: tying the only query-back-to-client channel to a mobile app
install is a serious design defect. It means the feature is unavailable for
exactly the documents that most need querying — the ones a client emailed in and
then forgot about. Do not copy this.

### 5.4 Duplicate detection

([216124](https://help.dext.com/en/articles/216124-how-dext-handles-duplicate-cost-documents))

Detection keys, which differ by document type — worth copying near-verbatim:

- **Receipts**: Supplier **+** Date **+** Total amount **+** Document owner (all
  must match)
- **Invoices and credit notes**: Supplier **+** Total amount **+** Document
  reference (all must match)
- Honest caveat in Dext's own words: "If key fields (such as invoice number or
  date) are missing from one of the items, Dext may not recognise them as
  duplicates."

Three configurable modes:

| Mode | Behaviour |
|---|---|
| **Automatic** | "Suspected duplicates are **automatically deleted** once detected", removed from the inbox, visible only in Submission History |
| **Review** | "Suspected duplicates are flagged in the Costs inbox with an **amber duplicate icon**"; user compares **side-by-side** |
| **Off** | No duplicate checking |

In Review mode the user chooses **"No, it's a different purchase"** (keep both)
or **"Yes, it's the same purchase"** and then either **delete the duplicate** or
**"Attach image to original purchase"**.

Two things stand out:

1. **Automatic mode auto-deletes without asking.** That is only tolerable
   *because* delete is recoverable and Submission History retains the record. The
   two design decisions are load-bearing on each other. If you copy auto-dedupe,
   you must first copy the recoverable-delete ledger.
2. **"Attach image to original purchase" is not a merge.** Dext's own dedupe flow
   does not produce a merged item; it attaches the duplicate's image to the
   original. The docs "don't describe a traditional merge function" here. So Dext
   has *two* different consolidation verbs for two different situations.

Restoring a deleted duplicate "**does not remove or affect the original item**".

### 5.5 Merge — real, and reversible

([416737](https://help.dext.com/en/articles/416737-how-to-merge-items-in-dext))

- **2 or more** documents, in Costs or Sales.
- "The final merged item will contain **every page** from the selected
  documents." **Selection order determines page order** in the merged document.
- **Confirmation screen** with a document preview and editable combined details
  (Type, Date, Supplier, Category, Total amount) before committing. **A warning
  appears if items have differing amounts, dates, or users** — i.e. Dext warns on
  semantic mismatch, not just on the action.
- **Losing items are not destroyed**: they "move to the Submission history with a
  **Merged** status" and leave the active inbox.
- **Undoable**: "You can undo a merge from the merged item's details page" via
  **Unmerge**, separating it back into individual entries.
- Restrictions: both items in the same inbox; should relate to the same
  transaction. Restrictions on merging **published** items: **not verified**.

This is the best-designed operation in the product: destructive-looking,
actually non-destructive, with a mismatch warning and a named inverse.

### 5.6 Split — an *amount* split, NOT a page split

([416731](https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext))

This is the single easiest thing to get wrong when reading about Dext, so it is
worth stating flatly:

- **Split divides one item into two items for coding purposes.** It does **not**
  cut a multi-page PDF into separate documents.
- "**Both items keep the full document image from the original**" — the image is
  duplicated, not divided.
- Per-item you may set: **Category, Product/Service (current item only), Total
  amount, Tax amount**. Every other field copies from the original.
- The original **stays in the inbox**.
- "Undo" is manual and crude: **delete the new item created by the split**.
  There is no `Unsplit` verb to match `Unmerge`. Asymmetric.
- Restrictions on splitting published items: **none described / not verified**.

Related but distinct: **Smart split**
([416726](https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext))
— not fetched in detail; **not verified**.

### 5.7 Move between workspaces / clients

- The **Move to** action (bulk and detail-view) moves items to **Sales, Supplier
  statements, or Vault**
  ([416718](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext),
  [105676](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext)).
  This is a move between **document types within one client**, not between
  clients.
- Precise destinations
  ([416734](https://help.dext.com/en/articles/416734-how-to-move-items-between-workspaces-in-dext)):
  - **Costs** items → Sales, Supplier statements, or Vault
  - **Sales** items → Costs or Vault
- **Moving an item between two different client businesses/accounts is NOT
  documented and is `not verified`.** The article titled "How to move items
  between workspaces" does not address cross-client transfer at all. Given
  Dext's per-client data separation, assume it is unsupported (or a support-only
  operation) unless proven otherwise. **Do not build against a Dext precedent
  here — there isn't one.**
- Billing side-effect worth noting as a design pattern: "**Moving a costs item
  to Supplier statements incurs supplier statement extraction charges**". A move
  can cost money, so the destination matters commercially, not just logically.
- Also **not verified**: whether published or archived items can be moved,
  whether any data is lost in the move, and whether a move is reversible.

### 5.7.1 The Costs workspace structure

([105789](https://help.dext.com/en/articles/105789-the-costs-inbox))

Four standard sections plus two optional ones — a useful information
architecture to steal:

| Section | Contents |
|---|---|
| **Inbox** | Items awaiting publication, export, or review |
| **Processing** | Documents currently being handled, **with estimated time remaining** |
| **Approvals** | Documents awaiting approval (if enabled) |
| **Archive** | Published or manually archived items |
| *To review* (optional) | "Documents missing required details (usually the *Category* field)" |
| *Ready* (optional) | "Documents that have all necessary details and are ready to be published" |

**Processing as a visible, first-class section with an ETA** is the standout.
Extraction latency is made honest and legible instead of being hidden behind a
spinner. Copy this.

Default Costs inbox columns per this article: **Status** (viewed / edited /
publication-ready), **User**, **Date** (invoice date, falling back to submission
date), **Supplier**, **Category** (editable inline via dropdown), **Total**,
**Tax**. Note **inline row-level category editing** — the single most repeated
action gets an inline control rather than requiring the detail page.

**Pagination limits and maximum multi-select quantity: not verified.** The
documentation does not state a cap on how many items may be selected or bulk-
actioned. Do not assume "unlimited" — assume you must decide this yourself.

### 5.8 Assign to a reviewer / approvals

Dext has a genuine approval workflow layer
([219981](https://help.dext.com/en/articles/219981-how-to-set-up-approval-workflows-for-cost-and-sales-documents),
[689612](https://help.dext.com/en/articles/689612-how-to-review-and-approve-documents-in-dext),
[689941](https://help.dext.com/en/articles/689941-how-do-approval-permissions-work-in-dext),
[754283](https://help.dext.com/en/articles/754283-how-to-request-approval-for-costs-and-sales-documents-in-dext)),
including an **Approvals tab** with its own columns (§4.4), **Request Approval**
as a bulk action (§3), approval **reminders**
([600485](https://help.dext.com/en/articles/600485-how-to-set-up-approval-reminders-in-dext)),
and workflow **priority** rules
([690088](https://help.dext.com/en/articles/690088-how-approval-workflow-priority-works-in-dext)).
Rejection is a real state — the item details page shows a status message when an
"item is rejected during approval"
([105676](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext)).

Mechanics of the approver's screen
([689612](https://help.dext.com/en/articles/689612-how-to-review-and-approve-documents-in-dext)):

- Approvers work from the **Approvals tab** in the Costs or Sales inbox, which
  **defaults to "Assigned to me"** and can be switched to **"All items"**. A
  personal queue by default, with an escape hatch — exactly right.
- Actions: **Approve** and **Reject**, both **individually or in bulk**;
  **Cancel approval request** (Admins only), which "returns the item to the
  Inbox"; and **Export** items without completing the approval flow.
- **Approvers can edit some fields during approval** if an Admin enables it, via
  **Edit details** — document owner, type, date, category and others — but
  "**Approvers can't edit a document's line items during the approval stage**".
- **Once approved, "its details can't be edited."** This is the one place Dext
  makes a state genuinely immutable, and it is the single most Neoting-compatible
  behaviour in the product.
- Whether a **reason or comment is required on rejection**: **not verified** —
  the article does not say. Given how much a UK practice needs the audit trail on
  a rejection, treat this as a gap in Dext rather than a model to copy.

**Caution**: "Export items without completing the approval flow" is an approval
bypass. Neoting must not have an equivalent.

### 5.8.1 To review / Ready — the readiness gate

([416750](https://help.dext.com/en/articles/416750-what-do-to-review-and-ready-mean-in-dext))

- **To review** = "Dext has detected something missing or incorrect on the item".
  Typical triggers: missing category, supplier, or total amount; **line item
  discrepancies**; **duplicate documents**.
- **Ready** = validation passed; the item may be published, exported or archived.
- **Ready has two colour variants, and the second is clever**:
  - **Green** — all requirements met
  - **Yellow** — "Dext validation passed, **but a previous accounting software
    export attempt failed**"

  A single status chip carrying both *internal readiness* and *last outbound
  attempt outcome* is a genuinely good piece of design. Steal it.
- Transition is **automatic** on completing the flagged fields. Where there is no
  accounting integration, users can manually **Move to ready** / **Move to
  review**.
- Both tabs are **optional** and must be enabled at **Business settings →
  Extraction → Inbox tabs → "Show To review and Ready tabs"**.
- Which fields are universally mandatory is deliberately **not** fixed —
  "issues are context-dependent and displayed via **tooltips**" on the item.

### 5.9 Re-run extraction

- **"Extract line items"** is an explicit, **admin-only** button on the item
  details page
  ([105676](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext)),
  i.e. extraction can be invoked on demand after the fact, not only at ingest.
  See also Line Item Extraction
  ([377044](https://help.dext.com/en/articles/377044-how-to-use-line-item-extraction-in-dext)).
- A general **"re-run the whole extraction / re-OCR this document"** action:
  **not verified**. **Boost**
  ([106031](https://help.dext.com/en/articles/106031-what-is-boost-in-dext))
  concerns processing speed, not re-extraction.
- **Tax extraction can be toggled on/off**
  ([416733](https://help.dext.com/en/articles/416733-how-to-turn-tax-extraction-on-or-off-in-dext)).

---

## 6. Retention and expiry

### 6.1 There is no "expiring document" concept in Dext

Searching the Dext help centre for expiry/expiring/auto-deletion returns nothing
of the kind. **Dext does not appear to have any notion of a document that
expires, ages out, or is auto-purged after N days while the subscription is
live.** Documents persist until a human archives or deletes them, or the
subscription ends. Recorded as an absence, not a certainty — but nothing in the
help centre suggests otherwise.

### 6.2 While the subscription is active

Two statements, from two places, and they do not fully agree:

- **"At least 10 years"**: Dext "stores documents **for at least 10 years while
  your subscription is active**", accessible in either the Inbox or Archive
  ([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules)).
- **"As long as the subscription is active"**: "Your archived documents remain
  accessible **for as long as your Dext subscription is active**"
  ([416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext)).

The second is weaker than the first. Neither is contractual — see 6.4.

### 6.3 HMRC / tax-authority framing — Dext does market this

([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules))

- Dext says it "complies with tax authorities that accept digital records as
  valid evidence of transactions", **naming HMRC (UK), ATO (Australia), CRA
  (Canada), IRD (New Zealand) and IRS (USA)**.
- "Receipts, invoices, and other financial records stored in Dext **can be used
  as supporting documentation where digital record-keeping is accepted**."
- But the framing is carefully hedged, and the hedge is the interesting bit:
  "**Always confirm the specific record-keeping requirements that apply to your
  business with your accountant or local tax authority.**"

Read carefully, Dext claims *the format is acceptable*, not *we are your
compliant archive*. That is the right liability posture and Neoting should adopt
the same distinction in its copy.

### 6.4 On cancellation — the sharp edge

This is where the retention story turns dangerous, and it is the part most users
will not have read:

- Help centre: users should "**download your data before the account is
  closed**"; Dext "reserves the right" to "**permanently delete your account
  data 10 days after the subscription ends without further notice**"
  ([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules)).
- Terms and Conditions, **Schedule 1, clause 6.5(f)**: "We may destroy or
  otherwise dispose of any of the Customer Data in Our possession, **unless We
  receive, no later than ten days after the date of the termination of this
  Agreement, a written request** for the delivery to You of the then most recent
  back-up of the Customer Data." Dext will then "use reasonable commercial
  endeavours to deliver the back-up **within 30 days**", conditional on all fees
  being paid
  ([terms](https://dext.com/en/terms-and-conditions)).
- The Terms contain **no minimum retention commitment** and no 6- or 7-year
  HMRC-aligned guarantee.

So the actual, contractual retention guarantee is: **ten days after termination,
and only if you write in.** The "at least 10 years" figure is a marketing
statement about active subscriptions, not a durable commitment. A UK practice
relying on Dext as its statutory record store is relying on something Dext has
not promised.

### 6.5 Do not confuse this with the Privacy Policy's six years

The privacy policy states: "**By law we have to keep basic information about our
customers (including Contact, Identity and Transaction Data) for six years after
they cease being customers for tax purposes** or after we were last in contact
with you" ([privacy policy](https://dext.com/en/privacy-policy)).

That six-year period covers **Dext's own customer/billing records**, not the
client's uploaded receipts and invoices. Conflating the two would be an easy and
serious mistake.

### 6.6 Backup as mitigation

Dext offers document backup to external cloud storage
([377041](https://help.dext.com/en/articles/377041-how-to-back-up-your-documents-in-dext)):

- **Backup all** — pushes all Costs and Sales documents to a cloud provider
  immediately
- **Autobackup** — "automatically back up any new documents submitted to Dext
  going forward"
- **Per-document** — select items in the inbox or archive → Actions → **Backup**
- Destinations: **Dropbox, Google Drive, Microsoft OneDrive, Everial Digital
  Expert** ("OneDrive and SharePoint work together")
- Export file formats, size limits and quantity limits: **not verified**
- Notably, Dext does **not** frame this as recommended practice — it is
  presented as an optional feature, despite §6.4 making it close to essential.

---

## 7. Audit trail

### 7.1 Per-document: the History tab

The Item details page carries a **History tab** described as a "**Full audit
trail for the item, including who submitted the document, changes made to
fields, publishing, approval, and archiving actions**"
([105676](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext)).

That single sentence is the whole documented scope. It gives five event classes:

1. submission (who submitted, implicitly when and how)
2. **field-level changes** — note: changes to fields, not merely "item edited"
3. publishing
4. approval
5. archiving

Explicitly **not verified**: whether the History tab records **deletion** and
**restore**, whether it records **merge/split**, whether it shows before→after
values or only that a field changed, whether entries are exportable, and whether
there is any tamper-evidence. Given delete is recoverable from Submission
History rather than from the item, it is plausible the delete event lives in the
Submission History record rather than the item History — but that is
**not verified**.

### 7.2 Account-level: Submission History as the ingest ledger

Separate from per-item history, **Submission History** is the account-wide
record of every document ever submitted, surviving every status change
([105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext)).
Columns: **Status, Item ID, Submitted at, Submitted by, Submission method, Owned
by, Date, Supplier, Customer, Total amount, Workspace, Action.**

`Submission method` is a column worth noting — Dext treats *how* a document
arrived (email-in, mobile app, upload, fetch, integration) as first-class
queryable metadata, not an implementation detail.

### 7.3 Who can see it

- "**All users can access Submission history**", but scoped:
  ([105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext))
  - **Standard users see only their own submissions** by default.
  - **Standard users with the "Access all documents" permission** see all account
    items.
- Visibility of the per-item **History tab** by role: **not verified**.
- The **Messages tab is restricted** — "only available to accountants and
  bookkeepers and the client accounts they manage"
  ([105676](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext)).

The pattern — *everyone gets an audit view, but the default row filter is "mine",
and seeing everyone else's is a named permission* — is a good one and maps
cleanly onto row-level security.

### 7.4 The permission model behind it

([215320](https://help.dext.com/en/articles/215320-roles-and-permissions-in-dext))

Two role hierarchies, which matters for a practice product:

- **Practice roles**: **Practice Admin** ("full access across the practice and
  the practice's own business account"); **Client Admin** (default access to all
  client accounts; can manage Standard Users and other Client Admins; cannot
  create/suspend Practice Admins or manage practice subscriptions); **Standard
  User (Practice)** ("can only view assigned clients", no practice settings or
  Team page).
- **Business roles**: **Business Admin** (full access incl. users, settings, all
  documents, subscriptions); **User Admin** (manages all documents and most
  settings, but not Business Admins or subscriptions); **Standard User**
  ("view/edit only their own items by default").

The **named optional permissions** are the interesting part, and they are worth
copying as a vocabulary:

- **"Access all documents"** — view and edit all users' items (the row-level
  scope switch)
- **"Manage the practice's business"**
- **"Create expense claims"**
- **Publishing permissions**, as a three-way enum: **publish all / expense claims
  only / cannot publish**

That last one is the model to copy: release capability is not a boolean, it is a
graded enum. Neoting's Approve/Release should be the same shape.

**Not addressed by Dext's own roles article — all `not verified`:** permissions
for **deleting documents**, for **approving items**, for **exporting**, and for
**viewing audit trails / submission history**. For a product sold to accounting
practices, the absence of a documented *delete* permission is a striking gap.
Neoting should have an explicit, named delete permission from day one.

---

## 8. Vendor comparison: Hubdoc, AutoEntry, Xero Files

### 8.1 AutoEntry (Sage) — the opposite philosophy to Dext

All URLs verified 2026-09-02 against the Intercom help centre at
https://help.autoentry.com.

**Delete: hard, two-step, and irreversible.** This is the single biggest
divergence from Dext in this whole document.

- Deletion is **Reject first, then delete from the Rejected tab** (Inbox → tick →
  Actions → Reject → open Rejected tab → trash icon)
  ([4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement)).
- "**Once you delete a document, you can't retrieve it.**" And: "AutoEntry can't
  retrieve this upload for you after deletion"
  ([4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement),
  [8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice)).
  **There is no bin for processed documents.**
- **A Recycle bin exists, but only in File Management** — the pre-extraction
  staging area. Deleted FM files can be restored to their original folder via
  Actions → Restore; deleting from the Recycle bin is irreversible. **No
  retention period is documented**
  ([15262062](https://help.autoentry.com/en/articles/15262062-recycle-bin-in-file-management)).
  So AutoEntry protects documents *before* you spend money on them and stops
  protecting them after.
- **Rejection reasons are mandatory**, from a picker: *Already in Software
  Accounting Package / Duplicate / Uploaded in error / Uploaded into incorrect
  folder / Other (free text)*, then a confirm
  ([8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice)).
  **AutoEntry beats Dext here** — Dext does not document a required reason
  anywhere. Neoting should copy AutoEntry's mandatory reason picker (see §10 B6).
- **Blocked while processing**: "You can't delete or cancel a document while the
  upload or processing is in progress"
  ([4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement)).
- **Blocked while published**: the reject flow requires the invoice be
  unpublished first. Published → Unpublish → Reject → Delete
  ([8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice)).
  **This is a genuine published-item delete guard — Dext has none.**
- **No bulk delete**: "You can't select multiple invoices within the Rejected
  folder. You can only delete one invoice at a time"
  ([4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement)).
  Deliberate friction on the irreversible act.
- **Expenses** are deletable directly (Actions → Delete) but "cannot delete
  expenses that are in reports" — remove from the report first
  ([8937708](https://help.autoentry.com/en/articles/8937708-delete-an-expense)).
- **Bank statements cannot be deleted by users at all** — support must do it.
  Mid-processing support deletion incurs no credit charge; after approval,
  support can only reject "if you make the request on the same day"
  ([11653802](https://help.autoentry.com/en/articles/11653802-delete-a-bank-statement)).
- **Delete a company** destroys all its documents permanently, requires the
  billing user, prior disconnection from the accounting software, and a
  checkbox acknowledgement; "we have no way of recovering the data", and the
  docs tell the user to check local legal retention requirements first
  ([1312910](https://help.autoentry.com/en/articles/1312910-delete-a-company)).

#### 8.1.0 AutoEntry delete, re-verified and extended (2026-09-03)

Re-fetched from live Intercom articles via the discovery endpoint in Appendix B.
**Every delete claim above survived re-verification**, and the live articles carry
`lastUpdatedDate` values that show the KB is current (delete-an-invoice
2025-07-25, delete-a-bank-statement 2025-08-19, recycle-bin 2026-05-26,
delete-an-expense 2026-06-08, delete-my-account 2026-08-12). Six additions:

**1. The full path from a normal document to gone, with the required
intermediate states.** There is no one-step delete for an invoice or supplier
statement. The complete gate sequence is:

| # | Gate | Enforced how | Source |
|---|---|---|---|
| 0 | Must not be uploading or processing | "You can't delete or cancel a document while the upload or processing is in progress" | [4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement) |
| 1 | Must be **status Ready** / processed | "It's possible to delete invoices or supplier statements once the status is ready and after the system processed it" | [4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement) |
| 2 | Must be **unpublished** | "Make sure the invoice is **unpublished**" is step 1 of Reject | [8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice) |
| 3 | Must be **Rejected**, with a **reason** | Inbox → tick → Actions → Reject → pick a reason → confirm; item moves to the **Rejected** tab | [8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice) |
| 4 | Delete, **one at a time**, from the Rejected tab | "Click the rubbish bin icon"; "You can't select multiple invoices within the Rejected folder. You can only delete one invoice at a time" | [4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement) |

So **Rejected is a required intermediate state, not an optional one**, and it is
the closest thing AutoEntry has to a trash — except that it is a *workflow*
state carrying a business meaning ("we are not booking this"), which is a
different thing from "the user pressed delete". Conflating the two is a design
error Neoting should avoid: rejection is a decision about the document, deletion
is a decision about the record.

**A reason IS captured, and it is mandatory**, from a fixed picker — *Already in
Software Accounting Package / Duplicate / Uploaded in error / Uploaded into
incorrect folder / Other* — where **Other opens a free-text field**
([8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice)).
Note carefully: the reason is attached to the **Reject**, not to the **Delete**.
By the time the destructive act happens the reason has already been given, and
nothing records why the row was then destroyed.

**2. Bulk delete: still no, and now doubly confirmed.** Not in the Rejected tab
(verbatim above). The bulk verb list in the Inbox — Publish/Approve,
Unpublish/Unapprove, Move, Archive/Unarchive, Reject, Download — contains no
Delete
([11910976](https://help.autoentry.com/en/articles/11910976-inbox-overview)).
**The one place bulk delete does exist is the File Management Recycle bin**
(next point), i.e. only for files that were never extracted.

**3. The Recycle bin offers three actions, not one — including Download.** From
the live article
([15262062](https://help.autoentry.com/en/articles/15262062-recycle-bin-in-file-management),
revised 2026-05-26), the Recycle bin is reachable "from the company's homepage…
within the File management panel" or "from any folder within the File management
folder", and offers, each via tick-boxes + **Actions**:

- **Restore** — "you can restore it back to its **original folder**". So
  AutoEntry *does* remember the origin. **This is strictly better than Hubdoc's
  drag-and-drop-anywhere restore** (§8.2.0) and better than nothing at all, which
  is what AutoEntry offers for processed documents.
- **Download** — "allows you to export and back up your data on your personal
  device **before you delete it permanently**". A deliberate escape hatch on the
  irreversible path, and a good idea.
- **Delete permanently** — "⚠️CAUTION: This action is irreversible. Once you
  delete a file from the Recycle bin, you can't restore it", reinforced by "You
  can't restore a file that you deleted from the Recycle bin."

All three are **multi-select** ("Tick the checkboxes to the left to select one or
more files"). **So AutoEntry allows bulk permanent destruction of un-extracted
files while forbidding bulk deletion of extracted ones** — the friction is
allocated by *how much money was spent*, not by how much data is at risk.

**No expiry is published for the Recycle bin.** Re-checked 2026-09-03 against
the live article: no day count, no auto-purge, no "kept for N days". **Not
verified — and consistent with all four vendors** (§8.4).

**4. Bank statements: a user cannot delete one, and the only workaround is
destructive.** Verbatim: "**Users can't delete an individual uploaded bank
statement.**" The route is a support request quoting the Document ID, and what
support can do depends on stage — *Delete* while the upload is still in progress
(no credits charged), or *Reject* once complete and approved "**but only if you
make the request on the same day**… The team won't be able to reject bank
statements the day after upload."

The addition this document did not previously record is the workaround, and it is
alarming:

> "📎NOTE: The only way for a user to delete a bank statement is to **delete the
> bank account in AutoEntry that it's associated with. However, this will delete
> all other bank statements associated with the account.** We don't recommend
> doing this, and we can't retrieve any deleted data."
> — [11653802](https://help.autoentry.com/en/articles/11653802-delete-a-bank-statement)

**A product that offers no way to delete one row therefore pushes users into
deleting the whole account.** That is the canonical argument for shipping a
scoped delete: withholding it does not prevent destruction, it just makes the
destruction bigger. Neoting's bank-statement objects (ID: D40 makes manual
statement upload the only bank input) must have a per-statement delete for
exactly this reason.

**5. Expense delete is blocked by report state, with a verbatim refusal.** The
on-screen message is:

> "**Warning! Cannot delete expenses that are in reports**"
> — [8937708](https://help.autoentry.com/en/articles/8937708-delete-an-expense)

and the article documents a full unwind matrix by report status — **Open**:
submitter removes the expense from the report; **Submitted**: submitter reopens
the report from the Reports tab, then removes it; **Pending**: the *approver*
must reject it from the Review tab before the submitter can reopen; **Rejected**:
submitter reopens, removes, then deletes. This is a genuine
**approval-status-blocks-deletion** guard, and the escalation to the approver in
the Pending case is the right shape.

Two further blocks worth recording, because they are *identity*-shaped rather
than *state*-shaped: "If the **submitter no longer has access to the account**,
it's not possible to delete the rejected expenses", and if the **approver** has
lost access, pending/submitted expenses cannot be unblocked either — "in both
cases, you need to contact support"
([8937708](https://help.autoentry.com/en/articles/8937708-delete-an-expense)).
**Deleting is coupled to a live user account**, so offboarding a person strands
their documents. Neoting must not tie the ability to unwind a workflow to the
continued existence of a particular user.

**6. Contacts, companies and the account itself.** Contacts are deletable only
when the company is **not** integrated with accounting software — "the manual
options to create or delete contacts aren't available when integrated", and the
suggested alternative is to **hide** the contact instead
([12951570](https://help.autoentry.com/en/articles/12951570-delete-a-contact)).
*Hide-instead-of-delete for master data is the right instinct.* Whole-account
deletion is a documented four-step manual process — cancel subscription →
disconnect integrations → delete or transfer every company → email support — and
"If you're not the billing administrator… you'll need to provide an official
request **on the company letterhead, signed by the company director**"
([11992496](https://help.autoentry.com/en/articles/11992496-delete-my-autoentry-account),
revised 2026-08-12). **There is no self-service account deletion in AutoEntry.**

**Which roles are blocked from deleting: not verified.** AutoEntry documents
permission *templates* and per-folder access
([1893627](https://help.autoentry.com/en/articles/1893627-permission-templates),
[11991722](https://help.autoentry.com/en/articles/11991722-access-and-permission-settings)),
and names the **billing user** as the only one who may delete a company
([1312910](https://help.autoentry.com/en/articles/1312910-delete-a-company)), but
no article maps a role to a document-delete right. **Whether a lock date or
period lock blocks deletion: not verified — AutoEntry documents no lock-date
concept at all.**

**Credits — a cost dimension Dext does not have at all.** This is the most
interesting AutoEntry-specific finding and it explains the whole delete design:

- **Rejected invoices still cost credits**: "There's a charge for rejected
  invoices as there has been an attempt to process them" (not applied to rejected
  bank statements)
  ([1312979](https://help.autoentry.com/en/articles/1312979-rejected-invoices)).
- **Deleting refunds nothing**: delete by mistake and "you must reupload it.
  There will be another charge for the reupload"
  ([4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement)).
- **Duplicate charging depends on the stage that catches it**: at upload = free
  (unless you click "Process Anyway"); at extraction = charged; at publishing =
  charged
  ([6783974](https://help.autoentry.com/en/articles/6783974-duplicate-check-for-invoices)).
- Pricing: 1 credit/invoice, 2 with line items; 1/receipt; 2/supplier statement;
  3/page for bank statements
  ([6007778](https://help.autoentry.com/en/articles/6007778-autoentry-credits-explained)).
- **Credits themselves expire**: 90 days after purchase (even if the subscription
  is paused), 30 days after cancellation
  ([15705158](https://help.autoentry.com/en/articles/15705158-manage-autoentry-credits)).

*Lesson for Neoting*: metering per document makes delete expensive and therefore
scary, which forces a hard-delete, no-bulk, high-friction design. If Neoting ever
meters ingest, that pricing choice will silently dictate the document-management
UX. Decide the pricing model before finalising delete semantics.

**Preview**: thinner than Dext.
- Download is **PDF only from the viewer** (button bottom-right); the original
  format is not offered there, and downloaded PDFs are renamed "AutoEntry
  Invoice"/"Sage Invoice" + DOC ID because the file is reprocessed
  ([4704597](https://help.autoentry.com/en/articles/4704597-download-a-pdf-copy-of-your-document)).
  Originals download from the Activity tab's Uploaded Files list
  ([1312938](https://help.autoentry.com/en/articles/1312938-activity-tab-in-a-folder)).
  **AutoEntry does draw the original-vs-PDF distinction Dext does not — but it
  splits them across two screens.**
- **Line-item expanded view**: a four-arrow icon opens full screen with the image
  in the top half, line items below, **and a slider to resize the split**
  ([1312981](https://help.autoentry.com/en/articles/1312981-line-item-extraction)).
  The resizable split is a nice touch Dext lacks.
- **Rotate: web viewer not verified** — rotate is documented only in the mobile
  app at capture time
  ([13186041](https://help.autoentry.com/en/articles/13186041-mobile-application-crop-and-rotate)).
- **Keyboard shortcuts: not verified / apparently absent.**
  **Next/previous in viewer: not verified.** **Multi-page navigation: not
  verified.** **General zoom: not verified.**

**Bulk operations**: Publish (integrated) or Approve (standalone),
Unpublish/Unapprove, Move (folder/company), Archive/Unarchive, Reject, Download
(CSV / "Generic Excel" which embeds a shareable image link per row)
([11910976](https://help.autoentry.com/en/articles/11910976-inbox-overview)).
Select-all checkbox selects every displayed item. **Delete is the one operation
that is not bulk.**

**Search/filters/columns**: markedly thinner than Dext. Inbox filters by **date
range** plus keyword search across "Supplier account name, Supplier name, Amount
(Net, VAT, or Total)"; the Purchases inbox adds a status filter (All / Published
/ Unpublished / Matched / Unmatched)
([11910976](https://help.autoentry.com/en/articles/11910976-inbox-overview)).
Archived tab filters by Status, Date, keyword
([1312926](https://help.autoentry.com/en/articles/1312926-manage-archived-documents)).
**Column customisation: not verified. Sorting: not verified.** Like Dext,
AutoEntry supports **inline list editing** — Supplier, Customer, Tax code and
Category via row dropdowns
([11910976](https://help.autoentry.com/en/articles/11910976-inbox-overview)).

**Organisational features**:
- **Archive** with an **Auto-Archive after publishing** option — same idea as
  Dext ([4729991](https://help.autoentry.com/en/articles/4729991-archive-a-document),
  [1313066](https://help.autoentry.com/en/articles/1313066-auto-archive-invoices)).
- **Move between folders AND companies** — so **AutoEntry does support
  cross-company movement, which Dext does not document**
  ([1312917](https://help.autoentry.com/en/articles/1312917-move-invoices-to-another-folder-or-company)).
  But note the warning: moving Sales↔Purchases "can cause some data loss… around
  line items or tax summaries". A move that loses data is exactly the pattern
  Neoting must refuse.
- **Split is upload-time only**, and unlike Dext's it *is* a page split: **Auto**
  (system decides), **Item per Page** (each page = separate invoice), **Single
  Item** (whole file = one document)
  ([1482856](https://help.autoentry.com/en/articles/1482856-upload-documents-to-autoentry)).
  **No post-upload split and no merge at all** — not verified/absent.
  **Dext and AutoEntry use "split" to mean opposite things**: Dext splits an
  amount, AutoEntry splits pages. See §9.3.
- **Duplicate detection in three stages**, including **at publish time against
  the accounting software** — catching invoices entered manually in the ledger,
  with an "Add the invoice anyway" override and a configurable **Duplicate Check
  Date Threshold**
  ([6783974](https://help.autoentry.com/en/articles/6783974-duplicate-check-for-invoices),
  [4647925](https://help.autoentry.com/en/articles/4647925-duplicate-check-date-threshold-sage-accounting-xero-and-quickbooks-online)).
  **Dext has no publish-time duplicate check against the destination.** This is
  the best idea AutoEntry has.
- **Shareable image links** with a company-level Public ("anyone with the link")
  vs Private (login + folder access) toggle, **no documented link expiry**
  ([1312956](https://help.autoentry.com/en/articles/1312956-how-to-share-an-invoice-image-link)).
  Public no-expiry document links in a multi-tenant bookkeeping product is a
  security posture Neoting should not adopt.
- **File Management**: a staging area where files sit unprocessed in folders,
  get an assigned Type, and are charged only on **Submit** for extraction; its
  own Recycle bin; move between companies
  ([4858792](https://help.autoentry.com/en/articles/4858792-file-management-overview),
  [9760125](https://help.autoentry.com/en/articles/9760125-manage-files-in-file-management)).
- **Absent**: tags/labels (closest are FM "Assign Type" and accounting tracking
  categories, [12156756](https://help.autoentry.com/en/articles/12156756-tracking-invoices-with-projects-or-categories));
  **notes/comments**; **flag or query-back-to-client**; **per-document assignee**
  (access is per-folder, [11991722](https://help.autoentry.com/en/articles/11991722-access-and-permission-settings)).
  Only Expenses has an approval workflow with Submitter/Approver/Admin roles.
- **Re-run extraction: not verified / absent.** The documented remedy for bad
  extraction is delete and re-upload — **and pay again**
  ([1312981](https://help.autoentry.com/en/articles/1312981-line-item-extraction)).
- **Human verification: not verified in current docs.** AutoEntry's historical
  reputation for human-verified extraction is *not* supported by current
  documentation, which describes an automated Queued → Processing → Ready
  pipeline, and autoentry.com claims only "up to 99% accurate" via OCR/ML
  ([1313005](https://help.autoentry.com/en/articles/1313005-invoice-and-statement-processing-times),
  [autoentry.com](https://www.autoentry.com/)). Do not repeat the human-review
  claim.

**Retention** — and this is where AutoEntry decisively beats Dext:
- Documents stored "**a minimum of seven years or as long as there's an active
  subscription**"
  ([1312814](https://help.autoentry.com/en/articles/1312814-how-long-are-documents-stored-in-autoentry)).
- After cancellation, data is kept **13 months**, then permanently deleted; early
  deletion on request
  ([1312814](https://help.autoentry.com/en/articles/1312814-how-long-are-documents-stored-in-autoentry),
  [1312872](https://help.autoentry.com/en/articles/1312872-cancel-your-subscription)).
  Inactive accounts get a deletion-warning email with a reactivation link, and
  simply logging in cancels the deletion
  ([11884475](https://help.autoentry.com/en/articles/11884475-inactive-accounts)).
  **Compare Dext's ten days and a written request.** A 13-month post-cancellation
  window with a warning email is the humane design.
- **Internal tension**: the storage article says that during the 13-month window
  you can export data "or use any remaining credits", while the cancellation
  article says credits expire **30 days** after cancellation. Data access and
  credit usability are blurred.
- **HMRC framing is REFUTED for retention.** The retention article cites no
  HMRC or legal basis; the seven-year figure matches UK norms but **the vendor
  does not claim that as the reason**. HMRC appears only via MTD marketing
  ([autoentry.com](https://www.autoentry.com/),
  [3275462](https://help.autoentry.com/en/articles/3275462-about-accountsprep)),
  and the delete-a-company article pushes legal retention responsibility onto the
  user ([1312910](https://help.autoentry.com/en/articles/1312910-delete-a-company)).

**Audit trail**:
- **Invoice history**: per-document chronological log of **Date / Time / Action /
  User** (upload, edits/coding, acceptance, move to accounting software), from a
  button top-right of the open document, reachable from Inbox, Archive, Rejected
  and Processed Items. **Sales and Purchases invoices only** — explicitly not
  available for Expenses, Bank Statements or Supplier Statements
  ([15518992](https://help.autoentry.com/en/articles/15518992-invoice-history)).
- **Activity tab** per folder is AutoEntry's nearest analogue to Submission
  History: all uploads by all users, with date, user, upload mode
  (browser/mobile), preview, size, **original-file download**, page count, status
  (Queued → Sent for Processing → Processed → Ready), and a Processed Items view
  showing document ID, last active user, action, timestamp and current location.
  Crucially: "**You can't delete or export documents from this section**" — an
  immutable ledger, **but with no restore capability**, unlike Dext's
  ([1312938](https://help.autoentry.com/en/articles/1312938-activity-tab-in-a-folder)).
- Every document has a permanent **Document ID** used for support and deletion
  requests ([4670932](https://help.autoentry.com/en/articles/4670932-the-document-id))
  — same idea as Dext's Item ID.
- Audit visibility permissions: **not verified**; visibility appears to follow
  folder access.

### 8.2 Hubdoc (Xero)

> **⚠ SOURCING CAVEAT WITHDRAWN — 2026-09-03.** The paragraph that used to sit
> here said the old Hubdoc help domain "does not resolve" and that everything
> below rested on Wayback captures "true as of June 2023". **That was wrong on
> both counts**, and it understated what is knowable. It is kept below, struck
> through, only so that a reader who acted on it knows the ground moved.
>
> ~~"The old `help.hubdoc.com` does not resolve… The workaround used was the
> Wayback Machine's full-content captures of the Hubdoc Zendesk KB, last revised
> 26 June 2023… Treat Hubdoc facts below as 'true as of June 2023'."~~

**Sourcing, corrected and re-verified 2026-09-03.** `support.hubdoc.com` is
**live, public and actively maintained**. Its Zendesk help-centre API enumerates
the whole KB without a browser:

```
https://support.hubdoc.com/api/v2/help_center/en-us/articles.json?per_page=100
```

That returns **65 articles** with full HTML bodies and `updated_at` timestamps.
The KB is not stale: *Customise configurations by supplier*, *Merge or delete
supplier accounts*, *Publish Hubdoc documents to BILL*, *Set due dates for
suppliers*, *Send documents from Hubdoc to cloud storage* and *Set up or manage
Hubdoc email forwarding* were all revised **2026-02-09**, and *Use the same email
account for multiple Hubdoc organisations* on **2026-08-05**.

Two consequences for anyone re-running this research:

1. **Every Hubdoc claim in this section has been re-sourced to the live
   `support.hubdoc.com` article**, not to an archive. Where the live wording
   still matches the 2023 capture, the archive link is left in place as a
   secondary citation; where it differs, the difference is called out.
2. **Xero Central and `support.hubdoc.com` are near-identical but neither is a
   superset.** Xero Central carries at least one Hubdoc article the Hubdoc
   helpdesk does not — the document-viewer article
   `https://central.xero.com/s/article/Open-and-modify-a-document-in-Hubdoc`,
   which has no `support.hubdoc.com` counterpart in the 65-article list. **Check
   both.** Xero Central remains JS-rendered and needs headless Chrome (see
   Appendix B); `support.hubdoc.com` needs nothing but `curl`.

**What has *not* changed:** `web.archive.org` was **unreachable from this
environment on 2026-09-03**, so the Wayback citations already in this section
could not be re-opened to confirm they still say what they were reported to say.
They are retained but should be read as second-hand. Any Hubdoc claim below that
rests *only* on a Wayback URL is marked as such.

#### 8.2.0 Hubdoc delete, re-verified live (2026-09-03) — the closest precedent we have

**Hubdoc is the only one of the four products with a real Trash**, and it is
therefore the nearest thing to a precedent for what Neoting is building. Every
claim in this sub-section comes from the **live** article
[support.hubdoc.com/…/16695595279629-Delete-a-document](https://support.hubdoc.com/hc/en-us/articles/16695595279629-Delete-a-document)
(revised 2024-07-22) unless stated otherwise. The 2023 Wayback text and the 2024
live text **agree**, so the earlier finding stands — it was simply sourced more
weakly than it needed to be.

Six things the live articles establish that this document did not previously
record:

1. **Trash is a *location in the left-nav folder list*, not a status filter.**
   The restore instruction is literally "Under **FOLDERS**, select **Trash**"
   ([16695595279629](https://support.hubdoc.com/hc/en-us/articles/16695595279629-Delete-a-document)).
   It sits among the user's own supplier folders. That is a different mental
   model from Dext's Submission History, which is a *report* you search.
2. **Restore is drag-and-drop only.** Verbatim: "Under FOLDERS, select **Trash**.
   **Drag and drop** the document to the relevant folder." There is **no Restore
   button and no "put back where it came from"** — the user must know, and
   choose, the destination folder. **So in Hubdoc, restore is also a move**: the
   original location is not recorded, or at least not offered back. This is the
   single worst detail of an otherwise good design, and Neoting must not copy it
   (§10.4).
3. **There is no per-document permanent delete.** The only hard-delete primitive
   is **Empty Trash**, which purges the *whole organisation's* trash at once:
   "Under FOLDERS, select Trash. Click the down arrow, then select **Empty
   Trash**." Verbatim consequence: "**Once a document has been emptied from the
   trash folder, it can't be restored.**" A user who wants to destroy one
   document must destroy every other trashed document with it.
4. **No trash retention window is published — confirmed, still not verified.**
   The live article states no auto-purge period, no day count and no expiry.
   Re-checked 2026-09-03 across the live delete article, the mobile delete
   article and the org-deletion article. **This makes it four vendors out of
   four with no published recovery window** (§8.4). The "30 days" that everyone
   in this category assumes is standard is published by *nobody*.
5. **Archive and Delete are unrelated axes.** *Archived* is one of five **status
   tabs** — All / Processing / Review / Failed / Archived — entered
   automatically on successful publish
   ([16695034961933](https://support.hubdoc.com/hc/en-us/articles/16695034961933-About-a-document-s-status-in-Hubdoc)).
   *Trash* is a **folder**. They are orthogonal dimensions of the same record,
   which is why deleting is not archiving and archiving is not deleting.
   *Whether a single document can be simultaneously archived **and** in the trash
   is* **not verified** *— it follows from the status-vs-location split but no
   Hubdoc article states it, and it must not be cited as vendor-confirmed.*
6. **Trashed documents still hold referential locks.** From the live *Merge or
   delete supplier accounts* article (revised **2026-02-09**): "Before you delete
   a supplier account, remove or reassign any documents in the supplier's folder.
   **If the delete option still isn't available, empty the trash folder.**"
   ([16695616930829](https://support.hubdoc.com/hc/en-us/articles/16695616930829-Merge-or-delete-supplier-accounts))
   In other words a *soft-deleted* row is still a live foreign-key reference that
   blocks deletion of its parent — and Hubdoc's stated remedy is to destroy the
   trash. **This is the exact failure mode a soft-delete design produces if you
   do not think about referential integrity up front**, and it is the most useful
   single sentence in the Hubdoc KB for Neoting's implementers.

Same article also yields two supplier-object facts worth recording, because they
show Hubdoc *does* know how to guard destructive actions when it wants to:
merges are capped at **10 suppliers at a time** and "you can't undo a merge";
deletes are capped at **50 supplier accounts at a time** and "deleting a supplier
can't be undone", with the recovery advice being "you'll need to set up the
supplier again"
([16695616930829](https://support.hubdoc.com/hc/en-us/articles/16695616930829-Merge-or-delete-supplier-accounts)).
**Compare AutoEntry, which caps deletes at one.**

**Mobile delete is a two-tap confirm**: "tap the delete icon → tap **Delete
document** to confirm"
([16699660016269](https://support.hubdoc.com/hc/en-us/articles/16699660016269-Delete-a-document-using-the-mobile-app),
live, revised 2023-06-26). The article does **not** say the document goes to
Trash — it is silent. **Whether mobile delete is soft: not verified.** Do not
assume parity with the web app.

**Still not verified after live re-check**: whether **Empty Trash** shows a
confirmation dialog; whether bulk delete of an arbitrary multi-selection exists;
whether any document type is protected from deletion; and whether published or
archived documents can be deleted. The live articles are silent on all four,
exactly as the archived ones were.

---

**Delete: soft, with a real Trash folder AND an explicit permanent purge.**
This is a third distinct model, different from both Dext and AutoEntry.

- Single document: open → **Delete** → **OK** to confirm. Deleting a *folder*
  moves all its documents to **Trash** (and does not remove the automated
  supplier connection)
  ([archived](https://web.archive.org/web/20231004123423/https://support.hubdoc.com/hc/en-us/articles/16695595279629-Delete-a-document);
  current slug: https://central.xero.com/s/article/Delete-a-document-in-Hubdoc).
- **Restore**: open the **Trash** folder under FOLDERS and **drag and drop** the
  document back into a folder. (Drag-to-restore, not a Restore button.)
- **Permanent delete is a separate, explicit action**: Trash → down arrow →
  **Empty Trash**. Verbatim: "**Once a document has been emptied from the trash
  folder, it can't be restored.**" **Hubdoc is the only one of the three vendors
  with a user-facing hard purge.**
- **Recovery window: NOT FOUND.** No auto-purge period for Trash is documented.
  The widely-repeated belief that Hubdoc has a fixed day count could not be
  verified in any fetchable Hubdoc or Xero source — **not verified**. Trash
  appears to be indefinite until manually emptied.
- **What cannot be deleted: not documented.** Published documents move to the
  **Archived** tab, but no article says they are protected from deletion. Hubdoc
  has **no locked-period concept**. No refusal wording found. **Not verified
  either way.**
- Mobile: document → delete icon → **Delete document** to confirm
  ([archived](https://web.archive.org/web/20231004132425/https://support.hubdoc.com/hc/en-us/articles/16699660016269-Delete-a-document-using-the-mobile-app)).
- Duplicate triage: a **Show Duplicates** panel with per-document **Move to
  Trash** or **Not a duplicate**
  ([archived](https://web.archive.org/web/20231004120000/https://support.hubdoc.com/hc/en-us/articles/16695858907789-Resolve-issues-with-documents-in-Hubdoc)).
- Organisation deletion: "**Deleting an organisation permanently removes all
  data and documents from Hubdoc**"; owner/creator only; one org at a time;
  confirmed by **typing the organisation name**. **Downgrading instead leaves a
  read-only, non-paying state with documents still accessible**
  ([archived](https://web.archive.org/web/20231004132558/https://support.hubdoc.com/hc/en-us/articles/16664709273357-Downgrade-or-delete-a-Hubdoc-organisation)).
  Type-the-name confirmation for tenant-destroying actions, and a read-only
  downgrade tier rather than deletion, are both worth copying.

**Preview**: the weakest of the three.
- **Edit Document** to the right of the document opens a **data toolbar** —
  Date, Total Amount, Supplier, Due Date, Invoice/Ref #. The **Edit Line Items**
  dialog is **draggable** "so it's easier to see the relevant areas of the
  document"
  ([archived](https://web.archive.org/web/20231004121147/https://support.hubdoc.com/hc/en-us/articles/115001289603-Manually-enter-data-for-a-document)).
- **Download**: single original file per document; folder-level **Download All
  Files** produces a **ZIP preserving folder structure**
  ([archived](https://web.archive.org/web/20231004142050/https://support.hubdoc.com/hc/en-us/articles/16699638666765-Download-or-export-documents-from-Hubdoc)).
  "Download as PDF" as a distinct option: **not verified**.
- ~~**Zoom, rotate, multi-page navigation, keyboard shortcuts, next/previous in
  viewer: none documented — not verified.** Tellingly, Hubdoc's troubleshooting
  advises fixing preview display problems using the **browser's** zoom setting,
  which implies there is no in-app zoom.~~
  **⚠ CONTRADICTED 2026-09-03 — zoom and rotate are documented, and the
  inference above was wrong.** See §8.2.1 immediately below. The reason this was
  missed is instructive: **the article that documents the Hubdoc viewer exists
  only on Xero Central, not on `support.hubdoc.com`**, so it is invisible to
  anyone enumerating the Hubdoc KB, and it was invisible to the earlier research
  because Xero Central would not render. The "browser zoom" troubleshooting
  inference was plausible and false — exactly the kind of gap-filling this
  document's sourcing rule exists to prevent.

#### 8.2.1 Hubdoc's viewer, verified (Xero Central only)

Source: [Open and modify a document in
Hubdoc](https://central.xero.com/s/article/Open-and-modify-a-document-in-Hubdoc)
(rendered with headless Chrome, 2026-09-03; filed under the **Files** topic).
**This article has no `support.hubdoc.com` counterpart.**

- **Opening**: click the document summary in the **DOCS** panel. "The document
  shows in the **document viewer screen**, and the **audit trail and upload
  information show below the document**." That confirms the audit panel's
  placement independently of the audit-trail article.
- **In-viewer controls, verbatim**: "Use the options under the document title to
  **zoom out, zoom in, rotate left, rotate right or reset**."
- **Pan**: "While you're zoomed in, you can **click and drag** to move around the
  document." A real pan affordance, which Dext's documentation does not describe.
- **Detached full view**: a **View icon** above the transaction details "to open
  the document in a **new tab**. In this tab you can **print, zoom, rotate and
  download**." So Hubdoc has **two** viewers with overlapping controls, and
  **print** is offered — a verb neither Dext nor AutoEntry documents.
- **Still not verified**: multi-page navigation, next/previous document without
  returning to the list, keyboard shortcuts, and side-by-side layout as such.
  The article describes controls "under the document title" and transaction
  details nearby, but never states a two-pane layout. **Do not read the absence
  of a next/previous control as proof it is missing.**

**Net effect on the scoreboard: Hubdoc's viewer is better than this document
previously claimed, and on rotate/zoom/pan/print it is arguably ahead of
AutoEntry.** §8.4 has been corrected accordingly.

**Bulk operations**: thin.
- Multi-select is **Ctrl/Cmd-click**, then **drag onto a tag folder** to bulk-tag
  ([archived](https://web.archive.org/web/20231004131733/https://support.hubdoc.com/hc/en-us/articles/16699481651853-Organise-documents-with-tags-and-folders)).
- Folder-level: **Delete Folder** (confirms), **Download All Files** (ZIP),
  **Export to CSV** with a date-range prompt (Document ID, supplier, bill date,
  invoice #, due date, currency, subtotal, tax, total; documents need a bill
  date).
- **Bulk publish or bulk delete of an arbitrary multi-selection: not documented
  — not verified.** Whether **Empty Trash** confirms: **not documented**.

**Search, filters, sorting**
([archived](https://web.archive.org/web/20231004135512/https://support.hubdoc.com/hc/en-us/articles/16694888963853-Search-for-documents-in-Hubdoc)):
- Simple search over contact name, date/due date, total amount, **note text**,
  document type. Searches extracted data, manually entered data and **embedded
  PDF text — but not text in images**. That is a notable step down from Dext,
  which searches the image OCR layer.
- Advanced search adds custom date ranges, upload date, custom amount ranges
  ([2018 version](https://web.archive.org/web/20190819172007/https://support.hubdoc.com/hc/en-us/articles/360016251872-Advanced-Search)
  also lists bill date, due date, supplier, document type).
- **Saved searches = copy the URL.** Search state is in the URL, so a search is
  bookmarkable and shareable. Cheap, elegant, and worth copying.
- **Sorting exists** — **Sort By** date or amount; default is upload time on the
  All tab and bill date elsewhere
  ([archived](https://web.archive.org/web/20231004120000/https://support.hubdoc.com/hc/en-us/articles/16695034961933-About-a-document-s-status-in-Hubdoc)).
  **Hubdoc is the only vendor of the three with documented sorting.**
- **Column selection does not exist** — results are a fixed **card list**
  (supplier, doc date, amount, currency, due date; hover the file-location icon
  to see the folder), not a configurable table.

**Organisational features**:
- **Status tabs: All / Processing / Review / Failed / Archived.** A dedicated
  **Failed** tab is something neither Dext nor AutoEntry has as a peer tab, and
  it is a good idea. **Archived** is entered automatically on publish, plus
  per-supplier auto-archive, documents added while non-paying, initial-import
  documents, and manual archiving.
- **Duplicate icon** when date + supplier + amount + invoice # match; **duplicates
  are never auto-published** — a safer default than Dext's optional auto-delete.
- **Tags** (create, per-document add, bulk drag) and **auto-created supplier
  folders with per-account subfolders**; drag-and-drop to move; merging suppliers
  merges folders. Hubdoc explicitly suggests tags for "documents to be reviewed
  by a particular person" — **tag-based review is the only assignment mechanism;
  a real assignee field is not documented.**
- **Notes**, with an important rule stated verbatim: "**Notes will not be
  published with the document to integrations. Notes are for internal Hubdoc
  purposes only**"
  ([archived](https://web.archive.org/web/20190819165800/https://support.hubdoc.com/hc/en-us/articles/208245073-Add-a-Note)).
  Notes can be set by email using `#note [text] #note`.
- **Split is a real page split, at upload, up to 50 pages**, or by putting
  `#split` in an email subject
  ([archived](https://web.archive.org/web/20190723201535/https://support.hubdoc.com/hc/en-us/articles/360016467291-Multi-Page-PDF-Splitting)).
  So Hubdoc agrees with AutoEntry, and **Dext is the odd one out** on what
  "split" means.
- **Email command syntax** (`#split`, `#note`) is a genuinely good ingest
  affordance: metadata supplied at the moment of sending, by a client who will
  never log in.
- **Merge of documents: not a feature** (only supplier-account merge).
  **Re-running extraction: not a feature.**
  **Moving a document between organisations: not documented.**
  **Query/flag back to client: not documented.**

**Retention**: Hubdoc's own docs state **no retention period at all**. Org
deletion is immediate and permanent; downgraded orgs retain read-only document
access. Xero's **Terms of Use §60** says terminated subscriptions are archived
and data retained "for a period of time consistent with our data retention
policy" — **no number given** ([xero.com/legal/terms](https://www.xero.com/legal/terms/)).
The privacy notice likewise gives **no number**
([xero.com/legal/privacy](https://www.xero.com/legal/privacy/)).
**The "Hubdoc markets 7-year retention" belief is REFUTED as far as current
vendor pages go**: https://www.xero.com/hubdoc/ mentions only "Attach the
original photo or file to the digital record for your tax-office compliance" —
no duration, no HMRC/IRS/ATO year count.

**Audit trail**
([archived](https://web.archive.org/web/20231004124112/https://support.hubdoc.com/hc/en-us/articles/16695107301389-View-a-document-s-audit-trail-in-Hubdoc);
current slug `https://central.xero.com/s/article/View-a-document-s-audit-trail-in-Hubdoc`):
- Shown **at the bottom of the document image**: unique **Document ID**, **upload
  method** (direct connection / mobile / email / web / ScanSnap), **who uploaded
  it**, **date and time**. A **Destinations** section lists each publish/forward
  destination, who did it and when.
- **Only documents uploaded on or after 5 July 2018 have audit details** — a
  permanent, visible scar from retrofitting an audit trail onto an existing
  product. **Build the audit trail from day one; you cannot backfill it.**
- Visible to anyone who can open the document; explicit audit-visibility rules
  are **not documented**.

### 8.3 Xero Files — **now verified** (was: "almost entirely unverifiable")

> **⚠ THIS SECTION'S HEADLINE CLAIM IS WITHDRAWN — 2026-09-03.** The paragraph
> below used to read: *"Honest position: Xero Files' UI behaviour could not be
> verified at all. The article
> `https://central.xero.com/s/article/Delete-a-file-or-folder-from-Xero` exists
> (slug confirmed via the Wayback CDX index) but every capture is an empty
> JavaScript shell."*
>
> **Both halves of that are now wrong.**
>
> 1. **The UI behaviour is verified.** Xero Central renders completely under
>    **headless Chrome** (Playwright driving the system Chrome; see Appendix B).
>    The article body — including collapsed accordion sections and their warning
>    banners — is present in the DOM and readable via `textContent` without even
>    clicking to expand.
> 2. **That slug does not exist.** `Delete-a-file-or-folder-from-Xero` is
>    **absent from Xero Central's own sitemap** (3,121 article URLs, see
>    Appendix B) and requesting it **bounces to the Xero login page**, which is
>    what Xero Central does for any unknown slug. The real article is
>    **[`Manage-your-file-library`](https://central.xero.com/s/article/Manage-your-file-library)**,
>    titled *"Organise your file library"*, with **Delete a file or folder** as
>    one of its collapsed sections.
>
> Anyone who acted on the old paragraph and concluded "Xero Files cannot be
> researched" should re-read §8.3.1–§8.3.4 below.

#### 8.3.1 Xero Files delete: hard, bulk-capable, and it silently detaches transactions

**The on-screen warning, verbatim.** It is a Warning banner at the head of the
*Delete a file or folder* section of
[Manage-your-file-library](https://central.xero.com/s/article/Manage-your-file-library):

> **"Deleting a file from the file library removes the file from all transactions
> it's attached to. We can't retrieve deleted files. To use a deleted file, you
> need to upload it again."**

Read that slowly, because it settles three separate questions at once:

- **Hard delete.** "We can't retrieve deleted files." No qualifier, no window, no
  support-request escape hatch of the kind AutoEntry offers for bank statements.
- **No trash and no restore.** The article documents no Trash, no Recycle bin, no
  Deleted folder and no Restore action anywhere in the file library. The library
  has exactly two locations — **Inbox** and **Archive** (with folders) — and
  *Archive here means "attached to something", not "deleted"*. **This confirms
  what §8.3's API-only analysis could previously only call "consistent with hard
  delete": the Files API has no restore endpoint because the product has no
  restore.** The inference was right; it is now evidence.
- **Deleting a library file cascades a detach onto every transaction using it.**
  This is the most important sentence in the whole comparator research. Xero
  models the attachment as a *reference to a library file*, so destroying the
  file destroys the evidence on every bill, invoice and receipt that pointed at
  it — and the only warning is one line of banner text on a collapsed accordion
  section. **There is no listing of which transactions will be affected, no
  count, and no block.** Not verified whether any confirmation dialog follows the
  Delete click; the article shows none.

**Bulk delete exists, and it is frictionless.** "Select the checkbox next to
**each file** you want to delete. Click **Delete**."
([Manage-your-file-library](https://central.xero.com/s/article/Manage-your-file-library))
So of the four products, **Xero Files has the loosest delete of all**: hard,
bulk, cascading, unrecoverable, no reason captured, no intermediate state.
Compare AutoEntry, which for a far less consequential object insists on
Unpublish → Reject-with-reason → delete one at a time.

**Folder deletion is better designed than file deletion.** Deleting a folder
prompts: "(Optional) If there are files in the folder, choose to either **delete
them or move them to the Archive**, then click Delete." That is the
delete-a-container-without-cascading choice done properly — the same instinct as
Dext's expense-claim delete (§1.2b) — and it makes the unguarded single-file
delete look like an oversight rather than a philosophy.

**One object is protected: the Contracts folder.** "You can rename any folder in
the archive, **except the Contracts folders**" and "You can delete any folder in
the archive, **except the Contracts folder**." A single system folder is
undeletable. **No document-level protection of any kind is documented.**

**Mobile delete differs by platform and is worth noting for terminology
discipline**: on iOS the verb is **Remove** (Options → Remove), on Android it is
**Delete** with a confirm, and Android additionally supports **multi-select via
tap-and-hold** then a delete icon and a confirm
([Manage-your-file-library](https://central.xero.com/s/article/Manage-your-file-library)).
**Whether iOS "Remove" is the same operation as web "Delete": not verified** —
the article does not say, and the word choice is exactly the kind of ambiguity
Neoting's glossary exists to prevent.

#### 8.3.2 What blocks deletion in Xero Files: roles do, and nothing else does

**The role matrix is published in full** — this is the single best-documented
permission surface in any of the four products
([User-role-access-to-files-in-Xero](https://central.xero.com/s/article/User-role-access-to-files-in-Xero)):

| Capability | Administrator | Standard | Sales and purchases | Upload only | Viewer |
|---|---|---|---|---|---|
| File library — view, **add and remove files** | ✔ | ✔ | – | ✔ ** | – |
| File library — view, **add and remove folders** | ✔ | ✔ | – | – | – |
| Add or remove files for transactions/items you can access | ✔ | ✔ | ✔ * | – | – |
| View or download files for transactions/items you can access | ✔ | ✔ | ✔ | – | ✔ *** |

Footnotes, verbatim from the article:

- \* "Sales and purchases users can add files from the **file library inbox**,
  including those others have added. Sales and purchases users **can't access any
  other folders** in the file library."
- \*\* "**Upload only users can only upload files to the file library and view
  their own files. Upload only users can't delete, archive, or move any files.**"
- \*\*\* "Viewer users can only view or download files attached to **spend or
  receive money transactions in the account transactions tab of a bank account**,
  not in the individual transaction."

**So the roles blocked from deleting library files are: Sales-and-purchases,
Upload-only and Viewer.** Only **Administrator** and **Standard** may delete
files; only those two may delete folders. The article also states the rule
positively in the file-library overview: "You need the **administrator or
standard** user role to manage files in the file library."

**Upload-only is the interesting role** and Neoting should steal it outright: a
principal that can *put documents in* and *see only its own*, and can neither
delete, archive nor move anything. That is precisely the shape of a client
uploading receipts into a practice's workspace, and none of Dext, AutoEntry or
Hubdoc documents an equivalent.

**What does NOT block deletion — all newly checked, all negative:**

- **Lock dates do not block file deletion.** Xero has a well-known lock-date
  concept, but it is documented against *transactions*, and neither the file
  library article nor the transaction-files article mentions a lock date, a
  closed period or a locked financial year as a barrier to deleting a file.
  **Not verified as a block — and the delete warning's unconditional wording
  ("removes the file from all transactions it's attached to") implies there is
  none.** Flagged as an inference, not a fact.
- **Reconciliation status does not block file deletion.** Not mentioned in any
  Files article. **Not verified.**
- **Approval status does not block file deletion.** Xero Central's bill-approval
  article (`Understand-bill-approval-workflows`) is **`Disallow`ed in
  central.xero.com/robots.txt and was therefore not fetched**, so approval
  interactions with file deletion remain **not verified** and were deliberately
  left unresearched rather than guessed.

#### 8.3.3 Xero Files preview and viewer

- **Side-by-side preview is confirmed and named as such.** Verbatim from the
  file-library overview: "**Preview files using the side-by-side view.**"
  ([Manage-your-file-library](https://central.xero.com/s/article/Manage-your-file-library))
  So Xero Files matches Dext on the one layout property that matters most.
- **Download**: a **download icon** on the opened file saves the original to the
  computer; on iOS it is Options → Share → Save to Files, on Android Options →
  Share → choose an app. **Download-as-PDF as a distinct option from
  download-original: not verified** — Xero Files stores and returns the file you
  uploaded, and no conversion is documented. This is the opposite of AutoEntry,
  which offers PDF-only from the viewer and hides the original on another screen
  (§8.1).
- **Zoom, rotate, multi-page navigation, next/previous document, keyboard
  shortcuts: not verified.** The Files articles document none of these. Note the
  contrast with **Hubdoc**, whose viewer article explicitly lists zoom, rotate
  and pan (§8.2.1) — within the same vendor, the Hubdoc viewer is better
  documented than the Xero Files one.

#### 8.3.4 Structure, and what Xero Files is actually for

The file library is **not a document-processing queue**; it is an attachment
store, and its two-location model reflects that
([Manage-your-file-library](https://central.xero.com/s/article/Manage-your-file-library)):

- **Inbox** — "Upload or email files directly to the inbox, then attach them to
  transactions, items and emails in Xero."
- **Archive** — "**Once a file is attached to a transaction, it's moved and
  stored in the archive.**" It "contains a **Contracts** folder, and you can add
  and manage any additional folders you need."
- Files move between the two by checkbox + **Archive to** / **Move to**, or by
  **drag and drop**.

**The critical translation for the implementation team**: in Xero Files,
**Archive is the state meaning "in use"** — a file lands there *because* it got
attached to a transaction. In Dext, Archive means "done with, published" (§5.1).
In Hubdoc, Archived means "successfully published" (§8.2.0). **Three products,
three incompatible meanings of the same word, and Xero's is the odd one out
because it is the only one where Archive means the document is *live*.** Added to
§9.3.

**Renaming exists and is constrained**: files can be renamed but "you can't
change its file extension". **Rename is not documented in Dext, AutoEntry or
Hubdoc's web app** (Hubdoc has *Change a document file name*, so call that a
draw). Renaming a stored document without renaming the stored object is a
sensible split.

**Split or re-run extraction: neither exists, and cannot.** Xero Files performs
**no extraction at all** — it is storage. There is no OCR step to re-run and no
page-splitting feature in any Files article. **This is an absence stated on the
basis of the product's documented purpose, not a "not verified".**

#### 8.3.5 What the API said, and how it holds up

What *was* verifiable before this round came from the public API specification
([xero_files.yaml](https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_files.yaml)):

- The Files API exposes **`deleteFile`** ("Deletes a specific file"),
  **`deleteFolder`** and **`deleteFileAssociation`**.
- **There is no restore endpoint and no trash concept anywhere in the API.**
- Sorting is supported by **Name, Size, CreatedDateUTC**.
- **No file-size or storage cap appears in the spec.**

~~The absence of a restore endpoint is **consistent with hard delete at the API
level, but it is not proof of the UI's behaviour** — a product can perfectly well
have a UI trash that the API does not expose. Do not cite "Xero Files hard
deletes" as fact.~~

**⚠ SUPERSEDED 2026-09-03 — you may now cite it as fact.** The UI article says
"**We can't retrieve deleted files**" (§8.3.1). API and UI agree: **Xero Files
hard-deletes, with no trash and no restore.** The API's shape was a correct
signal, and the cautious reading above was the right call *at the time* — it is
recorded here because the reasoning pattern (absence in an API is weak evidence
about a UI) remains sound even though this particular instance resolved in its
favour.

Two API facts also gain meaning now that the UI is known:

- **`deleteFileAssociation` exists as a separate endpoint from `deleteFile`.**
  So the API *can* express "detach this file from this transaction without
  destroying the file" — the very operation the UI's delete button does **not**
  offer. **The safe operation exists at the API layer and is missing from the
  screen.** That is worth copying in reverse: Neoting should surface *detach*
  next to *delete* wherever a document is attached to something.
- Sorting by **Name, Size, CreatedDateUTC** in the API, and **no file-size or
  storage cap in the spec**, remain the only evidence on those points.

**Still not verified for Xero Files after this round**, and now for stated
reasons rather than for want of a fetcher:

- **Search / filter / sort in the file-library UI** — no Files article describes
  a search box, filter panel or sort control. The API sorts; the UI is silent.
- **Per-plan storage limits** — the old marketing page
  `https://www.xero.com/us/accounting-software/manage-files/` is still a 404, and
  Xero's current *Store files* page carries no figure.
- **Any audit trail on a file** — no Files article documents who uploaded a file,
  when, or who deleted it. **Given that deletion is hard and cascades onto
  transactions, the absence of a documented file audit trail is the sharpest gap
  in the whole comparator set** (see §10.4).
- **Confirmation dialogs**, **duplicate detection**, **notes/tags on files**,
  and **any recovery path whatsoever**.

### 8.4 Comparison at a glance

| | **Dext** | **AutoEntry** | **Hubdoc** | **Xero Files** |
|---|---|---|---|---|
| Delete of a processed doc | Soft | **Hard** | Soft | not verified (API suggests hard) |
| Recovery surface | Submission History ledger | Recycle bin, **pre-processing only** | **Trash folder**, drag to restore | none in API |
| User-facing permanent purge | **No** | Yes (the only delete) | **Yes — Empty Trash** | not verified |
| Documented recovery window | **None stated** | n/a | **None stated** | not verified |
| Bulk delete | Yes | **No** | not verified | not verified |
| Reason required to delete | No | **Yes, mandatory picker** | No | not verified |
| Delete blocked when published | **No** | **Yes** | not documented | not verified |
| Period lock on documents | **No** (monitors Xero/QBO only) | not documented | **No concept** | not verified |
| Archive as separate state | Yes, auto | Yes, auto-archive option | Yes, **Archived tab** | not verified |
| "Split" means | **amount allocation** | **page split** (upload only) | **page split** (upload, ≤50pp) | n/a |
| Merge documents | **Yes, with Unmerge** | No | No | n/a |
| Re-run extraction | Line items only | **No** | **No** | n/a |
| Search covers image OCR | **Yes** | not verified | **No** (embedded PDF text only) | not verified |
| Documented sorting | **not verified** | **not verified** | **Yes** (date, amount) | API: name/size/date |
| Column selection | **Yes, per user** | not verified | **No** (card list) | not verified |
| Keyboard shortcuts | **Yes** (`⌘J`/`⌘K`) | not verified | not verified | not verified |
| Notes / comments | Yes + client messaging | **No** | **Yes** (internal only) | not verified |
| Flag / query to client | **Yes** (flags; messaging needs the mobile app) | **No** | No | not verified |
| Per-document audit trail | **Yes** (History tab) | **Yes** (Invoice history, Sales/Purchases only) | **Yes** (but only for docs after 5 Jul 2018) | not verified |
| Active-subscription retention claim | "at least 10 years" | "minimum seven years" | **none stated** | none stated |
| Post-cancellation window | **10 days**, written request | **13 months**, warning email | not stated | "consistent with our data retention policy" |

---

## 9. Where vendors disagree

### 9.1 Dext disagrees with itself — three documented contradictions

**D1. Is deleting an archived item permanent?**

| Says permanent | Says recoverable |
|---|---|
| "Users can delete archived items… **Deletion is permanent** and differs from unarchiving" ([416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext)) | "Deleted items remain **recoverable** through the Submission History page" ([416718](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext)) |
| — | Deleted Costs & Sales items are restored via a per-row **Restore** button ([105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext)) |

Most plausible reconciliation: "permanent" means *irreversible from the
Archive's point of view* (unarchiving will not bring it back), not
*irrecoverable*. But Dext never says so. **An implementer must not rely on
either reading.**

**D2. How long are documents retained during an active subscription?**
"**At least 10 years** while your subscription is active"
([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules))
versus the weaker "for **as long as your Dext subscription is active**"
([416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext)),
versus the Terms, which promise **no minimum retention at all** and permit
destruction ten days post-termination
([terms, Sch. 1 cl. 6.5(f)](https://dext.com/en/terms-and-conditions)).
Marketing copy, help copy and contract copy give three different answers.

**D3. Can archived items be deleted or edited?**
[416742](https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext)
says archived items can be deleted; the dedicated archive/unarchive article
"does not specify whether archived items can be edited or deleted"
([416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext)).

### 9.2 Terminology clash: "Published"

This is the disagreement most likely to cause real damage to Neoting's
implementation, and it is not between vendors but between Dext and Neoting:

| Term | Dext | Neoting |
|---|---|---|
| **Publish** | "Sends extracted item data along with the document image to your connected accounting software… a one-way transfer into your accounting system" ([416716](https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext)) | **Approved and released for export. Never "posted to a ledger".** |
| **Export** | Downloads items from Dext for storage or sharing elsewhere ([416716](https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext)) | The downstream consumption of released lines |

**Dext's "publish" is the thing Neoting explicitly says "published" does not
mean.** Every Dext article the implementation team reads needs this translation
applied consciously. Recommend the team never uses the bare word "publish" in
code, tickets or UI copy without a qualifier.

### 9.3 Cross-vendor disagreements

**V1. Delete — the vendors are in flat opposition.**

| | Dext | AutoEntry |
|---|---|---|
| Delete of a processed document | **Soft**, restorable from Submission History | **Hard**, "once you delete a document, you can't retrieve it" |
| Bin/recovery area | Submission History (post-processing) | Recycle bin exists **only in pre-processing File Management** |
| Bulk delete | **Yes**, from the Actions menu | **No** — "you can only delete one invoice at a time" |
| Reason required | Not documented | **Mandatory reason picker** |
| Blocked when published | **No** — instead offers Clear Publishing Data | **Yes** — must Unpublish before Reject before Delete |
| Blocked while processing | Not documented | **Yes**, explicitly |

Sources:
[Dext 416718](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext),
[Dext 105787](https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext),
[AE 4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement),
[AE 8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice),
[AE 15262062](https://help.autoentry.com/en/articles/15262062-recycle-bin-in-file-management).

There is **no industry consensus on delete** in this category. Neoting cannot
appeal to "how everyone does it" — it must choose. My recommendation (§10) takes
Dext's recoverable ledger and AutoEntry's published-item guard and mandatory
reason, which is better than either vendor ships.

**V2. "Split" means opposite things.**
Dext's Split divides an **amount** across categories, duplicating the image to
both children
([416731](https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext)).
AutoEntry's split divides **pages** into separate documents, and only at upload
time
([1482856](https://help.autoentry.com/en/articles/1482856-upload-documents-to-autoentry)).
Neither does both. **This is a live terminology trap for the implementation
team** — a ticket saying "add document split" is ambiguous until someone says
which. Neoting probably needs both, under two different names (suggest
*allocate* for the amount case, *split pages* for the page case).

**V3. Merge.**
Dext has a real, reversible Merge with an Unmerge
([416737](https://help.dext.com/en/articles/416737-how-to-merge-items-in-dext)).
**AutoEntry has no merge at all** (not verified/absent). Its duplicate flow
rejects rather than combines.

**V4. Retention after cancellation — a 40× difference.**

| Vendor | Post-cancellation window |
|---|---|
| **Dext** | **10 days**, and only if you send a **written request** for a backup ([terms Sch. 1 cl. 6.5(f)](https://dext.com/en/terms-and-conditions), [106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules)) |
| **AutoEntry** | **13 months**, with a deletion-warning email and reactivation-by-login ([1312814](https://help.autoentry.com/en/articles/1312814-how-long-are-documents-stored-in-autoentry), [11884475](https://help.autoentry.com/en/articles/11884475-inactive-accounts)) |

And on active-subscription storage: Dext claims "at least 10 years"
([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules)),
AutoEntry "a minimum of seven years"
([1312814](https://help.autoentry.com/en/articles/1312814-how-long-are-documents-stored-in-autoentry)).
Both figures are help-centre claims, not contractual terms.

**V5. HMRC framing — the vendors differ in posture.**
Dext **does** name HMRC (and ATO, CRA, IRD, IRS) and asserts its stored records
"can be used as supporting documentation where digital record-keeping is
accepted", while hedging that users must confirm their own requirements
([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules)).
AutoEntry **does not** cite HMRC as the basis for its seven-year figure at all;
HMRC appears only in MTD marketing
([autoentry.com](https://www.autoentry.com/)). So the seven-year number is *not*
a vendor-claimed HMRC retention commitment — do not repeat it as one.

**V6. Duplicate checking against the destination.**
AutoEntry checks for duplicates **at publish time against the accounting
software**, catching invoices a human keyed directly into the ledger, with a
configurable date threshold
([6783974](https://help.autoentry.com/en/articles/6783974-duplicate-check-for-invoices),
[4647925](https://help.autoentry.com/en/articles/4647925-duplicate-check-date-threshold-sage-accounting-xero-and-quickbooks-online)).
**Dext has no equivalent** — it only compares documents to each other within
Dext. AutoEntry is right and Dext is wrong on this one.

**V7. Three vendors, three delete models — the full picture.**
Dext: soft, recovery on an **ingest ledger**, **no user-facing purge**.
AutoEntry: **hard**, with a bin that protects documents only *before* extraction
is paid for. Hubdoc: soft, with a **real Trash folder and an explicit
"Empty Trash" hard purge**
([Hubdoc, archived](https://web.archive.org/web/20231004123423/https://support.hubdoc.com/hc/en-us/articles/16695595279629-Delete-a-document)).
**Not one of the three publishes a recovery time limit.** The industry-standard
"deleted items are kept for 30 days" that everyone assumes exists in this
category **does not exist in any of these products' documentation**. If Neoting
states a window, it will be stating more than any competitor does — which is a
reason to do it, not to avoid it.

**V8. "Split" — Dext is the outlier, 2 to 1.**
AutoEntry and Hubdoc both use *split* to mean **dividing a multi-page file into
separate documents**
([AE 1482856](https://help.autoentry.com/en/articles/1482856-upload-documents-to-autoentry),
[Hubdoc, archived](https://web.archive.org/web/20190723201535/https://support.hubdoc.com/hc/en-us/articles/360016467291-Multi-Page-PDF-Splitting)),
both **only at upload time**. Dext alone uses it to mean **allocating an amount
across categories**
([416731](https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext)).
Since two of three vendors and most users' intuition say "pages", Neoting should
reserve the word **split** for pages and pick a different word (*allocate*,
*apportion*) for the amount case.

**V9. Search depth.**
Dext searches **inside document images** (the OCR layer)
([105914](https://help.dext.com/en/articles/105914-how-to-search-through-the-inbox-and-archive)).
Hubdoc explicitly does **not** — it covers extracted data, manually entered data
and **embedded PDF text only**
([Hubdoc, archived](https://web.archive.org/web/20231004135512/https://support.hubdoc.com/hc/en-us/articles/16694888963853-Search-for-documents-in-Hubdoc)).
For a product whose input is largely photographs of receipts, Dext is clearly
right.

**V10. Duplicate defaults.**
Hubdoc flags duplicates and guarantees "**duplicates are never auto-published**"
([Hubdoc, archived](https://web.archive.org/web/20231004120000/https://support.hubdoc.com/hc/en-us/articles/16695858907789-Resolve-issues-with-documents-in-Hubdoc)).
AutoEntry **auto-rejects** at extraction — and charges for it
([AE 6783974](https://help.autoentry.com/en/articles/6783974-duplicate-check-for-invoices)).
Dext offers **auto-delete** as a configurable mode
([216124](https://help.dext.com/en/articles/216124-how-dext-handles-duplicate-cost-documents)).
Hubdoc's posture — *block the release, never destroy the document* — is the
safest and is what Neoting should default to.

**V11. Retention: nobody agrees, and two of four say nothing.**
"At least 10 years" (Dext) vs "minimum seven years" (AutoEntry) vs **no stated
period at all** (Hubdoc, and Xero's Terms §60 which promises only a period
"consistent with our data retention policy",
[xero.com/legal/terms](https://www.xero.com/legal/terms/)). Post-cancellation:
**10 days** (Dext) vs **13 months** (AutoEntry) vs unstated (Hubdoc/Xero). Any
Neoting claim that is specific and honest beats the entire field.

**V12. The "7 years / HMRC" folklore is refuted for both vendors that supposedly
market it.** Hubdoc's current marketing page states no duration and no tax
authority ([xero.com/hubdoc](https://www.xero.com/hubdoc/)); AutoEntry's
seven-year figure is stated **without** any HMRC or legal basis
([AE 1312814](https://help.autoentry.com/en/articles/1312814-how-long-are-documents-stored-in-autoentry)).
Only **Dext** actually names tax authorities, and even then it hedges
([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules)).
Do not repeat "the industry standard is 7 years for HMRC" — no vendor here says
it.

**V13. Cross-company movement.**
AutoEntry moves invoices between **companies**
([1312917](https://help.autoentry.com/en/articles/1312917-move-invoices-to-another-folder-or-company));
Dext documents only within-client workspace moves (§5.7). But AutoEntry's own
warning that a Sales↔Purchases move "can cause some data loss… around line items
or tax summaries" is a reason to side with Dext's caution.

---

## 10. What Neoting should adopt, adapt, or refuse

Judged against Neoting's stated constraints: UK practice product; money in
integer pence; every state change goes through Review → Approve except
ingest-class writes; **Published = "approved and released for export", never
"posted to a ledger"**; every exported line must resolve back to its source
document; multi-tenant RLS with a document belonging to exactly one client
business.

### 10.1 ADOPT — take these more or less as they are

**A1. The submission ledger, as a separate table from the document.**
Dext's Submission History is the best structural idea in the product. A row is
written at ingest and is **never deleted, only annotated with a status**
(Inbox / Archive / Deleted / Merged / Duplicate). It gives you soft delete,
dedupe provenance, merge provenance and an ingest audit trail from one
construct. For Neoting this is close to mandatory: if every exported line must
resolve to a source document, the source-document record must be immortal even
when the *working* document is gone. Make `submission` immutable-append and let
`document` carry mutable state.

**A2. Delete changes status; it never removes the row.** And put restore on the
ledger screen, not in a Trash tab. A Trash tab invites "empty trash". There is no
"empty trash" in Neoting.

**A3. Deleting a container releases its members.** Dext's expense-claim rule —
delete the claim, the receipts go back to the inbox
([105940](https://help.dext.com/en/articles/105940-how-to-delete-an-expense-claim))
— should be Neoting's universal rule for every grouping object (batch, claim,
export run). Never cascade a delete onto documents. Cascading destroys export
traceability, which Neoting refuses by policy.

**A4. Archive as an automatic consequence, not a chore.** Auto-archive on
publish and on export
([416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext)).
The working list should empty itself. A list that requires tidying will not be
tidied.

**A5. Flags: an admin-defined controlled vocabulary, freely applied by staff.**
Five colours, admin-authored labels, visibility toggles, bulk add/remove,
filterable ([522481](https://help.dext.com/en/articles/522481-how-to-use-flags-to-organise-your-inbox)).
Dext's own example labels — "Waiting on client response", "Do not process" — are
exactly a practice's vocabulary. **Refuse free-text tags** (see 10.3).

**A6. "With extraction warnings / Without extraction warnings" as a
first-class filter.** The single highest-value queue in a bookkeeping product is
"everything the machine wasn't sure about". Ship it on day one.

**A7. Three separate lifecycle timestamps — uploaded, published, exported — each
independently filterable and available as a column.** Neoting's Published and
Exported are genuinely different events; do not collapse them into one
`updated_at`.

**A8. The `Processing` section with a visible ETA.** Honest latency beats a
spinner ([105789](https://help.dext.com/en/articles/105789-the-costs-inbox)).

**A9. Per-user column selection with a Reset, plus row density.** Cheap, and it
matters to people who live in the screen all day
([105716](https://help.dext.com/en/articles/105716-managing-table-columns-and-density-in-inbox-archive-and-approvals)).

**A10. A read-only, user-visible document ID**, surfaced as a column, a filter
and a detail field. It is the handle for support conversations and for
reconciling an export line back to its document.

**A11. Search the OCR text layer, not just extracted fields, and highlight what
matched.** ([105914](https://help.dext.com/en/articles/105914-how-to-search-through-the-inbox-and-archive))

**A12. Merge's confirmation pattern**: preview + editable combined result + a
**semantic mismatch warning** ("these have different amounts/dates/users") + a
named inverse (**Unmerge**). This is the template for every risky operation in
Neoting.

**A13. Approvals default to "Assigned to me" with an "All items" toggle.**
Personal queue first ([689612](https://help.dext.com/en/articles/689612-how-to-review-and-approve-documents-in-dext)).

**A14. "Once approved, its details can't be edited."** Dext gets this right.
Neoting's Approve must be a hard immutability boundary.

**A15. Side-by-side image and fields as a full page, not a modal**, with
`Ctrl/⌘ + J/K`-style next/previous so a reviewer never returns to the list.

**A16. Dext's dedupe keys**, which are well-chosen and differ by document type:
receipts on Supplier + Date + Total + Owner; invoices/credit notes on Supplier +
Total + Document reference
([216124](https://help.dext.com/en/articles/216124-how-dext-handles-duplicate-cost-documents)).
With integer pence you get exact equality on Total for free — no float
tolerance, no epsilon. That is a real advantage over every vendor here.

### 10.2 ADAPT — right idea, wrong shape

**B1. The status chip should carry the last outbound result.** Dext's yellow
Ready ("validation passed, but the previous export attempt failed") is excellent
([416750](https://help.dext.com/en/articles/416750-what-do-to-review-and-ready-mean-in-dext)).
Adapt it to Neoting's vocabulary: `Approved` (green) vs `Approved · last export
failed` (amber). Do **not** reuse the word "Ready" — Neoting already has Review
and Approve, and a third readiness word will be confused with both.

**B2. Give restore a bounded window and a named actor, and log it.** Dext's
unlimited, unlogged restore is not defensible in a practice. Suggested shape:
soft-deleted documents restorable indefinitely *by the ledger*, but **restore is
an Approve-ceremony action**, not an ingest-class write, and it writes an audit
event. Deletion itself can be ingest-class only for never-approved documents;
deleting an approved document must go through Review → Approve.

**B3. Confirmation policy, inverted from Dext's.** Dext confirms merge and
delete and waves through publish/export
([416716](https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext)).
For Neoting the irreversible, externally-visible act is **release for export**,
so that is what must carry the ceremony. Rule of thumb: **confirmation friction
should be proportional to how hard the act is to reverse *outside* the system**,
not inside it.

**B4. Dext's three-field publish gate (Category, Supplier, Total)** is the right
idea — a small, legible completeness rule — but Neoting should express it as a
per-client-business rule set, evaluated server-side, with the failing fields
surfaced inline as Dext does via tooltips.

**B5. Client query-back must not depend on a mobile app.** Dext's item messaging
only works "if the document owner has the Dext mobile app installed"
([416724](https://help.dext.com/en/articles/416724-how-to-use-item-messaging-in-dext)),
which disables the feature for exactly the clients who most need chasing. Build
query-back on email with a tokenised reply link; treat any app as an
accelerator, never the transport.

**B6. Require a reason on rejection — and on delete.** Dext does not document
one. **AutoEntry does, and gets it right**: a mandatory picker of *Already in
Software Accounting Package / Duplicate / Uploaded in error / Uploaded into
incorrect folder / Other (free text)* before the reject confirms
([AE 8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice)).
Copy the enum-plus-free-text shape: the enum makes rejections *countable* (how
many documents this month were "uploaded in error"?), the free text stops the
enum from lying.

**B7. Split needs an inverse.** Dext's split has no `Unsplit`; you delete the
child ([416731](https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext)).
If Neoting splits a document's *amount* across categories, the children must
carry a shared `split_group_id` back to one source document — otherwise an
exported line cannot resolve to its source, which Neoting refuses. Also: with
integer pence, **enforce that the children sum exactly to the parent**. Dext
cannot do this reliably; Neoting can, and should make it a hard constraint
rather than a warning.

**B8. Auto-dedupe may auto-delete *only* because delete is recoverable.** If
Neoting ships Dext's "Automatic" duplicate mode
([216124](https://help.dext.com/en/articles/216124-how-dext-handles-duplicate-cost-documents)),
it must ship the ledger first, and the auto-delete must be an ingest-class write
that is loudly visible in the list ("3 suspected duplicates auto-removed —
review"). Defaulting to Dext's **Review** mode with side-by-side comparison is
the safer launch position.

**B9. Retention copy: claim what Dext claims, promise what Dext won't.** Adopt
Dext's careful liability split — *the format is acceptable to HMRC* vs *we are
your statutory archive*
([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules))
— but beat Dext on the exit path. Dext's contractual position is destruction ten
days after termination unless the customer writes in
([terms, Sch. 1 cl. 6.5(f)](https://dext.com/en/terms-and-conditions)). For a
practice product that is a liability, not a feature. Offer a **self-service full
export at any time**, including after cancellation, for a stated period, and say
the period in the UI.

**B10. Bulk-edit is necessary; scope it.** Dext offers unrestricted bulk edit.
Neoting should allow bulk edit of *coding* fields (category, tracking, flags) as
ingest-class, but route bulk edits of **monetary fields** through the Approve
ceremony. Editing 400 documents' totals in one unaudited action is not something
a practice product should permit.

### 10.3 REFUSE — do not copy these, and here is why

**R1. "Clear Publishing Data". Refuse absolutely.**
This is Dext's worst idea. It lets a user erase the system's record that a
document was already released downstream
([416718](https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext),
[416728](https://help.dext.com/en/articles/416728-how-to-republish-an-item)),
and Dext itself admits the consequence — the unarchive prompt warns it "may
create duplicates in your accounting system"
([416746](https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext)).
Afterwards the system cannot distinguish "never released" from "released, then
flag cleared". Neoting's rule that every exported line resolves back to its
source document dies the moment that distinction is lost. **Release must be an
append-only fact.** If a document must go out again, model it as a *new export
event with a new version*, linked to the prior one — never as the erasure of the
old one. Corrections are new facts, not amnesia.

**R2. Asking the user to adjudicate a data-integrity question in a modal.**
Dext's "Clear publishing data / Keep publishing data" prompt hands a downstream
duplication risk to whoever happens to be unarchiving. Neoting should decide
this in the domain model and never ask.

**R3. Manual out-of-band compensation.** Dext's republish instructions begin
"delete the previously published version in your accounting software"
([416728](https://help.dext.com/en/articles/416728-how-to-republish-an-item)) —
an unverified human step across a system boundary. Any Neoting flow whose
correctness depends on the user remembering to fix something in another product
is broken by design.

**R4. Overriding `Ctrl/⌘ + P` and `Ctrl/⌘ + A`.**
Dext binds these to Publish and Archive
([551293](https://help.dext.com/en/articles/551293-are-there-keyboard-shortcuts-in-dext)).
`⌘ + A` firing *Archive* instead of select-all, near an editable amount field,
is a data-integrity hazard dressed as a convenience. Use unmodified single keys
in a non-input context (`j`/`k`, `a`, `e`) or a leader chord. Never steal
browser-reserved combinations for destructive verbs.

**R5. Inconsistent delete semantics per object type.**
Dext has three (§1.2b). Neoting should have **one** rule, stated once: *nothing
is ever hard-deleted by a user; the submission record is permanent; the working
document's status changes.* Whatever object you are looking at, the answer is
the same. Consistency here is worth more than any individual behaviour.

**R6. "Export items without completing the approval flow."**
An explicit approval bypass in Dext's Approvals tab
([689612](https://help.dext.com/en/articles/689612-how-to-review-and-approve-documents-in-dext)).
Neoting's ceremony is the product. No bypass, not for admins, not for "just this
once". If people need data out before approval, give them a clearly-labelled
*unapproved working extract* that is watermarked and not a release.

**R7. Free-text tags.** Not a Dext feature, and Dext is right to omit it.
Free-text labels in a multi-user practice decay into "Q1", "q1", "Q1 ", "Quarter
1" within a month, and then filters lie. Flags with admin-defined labels, plus
notes for prose. If you later need per-client vocabularies, make them
admin-managed enumerations under RLS — never free text.

**R8. Silent autosave on monetary fields.** Dext autosaves the Details tab with
no save ceremony
([105676](https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext)).
Fine for a category dropdown; wrong for pence. Neoting's constraint that every
state change passes Review → Approve is incompatible with a design where typing
in a total silently commits it. Autosave *drafts*; commit on an explicit action.

**R9. Cross-client movement, in any form Dext might suggest.**
Dext's "Move to" is within-client only, and cross-client transfer is
undocumented (§5.7). Given Neoting's rule that a document belongs to **exactly
one** client business under RLS, do not build a move. If a document was ingested
to the wrong client, the correct operation is **delete-and-reingest with an
audit link**, not a tenant reassignment — a moved row silently invalidates every
export line that already resolved to it under the old tenant.

**R10. Marketing a retention promise you have not engineered.** Dext says "at
least 10 years" in the help centre while its Terms promise nothing
([106130](https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules)
vs [terms](https://dext.com/en/terms-and-conditions)). For a UK practice
audience that gap is a live risk. State one retention number, make it true in
the Terms and in the storage lifecycle policy, and put it in the UI.

### 10.4 Additions forced by the comparator research

**C1. ADOPT AutoEntry's state guards on delete.** "You can't delete or cancel a
document while the upload or processing is in progress", and a published item
must be unpublished before it can be rejected and deleted
([AE 4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement),
[AE 8820077](https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice)).
Dext has neither guard. Neoting's version: **delete is refused while extraction
is in flight, and refused outright for any document with an export line**,
because that link must survive. This is the concrete implementation of "anything
breaking the source link is refused".

**C2. ADOPT AutoEntry's publish-time duplicate check against the destination.**
Checking only within your own database misses the invoice a client keyed
straight into the ledger
([AE 6783974](https://help.autoentry.com/en/articles/6783974-duplicate-check-for-invoices)).
Neoting should check at **release-for-export** time, not only at ingest, and the
configurable **date threshold** idea
([AE 4647925](https://help.autoentry.com/en/articles/4647925-duplicate-check-date-threshold-sage-accounting-xero-and-quickbooks-online))
is worth copying so old documents don't trigger endless false positives.

**C3. ADOPT AutoEntry's resizable image/fields split**
([AE 1312981](https://help.autoentry.com/en/articles/1312981-line-item-extraction))
and its explicit **original file vs generated PDF** distinction
([AE 4704597](https://help.autoentry.com/en/articles/4704597-download-a-pdf-copy-of-your-document))
— but put both downloads in one menu, not on two different screens as AutoEntry
does. For Neoting the **original bytes must always be downloadable**, unmodified,
because that is what an inspector will want.

**C4. ADOPT the humane cancellation path.** AutoEntry keeps data **13 months**
after cancellation, emails a deletion warning, and cancels the deletion if you
simply log in
([AE 1312814](https://help.autoentry.com/en/articles/1312814-how-long-are-documents-stored-in-autoentry),
[AE 11884475](https://help.autoentry.com/en/articles/11884475-inactive-accounts)).
Dext gives ten days and requires a written request. For a UK practice holding
statutory records on behalf of clients, AutoEntry's design is the only defensible
one.

**C5. REFUSE public, non-expiring shareable document links.** AutoEntry offers a
per-document image link with a company-level Public toggle — "anyone with the
link can view" — and **no documented expiry**
([AE 1312956](https://help.autoentry.com/en/articles/1312956-how-to-share-an-invoice-image-link)).
In a multi-tenant product with row-level security, an unauthenticated permanent
URL to a client's invoice defeats the entire access model. If sharing is needed,
issue short-lived signed URLs, scoped to one document, logged in the audit trail,
and revocable.

**C6. REFUSE any move that admits data loss.** AutoEntry warns that moving
between Sales and Purchases "can cause some data loss… around line items or tax
summaries"
([AE 1312917](https://help.autoentry.com/en/articles/1312917-move-invoices-to-another-folder-or-company)).
A bookkeeping product should never ship an operation whose documentation
concedes it silently drops tax data. If a transformation cannot be lossless,
make it an explicit re-create with the old version retained.

**C7. REFUSE "delete and re-upload" as the fix for bad extraction.** That is
AutoEntry's documented remedy, and it charges the customer again
([AE 1312981](https://help.autoentry.com/en/articles/1312981-line-item-extraction)).
Neoting must have a **re-run extraction** action that preserves the document
identity, its submission record and its audit history — otherwise every
extraction bug becomes a broken source link.

**C8. NOTE for anyone writing marketing copy:** do not claim human verification.
AutoEntry's current documentation describes a fully automated pipeline and claims
only "up to 99% accurate" OCR/ML
([AE 1313005](https://help.autoentry.com/en/articles/1313005-invoice-and-statement-processing-times)),
despite a widespread reputation for human review. Claims in this category age
badly; only state what is currently true of Neoting's own pipeline.

**C10. ADOPT Hubdoc's audit-trail lesson, which is written in scar tissue.**
"**Only documents uploaded on or after 5 July 2018 have audit details**"
([Hubdoc, archived](https://web.archive.org/web/20231004124112/https://support.hubdoc.com/hc/en-us/articles/16695107301389-View-a-document-s-audit-trail-in-Hubdoc)).
Eight years on, Hubdoc still ships a permanent caveat because the audit trail was
retrofitted. **You cannot backfill provenance.** Write the audit event on the
very first ingest of the very first document, before the list screen exists.

**C11. ADOPT search-state-in-the-URL.** Hubdoc's "saved searches" are simply the
URL — bookmark it, share it, send it to a colleague
([Hubdoc, archived](https://web.archive.org/web/20231004135512/https://support.hubdoc.com/hc/en-us/articles/16694888963853-Search-for-documents-in-Hubdoc)).
Near-zero implementation cost, and it makes filters shareable across a practice
without building a saved-views feature. Do this instead of saved searches in v1.

**C12. ADOPT a `Failed` tab as a peer of the working list.** Hubdoc's status tabs
are All / Processing / Review / Failed / Archived
([Hubdoc, archived](https://web.archive.org/web/20231004120000/https://support.hubdoc.com/hc/en-us/articles/16695034961933-About-a-document-s-status-in-Hubdoc)).
Documents that failed ingest or extraction must be *visible*, not silently
absent. A document a client believes they sent, which the system dropped, is the
worst failure mode in this category.

**C13. ADOPT Hubdoc's rule that notes never leave the system.** Verbatim: "Notes
will not be published with the document to integrations. Notes are for internal
Hubdoc purposes only"
([Hubdoc, archived](https://web.archive.org/web/20190819165800/https://support.hubdoc.com/hc/en-us/articles/208245073-Add-a-Note)).
Stating plainly where internal commentary can and cannot travel is exactly the
clarity a practice needs before staff will write candidly. Say it in the UI, next
to the field.

**C14. ADOPT type-the-name confirmation for tenant-scale destruction, and a
read-only downgrade as the alternative to deletion.** Hubdoc requires typing the
organisation name to delete it, and offers downgrade — a non-paying, read-only
state where documents remain accessible
([Hubdoc, archived](https://web.archive.org/web/20231004132558/https://support.hubdoc.com/hc/en-us/articles/16664709273357-Downgrade-or-delete-a-Hubdoc-organisation)).
For a practice product, "stop paying" must never be a synonym for "lose the
records". This is also the cleanest answer to §10.2 B9.

**C15. ADOPT email command syntax for ingest metadata.** Hubdoc's `#split` and
`#note [text] #note` in an email
([Hubdoc, archived](https://web.archive.org/web/20231004120000/https://support.hubdoc.com/hc/en-us/articles/16568557035789-Upload-or-email-documents-into-Hubdoc))
let a client who will never log in supply structure at the moment of sending.
Ingest-class writes are exempt from the Approve ceremony anyway, so this fits
Neoting's constitution cleanly.

**C16. REFUSE Hubdoc's card list and its shallow search.** A fixed card list with
no column selection
([Hubdoc, archived](https://web.archive.org/web/20231004135512/https://support.hubdoc.com/hc/en-us/articles/16694888963853-Search-for-documents-in-Hubdoc))
is wrong for professional users processing hundreds of documents; Dext's
configurable dense table is right. And searching only embedded PDF text, not
image OCR, fails on the photographed receipt — which is the single most common
document in the category.

**C17. REFUSE a user-facing "Empty Trash".** Hubdoc has one, and warns "once a
document has been emptied from the trash folder, it can't be restored"
([Hubdoc, archived](https://web.archive.org/web/20231004123423/https://support.hubdoc.com/hc/en-us/articles/16695595279629-Delete-a-document)).
Neoting's export-traceability rule means no ordinary user should ever hold a
button that permanently destroys source documents. Erasure belongs in a
deliberate, logged, admin-level GDPR workflow — not one click from the list.

**C18. Decide pricing before delete.** AutoEntry's per-credit metering — rejected
documents still charged, deletes never refunded, re-uploads charged again
([AE 1312979](https://help.autoentry.com/en/articles/1312979-rejected-invoices),
[AE 4996672](https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement))
— is the reason its delete UX is hostile. Metering per document makes users
afraid of their own document list. If Neoting meters ingest, budget for the UX
consequences explicitly rather than discovering them.

### 10.5 Recommended Neoting behaviour, in one table

For the two implementation agents: this is the opinionated bottom line. Anything
marked **decide** is genuinely open.

| Question | Recommendation |
|---|---|
| Soft or hard delete? | **Soft, always.** A permanent `submission` row plus a `document` whose status changes. No user-facing hard delete. |
| Trash tab? | **No.** Restore lives on the submission/ingest ledger screen, filtered by status = Deleted. |
| Recovery window | **Unbounded** while the tenant is active. Nothing self-purges. |
| Permanent delete | **Not a user action.** GDPR erasure is an admin/DPO workflow, logged, outside the document list. |
| Delete refused when… | extraction in flight; document has any export line; document is inside a locked period; document is Approved (must be un-approved via ceremony first). |
| Delete permission | A **named, explicit permission**, separate from edit. Dext does not have one; that is a mistake. |
| Reason on delete/reject | **Mandatory**, enum + free text, following AutoEntry's picker. |
| Deleting a grouping | **Releases** members back to the working list. Never cascades. |
| Archive | Separate verb, **automatic** on approve and on export, reversible, fully searchable. |
| Un-archiving a released document | Allowed, **but the release record is never cleared.** No equivalent of Clear Publishing Data. |
| Re-release | A **new export event, new version, linked to the prior one.** Never erasure. |
| Preview | Full page, side-by-side, resizable split, rotate/zoom/fullscreen, **multi-page stepper** (all vendors are weak here — beat them), original-bytes download *and* generated-PDF download in one menu. |
| Viewer keyboard | `j`/`k` next/previous, unmodified, non-input context only. **Never** rebind `⌘P`/`⌘A`. |
| Bulk verbs v1 | Approve/Request approval, Flag add/remove, Bulk edit (coding fields only), Archive/Unarchive, Export, Delete. |
| Bulk confirmation | Proportional to external irreversibility: **release/export confirms**; archive does not; delete confirms with reason. |
| Bulk limit | **Decide.** Only documented precedent is AutoEntry's absence of bulk delete and Dext's 250-item PDF export cap. |
| Tags | **No free text.** Admin-defined flags with labels; notes for prose. |
| Move between clients | **Refused.** Delete-and-reingest with an audit link instead. |
| Duplicate keys | Receipts: supplier + date + total + owner. Invoices/credit notes: supplier + total + reference. Exact integer-pence equality. |
| Duplicate default mode | **Review** (side-by-side), not auto-delete. |
| Duplicate check at release | **Yes** — check the destination too, with a configurable date threshold (AutoEntry's best idea). |
| Split | Two named operations: **allocate** (amount, children must sum exactly to parent) and **split pages** (real page division). Both keep a link to one source document. |
| Merge | Preview + editable result + mismatch warning + a real **Unmerge**. |
| Re-run extraction | **Required**, preserving document identity, submission row and history. |
| Client query-back | **Email with tokenised reply**, never app-dependent. |
| Audit trail | Per-document history including delete, restore, merge, split, approve, release, and **before→after values** on field changes. Visible to all users, default-filtered to "mine", with a named "access all documents" permission to widen. |
| Retention | State **one** number; make it true in the UI, the Terms and the storage lifecycle. Post-cancellation window measured in **months, with a warning email**, not Dext's ten days. |
| HMRC copy | Claim the **format is acceptable**; never claim to be the client's statutory archive. |

### 10.6 Open questions the implementation team must decide (no vendor precedent)

None of the four vendors documents these; do not wait to find an answer.

1. **Maximum multi-select size** and whether bulk actions run synchronously or
   as a job with progress. Dext documents only "250 items per PDF export".
2. **Whether a document in an approved-and-exported state can be deleted at
   all.** My recommendation: no — only *superseded*, which is a new state, not a
   deletion.
3. **Locked-period behaviour.** Confirmed: **no vendor here locks its own
   documents by period.** Dext's only lock-date feature merely *monitors* the
   lock dates set in Xero/QBO
   ([278973](https://help.dext.com/en/articles/278973-using-the-lock-date-history-check));
   AutoEntry documents nothing comparable. Neoting must invent this. Proposed
   rule: **a locked period blocks Approve and Delete for documents dated inside
   it, and never blocks ingest** (ingest-class writes are exempt by Neoting's own
   constitution, and refusing ingest would just push paperwork back into email).
   Unlocking must itself be a Review → Approve action with a recorded reason.
4. **Exact refusal copy.** No vendor publishes its error strings. Write them
   deliberately: say what is blocked, why, and what the user can do instead.

---

## Appendix A: source list

### Dext Help Centre — "Manage documents" collection (59 articles)

Collection root: https://help.dext.com/en/collections/878054-manage-documents
(Other collections: `878035-get-started`, `878052-capture-documents`,
`878041-connect-export`, `1450023-add-ons-advanced-features`,
`878039-manage-your-account`, `878050-security-access`,
`1450017-subscriptions-billing`, `878076-help-troubleshooting`.)

Articles most relevant to a document list screen:

| URL | Title |
|---|---|
| https://help.dext.com/en/articles/416718-how-to-use-the-actions-menu-in-dext | How to use the Actions menu in Dext |
| https://help.dext.com/en/articles/416742-what-is-the-archive-in-dext | What is the Archive in Dext? |
| https://help.dext.com/en/articles/416746-how-to-archive-and-unarchive-items-in-dext | How to archive and unarchive items in Dext |
| https://help.dext.com/en/articles/105789-the-costs-inbox | The Costs inbox |
| https://help.dext.com/en/articles/416748-the-sales-inbox | The Sales inbox |
| https://help.dext.com/en/articles/416750-what-do-to-review-and-ready-mean-in-dext | What do "To review" and "Ready" mean |
| https://help.dext.com/en/articles/105914-how-to-search-through-the-inbox-and-archive | How to search through the Inbox and Archive |
| https://help.dext.com/en/articles/105716-managing-table-columns-and-density-in-inbox-archive-and-approvals | Managing table columns and density |
| https://help.dext.com/en/articles/105787-how-to-use-the-submission-history-in-dext | Submission history |
| https://help.dext.com/en/articles/551293-are-there-keyboard-shortcuts-in-dext | Keyboard shortcuts |
| https://help.dext.com/en/articles/522481-how-to-use-flags-to-organise-your-inbox | Flags |
| https://help.dext.com/en/articles/105676-how-to-use-the-item-details-page-in-dext | Item details page |
| https://help.dext.com/en/articles/416737-how-to-merge-items-in-dext | Merge items |
| https://help.dext.com/en/articles/416731-how-to-split-an-item-in-dext | Split an item |
| https://help.dext.com/en/articles/416724-how-to-use-item-messaging-in-dext | Item messaging |
| https://help.dext.com/en/articles/216124-how-dext-handles-duplicate-cost-documents | Duplicate Cost documents |
| https://help.dext.com/en/articles/416734-how-to-move-items-between-workspaces-in-dext | Move items between workspaces |
| https://help.dext.com/en/articles/416728-how-to-republish-an-item | Republish an item |
| https://help.dext.com/en/articles/416716-how-to-edit-publish-and-export-items-in-dext | Edit, publish, export items |
| https://help.dext.com/en/articles/689612-how-to-review-and-approve-documents-in-dext | Review and approve documents |
| https://help.dext.com/en/articles/219981-how-to-set-up-approval-workflows-for-cost-and-sales-documents | Approval workflows |
| https://help.dext.com/en/articles/689941-how-do-approval-permissions-work-in-dext | Approval permissions |
| https://help.dext.com/en/articles/416713-rules-and-automation-in-dext | Rules and automation |
| https://help.dext.com/en/articles/416726-how-to-use-smart-split-in-dext | Smart split |
| https://help.dext.com/en/articles/105940-how-to-delete-an-expense-claim | Delete an Expense Claim |
| https://help.dext.com/en/articles/106031-what-is-boost-in-dext | Boost (extraction speed) |

### AutoEntry Help Centre (help.autoentry.com, Intercom)

| URL | Topic |
|---|---|
| https://help.autoentry.com/en/articles/4996672-delete-an-invoice-or-supplier-statement | Delete (hard, two-step, no bulk) |
| https://help.autoentry.com/en/articles/8820077-manually-reject-an-invoice | Reject + mandatory reason picker |
| https://help.autoentry.com/en/articles/15262062-recycle-bin-in-file-management | Recycle bin (File Management only) |
| https://help.autoentry.com/en/articles/8937708-delete-an-expense | Delete an expense |
| https://help.autoentry.com/en/articles/11653802-delete-a-bank-statement | Bank statement deletion (support-only) |
| https://help.autoentry.com/en/articles/1312910-delete-a-company | Delete a company |
| https://help.autoentry.com/en/articles/1312979-rejected-invoices | Rejected invoices still charged |
| https://help.autoentry.com/en/articles/6007778-autoentry-credits-explained | Credit pricing |
| https://help.autoentry.com/en/articles/15705158-manage-autoentry-credits | Credit expiry |
| https://help.autoentry.com/en/articles/11910976-inbox-overview | Inbox, filters, bulk actions, inline edit |
| https://help.autoentry.com/en/articles/1312926-manage-archived-documents | Archived tab |
| https://help.autoentry.com/en/articles/4729991-archive-a-document | Archive |
| https://help.autoentry.com/en/articles/1313066-auto-archive-invoices | Auto-archive |
| https://help.autoentry.com/en/articles/8541259-unpublish-and-republish-an-invoice | Unpublish / republish |
| https://help.autoentry.com/en/articles/1312917-move-invoices-to-another-folder-or-company | Move (incl. cross-company, lossy) |
| https://help.autoentry.com/en/articles/1482856-upload-documents-to-autoentry | Upload-time page split modes |
| https://help.autoentry.com/en/articles/6783974-duplicate-check-for-invoices | Three-stage duplicate check |
| https://help.autoentry.com/en/articles/4647925-duplicate-check-date-threshold-sage-accounting-xero-and-quickbooks-online | Duplicate date threshold |
| https://help.autoentry.com/en/articles/4704597-download-a-pdf-copy-of-your-document | PDF download from viewer |
| https://help.autoentry.com/en/articles/1312981-line-item-extraction | Resizable image/line-item split view |
| https://help.autoentry.com/en/articles/1312956-how-to-share-an-invoice-image-link | Public/private share links |
| https://help.autoentry.com/en/articles/4858792-file-management-overview | File Management staging area |
| https://help.autoentry.com/en/articles/9760125-manage-files-in-file-management | File Management bulk actions |
| https://help.autoentry.com/en/articles/1312814-how-long-are-documents-stored-in-autoentry | Retention (7 years / 13 months) |
| https://help.autoentry.com/en/articles/1312872-cancel-your-subscription | Cancellation |
| https://help.autoentry.com/en/articles/11884475-inactive-accounts | Inactive-account deletion warning |
| https://help.autoentry.com/en/articles/15518992-invoice-history | Per-document audit trail |
| https://help.autoentry.com/en/articles/1312938-activity-tab-in-a-folder | Activity tab (immutable ledger) |
| https://help.autoentry.com/en/articles/4670932-the-document-id | Document ID |
| https://help.autoentry.com/en/articles/11991722-access-and-permission-settings | Folder-level permissions |
| https://help.autoentry.com/en/articles/1313005-invoice-and-statement-processing-times | Processing pipeline (no human review) |

### Hubdoc (Wayback captures of the former Zendesk KB, revised 26 June 2023)

Current equivalents live at `https://central.xero.com/s/article/<slug>` but are
unreadable to non-browser fetchers.

| Archived URL | Topic |
|---|---|
| https://web.archive.org/web/20231004123423/https://support.hubdoc.com/hc/en-us/articles/16695595279629-Delete-a-document | Delete, Trash, Empty Trash |
| https://web.archive.org/web/20231004132425/https://support.hubdoc.com/hc/en-us/articles/16699660016269-Delete-a-document-using-the-mobile-app | Mobile delete |
| https://web.archive.org/web/20231004132558/https://support.hubdoc.com/hc/en-us/articles/16664709273357-Downgrade-or-delete-a-Hubdoc-organisation | Org delete / read-only downgrade |
| https://web.archive.org/web/20231004120000/https://support.hubdoc.com/hc/en-us/articles/16695858907789-Resolve-issues-with-documents-in-Hubdoc | Duplicates, Show Duplicates panel |
| https://web.archive.org/web/20231004120000/https://support.hubdoc.com/hc/en-us/articles/16695034961933-About-a-document-s-status-in-Hubdoc | Status tabs, sorting |
| https://web.archive.org/web/20231004135512/https://support.hubdoc.com/hc/en-us/articles/16694888963853-Search-for-documents-in-Hubdoc | Search, saved-search-by-URL, card list |
| https://web.archive.org/web/20190819172007/https://support.hubdoc.com/hc/en-us/articles/360016251872-Advanced-Search | Advanced search (2018) |
| https://web.archive.org/web/20231004131733/https://support.hubdoc.com/hc/en-us/articles/16699481651853-Organise-documents-with-tags-and-folders | Tags, folders, multi-select |
| https://web.archive.org/web/20231004142050/https://support.hubdoc.com/hc/en-us/articles/16699638666765-Download-or-export-documents-from-Hubdoc | Download, ZIP, CSV export |
| https://web.archive.org/web/20231004121147/https://support.hubdoc.com/hc/en-us/articles/115001289603-Manually-enter-data-for-a-document | Data toolbar, line-item dialog |
| https://web.archive.org/web/20190819165800/https://support.hubdoc.com/hc/en-us/articles/208245073-Add-a-Note | Notes are internal only |
| https://web.archive.org/web/20231004120000/https://support.hubdoc.com/hc/en-us/articles/16568557035789-Upload-or-email-documents-into-Hubdoc | Email ingest, `#note` |
| https://web.archive.org/web/20190723201535/https://support.hubdoc.com/hc/en-us/articles/360016467291-Multi-Page-PDF-Splitting | `#split`, page splitting |
| https://web.archive.org/web/20231004124112/https://support.hubdoc.com/hc/en-us/articles/16695107301389-View-a-document-s-audit-trail-in-Hubdoc | Audit trail, 5 July 2018 cutoff |

### Xero

- https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_files.yaml — Files API: `deleteFile`, `deleteFolder`, no restore endpoint
- https://www.xero.com/legal/terms/ — Terms of Use §60, post-termination archiving
- https://www.xero.com/legal/privacy/ — retention, no stated period
- https://www.xero.com/hubdoc/ — Hubdoc marketing; no retention duration claimed

### Dext — other sources

- https://dext.com/en/terms-and-conditions — Schedule 1, clause 6.5(f), post-termination data destruction
- https://dext.com/en/privacy-policy — six-year retention of Dext's own customer records
- https://help.dext.com/en/articles/106130-does-dext-comply-with-tax-authority-record-keeping-rules — HMRC/tax-authority framing, "at least 10 years"
- https://help.dext.com/en/articles/215320-roles-and-permissions-in-dext — roles and named permissions
- https://help.dext.com/en/articles/339544-how-to-use-vault-in-dext — Vault, folders, tags
- https://help.dext.com/en/articles/377041-how-to-back-up-your-documents-in-dext — cloud backup
- https://help.dext.com/en/articles/278973-using-the-lock-date-history-check — lock date monitoring

Tip for future researchers: the Dext help centre exposes a working search
endpoint at `https://help.dext.com/en/?q=<terms>`, which returns article titles
and URLs. It was the most efficient way to navigate the site without WebSearch.

**Research constraint note:** the WebSearch quota for this session was already
exhausted when this agent started, so all sourcing below is by direct WebFetch
of vendor documentation URLs. That biases sources toward official help centres
(good for accuracy) and away from third-party reviews (a gap; noted where it
matters).
