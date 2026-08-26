# publishing

**Lane I** · **Source of Truth:** SoT §4 Stage 10, §17.1 · **Owner:** see the project board

## Purpose

The canonical model, Xero and QuickBooks adapters, two-way reference sync, idempotent publish, and the integration health surface.

## ⚠ Initial Delivery (ID) — read this before the sections below

**D42 supersedes D6 and this module’s whole adapter path for ID** (SoT §24.3). No ledger API integration and no auto-publish ships in the first client release. Concretely:

- **`Published` is an internal state meaning approved and released for export.** It asserts nothing about a ledger. No ID surface, no string, no API field and no audit line may imply a bill was posted to Xero, QuickBooks or anything else — that would be a lie to the accountant about the state of their books, and it is the single most damaging thing this module could get wrong.
- **Export is the sole egress** (`modules/exports-public-api`, SoT §24.3). Ready → Published is what makes a document *exportable*; the export carries it out.
- **Only the accounting firm’s super admin may release** Ready → Published, singly or in bulk (D44). Accountants compose and edit; they do not release. This is a server check, not a hidden button.
- **Everything else in this file stands and is still correct** — the `LedgerAdapter` seam, `publishes` rows, idempotency keys, the QUEUED → SUCCEEDED/FAILED lifecycle, the post-commit follow-up. Keeping the seam is exactly what makes a real Xero adapter a later *addition* rather than a later rewrite. It simply has no real implementation behind it in ID, and `LEDGER_ADAPTER=demo` remains the only admitted value.

D6 stands unchanged for v1. Nothing here is deleted; it is dormant.

### What launch stage A5 did to that, on 26 Aug 2026

**Dormant now means unreachable, not merely unused.** `publish.batch` no longer returns the `publish` `FollowUp`, so nothing drives `publish-follow-up.ts` and nothing calls `LedgerAdapter.publishBill`. The release happens inside the effect transaction — `publishes` QUEUED → SUCCEEDED and READY → PUBLISHED, atomically with the approval — because releasing for export makes no external call, and the post-commit split existed for exactly one sentence: *an external HTTP call must never hold a tenant transaction open*. The reasoning below is still the reasoning; it is just waiting for D6.

Three consequences worth knowing before touching this module:

- **`export-destination.ts` is the new ID vocabulary.** `VT` and `MANUAL` are export destinations; the four ledger vendors are not, and `isExportDestination` is what keeps a seeded `XERO` row from being adopted by a release. The contract says it on `IntegrationKind` itself: neither value carries a token, an org ref or a health state, and **neither may ever become an adapter call**.
- **A client with no `integrations` row releases anyway.** D47 forbids intake from asking for a connection, so the row is optional and `publishes.integration_id` is null when there is none. The refusal that used to live here — "this client has no active ledger connection" — is why nothing could ever reach Published.
- **⚠ Auto-archive was removed with the follow-up, and that is load-bearing.** `POST /v1/exports`: *"Only `PUBLISHED` documents are exported."* Archiving on release would move every document past the only state the export can see. **If the v1 ledger lane is ever re-enabled, its archive step has to be reconsidered against the export lane, not restored verbatim.**
- **`external_ref` stays NULL and `attachment_sent` FALSE on an ID release.** Nothing external was reached; nothing travelled. The link back to the source document is the D43 capability code the export emits (stage A8), never a vendor reference.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Idempotency keys and external references are mandatory. Republishing must never create a duplicate vendor or double-post a bill. The source document always travels with the data.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

`index.ts` is the public seam. It carries the **export-destination vocabulary** (A5), the
adapter interface + its result types, the config selector, the preview/minimum functions
and the `LEDGER_ADAPTER` DI token — the surface the `publish.batch` executor and the
`GET /v1/publishes` read lane need, and nothing else. **`DemoXeroAdapter` is deliberately
not on it:** nothing outside this module should name a demo implementation, which is what
keeps the adapter choice in config where the real Xero client replaces it without touching
a call site.

## Tests

```bash
pnpm --filter @neoting/api test -- publishing        # unit, offline
# the RLS test needs a database (DATABASE_URL + DIRECT_URL); it self-skips without one
docker compose up -d && pnpm db:migrate
pnpm --filter @neoting/api test -- publishes.integration
```

`publishes.integration.test.ts` seeds as the OWNER (bypasses RLS) and reads as the
APPLICATION (`nt_app`, which does not) — writing the fixtures through the app role would
prove nothing about reads and would make a policy bug look like a setup failure. Ids are
prefixed `p10_` and torn down at both ends; vitest runs file-serially
(`fileParallelism: false`), which is what keeps prefix isolation honest.

