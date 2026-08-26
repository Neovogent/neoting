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
  renders every SMS byte-for-byte (the contract's words); `rule.create`
  (METH S13, #142) renders the rule in full — tier, scope, conditions and
  every field it sets — because a reviewer must see what will start coding
  their client's documents, not a JSON blob. A12 shaped two more: `reject`
  shows the reason **verbatim** (the contract's word for it), and `reprocess`
  states what it does *not* do — *"Reads the document again: No"* — because
  Review → Approve promises that what was shown is what happens, so a shortfall
  belongs on the card rather than in a source file nobody opens. Kinds without a
  shaped card yet (`move-business`, `split`, `revoke-link`, `bank.confirm-match`)
  fall back to naming every payload member.
- `assert-can.ts` — **the release gate** (A12, D44, Governance §11.2). See the
  section below; the file's own header carries the full reasoning.
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

## The release gate — D44, stage A12

`assert-can.ts`, called from `action-proposals.service.ts` on the **approve**
path. Read its header before changing anything here; the short version:

- **Only the firm's super admin may release.** `mayRelease(actor)` is
  `canRelease(role) && isOwner` — the role half imported from A11's public seam
  (`clients-team-settings/index.ts`), never re-derived, so "which role" is
  written once. The `isOwner` half is the narrowing A11's `team-authority.ts`
  explicitly handed to this stage: D44 says *the* firm's super admin, singular,
  and `PRACTICE_ADMIN` alone reads as *any* admin. Today the two rules select the
  same person in any real practice — signup mints exactly one `PRACTICE_ADMIN`
  and sets `isOwner` on the same row, and `POST /businesses/{id}/members` refuses
  every practice-level role — so this costs nothing now and prevents a silent
  widening on the day an invite path for a second admin lands.
- **Two kinds are gated: `publish.batch` and `chase.send`** — D44's two, and the
  only two acts that reach outside the product and cannot be taken back.
  `RELEASE_KINDS` is a **total** record over `ProposalKind`, the way the executor
  registry is: a new kind that fails to compile there has to answer "is this an
  irreversible outward act?" rather than inherit a default. `document.revoke-link`
  is deliberately `false` — it *is* outward, but revoking is a **containment**
  action and a rule that lets only one person stop a leaked link makes the leak
  last longer. A8 may revisit with that surface in front of it.
- **Where it sits in the ladder: after the RLS lookup, before everything else.**
  A proposal the caller cannot see is `404 NT-VAL-001` (RLS decided first, and
  the answer never confirms it exists). A proposal they can see but may not
  release is `403 NT-PRM-001` — a **permission** refusal, not a visibility one,
  and it discloses nothing, because every fact it implies is already on
  `GET /action-proposals/{id}` for that same caller. It is ordered above the
  review/TTL/hash gates so a refused releaser cannot use approve as an oracle for
  a proposal's state.
- **The executor never runs.** That is the assertion, and
  `release-gate.integration.test.ts` makes it against a real database: document
  still READY, no `publishes` row, no audit row, proposal **not consumed** — then
  the owner approves the very same proposal and it releases.
- **The membership read is lazy.** Only a gated kind resolves an actor, so the
  ordinary compose-and-edit approvals every accountant does all day cost no extra
  query. `memberships` carries no RLS (it is a table the policies read), so the
  `userId` + `practiceId` + `businessId: null` filter **is** the boundary there;
  `ctx.actorId` comes from the verified session.

⚠ **A seeded database has nobody who can release.** `prisma/seed.ts` gives
`mem_priya` `isOwner: true` but she has no demo credential, while the login-able
`mem_shakib_demo` is a `PRACTICE_ADMIN` with the flag unset. So on a seeded
laptop the account you can sign in as composes but cannot release. Real practices
are unaffected (signup writes the owner), and the §24.7 walkthrough starts from
signup — but `prisma/` is LAW, so the one-word fix is a contract-change issue.
See the TODO.

⚠ **The UI is not the gate, and must not pretend the action does not exist.**
Governance §11.2 says so in as many words. What the server provides for honest
degradation is the fact (`BusinessMember.role` / `.scope` / `.isOwner`, A11) and
a refusal whose `detail` is written to be read by the person who pressed the
button — *"Only your practice's super admin can release documents for export. Ask
them to approve it."* Hiding the button instead would be a different lie.

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
implemented) · `NT-IDM-001` idempotency-key reuse with a different payload, or
the **same key from a different actor** (A12 — see below) · **`NT-PRM-001` (403)
the actor may not release this kind** (A12; runbook page in
`docs/runbooks/error-codes.md`) · 404s carry `NT-VAL-001` (no NT-NOT code
exists), never confirming existence.

**The idempotency fingerprint is actor-scoped since A12.** The store is a
process-wide map keyed by a *caller-chosen* string, and a replay returns its
stored response **before** any scoped query runs — so without the actor in the
fingerprint, presenting somebody else's `Idempotency-Key` with a matching body
replayed their response past RLS and past the release gate. Nothing executed
twice (the row is consumed and the DB guard is what makes that true), so it was a
disclosure hole rather than an effect one — but on approve the thing disclosed is
the outcome of an approval the caller was refused. `fingerprintFor(ctx, request)`
narrows it; it does **not** close the class, because the store itself is neither
durable nor tenant-scoped. Same change as the durable-store TODO.

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
# Since A12, `release-gate.integration.test.ts` (prefix `a12g-`, teardown by
# EXPLICIT id list) proves the refusal has NO effect: a non-owner
# PRACTICE_ADMIN approving a publish.batch gets 403 NT-PRM-001 while the
# document stays READY, `publishes` stays empty, no audit row is written and
# the proposal is not consumed — then the owner approves the same proposal.
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

- [x] **The release gate** (D44, Governance §11.2) — landed in launch stage A12.
      `assertCan(actor, 'publish.release', resource)` on the approve path, before
      the executor, for `publish.batch` and `chase.send`. Propose-permission and
      approve-permission are now distinct for those two kinds; every other kind is
      still propose-anything/approve-anything within the practice, which is D44's
      compose half and is intended. **Still open:** the workspaceSession/CSRF
      requirement on approve awaits the auth hardening pass.
- [ ] ⚠ **`prisma/seed.ts` leaves the only login-able demo admin unable to
      release.** `mem_shakib_demo` is a `PRACTICE_ADMIN` with no `isOwner`, and
      `mem_priya` (who has it) has no demo credential. One word — `isOwner: true`
      on that seed row — but `prisma/` is LAW, so it needs a contract-change issue
      (G7). Real practices are unaffected: signup writes the owner.
- [ ] **No ownership TRANSFER operation exists in the contract.** With release
      authority narrowed to `isOwner`, a practice whose owner leaves cannot
      release until a DBA moves the flag. The bus factor is identical today under
      any reading (only signup mints a `PRACTICE_ADMIN`), so this is not urgent —
      but it becomes urgent the moment a second admin can be invited, and it is
      the thing to build alongside that invite path.
- [ ] **`memberships.permissions` is not consulted by the gate.** Governance
      §11.1 describes per-permission toggles and `prisma/seed.ts` fills the array,
      but `practice-signup.service.ts` leaves it `[]` — so requiring a `publish`
      string would mean nobody could ever release, and defaulting empty to
      "allowed" would make the field decorative. Role + ownership is the whole
      rule until a grant surface exists to fill it.
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
