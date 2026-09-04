# banking-matching

**Lane F** · **Source of Truth:** SoT §4 Stage 7 · **Built by:** METH S11 · **Contract:** `GET /v1/bank-transactions`

## Purpose

TrueLayer feeds, statement import, the normalised transaction schema, the match engine, cash coding, and chase-suppression descriptors.

## ⚠ Initial Delivery (ID) — read this before the sections below

**D40 supersedes D4 for ID: manual statement upload is the ONLY bank input** (SoT §24.2 Stage 7). No TrueLayer, no consent lifecycle, no 90-day reconfirmation, no feed normalisation in the first client release.

- **Statement import is not the fallback here — it is the product.** The invariant below still reads “statement upload is the fallback that means books never stall”. In ID it is the *only* path, which raises the stakes on everything downstream: a transaction the extractor drops is a document that is never chased, and nothing else will catch it.
- **D41 makes that a hard gate, not a confidence score.** Statement extraction must prove completeness: balance continuity to the penny, page accounting, date monotonicity, in-statement dedupe, and cross-statement period-gap detection. A statement with no running-balance column is a **distinct reduced-assurance class**, not a silent pass. Accepted formats are PDF, CSV and XLSX, uploadable by accountant *and* client, per client, per period.
- **The normalised `bank_transactions` schema stays exactly as it is.** It is what the statement extractor targets, and keeping it is precisely what makes TrueLayer a later addition rather than a later rewrite.

D4 stands unchanged for v1.

**Built today: the read surface only.** One GET over the normalised
`bank_transactions` schema. The *write* half of matching lives on the Review →
Approve spine as the `bank.confirm-match` executor — in
`validation-dedupe/proposals/confirm-match.ts`, beside the other ten, because
that is where the registry composes them.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Matching links documents to existing transactions — it never creates transactions. Statement upload is the fallback that means books never stall.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Current state — the read surface (METH S11)

`GET /v1/bank-transactions` — the normalised feed, newest booked first,
`x-nt-side-effect: none`.

- `bank-transactions.controller.ts` — thin: `coerceQuery` → `parseBoundary`
  against the generated `listBankTransactionsQueryParams` → **one** service
  call. `coerceQuery` first, because Express delivers every query value as a
  string and a once-given repeatable filter as a bare value, while the schema
  types `limit` as a number and `matchState` as an array — without it the exact
  call the Bank screen makes is a 400.
- `bank-transactions.service.ts` — one method, `listBankTransactions`, and **no
  method that writes**. That is structural, the same way `modules/documents`
  has no write: there is no `PATCH /bank-transactions/{id}` and none may exist,
  so the absence of a mutating method is the enforcement rather than a promise.
  A unit test pins the method list.
- `bank-transaction-response.ts` — the row → contract projection, in its own
  file so the second surface that needs it uses the same one.

Three decisions worth knowing before changing anything here:

- **The sort is a CONSTANT, not a lookup table.** `listBankTransactions`
  declares no `sort`/`order` parameter; the contract fixes the answer in prose
  ("newest booked first"). There is no caller-supplied column to validate, and
  offering one would be inventing contract surface. `nullable: false` on the
  `bookedAt` sort field is load-bearing — Prisma throws at runtime on
  `orderBy: { col: { sort, nulls } }` for a required column.
- **There is no hidden default filter.** `GET /documents` excludes ARCHIVED
  when `state` is omitted; this excludes nothing, because a bank feed has no
  archive and a transaction quietly missing from the screen is a
  reconciliation that silently never balances. An explicitly *empty*
  `matchState` array is treated as no filter — `{ in: [] }` matches nothing and
  reads on screen as "the feed is empty".
- **`chaseSuppressed` is read off the column, never recomputed.** The
  descriptor rules (SERVICE CHARGE, STRIPE PAYOUT…) belong to the chase lane; a
  second implementation on the read path is how the Bank screen and the chase
  list start disagreeing about which lines have paperwork to chase.

## The automatic match suggester (Phase 4, 1 Sep 2026) — `suggestion/`

`confirm-match.ts` predicted it in code ("the seed (and, later, an automatic
suggester) writes SUGGESTED rows") and this is it: after extraction, the ingest
processor runs `PrismaMatchSuggester` for every routed, landed document.

- **One ruler.** The compare is the chase seam's own `chaseMatchesDocument` +
  tolerances — the predicate auto-close closes on — so a suggestion and a
  chase-close can never disagree. No second tolerance exists here.
- **Exactly one candidate, or nothing.** The `field-geometry` stance: two
  equally-fitting lines (the recurring direct debit) suggest neither, because a
  SUGGESTED line leaves the chase-detection set and a wrong guess would
  silently stop chasing a line whose paperwork never came.
