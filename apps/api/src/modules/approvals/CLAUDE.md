# approvals — the Review → Approve engine

**Lane H** · **Source of Truth:** SoT §4 Stage 9, Governance §10 · **Built by:** METH S3 (issue #122), list added METH S12 (issue #140) · **Contract:** the six `/v1/action-proposals` operations

## Purpose

The constitutional path every state change takes: create a proposal → open the
review (`[Read review]`) → approve (`[Approve]`, the **one** `x-nt-side-effect:
execute` operation in the whole API) → the registry executor runs the effect —
or cancel. The contract existed first; this implements it, it does not redesign
it.

## Division of labour (the #81 seam, honoured)

THIS module owns: the review gate, the shown-hash comparison, TTL, exactly-once
execution, the audit write, the `outcome` record, and idempotency. An executor
(they live in the domain modules — today `validation-dedupe/proposals/`)
performs exactly one effect inside the transaction this module opens, and
decides nothing about whether it may happen.

- `action-proposals.controller.ts` / `.service.ts` — the five engine ops, plus
  `GET /v1/action-proposals` (METH S12, issue #140 — the contract delta the
  TODO below deferred, signed off by Shakib on the issue). The list is the
  approval queue's read surface: keyset on `createdAt desc` (the chases-surface
  shape), `businessId`/`state`/`kind` as user FILTERS on the RLS-scoped set,
  no default state exclusion. Reading the list is NOT reviewing — nothing on
  it writes, and `[Approve]` stays server-gated on `POST .../review`. Approve
  runs gate-ladder → executor → proposal consumption → audit append in **one**
  `scopedDb` transaction; a refusal anywhere rolls the whole atom back.
- `proposal-body.ts` — boundary parsing. **Read its header before touching it**:
  two measured orval gaps mean the generated `createActionProposalBody` union
  cannot be used whole (the discriminator is `zod.unknown()`, and `allOf` +
  `.strict()` emits an intersection that rejects *every* input). The generated
  halves are parsed separately, member selected by the spec's `oneOf` order,
  pinned by `proposal-body.test.ts`. When orval fixes either gap the pinning
  test fails and this file collapses to one `parseBoundary`.
- `render-summary.ts` — deterministic, pure render of what `[Read review]`
  shows; `rendered_summary_hash` is `canonicalHash` over it. `chase.send`
  renders every SMS byte-for-byte (the contract's words). Kinds without a
  shaped card yet fall back to naming every payload member.
- `audit-writer.ts` — the minimal hash chain: `sha256(prev_hash +
  canonical_payload)`, seq per business allocated under a transaction-scoped
  advisory lock (the decision prisma/CLAUDE.md's open question 4 asked for —
  do not remove the lock: NULL-business seq has no unique-constraint backstop).
  `actor_pseudonym` stays NULL until the pseudonym map exists; the approver is
  on the proposal row and in `outcome`.
- `canonical-hash.ts` — canonical JSON (sorted keys, dropped undefined) +
  SHA-256. `payload_hash`, the rendered hash and the audit chain all use it.
- `approvals.module.ts` — builds `buildExecutorRegistry(...)`, the
  `PrismaDuplicateDetector` and the `PublishGateway` INSIDE the service
  factory, through the modules' public seams (`validation-dedupe/index.ts`,
  `ingestion-routing/index.ts`, since METH S8 `chase/index.ts` for the
  config-selected `SmsSender` passed to the registry — `chase.send` "sends"
  through it — and since METH S10 `publishing/index.ts`). **No token ever names
  an executor** — that is this module's half of the #81 no-bypass promise;
  `executors.test.ts` pins the controller-import half.
  **Why publishing arrives in two pieces** (METH S10): the `LedgerAdapter` is
  config-selected, so it comes through DI (`imports: [PublishingModule]`,
  `inject: [LEDGER_ADAPTER]`); `previewPublishBatch` is a pure function with no
  configuration to choose, so it is imported. Both go to the executor as ONE
  `PublishGateway` — the same object the service keeps — because an engine that
  queued a batch through one adapter and published it through another would be
  two systems wearing one name. It is handed over rather than imported by the
  executor because publishing imports validation-dedupe, and a runtime import
  back would close a cycle between two public seams. The composition root is
  the place allowed to know both.

## Enforcement is layered, deliberately

Every service refusal is ALSO enforced by `action_proposals_guard()` in the
database (rls.sql §6): approve-requires-review, executed-is-immutable,
payload-hash-frozen. The service exists to turn those into contracted
problem+json; the integration test proves the trigger holds when the service
is bypassed with a raw UPDATE. Racing approvals serialise on `SELECT … FOR
UPDATE` **before** the gate ladder, so a loser refuses `NT-PRP-005` without
its executor ever running.

## Error codes

