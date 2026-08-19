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

- **`buildExecutorRegistry(deps?)`** — total over the contract's `ProposalKind`
  by mapped type: a missing kind is a compile error; the engine's `NT-PRP-001`
  stays the second line of defence. **Four real executors** (route, archive,
  update-coding since METH S3 #122, chase.send since METH S8), seven honest holes
  throwing `ProposalNotImplementedError` by name — the remaining #81 four
  (`move-business`, `reprocess`, `reject`, `split`) plus the METH Stage 2 kinds
  (#120) still open: `publish.batch` (S10), `bank.confirm-match` (S11),
  `rule.create` (S13), each typed off the generated payload models. The factory
  now takes an optional `ExecutorRegistryDeps` (`{ smsSender? }`) — chase.send
  needs a collaborator beyond the DB; it defaults to `new DemoSmsSender()` so the
  arg-less call still works (the executor tests use it), and `approvals.module.ts`
  passes the config-selected sender. **No controller imports the proposals
  directory** — a test walks every `*.controller.ts` and asserts it; the
  provider-side half is upheld in `approvals.module.ts` (registry built inside the
  service factory, no token).

- **`chase.send`** (METH S8) — the flagship effect, `chase-send.ts`. A factory
  `chaseSendExecutor(sender)` taking an `SmsSender` from the **chase module's
  public seam** (`../../chase/index.js`) — the executor's first cross-module
  dependency. Each grouped payload message (one per client, SoT §8.2) resolves
  its business FROM the chased transactions THROUGH RLS (an approver cannot chase
  what they cannot see; a grouped message spanning two clients refuses), then
  creates one `Chase` (state SENT — approval IS the send; engine (a),
  `itemRefs` = the transactionIds, stamped with the proposal for idempotency),
  one `ChaseMessage`, and "sends" through the sender. **The stored body and the
  sent body are the payload body verbatim** — composition ran at proposal time
  (`chase/sms-copy.ts`), nothing here rewrites it; that is the Review → Approve
  guarantee at the effect. A replay (same proposal already stamped) is an applied
  no-op — it never sends twice. `ExecutionResult.changed` gained a `'chase'`
  entity (the `ChangedEntity` union on `proposal-executor.ts`) — chase.send
  creates chases, not documents. Proven end to end through the real engine
  (`chase-send.integration.test.ts`).
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

## TODO

- [ ] The seven unimplemented executors — the remaining #81 four
      (`move-business`, `reprocess`, `reject`, `split`; each needs its own
      issue) and the three still-open METH kinds (`publish.batch` → S10,
      `bank.confirm-match` → S11, `rule.create` → S13). The registry already
      types and names them all. `update-coding` landed with the engine (METH
      S3, #122); `chase.send` landed with METH S8.
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