- **Flip-first, compare-and-swap.** `matchState UNMATCHED→SUGGESTED` guarded
  `updateMany` runs BEFORE the `matches` insert; a race with a concurrent
  confirm flips nothing and writes no orphan row. Idempotent per document (one
  live match row max; an `unmatchedAt`-stamped row does not block).
- **A suggestion gates nothing** (Governance §9.5): `bank.confirm-match`
  promotes it, humans only. `matchedBy: 'auto-suggester'`, deterministic
  confidence (1 pence-equal, 0.9 within tolerance), kind EXACT/PROBABILISTIC.
- Wired as a REQUIRED `ProcessorDeps.matchSuggester` (`NO_MATCH_SUGGESTER` for
  bankless roots), runs before auto-close, never fails the job. Proven against
  real RLS in `suggestion/match-suggester.integration.test.ts`.

**Two read surfaces landed with it (LAW ceremony retired 1 Sep — see
packages/contracts/CLAUDE.md):** `BankTransaction.matchedDocumentId` (the
CONFIRMED match's document, joined in the list projection — SUGGESTED
deliberately leaves it null: a suggestion is a question, not evidence) and
`GET /documents/{documentId}/bank-match` (`getDocumentBankMatch` on the
service; CONFIRMED outranks newest SUGGESTED; 404-never-403 on an unreachable
document; the embedded transaction goes through the SAME `toBankTransaction`
projection — the "second surface" its header predicted).

## Textract fuses adjacent columns page-by-page (31 Aug 2026)

On a real 29-page statement the header came back as `CREDIT BALANCE` in ONE
cell, with data rows one cell short on some pages (`"25.97 17,321.32"` fused)
and full-width on others — in the same document. Consequence before the fix:
every credit skipped "has no amount", `noBalanceColumn` on a statement whose
every line shows a balance, null opening/closing. `statement-parser.ts` now
maps a fused last header cell as two logical columns (closed vocabulary, both
halves anchored — "Balance brought forward" still matches nothing) and
realigns one-short rows: two money tokens split into amount+balance, a lone
token is the balance, every other shape stays a visible skipped line.
`parseMoneyPence` refuses whitespace between digits, closing the latent shape
where a fused pair parsed as one £259M amount with a null balance beside it —
the one lie the continuity check could not interrogate. Also observed:
Textract returned the LAST transaction row of most pages as an empty table
row; the D41 gate reports each as a `balanceBreak` with the exact missing
amount — that is the gate catching real truncation, not a parser defect. A
CSV of the same account proves complete.

## `GET /v1/statements` — the D41 verdict, where someone can read it

`statements.service.ts` + `statements.controller.ts`, added 29 Aug 2026.

**⚠ A verdict nobody can see is not a gate.** This lane has written `assurance`
since the day it shipped and nothing could read it: the accountant's Statements
tab was seed data, so a statement the product had *proven* incomplete looked
exactly like one it had proven whole. The first real statement through the
pipeline imported 1,144 transactions and reported `incomplete` — correctly — and
that verdict reached nobody. D41 is a claim about what the product can
demonstrate, and demonstrating it needs a surface.

- **It is provenance and proof, not rows.** The transactions stay
  `GET /bank-transactions`. This answers "which file did these come from, for
  what period, and what could we not prove about it" — which is also D43's
  resolvable link from an exported line back to its source document.
- **An unreadable `gapAnalysis` reports `reduced`, never `complete`.** The column
  is `Json?`, so a row written by an older build may carry anything; the one
  thing this must never do is claim a statement was proven whole because its
  analysis could not be parsed.
- **`businessId` NARROWS, it does not enforce.** RLS has already bounded the
  set. A business outside the caller's reach yields an empty page — the same
  answer as "no statements", and it never confirms the business exists.
- **There is no POST and none may be added.** A statement is created by
  UPLOADING one; a write door here would be a second way to create bank data,
  and the two would disagree.

## Removing a statement — design note, 3 Sep 2026

An accountant must be able to take a wrongly-uploaded statement back out —
one at a time or several at once. **The mechanism is a proposal, and only a
proposal**: a new `bank.remove-statement` kind on the Review → Approve spine,
executed by `validation-dedupe/proposals/remove-statement.ts` beside the other
eleven. The "no POST and none may be added" rule above extends to deletion
unchanged: there is **no `DELETE /v1/statements/{id}`** and none may exist. A
statement is created by one door (upload → ingest) and destroyed by one door
(the engine), so the two can never disagree — a bare DELETE endpoint is exactly
the side-effect path Governance §10 forbids.

### Hard delete of the DERIVED rows, and why not a soft delete

