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
- `business.offboard` renders a shaped card — "books retained" stated, the
  reason verbatim when given; the payload carries the business **id**, not the
  name (the render must be payload-pure and the payload is `.strict()`), so
  the human name on the queue line is the client surface's to add.
- `render-summary.ts` — deterministic, pure render of what `[Read review]`
  shows; `rendered_summary_hash` is `canonicalHash` over it.
  **`publish.batch` now renders the bookkeeping ENTRY, not just three totals**
  (2 Sep 2026) — see the section below. `chase.send`
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
- `index.ts` — **the module's first public seam, added 2 Sep 2026.** It exports
  the AUTHORITY names from `assert-can.ts` and **nothing else**: no Nest module
  (the `auth-tenancy/index.ts` circular-boot hazard), no `ActionProposalsService`
  (creating a proposal from another module is the second door issue #81 exists to
  prevent), no audit writer yet. It exists because `assert-can.ts` grew a SECOND
  consumer — `POST /v1/practice-members` in `clients-team-settings` — and the
  choice was a seam or a second opinion about who may do what.
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

## `publish.batch` shows the ENTRY now, and two money bugs it uncovered (2 Sep 2026)

*"Before publishing show the accountant the actual accounting entry that will be
put into the VT software."* The card showed `Publish 43 documents — gross £…,
VAT £…` and nothing else: a human was authorising rows they had never seen, which
is the failure this whole module exists to prevent.

**Three things changed together.**

**1. The entry is computed INTO the payload at proposal time**, the pattern this
file already records for publish previews and `chase.send`. `render-summary.ts`
is payload-pure and may not read a database, so anything a card must show has to
arrive in the payload. `computePublishBatchPayload` now also calls
`previewExportEntries` and stores `entryPreview`; `renderSummary` renders it.

⚠ **It is the EXPORT's emitter, handed in, never re-implemented.**
`approvals.module.ts` imports `previewExportEntries` from
`exports-public-api/index.ts` and passes it down — the composition root is the
only place allowed to know two seams, and `validation-dedupe` takes it as a
`ExportEntryPreviewer` dependency (`import type` only) for exactly the reason
`PublishGateway` exists: a runtime import from there into `exports-public-api`
is the arc that would close a cycle between two public seams. Nothing in this
module formats a VT cell, picks a file, or decides what goes in the Analysis
account column. `render-summary.ts` chooses headings and labels; that is all.

**2. Execution re-checks the entry, not only the totals.** Re-coding a document
from one nominal to another is the commonest edit between propose and approve,
and it leaves gross and VAT untouched — so the three-integer check cannot see it,
and `NT-PRP-004` structurally cannot either (review is idempotent, the render is
payload-pure). `sameEntryPreview` compares the rows. ⚠ It fingerprints through
**positional arrays**, because `action_proposals.payload` is `jsonb` and Postgres
normalises object key order — a naive `JSON.stringify` of the two sides reports
drift on every approval.

**3. Absence is silence, everywhere on this path.** A payload with no
`entryPreview` reviews with the card it always had; a payload with no
`preview.currency` skips the currency comparison. Both are newer than rows that
are already in the database, and a required addition would have made every
pending proposal unreviewable or unapprovable. `entryPreview` and `currency` are
therefore both OPTIONAL in the contract, and `preview` is `.strict()` — which is
the mechanism that made this non-negotiable rather than a preference.

⚠ **The `.strict()` trap, recorded because it cost a full test-suite cascade.**
`preview` gained `currency` in the API before the contract had it. The generated
member schema is `.strict()`, `parseStoredProposalPayload` re-parses the stored
payload at review time, and it failed — so **every publish review answered
`NT-PRP-006` "the stored payload no longer parses"**, and the failure surfaced
nowhere near the field that caused it. Anything added to a stored payload needs
the contract in the same change.

### The two money bugs the card was hiding

- **A USD invoice rendered as `gross £54352.51`.** `penceToGbp` hardcoded the
  symbol and the preview carried no currency at all. On the one path where the
  product guarantees that what was shown is what was approved. It is now
  `penceToMoney(value, code)`, `PublishPreview.currency` is the single shared
  code **or null**, and ⚠ **null means "these totals are not money in any one
  currency"** — rendered bare, with the reason on the card. Null is never
  sterling; substituting `£` reintroduces the defect. Pinned in
  `render-summary.test.ts` by asserting no symbol survives anywhere in the
  render, and in `publishing/publish-preview.test.ts` on the collapse rule.
- **The card said "Publish", which D42 forbids.** The title is now *"Release N
  documents for export"*. There is no ledger connection in this release and
  *Published* is an internal state; `render-summary.test.ts` reads the rendered
  strings and fails on the forbidden vocabulary, mirroring
  `apps/web/src/views/ExportView.test.tsx`. The contract carried the same claim
  in two descriptions (*"Publish 43 bills to Xero"*) and both were corrected.

**The gate is untouched.** The entry is part of the review, not a substitute for
it: Approve is still unreachable until `POST .../review` has run, approve still
echoes `renderedSummaryHash`, and `LiveProposalCard` still withholds Approve if
it cannot render a section (`apps/web/src/api/proposals.ts`, fail-closed) — the
new sections use the same `{heading, entries[{label, value}]}` shape, so nothing
on the web side had to change to display them.

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

✅ **A seeded database CAN now release** (2 Sep 2026). `prisma/seed.ts` gave
`mem_priya` `isOwner: true` but she has no demo credential, while the login-able
`mem_shakib_demo` was a `PRACTICE_ADMIN` with the flag unset — so on a seeded
laptop the account you could sign in as composed but could not release, and the
one behaviour this gate exists to protect could be tested by nobody. The flag is
set on that row. Real practices were never affected (signup writes the owner).

⚠ **The UI is not the gate, and must not pretend the action does not exist.**
Governance §11.2 says so in as many words. What the server provides for honest
degradation is the fact (`BusinessMember.role` / `.scope` / `.isOwner`, A11) and
a refusal whose `detail` is written to be read by the person who pressed the
button — *"Only your practice's super admin can release documents for export. Ask
them to approve it."* Hiding the button instead would be a different lie.

## `team.invite` — the second `PermittedAction` (2 Sep 2026)

`POST /v1/practice-members` is the first operation in the product that grants
somebody access to a practice, so its gate lives here rather than in the module
that offers it — the same argument the release gate makes.

**`mayManageTeam(actor)` is `canRelease(role)` WITHOUT the `isOwner`
narrowing**, and this is the first time the two rules diverge. Three reasons,
written out at the function rather than left to be inferred from a missing
conjunct:

1. **Inviting is reversible and internal.** `RELEASE_KINDS` draws its line at
   acts that reach outside the product and cannot be taken back. An invitation
   reaches one colleague's inbox, grants nothing until they accept, and expires
   by itself in seven days. It is D44's *compose and edit* half.
2. **Ownership would make team management a bus factor of one.** Exactly one
   membership per practice can carry `isOwner`, and there is no ownership-TRANSFER
   operation — so a firm whose founder is away could not add the temp they hired
   that morning, and the fix would be a DBA.
3. **The cost is bounded by what an invitation can grant.** `PRACTICE_ADMIN` is
   refused at the invite boundary and acceptance always writes `isOwner: false`,
   so an invited colleague can never release. The widest thing this permits is an
   admin adding somebody who composes and edits.

`assertCan` is overloaded: `team.invite` takes **no resource**, because a release
is authorised against one proposal and inviting is authorised against the
practice the session already fixes.

## `business.people.manage` — the THIRD `PermittedAction` (2 Sep 2026)

The product owner ruled on 2 Sep 2026 that a client business's own manager, HR
lead or owner adds and removes their staff from their portal; Settings → People
said the opposite. That made a third guarded act, and this file's own header says
what to do with one — the rule is written once, here, and `modules/portal` imports
it through `index.ts` rather than growing a second opinion beside its service.

**`mayManagePeople(actor)` is `BUSINESS_ADMIN || USER_ADMIN`.** `WorkspaceRole`
already contained all three business-level roles before any of this was built,
and the middle one reads as purpose-built: a business-side **user**
administrator. Nothing had ever granted it, so this is the first surface that
gives it a meaning.

- **`BUSINESS_ADMIN`** — the owner. Everything, including making somebody else an
  owner, which is what makes the last-owner rule escapable.
- **`USER_ADMIN`** — the office manager. The same people authority and nothing
  else: no billing, no export, no release.
- **`BUSINESS_STANDARD`** — reads the list, changes nothing. Deliberately not
  "cannot see it": who else can send paperwork on your employer's behalf is not a
  secret from you, and hiding the section would be the *"pretend the action does
  not exist"* failure §11.2 names.

⚠ **`isOwner` is not consulted, and that is not an omission.** For a portal actor
`isOwner` MIRRORS `BUSINESS_ADMIN` (`portalActorFor` sets it from the role), so a
conjunct would be a second spelling of the first — tested in both directions.

⚠ **A practice role is refused here, and that is not an oversight.** A
`PRACTICE_ADMIN` is not a member of the client's staff, and this rule is never
consulted for one: the only caller is the portal, whose actor is a `contacts` row
on exactly one business. An accountant adding a client's user is the older,
separate door (`POST /businesses/{businessId}/members`, workspace cookie), and it
is unchanged. Two doors onto one outcome is a thing this codebase normally
refuses — the difference is that these two have different PRINCIPALS, so
collapsing them would mean one authority checking a credential it cannot hold.

Like `team.invite` it takes **no resource**: the business is fixed by the portal
session's own `otp_sessions` row before this is reached, so a `businessId`
argument would be a second answer to a question the session has settled — and the
one place a caller could get it wrong.

⚠ **The actor is NOT `resolveActor(db, ctx)`.** A portal person usually has no
`users` row at all (SoT §3.3's phone-only contacts are real), so
`portalActorFor(contactRow)` builds it and `Actor.actorId` carries a **contacts**
id. Safe because `assertCan` reads only `role`; honest because a contact id is a
genuine, stable identifier for the person acting. `role === null` — a chase
session, whose `contact_id` is deliberately NULL — refuses, as everywhere here.

## `business.profile.manage` — the FOURTH `PermittedAction` (5 Sep 2026)

`PUT /portal/business-profile` (the setup journey's details step, review item 4)
is a client business restating its own record — trading name, company number,
legal structure, industry, website, VAT facts. The rule lives here with the
other three, for this file's standing reason.

**`mayManageProfile(actor)` is `BUSINESS_ADMIN` only — deliberately NARROWER
than `business.people.manage`.** A `USER_ADMIN` was granted exactly people
management and nothing else (that role's whole definition); a company number, a
VAT registration and a legal structure are the owner's facts to state.
`role === null` refuses, as everywhere here. Like the other two portal-facing
actions it takes **no resource**: the portal session's `otp_sessions` row fixes
the business before this is reached. The refusal is `NT-PRM-001` with its own
sentence ("Only an owner at your business can change its own details").
Consumer: `modules/portal/portal-business-profile.service.ts`, through
`index.ts`.

## `document.purge` — the fourteenth kind (2 Sep 2026)

Permanent document deletion, added with the Trash work in `modules/documents`.
Executor and full reasoning live in `validation-dedupe/proposals/purge-document.ts`;
what belongs here is the two decisions this module owns.

**`RELEASE_KINDS['document.purge'] = false`, and it is the most arguable entry
in that table.** A purge is irreversible, and irreversibility is half of what the
gate is about. It is ungated because the OTHER half is what the table actually
selects for: D44's two kinds both **reach outside the product** — a message to
somebody else's client, a figure released for export — and a purge reaches
nowhere. It destroys one of the practice's own rows, in their own workspace,
after a human already put it in Trash.

What protects the D43 promise here is not the approver's rank but the executor's
refusal: a released document, or one carrying an export link or named by a
statement, **cannot be purged by anybody, the super admin included**. A
permission gate would have been a weaker guarantee wearing a stronger word — it
would let the one person who may release also destroy the link their release
created. Revisit if a firm asks; the refusal is the part that must not move.

**The review card states the shortfall, not just the intent.** `render-summary.ts`
renders what is destroyed, what survives, **"Stored files: NOT deleted"**, and
the refusals as a PROMISE rather than a result — the render is payload-pure and
may not read a database, so it cannot say whether THESE documents are exported,
only that the executor will check. The `document.reprocess` precedent
(*"Reads the document again: No"*), applied to an act nobody can undo.

⚠ `NT-DOC-002` is now in the `ErrorCode` enum. `NT-DOC-001` is **not**, and the
asymmetry is deliberate: -001 is a `documents.failure_code` value that never
reaches the wire (its runbook page says so), -002 is a real 409.

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
# The `team.invite` half is proven from the other side, in
# `clients-team-settings/practice-invite.integration.test.ts` — a REAL invited
# colleague (created through invite + accept) is refused the release.
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
  **`chase.send` joined the compose-at-creation pattern on 1 Sep 2026**:
  `create()` calls `computeChaseSendPayload` (validation-dedupe seam) to
  compose each message body server-side with a SIGNED portal link over a
  minted chase id the executor adopts, discarding the caller's body — the
  S13 compose-seam gap, closed. The service takes a `ChaseComposeConfig`
  (portal-link secret + `APP_ORIGIN`) as its sixth constructor arg, wired in
  `approvals.module.ts`; `render-summary.ts` heads each message section with
  the payload's `recipientEmail` when present (the A13 render leftover).
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
- [x] **`prisma/seed.ts` gives the login-able demo admin `isOwner: true`**
      (2 Sep 2026, with the practice-invite work). The G7 ceremony was retired on
      1 Sep, so the one-word fix landed with the change that made it matter.
- [ ] ⚠ **No ownership TRANSFER operation exists, and this is now the sharpest
      edge in the module.** An invite path landed (`POST /v1/practice-members`),
      and the ONLY reason it did not make this urgent is that it REFUSES
      `PRACTICE_ADMIN` by name — precisely because an invited admin would hold
      `canRelease === true` and `isOwner === false`, could not release, and would
      be told *"only your practice's super admin can"* by a screen that had just
      called them an admin. `team-authority.ts`'s `INVITABLE_PRACTICE_ROLES` is
      what changes the day transfer exists.
- [ ] **`memberships.permissions` is not consulted by the gate.** Governance
      §11.1 describes per-permission toggles and `prisma/seed.ts` fills the array,
      but `practice-signup.service.ts` leaves it `[]` — so requiring a `publish`
      string would mean nobody could ever release, and defaulting empty to
      "allowed" would make the field decorative. Role + ownership is the whole
      rule until a grant surface exists to fill it. ⚠ **`apps/web` removed the
      per-permission tick-boxes on 2 Sep 2026** for the same reason: a toggle that
      governs nothing is the same lie as an invite button that sends nothing.
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