`NT-PRP-001` unknown kind (checked before the body parse — the contract's
"rejected outright") · `NT-PRP-002` approve before review · `NT-PRP-003`
expired (TTL 24 h, checked at review/approve; the EXPIRED-state sweep is
deliberately unbuilt) · `NT-PRP-004` echoed hash ≠ stored hash · `NT-PRP-005`
already executed · `NT-PRP-006` not executable (unreachable referenced record,
executor refusal, cancelled, stored payload no longer parses, executor not yet
implemented) · `NT-IDM-001` idempotency-key reuse with a different payload ·
404s carry `NT-VAL-001` (no NT-NOT code exists), never confirming existence.

## Post-commit follow-ups

`FollowUp` is a discriminated union and `runFollowUps`' switch is total over
it, the way the registry is total over `ProposalKind` — a new member that fails
to compile there is the point. **Two members.**

`document.route`'s deferred dedupe runs AFTER commit via
`runDedupeFollowUp` + the real detector; a failure is a loud log, never a 500
for a committed approval — the in-transaction deferral event keeps it
sweepable. The periodic sweep over `findStaleDedupeFollowUps` is **not wired
yet** (see TODO).

`publish.batch`'s ledger call (METH S10) runs AFTER commit via
`runPublishFollowUp` + the injected `LedgerAdapter`, and this one is not a
convenience — ⚠ **an external HTTP call must never hold a tenant transaction
open.** A batch is up to 500 items and a real Xero round trip lasts as long as
someone else's network decides. The executor commits `publishes` rows in
QUEUED (durable intent, atomic with the approval) and this drives the vendor
per item, each resolution in its own short transaction. A failure here is the
same loud log: the QUEUED rows are visible, truthful and re-drivable by calling
the runner again. **Approve therefore blocks for the publish** (~2.4 s for the
demo's three items) instead of returning instantly — the accepted cost, and the
exact seam a BullMQ enqueue replaces post-demo, with no call-site changes.
`modules/publishing/CLAUDE.md` carries the full reasoning.

## Tests

```bash
pnpm --filter @neoting/api test -- approvals            # unit, offline
# integration (needs docker compose up + .env): the METH S3 acceptance —
# create→review→approve archives + audit chain recomputed; the DB guard
# refused raw; double-approve exactly-once; cross-practice 404.
```

## Decisions a future session should know

- **Executor refusal rolls back and returns 409 `NT-PRP-006`** — it is NOT
  recorded as a failed execution on the row (proposal-executor.ts's header
  imagined recording it; recording would consume the proposal and block retry
  after facts change). Revisit if a kind needs failure forensics on the row.
- **Approve verifies the echoed hash against the STORED hash.** Review is
  idempotent and returns the stored render, so facts-moved detection is only
  as strong as the render being payload-pure — kinds whose reviews must read
  live state (publish preview) put those facts IN the payload at creation.
  METH S10 closed the other half of that: `publish.batch`'s executor
  re-computes the preview from live rows and refuses if it no longer matches
  the payload's. `NT-PRP-004` structurally cannot see that drift, so the
  executor is the only place it is visible — a pattern any future kind whose
  payload carries live facts should copy.
- The `Idempotency-Key` store is the shared in-memory one
  (`common/idempotency/` — moved there from web-upload when this module became
  its second consumer). Durable store remains the known follow-up, same as
  web-upload; the DB guard is what makes exactly-once true regardless.
- `expiresAt` = now + 24 h at creation. Nothing flips rows to `EXPIRED`; the
  gates refuse expired rows at the moment it matters.

## TODO

- [ ] Approve-permission split (Governance §11.2): propose-permission and
      approve-permission are not yet distinct — `assertCan` matrix is
      explicitly out of METH S3 scope. The workspaceSession/CSRF requirement on
      approve likewise awaits the auth hardening pass.
- [ ] Periodic sweep over `findStaleDedupeFollowUps` (worker concern), and the
      same sweep for QUEUED `publishes` rows whose `runPublishFollowUp` never
      completed. One worker, both follow-ups.
- [ ] Move the publish follow-up onto BullMQ so approve stops blocking for the
      ledger. The runner is already the single call site; nothing else changes.
- [ ] Durable idempotency store (with web-upload, one change).
- [ ] `audit_events.practice_id` (G7 contract change) — today the
      NULL-business chain is one global chain, world-readable under the
      shipped RLS read policy. Recorded in audit-writer.ts.
- [x] Proposal list endpoint — decided in METH S12 (issue #140): a contracted
      `GET /v1/action-proposals` with `businessId`/`state`/`kind` filters,
      approved by Shakib on the issue. Unit-tested (filters/order/projection)
      and integration-tested (own practice sees its pending row, the other
      practice's page is empty; reading never touches `reviewedAt`).
- [ ] Approval *workflows* (multi-stage/branching), expiry sweep, pseudonym
      map.
- [ ] Update this file on exit — it is how the next session picks up.