The `Statement` + `BankTransaction` rows are a **projection of the uploaded
file**, and the file — the source document — is never touched by removal. That
is what decides hard-vs-soft:

- **The reversal path is re-import, and it is better than un-hiding.** The
  document stays in the vault, `statementAlreadyIngested` keys on `documentId`,
  so removal frees the document for re-ingest — and a re-import re-runs the D41
  gate, so restored data is re-PROVEN rather than trusted. A soft-deleted row
  set would either block re-ingest forever or allow a second `Statement` for
  the same document, and un-deleting the first would double the feed.
- **Every reader agrees automatically.** A `deletedAt` flag must be honoured by
  the bank feed, chase detection, the match suggester, `GET /statements` and
  the `statementGaps` count on `GET /businesses` — and the one reader that
  misses the filter chases a client by email for a line the accountant removed.
  That two-doors-disagree failure is this module's central hazard ("the
  unmatched set is the chase list's set"). Deleted rows disagree with nobody.
- **The schema already votes for it.** `Match.transactionId` is
  `onDelete: Cascade` (a suggestion dies with its line); `Chase.transactionId`
  is `onDelete: SetNull` (the record of a sent email survives, `itemRefs` keeps
  the ids as history). A soft delete would additionally need `deletedAt` on two
  models — a prisma **LAW** change the hard delete does not need.

What must NOT be silently destroyed is protected by refusals, not by a flag —
see the guards below. The audit record of what was removed is the proposal row
itself (payload + rendered review + outcome), the engine's audit event, and a
`DocumentEvent` (`stage: 'statement'`, `outcome: 'removed'`) on the source
document, written in the effect transaction.

### Provenance: `importBatchId` is the link, written at ingest since 3 Sep 2026