## Current state

### `export-destination.ts` — what an `integrations` row means in ID (launch stage A5)

Small, and it is the file that lets a document reach Published. `EXPORT_DESTINATION_KINDS`
is `['VT', 'MANUAL']`, `isExportDestination(kind)` is the guard, and `ExportDestination` is
`{ id, kind }` — **no `orgRef`, no token, no health**, because the contract states neither
kind carries them and a field that is always null is an invitation to populate it.

`MANUAL` sits beside `VT` because the first client's software is not the last one's: a
practice whose client uses something with no emitter still releases documents and still
downloads `ExportTarget.GENERIC_CSV`. Both are inert by construction — nothing in this
module or any other may turn one into an adapter call.

**Where the row comes from:** stage **A11** (client intake,
`modules/clients-team-settings`) creates one `VT`/`MANUAL` row per client at intake.
**A11 has not merged**, and the release deliberately does not wait for it — a client with
no row releases with `publishes.integration_id = null`.

### The LedgerAdapter seam + the server-computed preview (METH Stage 10)

The half of Stage 10 that has no database in it. **// DEMO-MOCK throughout** — a real
system with a fake vendor, not a fake system. Nothing here opens a socket, and
`LEDGER_ADAPTER=demo` is the only value the enum admits.

- **`ledger-adapter.ts`** — the interface. `publishBill(request)` takes one bill:
  document identity, the resolved `LedgerTarget` (integration id + kind + org ref), the
  coded fields, integer pence, and a `LedgerAttachment` **reference** (never bytes — a
  500-item batch must not hold 500 buffers). It returns a **result**, not a throw:
  `{ok:true, externalRef, attachmentSent}` or `{ok:false, failure:{code, message,
  retryable}}`. That shape is load-bearing — a batch of 40 where item 12 is rejected
  must publish the other 39 and land item 12 on the Rejected/Failed surface with a
  reason ("a failure with no reason attached is a bug, not a state" — the contract).
  Throwing is reserved for the world being broken (no credentials, adapter
  misconfigured). Row-level codes (`LEDGER_REJECTED = 'NT-PUB-002'`) live in
  `publishes.failure_code`, which the contract types as a free string; they are **not**
  `Problem.code` values, and promoting one into the `ErrorCode` enum is a G7 change.
