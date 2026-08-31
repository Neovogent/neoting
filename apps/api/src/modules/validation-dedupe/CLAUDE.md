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

`index.ts` is the public seam, with **three** cross-module consumers — growing it
is a boundary decision, and it grew three times:

- The **Review → Approve engine** (`modules/approvals`, METH S3 / #122) takes the
  #81 executor contract: `buildExecutorRegistry`, the executor types and the two
  error shapes, `runDedupeFollowUp` + the `DedupeDetection` structural seam. The
  individual executors are deliberately NOT exported — reaching one around the
  registry is the bypass the registry exists to prevent.
- The **extraction lane** (`modules/extraction`, METH Stage 4) takes the state
  machine (`transitionDocument`, the transition type, `IllegalDocumentTransition`,
  `StaleDocumentState`) and the readiness rule (`resolveProcessedState`, its
  input/result types) — the two things extraction-completion drives.
- The **publishing lane** (`modules/publishing`, METH Stage 10) widened the
  readiness export to `evaluateReadiness` + `ReadinessField`. The publish
  minimum (Total + Supplier + Category) is not a second rule — it is THIS one,
  and `NT-PUB-001` has to name the fields that are missing, which only
  `evaluateReadiness` returns. Publishing re-stating the rule its own way is
  how a document ends up Ready on the inbox and unpublishable in the batch.

## Tests

```bash
pnpm --filter @neoting/api test -- validation-dedupe
pnpm --filter @neoting/api test -- proposals   # the executors, unit + integration
```

Integration suites here own disjoint id namespaces: `p81_` (executors), `p8_`
(chase.send), `s10_` (publish.batch), `p13_` (rule.create) and — since A12 —
**`a12x-`** (`reprocess-reject.integration.test.ts`, torn down by EXPLICIT id
list rather than `startsWith`, whose unescaped `LIKE` treats `_` as a wildcard
into a neighbour's fixtures).

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

- **`buildExecutorRegistry(deps)`** — total over the contract's `ProposalKind`
  by mapped type: a missing kind is a compile error; the engine's `NT-PRP-001`
  stays the second line of defence. **Ten real executors** (route, archive,
  update-coding since METH S3 #122, chase.send since METH S8, publish.batch
  since S10, bank.confirm-match since S11, rule.create since S13 #142,
  document.revoke-link since launch stage A8, reprocess and reject since launch
  stage A12), **two**
  honest holes throwing `ProposalNotImplementedError` by name — `move-business`
  and `split`, each typed off
  the generated payload models. The `deps`
  argument (`ExecutorRegistryDeps`) is **required since S10**: `publishing` has
  no safe default, and a registry that quietly degraded a built executor back
  to a hole because a call site forgot an argument is the failure the mapped
  type exists to prevent, moved one level out. `smsSender` stays optional —
  `DemoSmsSender` is a true safe default (the only mode in this push) and
  `approvals.module.ts` passes the config-selected sender. **No controller
  imports the proposals directory** — a test walks every `*.controller.ts` and
  asserts it; the provider-side half is upheld in `approvals.module.ts`
  (registry built inside the service factory, no token).

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
- **`publish.batch`** (METH S10, rebuilt for **Initial Delivery** by **D42**,
  launch stage A5) — `publish-batch.ts`. It **releases documents for export**.

  ⚠ ***Published* is an INTERNAL state meaning approved and released for
  export.** It asserts nothing about a ledger. Nothing was posted, synced or
  sent to VT — VT is where the *accountant* imports the file this release makes
  exportable. Every refusal, every `DocumentEvent` detail and the stored
  execution `detail` say **released-for-export**; a future edit that puts
  "posted" or "sent" back into this file is a D42 defect, not a copy
  preference.

  **What A5 changed, and why it had to.** The executor used to demand an active
  ledger connection (`resolveIntegration`) and refuse without one. There is no
  OAuth flow, no endpoint, no `integration.create` outside `prisma/seed.ts`,
  and D47 forbids intake from asking for a connection — so **nothing could ever
  reach PUBLISHED**, documents stopped at READY forever, and the export (ID's
  only egress) had nothing to export. Now:

  - **The export destination is OPTIONAL.** `VT`/`MANUAL` (S0's enum values,
    vocabulary in `publishing/export-destination.ts`) mean "this client exports
    rather than connects". A client with one records it on the `publishes` row;
    **a client with none still releases**, and `integration_id` is null — the
    schema's own nullability, used for what it is for. A dormant ledger-vendor
    row (XERO/…) is never adopted, and naming one refuses: stamping a vendor on
    a release would put its name on an act that never touched it.
  - **No follow-up, and the reason the split existed went with the vendor.**
    The post-commit `publish` `FollowUp` was there for one sentence — *an
    external HTTP call must never hold a tenant transaction open*. Releasing
    for export calls nothing, so the whole effect commits atomically with the
    approval and the READY-in-inbox/QUEUED-in-`publishes` window is gone.
    `publish-follow-up.ts`, the `FollowUp` variant, `PublishGateway.ledger` and
    the `LedgerAdapter` are **kept and untouched** for v1 (D6) — dormant, not
    deleted, which is what makes a real Xero adapter a later addition rather
    than a rewrite. Nothing returns that follow-up today.
  - ⚠ **AUTO-ARCHIVE IS GONE, AND THAT IS LOAD-BEARING.** The ledger follow-up
    archived on the vendor's confirmation, which was right when PUBLISHED meant
    "the books have it". `POST /v1/exports` says **"Only `PUBLISHED` documents
    are exported"** — so an archive on the way out would move every document
    past the only state the export can see, and `NT-EXP-001` would be the
    permanent answer. Archiving stays a `document.archive` proposal.
  - **`QUEUED → SUCCEEDED` stays**, both writes in the one transaction:
    `publishes` remains a truthful audit of a lifecycle, and it is the shape a
    v1 ledger follow-up would resolve in its own transaction. `external_ref`
    stays NULL and `attachment_sent` FALSE — nothing external was reached and
    nothing travelled. The link back to the source is A8's D43 capability code,
    not a vendor id.
  - **⚠ D44 — the release gate is NOT here and must not be.** Only the
    practice super admin may release. That is **stage A12, and it has landed**
    on the ENGINE's approve path (`modules/approvals/assert-can.ts`, called from
    `action-proposals.service.ts` before this executor is entered), because the
    engine owns authorisation and *an executor decides nothing about whether an
    effect may happen*. A second check here would be two mechanisms free to
    disagree, and the more permissive one wins exactly when it matters — **do
    not add one.** What this executor contributes is the evidence: every row
    records `publishedByUserId = ctx.actorId`.

  Everything below survived A5 unchanged:

  - **The only executor built as a FACTORY.** `createPublishBatchExecutor(gateway)`.
    Publishing imports THIS module (the publish minimum IS `evaluateReadiness`),
    so importing publishing back would close a cycle between two public seams.
    The shapes come in as `import type` (erased, no cycle); the destination
    vocabulary and `previewPublishBatch` are handed over or imported as values
    from the seam, composed by `approvals.module.ts` — the `DedupeDetection`
    precedent, applied.
  - **All-or-nothing.** One item short of Total + Supplier + Category refuses
    the WHOLE batch with `NT-PUB-001` naming every missing field (the contract:
    "refuses … rather than publishing half-coded books"; archive is
    all-or-nothing for the same reason). With the vendor gone so is the old
    per-item post-commit asymmetry — there is no post-commit step left.
  - **The preview is the SERVER's number, twice.** At creation the engine calls
    `computePublishBatchPayload` (exported here) and stores ITS preview in the
    payload — a caller-sent figure is discarded, and an item short of the
    minimum refuses creation with `NT-PUB-001` (the contract: "refusing at
    proposal time beats publishing half-coded books").
  - **The reviewed figures are re-checked.** The payload's server-computed
    preview is what a human approved; if the live totals no longer agree, the
    batch refuses. `NT-PRP-004` cannot catch this — review is idempotent and
    the render is payload-pure — so this is the only place the drift is visible.
  - **The retry edge.** A document sitting REJECTED with a failed attempt
    (today only from the dormant ledger lane) re-enters through REJECTED →
    PROCESSING → READY in the effect transaction: PROCESSING is the machine's
    only exit from REJECTED and the only edge that clears the reason, and a
    released document must not still carry why its last attempt failed. Retry
    is a NEW proposal over the failed item, never a replay.
  - **Idempotent.** `publishes.idempotency_key` is `<proposalId>:<documentId>`
    — globally unique per the schema, one row per item per proposal. A replay
    sees its own rows and returns `alreadyApplied` with no second row and no
    second release; the unique index is the database-level backstop that turns
    a concurrent double-execute into a rolled-back transaction. The in-flight
    QUEUED guard stays for the dormant ledger lane and for rows an older
    release of this code left behind.

- **`document.reject`** (stage A12) — `reject-document.ts`. A human marking a
  document as one these books should not carry: a personal receipt in the
  business pile, a supplier statement mistaken for an invoice. Before A12 the
  only way out of the inbox was `document.archive`, which says *filed*, not
  *wrong*, and which the Rejected view cannot show.

  - **The reason is stored verbatim** as `failure_message`, the way `chase.send`
    stores the composed SMS verbatim — the reviewer read those words and nothing
    here rewrites them. The review card renders it as its own entry.
  - **`failure_code` is `NT-DOC-001`**, a NEW family for document-lifecycle
    decisions taken by a human. Every other writer of that column names a
    subsystem that failed (`NT-ING-004` sanitisation, `NT-EXT-001` extraction);
    borrowing one would tell the Rejected surface the pipeline broke on a
    document it read perfectly. `Document.failureCode` is a free `string` in the
    contract, so this is a documentation decision, not a LAW change — its
    runbook page is in `docs/runbooks/error-codes.md` (Governance §13.4 requires
    one before a new code passes review).
  - **Refuses ARCHIVED even though `LEGAL_TRANSITIONS` allows the edge.** That
    edge exists for the unarchive RESTORE, and taking it from here would clear
    `archived_at` — silently unarchiving a document as a side effect of
    rejecting it. Two acts, two proposals. Everything else defers to
    `isLegalTransition` rather than restating the table, so PUBLISHED (already
    released) and FAILED (the pipeline's own verdict, undone by reprocess not by
    rejection) refuse because the machine says so.
  - Batched, all-or-nothing, idempotent per document — an already-REJECTED one
    is skipped and the FIRST rejection's words stand.
  - ⚠ **`RejectPayload` declares no `maxItems`** while every sibling batch
    declares 500. `MAX_REJECT_BATCH` applies the house number here, because an
    unbounded all-or-nothing effect is the unbounded load Governance §5.1
    forbids and would hit `scopedDb`'s 10 s timeout as a 500 rather than a
    refusal. Recorded as a contract gap in the TODO.

- **`document.reprocess`** (stage A12) — `reprocess-document.ts`. The Retry
  behind the Rejected/Failed view. Five files across the pipeline already told
  users their failed document was *"retryable through a reprocess proposal"*,
  and `documents.service.ts` refuses to grow a `POST /documents/{id}/retry`
  because this is where retry belongs — and approving one threw
  `ProposalNotImplementedError`.

  - **Accepts exactly what the read surface marks `retryable`** (REJECTED and
    FAILED), so the affordance and the effect are the same set by construction.
  - **Two edges through the machine:** → PROCESSING (the only exit from either
    failure state, and the only edge that CLEARS
    `failure_code`/`failure_message` — `document-state.ts` does that, this
    executor relies on it) → `resolveProcessedState`'s answer, READY or
    TO_REVIEW. So a human rejection over well-coded data is a clean undo back to
    READY, and a failed extraction lands in TO_REVIEW **in front of a human**
    instead of parked where nobody can act on it.
  - Same edge as `publish-batch.ts`'s `admitForRelease`, which the TODO below
    asked for. They are not two implementations of the legality or the
    reason-clearing — both go through `transitionDocument`. They stay two call
    sites because `admitForRelease` additionally demands a prior FAILED
    `publishes` row and lands on READY unconditionally, which is only correct
    because the batch already proved the publish minimum.
  - ⚠ **IT DOES NOT RE-READ THE DOCUMENT, AND THE REVIEW CARD SAYS SO.** Re-running
    extraction means enqueuing an ingest job, and the queue producer is not on
    `ingestion-routing`'s public seam; an executor may not make an external call
    anyway (it runs inside the engine's transaction). The correct shape is a
    post-commit follow-up that enqueues — one BullMQ push, not a 500-document
    synchronous Bedrock loop on the approve request. `PrismaExtractionStep.begin()`
    already treats a PROCESSING document as re-entrant, so the day that enqueue
    exists this executor needs no change. `fromStage` is recorded on the event and
    the outcome rather than honoured, for the same reason — never silently
    dropped, never silently honoured.

- **`rule.create`** (METH S13, #142) — the chat's rule beat: one `rules` row,
  active from birth (approval IS the activation — no `rule.activate` kind
  exists in this pass), `createdVia: 'chat'`, `actionProposalId` stamped so no
  rule exists without the proposal that activated it (the schema's own words).
  The payload carries no business — the PROPOSAL row is the anchor, read back
  by `proposalId` and refused when null (`rules.business_id` is required; a
  practice-level rule has no home in the schema). The business is re-resolved
  through RLS before the write (the route/chase.send guard). Richer
  `conditions` are stored verbatim for the four-tier engine; nothing evaluates
  them yet — the extraction pipeline honours the single-tier exact
  SUPPLIER_CUSTOMER match. `ChangedEntity` grew `'rule'`. Idempotent replay by
  the proposal stamp. Proven end to end through the REAL engine against a real
  DB (`rule-create.integration.test.ts`): create → review (fields/tier/scope
  named) → approve → the NEXT Bidfood document through `PrismaExtractionStep`
  arrives pre-coded with the rule's id as suggestion provenance — the demo's
  wow beat, server-side.
- **`document.revoke-link`** (launch stage A8) — `revoke-link.ts`. Kills D43
  capability URLs that are already sitting inside an accountant's ledger file,
  turning a working entry into a `410`. **It is a proposal and not a `DELETE`
  for exactly that reason**, and there is no revoke endpoint anywhere — the
  capability lane (`modules/exports-public-api/links/`) publishes precisely one
  route, `GET /d/{code}`, and it is a read.

  ⚠ **This is the one executor whose LANE lives in another module**, and the
  file's header records why: putting it in `exports-public-api` would close a
  runtime cycle between two public seams (`validation-dedupe/index.ts` →
  `registry.ts` → `exports-public-api/index.ts` → back, for the
  `ProposalExecutionRefused` class the engine matches with `instanceof`) — the
  same hazard `publish-batch.ts` documents. It costs nothing to keep here:
  revoking needs **nothing** from that module, it is one guarded `UPDATE`.

  All-or-nothing (an unreachable id refuses the batch — the archive rule),
  compare-and-swap shaped (`updateMany` guarded on `revokedAt: null`, so two
  overlapping batches cannot rewrite each other's timestamp), and idempotent (a
  replay is `alreadyApplied` with no second event; the original `revoked_at`
  survives, because *when* a link died answers "when did my January export stop
  working"). **It mints no replacement** — the schema says so on the model, and
  a test asserts the absence. `changed` names the affected **documents**, since
  `ChangedEntity` has no `document-link` member and "these documents stopped
  being reachable" is the sentence the outcome should read as anyway.

- **`business.offboard`** (31 Aug 2026, D32 slice) — `offboard-business.ts`.
  Soft-deactivates one client workspace: one compare-and-swap `UPDATE` on
  `businesses.is_active`, RLS resolves the row first (absent and foreign are
  the same refusal), already-inactive is an idempotent replay, and
  `payload.reason` rides verbatim in the detail. **Never deletes anything**
  (D12 six-year retention — the review card says so out loud);
  `ChangedEntity` grew `'business'` for it. Not a release
  (`RELEASE_KINDS: false` — internal and outward-silent, flagged for human
  ratification since that table is permission logic). No `business.reactivate`
  kind exists yet; an offboarded client can also STILL ingest (`mayIngest`
  reads only the subscription) — a billing decision deliberately left open.

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

- [ ] The **two** unimplemented executors — `move-business` and `split`; each
      needs its own issue. The registry already
      types and names them all. `update-coding` landed with the engine (METH S3,
      #122); `chase.send` in METH S8; `publish.batch` in METH S10;
      `bank.confirm-match` in METH S11; `rule.create` in METH S13 (#142);
      `document.revoke-link` in launch stage A8; `reprocess` and `reject` in
      launch stage A12 — every METH Stage 2 kind and every ID LAW kind now
      executes.
- [ ] ⚠ **Reprocess does not re-read the document.** It re-arms the state and
      re-decides readiness; running the extractor again needs a post-commit
      follow-up that ENQUEUES an ingest job, and the queue producer
      (`INGEST_QUEUE`, `ingestion-routing/queue/`) is not on that module's public
      seam. Growing that seam is a boundary decision in another lane, so A12
      stopped at the fence and put the limitation on the review card instead.
      Shape when it lands: a `reprocess` `FollowUp` member + a structural
      dispatch seam (the `DedupeDetection` precedent), composed in
      `approvals.module.ts`. One BullMQ push per document — never a synchronous
      extractor loop on the approve request.
- [ ] **`RejectPayload` has no `maxItems`** while `ArchivePayload` and
      `ReprocessPayload` both declare 500. `reject-document.ts` applies the house
      cap so an unbounded all-or-nothing transaction cannot be proposed; the
      contract should say it (G7, a one-line change).
- [x] The engine is wired (METH S3, #122 — `modules/approvals`): registry via
      `useFactory`, token kept out of public providers; dedupe follow-ups run
      post-commit. Still open: a periodic sweep over
      `findStaleDedupeFollowUps` (worker concern, tracked on the approvals
      CLAUDE.md too).
- [x] The sweep for **QUEUED `publishes` rows** whose follow-up never completed
      is **no longer needed for ID** — A5 removed the publish follow-up, so
      this executor cannot leave a QUEUED row behind (the row is created and
      resolved in the same transaction as the document's transition). It comes
      back with the v1 ledger lane, alongside `findStaleDedupeFollowUps`.
- [x] `document.reprocess` and `admitForRelease` share the edge rather than
      re-implementing it — both drive REJECTED/FAILED → PROCESSING → READY
      through `transitionDocument`, which owns the legality and the
      reason-clearing. They stay two call sites for the reason written in the
      reprocess section above.
- [x] **A12 (D44)** — `assertCan(actor, 'publish.release', …)` is on the
      engine's approve path (`approvals/assert-can.ts`), before the executor.
      `publish.batch` and `chase.send` now require the firm's super admin
      (`canRelease(role) && isOwner`). ⚠ **Two integration suites here seed
      `isOwner: true`** (`publish-batch`, `chase-send`) because their approvals
      are releases; without it they refuse `NT-PRM-001` and the executor never
      runs, which is the gate working rather than the fixture being fussy.
- [ ] **A11** — client intake must create the client's `VT` (or `MANUAL`)
      `Integration` row so the release records a destination. The executor no
      longer needs it, so this is a nice-to-have, not a blocker.
- [x] Wire the pipeline (extraction completion) onto `resolveProcessedState` —
      done in METH Stage 4. `modules/extraction`'s `PrismaExtractionStep` drives
      RECEIVED → PROCESSING → READY|TO_REVIEW|FAILED through `transitionDocument`
      (consumed via the `index.ts` seam), and is the ONE writer of the
      denormalised header projection readiness reads.
- [ ] Confidence gating — arrives with eval calibration, lands in the seam
      marked in `readiness.ts`. Do not invent thresholds.
- [ ] Update this file on exit — it is how the next session picks up