`BankTransaction.importBatchId` existed in the schema and **nothing wrote it**
— so there was no provable link from a transaction to the statement that
created it (period+account overlap is a guess, and two uploads of the same
month would claim each other's rows). `ingestStatement` now stamps
`importBatchId: statement.id` on every row it creates. No schema change: the
column was already there.

**A statement whose rows predate the stamp cannot be provably enumerated and
its removal REFUSES by name** (`rowCount > 0` with no provenance rows, or a
provenance count that disagrees with `rowCount`). Deleting by period guess
would remove another statement's lines.

### The guards (each one a refusal with the numbers in it)

- **A CONFIRMED match blocks removal.** A match is an accountant's assertion,
  and breaking one has no approved path (`bank.unmatch` has no `ProposalKind` —
  the standing TODO below). The refusal names how many lines are matched.
  Checked at proposal creation AND re-checked at execution.
- **An open chase blocks removal.** A client has been asked for paperwork
  against a line; deleting the line under an in-flight chase leaves the portal
  pointing at nothing. Closed chases are history and survive via `SetNull`.
  The guard reads `itemRefs`, not just `transactionId` — a grouped chase
  carries only its first id in the column.
- **A batch spans ONE business** (the chase.send rule) and is capped at 50.
- **The preview is the server's, twice** (the publish.batch pattern): creation
  computes `{transactionCount, matchedCount, openChaseCount}` per statement and
  stores it in the payload — the caller's figures are discarded — and the
  executor recomputes at approve and refuses on drift. `NT-PRP-004` cannot see
  live-fact drift; the executor is the only place it is visible.
- **Idempotent replay** is answered from the `DocumentEvent` stamped with the
  proposalId (the statement row is gone, so the event is the durable marker) —
  a redelivery deletes nothing twice and never mistakes "already removed by
  this proposal" for "not yours".

`statementGaps` on `GET /businesses` needs no change: it counts `gapAnalysis`
off statement rows, and a deleted row simply stops contributing.

### ✅ The LAW changes LANDED on 4 Sep 2026 — removal is live end to end

Every item below shipped exactly as specified (the G7 ceremony was retired
1 Sep): the enum value, `BankRemoveStatementPayload`, the request member +
discriminator mapping, and the whole mechanical wiring list (registry, payload
map, `proposal-body.ts`, `computeRemoveStatementPayload` branch, shaped review
card, `RELEASE_KINDS: false` per the recommendation below — awaiting human
ratification — `KIND_LABEL`/`KIND_NOTE`, and the live Bank-screen Remove, which
now stages the proposal with queue-posture copy). Proven live the same day:
the matched statement refused by name, the clean one queued → reviewed →
approved → its 8 provenance-stamped rows deleted with the removal marker on the
source document. The section is kept below as the design record.

### The original design note (LAW delta as specified — now landed)

1. `packages/contracts/openapi.yaml` — `ProposalKind` enum gains
   `bank.remove-statement` (# remove an uploaded statement and the transactions it imported).
2. `packages/contracts/openapi.yaml` — new schema `BankRemoveStatementPayload`:
   `statementIds` (string array, 1..50, uniqueItems) + `preview` (server-computed:
   per-statement `statementId`, `documentId`, `fileName`, `periodStart`,
   `periodEnd`, `transactionCount`, `matchedCount`, `openChaseCount`, plus
   `totalTransactions`), with the `PublishBatchPayload.preview` language: the
   caller's preview is discarded and the server's stored.
3. `packages/contracts/openapi.yaml` — new `BankRemoveStatementProposalRequest`
   member (`ProposalRequestBase` + `kind: {const: bank.remove-statement}` +
   the payload), added to `CreateActionProposalRequest`'s `oneOf` AND its
   discriminator mapping.
4. **No `prisma/` change** (hard delete; `ActionProposal.kind` is a plain
   `String`; `importBatchId` already exists). **No `packages/validators`
   change.** No new endpoint.
5. Refusals ride the engine's existing `NT-PRP-006`; a named code (e.g. for
   "matched lines block removal") is optional and NOT requested.

Mechanical wiring once the kind exists (not LAW, listed so nothing is lost):
registry entry + `ProposalPayloadMap` member (both are compile errors the
moment the enum grows — by design); the `oneOf` member parse in
`approvals/proposal-body.ts`; a creation-time
`computeRemoveStatementPayload` branch in `action-proposals.service.ts` (the
`publish.batch` branch is the template); a shaped card in
`render-summary.ts` (until then the fallback names payload members — the
preview's numbers ARE the members, so even the fallback shows the blast
radius); the `RELEASE_KINDS` total record in `assert-can.ts` forces a decision
— **recommended `false`**: removal is internal and reversible by re-import,
unlike D44's two outward irreversible acts, but that is Shakib's call to
confirm; `KIND_LABEL` in `apps/web/src/api/proposals.ts` (also a compile
error); and the live wiring of the Bank screen's Remove action
(`apps/web/src/views/BankView.tsx` — today it is disabled-with-tooltip on live
rows, the S14 rule, and works locally in synthetic mode).

## Tenancy: RLS, and deliberately no second mechanism

Every query runs inside `scopedDb`. The `businessId` filter **narrows** a set
RLS has already bounded; nothing here adds a tenancy clause to *enforce* scope,
because a hand-written filter that disagreed with a policy would be the more
permissive of the two exactly when it mattered. A unit test asserts the `where`
clause is empty when no filter was asked for.

Asking for a business the caller cannot reach returns an **empty page** — not
404, not 403. The rows were already invisible, so the filter matches none of
them, and the answer never confirms whether that business exists.

## The unmatched set is the chase list's set

The contract says it in as many words: *"the unmatched set this returns is the
same set chase detection reads, so the Bank screen and the chase list can never
disagree."* Both read `match_state` and `chase_suppressed` off these rows.

That is why the confirm-match executor flips `match_state` and does not merely
write a `matches` row: a match recorded without the flip leaves the line in the
unmatched set, and the client is chased by SMS for the receipt the accountant
just filed. `bank-matching.integration.test.ts` asserts the disappearance
directly, against a real database.

## Statement import (D40/D41) — `statement-ingest/`

**Built 28 Aug 2026, and it closed a hole worth naming: nothing in this API had
ever created a `BankTransaction`.** `prisma/seed.ts` was the only writer, so
every transaction on every screen was demo data — while the practice app's
"Upload statement" button took a file NAME, never the bytes, and pushed a row
into local React state that vanished on reload. D40 makes manual upload the ONLY
bank input in ID, so the one input the release has was a mock end to end.

| File | What it is |
|---|---|
| `sheet-reader.ts` | CSV + XLSX → grid, on `node:zlib`. **No new dependency** — adding one is on the root stop-and-ask list, and `apps/web/src/lib/spreadsheet.ts` already proved the subset is worth owning |
| `statement-parser.ts` | grid → dated, signed, integer-pence rows |
| `completeness.ts` | the D41 gate |
| `account-holder.ts` | **whose statement is this** (5 Sep 2026) — see the section below |
| `statement-ingest.ts` | persistence: `Statement` + `BankTransaction[]`, idempotent on `documentId` |
| `statement-step.ts` | the ingest job's step, exported through `index.ts` |

### 🚨 A statement can land in the WRONG BUSINESS, and until 5 Sep 2026 it did so silently

The second named data-integrity event in this lane: a real 1,491-row NatWest
statement of **American Burger Ltd** was uploaded into **Zeplow Inc**'s
workspace and imported without a word — every defence here is about the FILE
(completeness, duplicates, overlap) and none asked whether the file belongs to
the business it is landing in. The extractor had read the holder's name off the
page (`documents.customer_name`, which the statement-briefed prompt now asks
for explicitly — `extraction/CLAUDE.md`); nothing compared it to anything.

`statement-ingest/account-holder.ts` is the check, and it is pure:

- **The step supplies both sides.** `statement-step.ts` selects `customerName`
  off the document row and reads the business's `name` + `tradingName` beside
  it; both ride `StatementIngestInput` as optional fields (`accountHolder`,
  `businessNames`).
- **Match is token-SUBSET after suffix strip, in either direction** — "Zeplow"
  matches "Zeplow Digital Inc"; "American Pie Ltd" does NOT match "American
  Burger Ltd" on the shared word. The safe failure direction is a missed flag
  (the status quo), never a false one dressed as a fact.
- **A mismatch FLAGS, it never blocks** (D46): an `accountHolderMismatch`
  finding — FIRST in `gapAnalysis.findings`, because "wrong client" outranks
  every line-level finding — plus a WARN. The finding names both sides (the
  holder clamped to 60 chars, the chase-verdict rule for untrusted names) and
  points at removal, whose approved path is `bank.remove-statement`.
- **No holder read means no finding.** A spreadsheet statement has
  `customerName` hard-coded null, and an older extraction may carry none — the
  check only speaks when it can prove disagreement, D41's ethos one lane over.

`account-holder.test.ts` pins the incident verbatim, both match directions, the
subset rule, and the clamp.

**No new endpoint was needed, and that is the design.** `DocumentType.STATEMENT`
already existed in prisma and the contract, and `Statement.documentId` already
pointed at a document: statements were always meant to ride `/document-uploads`.
The step runs after extraction, reads the row it is about to act on, and answers
"not mine" for everything the extractor did not classify `STATEMENT`.

### PDF and photographs go through Textract (D20), 28 Aug 2026

**This lane hand-rolled a PDF text extractor first, and it was the wrong call.**
It is deleted (`pdf-reader.ts`), and it should not come back:

- it read only **born-digital** PDFs. A scanned or photographed statement has no
  text objects at all, and that is the file a client actually sends;
- on a real 29-page statement it parsed **1,170 of 1,250** rows, dropped **every
  one of the 80 credit lines** (`CREDIT` and `BALANCE` fused into a single header
  cell), and found no balance column — so under D41 it could only ever report
  **`reduced`**, never prove completeness. That is the gate failing quietly on
  the one bank input the ID release has;
- three separate bug fixes of its author's own (ASCII85 + Flate filter chains,
  `Tm` capture-group offsets, empty cells shifting columns) each made it *less*
  wrong without making it right. Recovering a table from glyph positions is a
  guess; Textract states the grid.

