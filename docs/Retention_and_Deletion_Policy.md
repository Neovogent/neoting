# Retention and deletion policy

**Version 1.0 · 7 September 2026 · owner-ruled in session (Shakib)**
Policy id, as recorded on every automated execution: `retention/trash@2026-09-07`

This document exists because review items **61** and **67** asked one question
between them — *"how will the trash hold the file? Clear that out"* — and the
product had no answer. The 2 September 2026 document-management work
deliberately promised **no** recovery window, on the correct ground that *"a
figure would be a promise the product does not keep"*: nothing enforced one.
Three research passes confirmed that no vendor in this market — Dext, Hubdoc,
AutoEntry, Xero — publishes a figure either.

The owner ruled the figures on 7 September 2026. **This file is where they are
written down; every surface that states one reads it from
`TRASH_RETENTION_DAYS` in `packages/contracts/src/retention.ts`, and the two
must move in the same commit or this document is fiction.**

---

## 1. The window: thirty days

**A document you delete is held for 30 days and then deleted for good.**
Ruled over 7 and 90: thirty is the interval every accountant already recognises
from their operating system, Google Drive and Dropbox, so it needs no
explaining, and it is long enough that a mistaken bulk delete is still
recoverable at the next month-end pass.

The same figure governs **one-click restore of a removed client** (§4). One
number for the whole of package L was the owner's explicit choice over two that
would drift.

### ⚠ The window has a second clause, and it is never optional

> **Anything already exported is held indefinitely instead.**

D43 promises that every exported transaction carries a resolvable link back to
its source document. A purge would turn a working URL inside an accountant's VT
file into a permanent `410`, weeks or months later, with nobody watching. The
refusal is `NT-DOC-002` and it binds **everybody, including the practice super
admin** — it is not a permission, it is a property of the data.

Four conditions hold a document for good, all read as ROWS rather than inferred
from `state` (`purge-document.ts` argues each one out):

| Held because | Why `state` cannot answer it |
|---|---|
| `state = 'PUBLISHED'` | the only one it does answer |
| a `publishes` row exists | it HAS been released even if `state` has since moved |
| a `document_links` row exists | the D43 capability code itself — including revoked and expired ones |
| a `statements` / `supplier_statements` row names it | ⚠ no foreign key exists on those columns, so nothing in Postgres would notice them dangling |

**Every surface that prints the window prints both clauses.** One without the
other is a promise the product will not keep, in whichever direction it is
missing. Pinned by tests in `DocumentsView.test.tsx` and
`ClientTrashPanel.test.tsx`.

---

## 2. What enforces it

`scripts/purge-expired-trash.ts`, run as an operator's daily tick:

```bash
pnpm trash:purge            # dry run — prints what WOULD go, and what is held
pnpm trash:purge --apply    # purges
```

It walks practice by practice through `scopedDb` (a plain unscoped query
returns an empty list and does not error — `documents` is under FORCE ROW LEVEL
SECURITY), applies the same four refusals as the human-facing
`document.purge`, and **skips** a protected document rather than refusing the
batch: one held document must not stop the other four hundred.

### Governance §10.5 — what authorises an automated destruction

§10 forbids a state change outside Review → Approve, with one door: *standing
automations execute without per-item proposals only under a policy that was
itself approved through this contract*, and *automated executions record the
policy ID they ran under*.

- **The policy is a platform term, not a per-practice toggle.** No practice
  turns it on, off, or to a different number, so there is no `policies` row for
  anyone to approve; its approval is the owner's ruling and its text is this
  document.
- **Consent is taken at the moment of deletion**, not at the moment of purge.
  Every accountant is told the window in the confirmation dialog *before*
  anything moves to Trash, and again in the Trash view they restore from.
- **Every purge appends an audit row** (`document.purge.retention`) naming
  `TRASH_RETENTION_POLICY_ID`, written in the same transaction as the delete and
  **before** it — `document_events` cascades away with the document, so that row
  plus its hash link is the only surviving record.

⚠ The stored object is **not** reclaimed. An executor may not make an external
call, and the sweep keeps the same limitation; the audit row says
`storedObjectsRetained: true` so no operator concludes otherwise. An
object-lifecycle sweep is separate work and does not exist.

---

