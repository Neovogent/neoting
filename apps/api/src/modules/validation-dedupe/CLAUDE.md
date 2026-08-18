# validation-dedupe

**Lane E** · **Source of Truth:** SoT §4 Stages 5-6 · **Owner:** see the project board

## Purpose

Processing / To Review / Ready states, mandatory-field configuration, the Rejected-Failed view, and multi-signal duplicate detection.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- The Rejected/Failed view is a first-class surface, not an afterthought: every failure lands somewhere visible with a reason and a retry action.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

`index.ts` is the public seam, with **two** cross-module consumers — growing it
is a boundary decision, and it grew twice:

- The **Review → Approve engine** (`modules/approvals`, METH S3 / #122) takes the
  #81 executor contract: `buildExecutorRegistry`, the executor types and the two
  error shapes, `runDedupeFollowUp` + the `DedupeDetection` structural seam. The
  individual executors are deliberately NOT exported — reaching one around the
  registry is the bypass the registry exists to prevent.
- The **extraction lane** (`modules/extraction`, METH Stage 4) takes the state
  machine (`transitionDocument`, the transition type, `IllegalDocumentTransition`,
  `StaleDocumentState`) and the readiness rule (`resolveProcessedState`, its
  input/result types) — the two things extraction-completion drives.

## Tests

```bash
pnpm --filter @neoting/api test -- validation-dedupe
```

## Current state

### The document state machine (issue #80)

`document-state.ts` — **the one transition function.** The sink creates
documents in RECEIVED (creation is not a transition); every move after that
goes through `transitionDocument`, inside the CALLER's open `scopedDb`
transaction — it takes a `ScopedClient`, so it structurally cannot open a
second one (#81's executor discipline).

Five properties, each pinned by a test:

- **`LEGAL_TRANSITIONS` is a total record over `DocumentState`** — adding an
  enum value without deciding its transitions is a compile error. Every
  illegal pair (including self-transitions) throws `IllegalDocumentTransition`
  rather than silently writing; the unit suite iterates the full 8×8 matrix.
- **REJECTED and FAILED are unreachable without a code and a message in the
  type system** — `DocumentTransition` is a discriminated union whose failure
  branch requires `{ code, message }` and whose other branch carries
  `failure?: never`. A caller arriving through a cast hits the runtime guard.
- **Every transition writes a `DocumentEvent`** (stage `state`, outcome = the
  new state, the caller's traceId, detail with from/to and the failure) in the
  same transaction — the processing log is the audit surface and has no gaps.
- **The write is compare-and-swap shaped**: `updateMany` guarded on the
  expected `from` state; a lost race throws `StaleDocumentState` instead of
  clobbering a concurrent transition.
- **Failure reasons clear on reprocess, survive the archive.** REJECTED/FAILED
  → PROCESSING wipes `failureCode`/`failureMessage`; → ARCHIVED keeps them,
  because an unarchived rejection restores as a rejection and needs its reason
  back (#81's unarchive ruling). `archivedAt` stamps on the way in, clears on
  the way out.

`readiness.ts` — READY requires **Total + Supplier + Category** off the
denormalised header fields; anything missing is returned by name and the
document belongs in TO_REVIEW (`resolveProcessedState` is the one place that
choice lives). `null` and `0` pence differ on purpose — a £0.00 credit is a
confirmed value. A failed deterministic validator blocks READY with zero
missing fields. **The confidence seam is deliberately empty**: thresholds are
eval-calibrated and do not exist yet — do not invent numbers (the seam is
marked in the file header).

The Rejected/Failed surface itself is `GET /documents?state=REJECTED|FAILED`
(modules/documents, #95 — default list already excludes ARCHIVED); what this
module adds is that those states cannot be reached without a reason.
`document-state.integration.test.ts` proves the loop against a real database:
RECEIVED → PROCESSING → FAILED through the machine, then read back through the
real `DocumentsService` under RLS, reason and `retryable` hint present, event
log gapless. **Retry is a `document.reprocess` proposal on the Review →
Approve spine — no `POST /documents/{id}/retry` exists and none may** (§10).

### Proposal executors (issue #81)

`proposals/` — the effects the Review → Approve engine (S1) executes, on the
signature ACKed on the issue. The ENGINE owns authorisation, the review gate,
the shown-hash check, the audit write and the `outcome` record; an executor
performs exactly one effect inside the engine's open `scopedDb` transaction
(`ScopedClient` has no `$transaction`, so one-effect-one-transaction is
structural) and decides nothing about whether it may happen.

- **`buildExecutorRegistry()`** — total over the contract's `ProposalKind` by
  mapped type: a missing kind is a compile error; the engine's `NT-PRP-001`
  stays the second line of defence. **Four real executors** (route, archive,
  update-coding since METH S3 #122; confirm-match since METH S11), seven
  honest holes throwing
  `ProposalNotImplementedError` by name — the remaining #81 four
  (`move-business`, `reprocess`, `reject`, `split`) plus the METH Stage 2
  kinds still unbuilt (#120): `chase.send` (METH S8), `publish.batch` (S10),
  `rule.create` (S13), each typed off the
  generated payload models. **No controller imports the proposals directory**
  — a test walks every `*.controller.ts` and asserts it; the provider-side
  half is upheld in `approvals.module.ts` (registry built inside the service
  factory, no token).
- **`document.route`** — assigns an Unrouted document a business + inbox.
  Keeps `practice_id` (decision 4; both-set is the normal routed case, #103),
  refuses UNROUTED as a target, refuses moving an already-routed document
  (that is `move-business`, which carries the addressee-mismatch warning),
  resolves the target business through RLS BEFORE writing (the web-upload
  guard, applied to effects), and never touches `DocumentState`.
  `teachRouterForSender` is a recorded seam for the rules lane. Idempotent:
  a replay is a no-op with no second event and no second dedupe.
- **Dedupe on route** — the deferred design decided on #81: the executor
  writes `DocumentEvent{stage:'dedupe', outcome:'deferred'}` IN the effect
  transaction (durable intent — the outbox principle on the table that
  exists) and returns a `dedupe` follow-up; the engine calls
  `runDedupeFollowUp` post-commit (detector passed through a STRUCTURAL seam,
  `DedupeDetection` — never an import into ingestion-routing's internals),
  which records the completion; `findStaleDedupeFollowUps` is the sweep for
  deferrals whose completion never landed. Proven end to end against a real
  database with the real `PrismaDuplicateDetector`: routing a byte-identical
  twin into a business creates the `Duplicate` pair.
- **`document.archive`** — batched (1..500), all-or-nothing, drives the state
  machine per document. Archive sets `state = ARCHIVED` AND `archivedAt`
  (decision 5 as ruled on #81 — the read surface's default exclusion keys on
  `state`). Unarchive restores the pre-archive state from the archive event's
  own `detail.from` (the audit trail as the restore oracle; derivation
  fallback for pre-machine rows), carries a failure's recorded reason back
  through the machine's typed gate, and `clearPublishingData` demotes a
  PUBLISHED restore to readiness's answer while recording
  `publishingDataClearDeferred` — clearing Publish rows is the publishing
  module's seam.
- **`document.update-coding`** (METH S3, #122) — a human correcting or
  confirming coding. Two surfaces move atomically: the denormalised header
  fields (the projection's one write path on the correction side), and a NEW
  accepted `extractions` row (`extractor_kind: 'human'`, keyed by the
  approver) carrying the corrections as `HUMAN_CONFIRMED` /
  `wasCorrected: true` with the proposal cited as `source` — history is
  append-only, the prior row loses only `is_accepted`. Refuses PUBLISHED and
  ARCHIVED (locked). Supplying the last missing mandatory field drives
  TO_REVIEW → READY through the machine; corrections carry values, never
  deletions, so no demotion path exists. `createRuleFromCorrection` is a
  recorded seam on the event (`createRuleDeferred`), for `rule.create`
  (METH S13). Dates land as UTC midnight; the extraction value keeps the
  contract's `YYYY-MM-DD`.
- **`bank.confirm-match`** (METH S11) — a human confirms that a document is the
  evidence for a bank transaction. **Two rows move or neither does:** the
  `matches` row AND the transaction's `match_state`. Writing the match without
  the flip would leave the line in the unmatched set chase detection reads, and
  the client would be chased by SMS for the receipt just filed — the
  disagreement the contract explicitly forbids. Refuses a cross-workspace pair
  (both rows individually visible to a practice-scoped approver does NOT make
  them the same client's, and `matches.business_id` holds only one of the two),
  an ARCHIVED or REJECTED document, and a transaction already CONFIRMED against
  a different document — there is no `bank.unmatch` kind, so overwriting one
  would be that missing path's bypass. An existing SUGGESTED row is
  **promoted**, not duplicated: `matches` has no unique constraint on
  (document_id, transaction_id). **It reads and writes no money column at all**
  — the suggestion arithmetic is display-tier float pounds in `apps/web`, and
  `confidence` is recorded for triage and gates nothing (a score is not an
  authorisation, Governance §9.5). A test pins the absence of any `Pence` field
  in everything it writes.

## TODO

- [ ] The seven unimplemented executors — the remaining #81 four
      (`move-business`, `reprocess`, `reject`, `split`; each needs its own
      issue) and the three METH kinds still open (`chase.send` → METH S8,
      `publish.batch` → S10, `rule.create` → S13). The registry
      already types and names them all. `update-coding` landed with the
      engine (METH S3, #122); `bank.confirm-match` landed with METH S11.
- [x] The engine is wired (METH S3, #122 — `modules/approvals`): registry via
      `useFactory`, token kept out of public providers; dedupe follow-ups run
      post-commit. Still open: a periodic sweep over
      `findStaleDedupeFollowUps` (worker concern, tracked on the approvals
      CLAUDE.md too).
- [x] Wire the pipeline (extraction completion) onto `resolveProcessedState` —
      done in METH Stage 4. `modules/extraction`'s `PrismaExtractionStep` drives
      RECEIVED → PROCESSING → READY|TO_REVIEW|FAILED through `transitionDocument`
      (consumed via the `index.ts` seam), and is the ONE writer of the
      denormalised header projection readiness reads.
- [ ] Confidence gating — arrives with eval calibration, lands in the seam
      marked in `readiness.ts`. Do not invent thresholds.
- [ ] Update this file on exit — it is how the next session picks up
