# approvals — the Review → Approve engine

**Lane H** · **Source of Truth:** SoT §4 Stage 9, Governance §10 · **Built by:** METH S3 (issue #122) · **Contract:** the five `/v1/action-proposals` operations

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

- `action-proposals.controller.ts` / `.service.ts` — the five ops. Approve runs
  gate-ladder → executor → proposal consumption → audit append in **one**
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
- `approvals.module.ts` — builds `buildExecutorRegistry()` and the
  `PrismaDuplicateDetector` INSIDE the service factory, through the two
  modules' public seams (`validation-dedupe/index.ts`,
  `ingestion-routing/index.ts`). **No token ever names an executor** — that is
  this module's half of the #81 no-bypass promise; `executors.test.ts` pins
  the controller-import half.

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

`document.route`'s deferred dedupe runs AFTER commit via
`runDedupeFollowUp` + the real detector; a failure is a loud log, never a 500
for a committed approval — the in-transaction deferral event keeps it
sweepable. The periodic sweep over `findStaleDedupeFollowUps` is **not wired
yet** (see TODO).

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
- [ ] Periodic sweep over `findStaleDedupeFollowUps` (worker concern).
- [ ] Durable idempotency store (with web-upload, one change).
- [ ] `audit_events.practice_id` (G7 contract change) — today the
      NULL-business chain is one global chain, world-readable under the
      shipped RLS read policy. Recorded in audit-writer.ts.
- [ ] Approval *workflows* (multi-stage/branching), expiry sweep, pseudonym
      map, proposal list endpoint (none is contracted yet — Stage 12 reads the
      queue somehow; decide there).
- [ ] Update this file on exit — it is how the next session picks up.