## 3. Removing a client asks what it means

`business.offboard` is soft and always has been — `is_active` flips, nothing is
deleted, the books stay under D12's six-year clock. What it never said was what
happens to the client's **documents**, and that silence was review item 67's
bug: they stayed live in the practice's queues, still offering Publish, under a
CLIENT column that had nothing left to resolve.

Offboarding now states its blast radius at Read review and acts on it. **All
three scopes are reversible**, because UK bookkeeping permits no fourth: D12
holds the books six years, D32 promises reading and exporting survive a lapse,
and D43 refuses to purge anything an export still links to.

| Scope | What happens | What does not |
|---|---|---|
| `keep` (default) | The documents are untouched. They leave the practice-wide queues with the client and come back if it is restored. | Nothing else. |
| `trash` | Every one of the client's documents not already in Trash is stamped `deleted_at`, through the same reversible seam `POST /documents/{id}/deletion` writes. §1's window then applies to them. | A document ALREADY in Trash keeps its own deletion moment — the window it is serving is not restarted. |
| `mark-for-erasure` | `businesses.erasure_requested_at` is stamped: the practice's stated intention that this client's data be erased once the statutory duty lapses. | **Nothing is erased and nothing is scheduled.** |

### ⚠ `mark-for-erasure` is a flag, not a timer

The owner ruled **erasure on request, no automatic date** (7 Sep 2026). Any
fixed window shorter than D12's six years would be this product deleting a UK
practice's statutory records out from under their legal duty, on a timer nobody
watched.

**No code in this repository may read `erasure_requested_at` and act on it on a
schedule.** The column exists so a later, deliberate, audited erasure surface
can find the clients that asked. Every surface says *marked*, never *scheduled*
— pinned in `OffboardClientDialog.test.tsx`.

---

## 4. A removed client is restorable

`business.reactivate` (the contract delta approved 7 Sep 2026) is offboard's
exact mirror: soft, idempotent, tier 1 — the undo of a tier-1 act belongs to the
same signature. It flips `is_active` back and clears both offboarding stamps.

**Clients → Removed** lists them with the removal date and the days left, and
Restore goes through Review → Approve like everything else.

⚠ **Restoring does not bring documents back out of Trash**, and the review card
says so. `documents.deleted_at` records *that* a document was deleted, not which
act deleted it, so a blanket restore would also resurrect everything a person
had trashed deliberately weeks earlier. The client's own Trash is where they
come back from, one at a time, each in the state it left.

### ⚠ Nothing is erased when the client window lapses

After 30 days the client stops being offered for **one-click** restore. That is
all that happens. The books stay under D12's clock, the workspace stays
reachable by id, and the panel says so in as many words — a row that simply
stopped offering a button would read as a countdown to destruction. Pinned in
`RemovedClientsPanel.test.tsx`.

---

## 5. What this policy does not cover

Named deliberately, so nobody reads silence as a decision:

- **The stored objects.** Purging destroys rows; the bytes in the object store
  are not reclaimed. Needs an object-lifecycle sweep that does not exist.
- **Actual erasure.** `mark-for-erasure` records intent. The surface that
  performs an audited erasure after the retention duty lapses is not built, and
  building it needs its own ruling — starting with who may approve it.
- **A restored client's subscription.** D48 bills £8.50/month per client
  business through Stripe; what happens to a subscription across
  offboard → reactivate is undefined, and `business.reactivate` deliberately
  touches no billing column rather than guessing. Item 67's notes entry carries
  this as an open question for the owner.
- **The whole-firm export at cancellation** (D32). Its own surface, unchanged.

---

## Rulings, dated

| Question | Ruling | Date |
|---|---|---|
| How long is a trashed document held? | 30 days, then auto-purge; exported documents held indefinitely | 7 Sep 2026 |
| How long is a removed client one-click restorable? | The same 30 days — one number for the whole policy | 7 Sep 2026 |
| Does offboarding ask what happens to the documents? | Yes — three scopes: keep / trash / mark-for-erasure | 7 Sep 2026 |
| When does `mark-for-erasure` erase? | On request, **no automatic date** | 7 Sep 2026 |
| Can a removed client be brought back? | Yes — `business.reactivate`, tier 1, with a Removed clients listing | 7 Sep 2026 |