- **`demo-xero-adapter.ts`** — `DemoXeroAdapter`. Refs are `XERO-INV-####`, derived from
  a SHA-256 of the document id: same document, same ref, on every attempt and every
  seeded database. It deliberately does **not** vary with the attempt — a republish that
  minted a second reference is exactly the double-post `publishes.idempotency_key`
  exists to prevent. `attachmentSent` reports what actually travelled.
  **The scripted failure is keyed on the ATTEMPT, not the document**: METH asks for
  both "a deterministic failure for one flagged document" and "retry succeeds second
  time", and those only reconcile if the flag is `flagged && attempt <= 1`. The flag is
  the normalised supplier name (`DEMO_FAILING_SUPPLIERS = ['british gas']`), chosen
  because it needs nothing from `prisma/seed.ts` — LAW, and being edited on another
  branch. It hits **`doc_007`: British Gas, £412.66 gross, READY, Utilities, American
  Burger**, one of that business's three publishable Ready documents, so the demo batch
  shows two succeed and one fail. The message is transient by design ("the supplier
  contact was locked by another update") because the retry must plausibly clear it; a
  coding-shaped rejection would be a lie, since nothing about the document changed.
- **`publish-preview.ts`** — pure, no DB, no clock. `computePublishPreview` sums integer
  pence and applies no rate and no rounding (the per-document figures were rounded once,
  at extraction; re-deriving VAT from a rate would silently disagree with the document).
  `checkPublishMinimum` **reuses `evaluateReadiness` through validation-dedupe's public
  seam** rather than re-stating Total + Supplier + Category — publishing asking the same
  question its own way is how a document ends up Ready on the inbox and unpublishable in
  the batch. That seam grew for this (`evaluateReadiness`, `ReadinessField`), because
  `NT-PUB-001` has to name *which* fields are missing. `previewPublishBatch` is the
  composition both call sites use — proposal time and the contract-mandated
  re-validation at execution time — and returns **every** refusal, not the first.
- **`select-ledger-adapter.ts` + `LEDGER_ADAPTER` env** — mirrors `EXTRACTOR` /
  `MEDIA_FETCH` exactly: `z.enum(['demo']).default('demo')`, selected by config, never
  by import. `publishing.module.ts` provides and exports the `LEDGER_ADAPTER` token so
  `approvals.module.ts` can hand the adapter to the executor registry. The module also
  carries the read surface's controller and service (next section); the read service is
  deliberately not given the adapter.

### `GET /v1/publishes` — the read surface (METH Stage 10)

`publishes.controller.ts` → `publishes.service.ts` → `publish-projection.ts`, mirroring
`modules/documents` (#77) exactly, because a second way of writing a keyset-paginated
list is a second way for it to be wrong. `x-nt-side-effect: none`, registered in
`publishing.module.ts` and `app.module.ts`.

- **One method, and it reads.** `PublishesService` has no mutating method, so there is no
  side-effect path outside Review → Approve for one to hide in — structural, not a
  promise (a unit test pins the method list at exactly `['listPublishes']`). Publishing
  is a `publish.batch` proposal; **retry is a NEW proposal over the failed item**, never
  `POST /publishes/{id}/retry`. ⚠ `PublishesService` is deliberately NOT given
  `LEDGER_ADAPTER`: a read service that could reach a ledger is that missing endpoint
  waiting to be written, and the cheapest way to make it impossible is for the
  dependency not to exist.
- **Newest first is fixed, not a parameter** — `listPublishes` declares no `sort`/`order`,
  so offering one would be an API the spec does not have. The sort is `createdAt desc`
  and **not `completedAt`**: a QUEUED row has no `completedAt`, and nulls-last would file
  every in-flight attempt below history nobody is waiting on. `createdAt` is NOT NULL, so
  `dateField(..., nullable: false)` — `common/pagination/cursor.ts` explains why that flag
  is load-bearing (Prisma throws at runtime on `nulls` for a required column).
  The `id` tie-break matters more here than anywhere else in the API: a batch fans out to
  one row per item **inside one transaction**, so a 40-item publish shares a `createdAt`
  to the microsecond and has no total order without it — a page boundary landing inside
  the batch would skip and repeat rows.
- **An omitted `state` means EVERY state**, deliberately unlike `GET /documents`, where
  omitted excludes ARCHIVED. The contract says so ("Repeat to widen. Omitted means every
  state."), and the asymmetry is right: a document list is a working queue that would
  otherwise grow forever, while publish history is an **audit trail** — a state hidden by
  default would mean a failed publish quietly missing from the record of what was
  attempted. The no-filter `where` is genuinely `{}`, and a unit test asserts that,
  which is also the "no second tenancy mechanism" test: **the guard is RLS
  (`publishes_tenant` → `app_can_access_business(business_id)`), and `businessId`/`state`
  are user FILTERS over an already-scoped set.** A hand-written practice clause beside a
  policy is two mechanisms that can disagree, and the more permissive wins exactly when
  it matters.
- **There is no 404 on this surface at all.** A `businessId` the caller cannot reach is an
  **empty page** — the rows were already invisible, and any other answer confirms whether
  that business exists. Proven against a real database, not asserted.
- **`publish-projection.ts` is pure and it invents nothing.** `state` is not re-derived
  from whether `externalRef` is set, there is no computed `retryable` (retry lives on the
  proposal spine), dates are ISO-8601 **UTC** and nullable ones are explicit `null` rather
  than omitted — present-and-null says "this attempt has not completed", which is the true
  statement about a QUEUED row. **Two columns never leave the server:**
  `idempotency_key` (the anti-double-post key, globally unique, derived from ids) and
  `published_by_user_id` (not in the contract's `Publish` at all). A test pins the exact
  key set, because the failure mode of a `...row` spread is silent over-exposure that
  typechecks.
- **A FAILED row's reason travels verbatim, and is never SUBSTITUTED.** The contract:
  "a failure with no reason attached is a bug, not a state". If a writer ever commits a
  reasonless FAILED row, the projection serves the null so the bug shows up on the
  Rejected/Failed surface where a human sees it. Papering it over with an invented code
  would hide the defect *and* put a value on the wire no writer emitted and no client has
  a branch for — the same mistake `modules/documents` avoided by refusing to invent
  `NT-NOT-001`. `failure_code` is a free string in the contract (a row-level ledger code
  like `NT-PUB-002`), **not** a `Problem.code`.
- **The controller coerces before it parses.** `?state=FAILED` — the single-state filter
  the Rejected/Failed surface sends — arrives from Express as a bare string while the
  generated schema types `state` as an array (`style: form, explode: true`), so raw
  parsing 400s the first real call. `coerceQuery` is schema-driven, so it cannot drift.
- **The cursor fingerprint is computed over the query MINUS the cursor.** Inherited
  regression: folding the cursor into the digest makes page 1's own token unmatchable on
  the way back and 400s **every** page-2 request. The test is a genuine two-page round
  trip, and the integration test pages the real table one row at a time — the only shapes
  that catch it.

### ⚠ The transaction/delay decision, and why

**An external HTTP call must never hold a tenant transaction open.** That sentence is
the whole reasoning, and it is written here because the executor contract makes the
wrong thing the easy thing.

A `ProposalExecutor` runs inside the engine's already-open `scopedDb` transaction —
`ScopedClient` has no `$transaction`, so one-effect-one-transaction is structural, and
the obvious reading of "publish the batch" is: call the ledger per item, right there.
Two things say no. A batch is up to **500 items** (the contract), and the adapter has a
per-item latency — at the demo's 800 ms that is **6m40s of held row locks** for one
approval, and a real Xero round trip is worse because its duration is someone else's
network. Second, the real adapter *is* HTTP, and `apps/api/CLAUDE.md`'s async spine
already rules that "every ingest/extract/publish/chase/export runs through BullMQ —
never inline in a request".

⚠ **A5 UPDATE — this whole section is v1's, not ID's.** D42 removed the vendor call, and
with it the reason for the split: `publish.batch` releases for export inside the effect
transaction and returns **no** `publish` follow-up, so `publish-follow-up.ts` and the
engine's arm below are dormant. Everything here stays because it is the design D6 restores,
and because the sentence at the top of it is permanent: the moment a real HTTP adapter
lands, the post-commit split has to come back with it.

**Decision: the adapter is called POST-COMMIT, through the engine's `FollowUp` seam.**
Not inside the effect. **This was BUILT** — `validation-dedupe/proposals/publish-batch.ts`
(the effect) and `publish-follow-up.ts` (the ledger call), with the `publish` `FollowUp`
arm in `approvals/action-proposals.service.ts`. The shape it took:

1. The executor, inside the effect transaction, re-runs `previewPublishBatch` over the
   documents (the contract's mandated re-validation → `NT-PUB-001`), resolves the
   integration, and writes one `publishes` row per item in state **`QUEUED`** — which is
   what that state is *for*, and is durable intent committed atomically with the
   approval, exactly the pattern `dedupe-follow-up.ts` established on the table that
   exists. `idempotency_key` is `<proposalId>:<documentId>` — globally unique per the
   schema, one row per item per proposal, which is also what makes a replay a no-op.
2. It returns a `publish` `FollowUp`. `FollowUp` is a discriminated union the engine
   switches on post-commit; adding a variant touches
   `validation-dedupe/proposals/proposal-executor.ts` and `modules/approvals` — our
   code, and the dedupe precedent is the template.
3. The follow-up runner calls `publishBill` per item and, **per item in its own short
   scoped transaction**, resolves the row to SUCCEEDED (+ `external_ref`,
   `attachment_sent`, `completed_at`) or FAILED (+ code + message — never reasonless),
   then drives the document READY → PUBLISHED → auto-archive, or onto the
   Rejected/Failed surface with the reason. A crash between commit and completion
   leaves QUEUED rows, which are sweepable (`@@index([businessId, state])` is right
   there), re-drivable by calling the runner again (it reads QUEUED as its work list),
   and never a lie.

**One correction to the sketch above, found in the building.** This section originally
said a failed publish drives the document to **FAILED**. It cannot and should not:
`LEGAL_TRANSITIONS` gives READY exactly one failure exit and it is **REJECTED**, and
that is the right one on the meaning too — FAILED is our pipeline breaking, and a ledger
declining a bill is something *refusing* it. Both states render on the same first-class
surface (`GET /documents?state=REJECTED|FAILED`), so the contract's "lands on the
Rejected/Failed surface" holds either way. Widening a shared state machine so a vendor's
"no" could reach FAILED would have been changing everyone's rules to avoid writing this
paragraph.

The consequence is the retry edge, and it is worth knowing before reading the code:
REJECTED's only exits are PROCESSING and ARCHIVED, and PROCESSING is the **only** edge
that clears `failure_code`/`failure_message`. So a retry proposal takes the document
REJECTED → PROCESSING → READY inside the effect transaction, both edges logged, nothing
re-extracted — a pass-through whose whole purpose is the machine's own reason-clearing
rule. A document that publishes on the second attempt must not still carry "Xero
rejected this" on its row.

The cost is honest and small: approve blocks for the follow-up (~2.4 s for the demo's
three items) instead of returning instantly. The win is that **no lock is held while a
vendor thinks**, and the follow-up runner is the exact place a BullMQ enqueue replaces
the inline call post-demo — one function, no call-site changes.

The delay is a constructor option (`DEMO_PER_ITEM_DELAY_MS = 800`, injectable `sleep`,
the `PrismaExtractionStep` pattern) rather than an env var: the unit suite passes
`perItemDelayMs: 0` and never waits, and the demo keeps its latency honesty. METH
sketched 1–2 s; 800 ms is deliberately under it, because the number multiplies by 500.

## TODO

- [x] METH Stage 10 (part 1): `LedgerAdapter` + `DemoXeroAdapter` + `LEDGER_ADAPTER`
      env + the pure server-computed preview and minimum check. Unit-tested offline.
- [x] The `publish.batch` executor — the shape above, in
      `validation-dedupe/proposals/publish-batch.ts` + `publish-follow-up.ts`. It
      replaced `notImplemented('publish.batch')` in that module's `registry.ts` (that
      ONE line), added the `publish` `FollowUp` variant and its engine arm, and takes
      the adapter through `buildExecutorRegistry({ publishing })` — a `PublishGateway`
      carrying this module's `LedgerAdapter` **and** `previewPublishBatch`, composed in
      `approvals.module.ts`. ⚠ **Handed over, not imported, and that is mechanical:**
      this module imports `validation-dedupe` (the publish minimum IS `evaluateReadiness`),
      so a runtime import back would close a cycle between two public seams — survivable
      in ESM only until someone calls something during module evaluation. The executor
      takes the SHAPES as `import type` (erased) and the FUNCTIONS as a dependency.
      A business with no active integration refuses, as required (`biz_dental` has none
      seeded); so does one with two, rather than picking.
- [x] **Launch stage A5 — a document can reach Published.** `export-destination.ts` +
      `publish.batch` releasing for export instead of demanding a ledger connection. The
      unit suite pins the D42 wording and the tripwire adapter; `publish-batch.integration.test.ts`
      (`s10_`) proves READY → PUBLISHED against a real database, including a client with
      **no** integration row.
- [x] A sweep for QUEUED `publishes` rows whose follow-up never completed — **not needed
      in ID**: the release resolves the row in the same transaction that creates it, so it
      cannot leave one QUEUED. It returns with the v1 ledger lane, alongside the dedupe
      sweep (`findStaleDedupeFollowUps`), on the worker.
- [x] `GET /v1/publishes` — `listPublishes`, `x-nt-side-effect: none`, `state` is an
      ARRAY query param (form + explode; omitted = every state). Thin controller,
      generated Zod at the boundary, `PublishingModule` and `app.module.ts` wire it.
      Unit-tested offline + an RLS integration test (`p10_`) proving another practice
      sees none of them.
- [ ] **v1, NOT ID** (D42) — the real Xero adapter behind `LedgerAdapter`
      (`LEDGER_ADAPTER=xero`): OAuth token storage on `integrations`, Zod-parsed HTTP
      responses, retryable/non-retryable mapped from status codes, and the follow-up
      runner moved onto BullMQ. Deliberately out of the first client release.
- [ ] Reference-list sync (`ReferenceSync`) — the seeded chart of accounts stands in for
      it in the demo, presented as synced. Out of Stage 10's scope on purpose.
- [ ] Integration health logic and webhooks — **v1, not ID** (D42). Canonical-model
      completeness IS ID work: it is what the export emitters read from.
- [ ] Release authority (D44): `Ready → Published` gated on the firm’s **super admin**,
      singly and in bulk. **Still not built — stage A12**, and it attaches on the ENGINE's
      approve path (`modules/approvals/action-proposals.service.ts`,
      `assertCan(actor, 'publish.release', …)` before the executor runs), NOT in the
      executor: the engine owns authorisation and an executor decides nothing about
      whether an effect may happen. Until it lands, any authenticated member of the
      practice can approve a `publish.batch`, which is the release. The `publishes` row
      already records `published_by_user_id`, so who released what is on the row either
      way (see `modules/approvals` TODO, Governance §11.2).
- [ ] `clearPublishingData` on unarchiving a PUBLISHED document — `document.archive`
      records `publishingDataClearDeferred` and leaves the `publishes` rows for this
      module (the seam agreed on #81). Still unbuilt.
- [ ] Update this file on exit — it is how the next session picks up.
