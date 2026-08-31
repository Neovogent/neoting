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
| `statement-ingest.ts` | persistence: `Statement` + `BankTransaction[]`, idempotent on `documentId` |
| `statement-step.ts` | the ingest job's step, exported through `index.ts` |

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
- [ ] **Contract change (Shakib, G7): `BankTransaction` carries `matchState`
      but not the id of the document that matched it.** The Bank screen needs
      it — `apps/web`'s local shape uses `matchedDocId` as a real key (one
      receipt may not answer two lines; `ClientApprovalView` looks a
      transaction up by it) — so today `apps/web` sets it to `undefined` for
      server rows and answers "is this matched" from `matchState` instead.
- [ ] `bank.unmatch` has no `ProposalKind`, so breaking a confirmed match has
      no approved path. The executor refuses rather than overwriting.
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