D20 already committed this job to Textract and `extraction/CLAUDE.md` carried it
as an open TODO. What is built:

| | |
|---|---|
| **Images and a single-page PDF** | synchronous `AnalyzeDocument`, raw bytes |
| **A multi-page PDF** | asynchronous `StartDocumentAnalysis` + `GetDocumentAnalysis`, **from S3 only** — it cannot be handed bytes, which is why `StatementIngestInput` carries `s3Key` as well as the file |

- **The response is PAGINATED and a statement is long enough to be paginated.**
  `GetDocumentAnalysis` is followed through every `NextToken`; stopping at the
  first response reads a slice of a file and reports it as the whole, which is
  exactly the silent truncation D41 exists to catch.
- **`blocksToGrid` reads `CELL` `RowIndex`/`ColumnIndex`, not geometry.** The
  grid is *stated* rather than inferred, so an empty cell is an empty column
  rather than a gap that slides every later value one place left — the defect
  that filed credits as debits in the hand-rolled reader.
- **Failures are classified, because they mean opposite things.**
  `noTableFound` is the document's problem and the accountant can send a better
  copy; `readerUnavailable` (a throttle, an expired credential, a socket reset)
  is OURS and must never be phrased as "your statement is unreadable" — that is
  a lie that costs the client a re-scan. `readerNotConfigured` is a third, and
  separate on purpose: it is permanent for that environment, so its message must
  not promise the retry `readerUnavailable`'s does.
- **`STATEMENT_READER=none` is a REFUSAL, not a degraded mode.** CSV and XLSX
  still import; a PDF is refused by name with a reason. There is deliberately
  **no fixture table reader** — a fake one would return invented transactions
  for a real client's statement, the same hazard `FallbackExtractor` was deleted
  for.
- ⚠ **Textract cannot read MinIO**, so local development has no multi-page PDF
  path and `none` is the local default by necessity. Testing a PDF statement
  locally needs a real bucket.
- ⚠ **COST.** Textract TABLES is ~1.2p/page — a 29-page statement is ~35p,
  far above the £0.02 per-**document** guardrail, which is written for receipts.
  A statement is a different unit (one file, a month of a client's banking) and
  D40 leaves the release no other bank input. Watch it per client per month, not
  per document.

### ⚠ This lane no longer calls Textract itself (29 Aug 2026)

It did, for one day, and that was a double read: the model was handed the whole
PDF to classify it, and then **this lane handed Textract the same PDF** to get
its rows. One document, two reads, two bills — and two answers that could
disagree about what it said.

The OCR rung now lives in `common/ocr/` and runs ONCE, in the extraction step.
Its result reaches here on `ExtractionCompletion.ocr`, passed through by
`ingest-processor.ts`, and `readStatementFor(input, ocr)` parses
`ocr.grid` instead of calling a reader of its own. `PrismaStatementStep` takes no
reader argument any more — there is nothing here to configure.

What each `undefined` means, because they are different:

| | |
|---|---|
| a spreadsheet | no OCR needed and none was done — a CSV is already an exact grid, and OCR-ing one would pay to make an exact thing approximate |
| no reader configured | `readerNotConfigured` — refused by name, PERMANENTLY, so the message must not promise a retry |
| the read failed | `readerUnavailable` — ours, not the document's, and retryable |
| read, nothing on it | `nothingFound` — the document's problem; the accountant can send a better copy |

⚠ A PDF statement whose EXTRACTION failed also arrives here with no OCR, because
the completion is null. That is harmless in practice: extraction failing means
`docType` was never written, so this step answers "not mine" before it looks.

### 🚨 Re-uploading a statement used to DOUBLE a client's bank data (fixed 2 Sep 2026)

**The most serious data defect this product has had.** A real client held
**2,288** `bank_transactions` that were 1,144 rows imported **twice** —
identical `booked_at`, `amount_pence`, `description_raw` and `account_id` — from
two `statements` rows covering the identical 2025-08-01 → 2026-07-31 period,
`row_count` 1144 each, created **nine seconds apart**. Half of that client's
ledger was a duplicate; every figure derived from it was wrong; nothing noticed.

Three defences existed and **all three were inert**:

| Defence | Why it did nothing |
|---|---|
| `bank_transactions_account_id_provider_transaction_id_key` | D40 has no provider, so every statement row's `provider_transaction_id` is NULL — and Postgres treats NULLs as **distinct** in a plain unique index. Not weak for this lane: **absent**, and this lane is the ONLY bank input in ID |
| the `documentId` key in `ingestStatement` | Two uploads of one period are two DOCUMENTS. It never fired |
| exact-byte dedupe upstream | Same reason: the two source PDFs had different `byte_hash` |

**The fix is `statement-ingest/row-identity.ts` + a real unique index.** Every
row now carries `bank_transactions.import_fingerprint`:

```
"v1:" + sha256( accountId ⋮ bookedOn ⋮ currency ⋮ amountPence ⋮ normalisedDescription ⋮ ordinal )
```

⚠ **The `ordinal` is the whole mechanism, and it is what separates the two
failures that look identical from one row's point of view.** It is the 1-based
occurrence of that exact tuple **within the file being imported**, in file order:

- **a business really can buy the same coffee twice** — two identical lines in
  ONE statement take ordinals 1 and 2, hash differently, and **both survive**.
  Collapsing them would delete a real payment out of an accounting ledger, which
  is a worse failure than showing two;
- **the same file imported again** replays the same lines in the same order, so
  it reproduces ordinals 1 and 2 — the same hashes — and the unique index
  rejects both. `createMany({ skipDuplicates: true })` therefore skips only rows
  that are provably the same line, never rows that merely look alike.

The ordinal is a property of the FILE, never of the database. Deriving it from a
count of rows already stored would give the second import ordinals 3 and 4 and
double the data again.

Deliberately **not** in the hash, each for a reason: `balanceAfterPence` (a
statement with no balance column is a supported class — hashing it would double
the period when a client sends a balance-less CSV and then a proper PDF of the
same month), `sourceLine` (a CSV and a Textract grid put one transaction on
different lines), `documentId`/`byteHash` (those are what already failed).

⚠ **The one false-skip it can cause, stated rather than hidden:** D40 gives a
business ONE implicit account, so two of a client's *different* bank accounts
carrying a byte-identical description on the same day for the same pence would
collide and the second would be skipped. Rare, strictly less wrong than doubling
every ledger, and **never silent** — see below.

**Three things carry the truth to a surface**, because a structural defence
nobody can see is how this gets rediscovered in a year:

| | |
|---|---|
| `Statement.rowCount` | now the count actually **imported**, which is what the contract says it is. The doubled client's two statement rows BOTH claimed 1,144, which is exactly what made it look normal on the Statements tab. A re-upload reports 0 |
| two new findings | `alreadyImported` ("every one of the N transactions in this file was already imported … this looks like the same statement uploaded twice") and `periodOverlap`. Both ride `gapAnalysis.findings` and reach `GET /v1/statements` with **no contract change** — `StatementFinding.kind` is a free string |
| `gapAnalysis` | gains `parsedRowCount` / `importedRowCount` / `alreadyPresentRowCount`, so the file's line count and the import result can never be confused for one another again |

**The period-overlap check REPORTS, it does not refuse** (`overlapFindings`).
Refusing would break a corrected re-issue, a period that overlaps by a day, and
the ordinary longer-file-extends-a-shorter-one case — all of which the
fingerprint index already makes harmless. The remaining job is visibility.

`BankTransaction.importBatchId` — declared in `init` and written by nothing
until now — carries the source `Statement.id`, so "which rows came from that
file" is answerable for provenance today and a repair tool later.

**Migration `20260902160000_bank_transaction_import_fingerprint`** adds the
nullable column and `@@unique([accountId, importFingerprint])` and **writes no
data at all** — safe against the local database holding real client rows however
duplicated. Keying the rows that predate it is a separate, idempotent, reversible
pass: `apps/api/src/db/backfill-import-fingerprints.ts`. ⚠ It runs **per practice
through `scopedDb`** — the first draft read the root client and reported "nothing
to do" against six un-keyed rows, because `bank_transactions` is in the
`direct_tables` RLS loop and a query with no GUCs matches nothing rather than
erroring. It **deletes nothing**: already-doubled data stays and is counted for
an operator, because removing a line from an accounting ledger is a human's
decision.

Tests: `row-identity.test.ts` (unit — the coffee-twice property, the
re-import property, and what does and does not change an identity) and
`statement-reimport.integration.test.ts` (real database, `stre-` prefix,
teardown by explicit id list).

### ⚠ The READ happens outside the transaction, and it must

`ingestStatement` did the read itself, inside `scopedDb` — a Prisma
**interactive** transaction whose timeout is **10 seconds**. A CSV parses in
milliseconds so it never showed. Textract takes **40-60 seconds** on a real
statement, and the first 29-page PDF through this path died on the query AFTER
the read returned:

```
Transaction already closed: … the timeout … was 10000 ms,
however 56824 ms passed since the start of the transaction
```

Textract had SUCCEEDED. The database connection it came back to had not — and
the step swallows its throw by design, so the only symptom was a statement that
silently did not import. Holding a transaction open across a minute-long
network call also pins a pooled connection for that whole minute, so a handful
of concurrent statements would have starved every other query in the process.

The shape now:

1. `statementAlreadyIngested` — its own tiny transaction, and first.
2. `readStatementFor` — **no transaction at all**. Since the OCR rung moved
   upstream this is now fast (it parses a grid it was handed), but the ordering
   stays: the caller that hands it that grid, `extraction-pipeline.ts`, is the
   one holding the 40-60 second call, and it makes it outside a transaction for
   exactly this reason.
3. `ingestStatement(db, input, logger, parsed)` — a transaction that opens once
   the bytes are already a grid and closes in milliseconds.

`statement-ingest.integration.test.ts` pins it with a reader that deliberately
sleeps past the 10-second ceiling. Move the read back inside and that test fails
exactly the way staging did.

Six things that are decisions, not details:

- **It is deterministic, not a model call.** A CSV has no page to read. D41 gates
  on *provable* completeness, and only arithmetic over exact input can prove a
  balance — a confidence score cannot.
- **The gate has three outcomes and `reduced` is a real one.** Balance continuity
  to the penny proves `complete`; a break is proof a transaction is MISSING and
  the finding names the line and the amount. **A statement with no balance column
  is `reduced`, never `complete`** — reporting it complete would be a green tick
  meaning "we did not look", which is precisely what D41 forbids.
- **A brought-forward line is the opening balance, not a dropped transaction.**
  Treating it as a hole marked every ordinary statement incomplete and made the
  gate cry wolf on the most common file there is.
- **`Paid out` is negated.** Getting it backwards files every payment as income;
  it looks entirely normal on screen and inverts the client's books.
- **It never fails the ingest job**, the same rule and reason as chase
  auto-close: by then the document is persisted and read, and losing that to a
  parse error would invert "nothing is ever silently dropped". A refusal writes
  `failureCode`/`failureMessage` on the document **without touching `state`** —
  the document is fine, only the import did not happen, and failing it would
  hide a good file in the Rejected/Failed view.
- **`gapAnalysis` has its first writer**, so `GET /businesses`'s `statementGaps`
  count reads real data instead of the hardcoded zero it shipped with.

⚠ **The implicit `BankAccount` carries no `connectionId`.** ID has no bank
connection, so one business gets one account created on first upload; a
populated connection would claim a feed was authorised.

## Tests

```bash
pnpm --filter @neoting/api test -- banking-matching            # unit, offline
# integration (needs docker compose up + .env): the METH S11 acceptance —
# the feed lists in pence newest-first; another practice sees an empty page;
# confirming persists across a fresh read and leaves the UNMATCHED set;
# a suggested pairing is PROMOTED not duplicated; cross-practice refusal.
```

⚠ The integration suite cleans by **explicit id list, never `startsWith`**.
Prisma compiles `startsWith: 'x_'` to `LIKE 'x_%'` without escaping the `_`,
which is LIKE's single-character wildcard — so a prefix cleanup silently
deletes another suite's fixtures. API test files run in parallel workers, so
that collision surfaces as an intermittent foreign-key violation in the *other*
file's `beforeAll`.

## Boundaries

`index.ts` is the seam, created when the worker composition root became this
module's first consumer: it exports `NO_STATEMENT_STEP`, `PrismaStatementStep`,
`selectTableReader` and the reader types, and nothing else. The `bank.confirm-match`
executor writes `matches` and `bank_transactions` through the engine's
`ScopedClient` directly, so it needs nothing from here.

## TODO

- [ ] **// DEMO-MOCK: TrueLayer.** No feed adapter exists. The seeded
      `bank_connections` row is presented as connected. The real
      implementation is a provider adapter behind a config-selected `BankFeed`
      seam (interface + fixture + real, chosen by CONFIG not import) writing
      the same `bank_transactions` rows this reads.
- [x] **`BankTransaction.matchedDocumentId` landed (Phase 4, 1 Sep 2026).**
      The CONFIRMED match's document rides the list projection;
      `apps/web/src/api/bank.ts` maps it onto the local `matchedDocId` key, so
      the claimed-set and `ClientApprovalView` lookups work on server rows.
      SUGGESTED stays null by design (the document's bank-match read carries
      the question).
- [ ] `bank.unmatch` has no `ProposalKind`, so breaking a confirmed match has
      no approved path. The executor refuses rather than overwriting. **It now
      also blocks statement removal** — `bank.remove-statement` refuses a
      statement with confirmed matches, so a matched statement is un-removable
      until this lands. The two kinds belong in one contract-change issue.
- [ ] **Contract change (Shakib, G7): `bank.remove-statement`** — the removal
      design note above carries the exact delta. Everything server-side is
      built and tested (`validation-dedupe/proposals/remove-statement.ts`,
      dormant) and the ingest now stamps `BankTransaction.importBatchId` with
      the statement id (3 Sep 2026, no schema change — the column existed
      unwritten). ⚠ Statements ingested BEFORE the stamp cannot be provably
      enumerated and refuse removal by name; re-seeding or a one-off backfill
      by period+account is a human decision, not something the executor
      guesses at.
- [x] **ID-critical (D40/D41): statement upload wiring with the completeness
      gates — DONE, 28 Aug 2026.** See *Statement import* below.
- [ ] **ID-critical, still open**: cash coding, partial/batch payments
      server-side, consent lifecycle and configurable match windows — all
      explicitly out of METH S11's scope.
- [x] **PDF and photographed statements — DONE, 28 Aug 2026, through Textract
      (D20).** See *PDF and photographs* above. Still open: nothing measures the
      real per-statement Textract cost the way `scripts/measure/extraction-cost.ts`
      measures a document. The local PDF path EXISTS since 31 Aug 2026: shared
      `nt-dev-*` S3 buckets replace MinIO under `docs/runbooks/live-local.md`,
      and the full upload → Textract → parser → D41 gates → 12 persisted
      transactions round trip is verified with
      `docs/runbooks/fixtures/meridian-statement-jul-2026.pdf`.
- [x] **31 Aug 2026: `statements.controller.ts` injects `StatementsService` by
      explicit `@Inject` token.** The bare class parameter worked in the tsc
      build (staging) but was `undefined` under `pnpm dev` — tsx/esbuild emits
      no `design:paramtypes` — so `GET /v1/statements` 500'd on every laptop
      since it landed on 29 Aug. Every other controller already injected by
      token; this one now matches.
- [ ] Update this file on exit — it is how the next session picks up.
