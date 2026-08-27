# chase

**Lane G** · **Source of Truth:** SoT §4 Stage 8 · **Owner:** see the project board

## Purpose

The five detection engines, chase composition, delivery with OTP secure links, the upload portal endpoints, the policy scheduler, and auto-close on matching inbound.

⚠ **Since launch stage A13 the chase has a real transport, and it is EMAIL.** SMS was cut for Initial Delivery and `DemoSmsSender` only ever wrote an outbox row, so until A13 nothing this module composed could reach a client. `EmailChaseSender` sits behind the SAME `SmsSender` seam, selected by `SMS_SENDER=email`, and carries the reviewed body byte-for-byte. Read "The email transport" below before touching anything in the send path.

## ⚠ Initial Delivery (ID) — read this before the sections below

**ID ships THREE of the five detection engines** (SoT §24.2 Stage 8), and the omissions are worth knowing rather than guessing at:

- **In:** (a) bank transaction with no matched document · (c) bank-statement period gap · (e) expected recurring document not arrived. ⚠ **Built today: (a) alone.** Launch stage A13 shipped engine (a) and its transport on purpose — §24.2.3 argues (a) is the differentiator, and (c) and (e) are additive behind the same shape.
- **Out, and for different reasons:** (d) *accounting-software transaction without an attachment* has nothing to read in ID — D42 means there is no ledger connection to read it from. (b) is out on scope, not on principle.
- **Composition and release are separate authorities (D44).** Accountants and their team members may compose and edit chase message text; only the firm’s **super admin** releases it. The existing “every SMS is shown verbatim in review before sending” invariant is unchanged and still absolute — D44 adds *who may press send*, it does not relax *what they are shown*.
- **Every inbound channel is identity-gated (D45)** — portal by OTP to the registered mobile, email from a registered address, WhatsApp from a registered number. A chase can still be closed by a reply through any of them; it simply cannot be closed by a stranger.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- The flagship. **Every message is shown verbatim in review before sending, whatever carries it.** `render-summary.ts` renders the payload body byte-for-byte and `rendered_summary_hash` is computed over that render; `chase_messages.body` is the same string; and since A13 the email body is the same string again. **No transport may compose, re-render or template.** The chase lane's delivery is email for ID (`SMS_SENDER=email`); a client may still reply through any inbound channel and that still closes the chase.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

## Tests

```bash
pnpm --filter @neoting/api test -- chase
```

## Current state

### The chase domain core (METH Stage 8)

The foundational seam the rest of Stage 8/9 builds against: detection engine
(a), composition, the portal-link token, the SMS sender, and the `chase.send`
executor. **// DEMO-MOCK throughout** — a real system with a fake vendor (no
Twilio, ever), not a fake system.

- **`suppression.ts`** — `SUPPRESSION_DESCRIPTORS` (the SoT §4 Stage 7 list,
  verbatim: `SERVICE CHARGE · COMMISSION · CHG · CHAPS · UNPAID · OD INTEREST ·
  SUMUP · WORLDPAY · STRIPE PAYOUT`) + `isChaseSuppressed(descriptionRaw)`, a
  pure case-insensitive substring predicate. The per-client extension SoT names
  is a recorded seam (needs a schema column, G7). Nobody is chased for a receipt
  that cannot exist.
- **`detection.ts`** — `detectUnmatchedChases(db, businessId)`, **engine (a)
  only**. Takes a `ScopedClient` (the caller opens `scopedDb`, RLS decides
  visibility). **Four gates since A13**, each closing a different way of asking
  for something we already have: the stored `chaseSuppressed` flag · the
  descriptor scan (`isChaseSuppressed`) · `matchState = UNMATCHED`, which is
  both the "no matched document" half of engine (a) and the *document already
  received* gate (a line whose paperwork arrived is SUGGESTED or CONFIRMED and
  never appears) · and `alreadyChasedTransactionIds`, the *chase already open*
  gate. That last one is new and it is the "do not over-ask" rule: **any chase,
  in any state, suppresses the line it covers.** Open means we have already
  asked and there is no reminder scheduler; `CLOSED_RECEIVED` means auto-close
  matched a document to it, and chasing then is chasing for a receipt we are
  holding; the other `CLOSED_*` states are somebody's decision not to chase,
  which re-detection would quietly overturn. It is keyed on `itemRefs` (through
  `chase-projection.ts`'s `chaseItemRefs`) and not on `transactionId`, because a
  grouped chase covers many receipts and only the first is in the convenience
  column — keying on that alone re-chases every other line in the group. **No
  new rules were written**: the descriptor list is `suppression.ts`'s, the
  refs narrowing is the projection's, and "the document arrived" stays whatever
  `auto-close.ts` and `bank.confirm-match` decided. // DEMO-MOCK lists engines
  (b)–(e); they are FIXTURE for the demo. ⚠ **A13 shipped engine (a) only, on
  purpose** — (c) period-gap and (e) expected-recurring are additive later. The
  pure predicates are split from the DB read (both unit-tested).
- **`sms-copy.ts`** — `composeChaseSms(input)`, a PURE function producing the SoT
  §8.2 copy **verbatim**: *"American Burger Accounts: we're missing the receipt
  for Currys £1,299 on 9 Aug. Upload securely: <link>"*. Grouped per client (one
  text, many receipts), never one per receipt. Money is integer pence and
  `formatGbp` is STRING arithmetic only — no float ever touches it, even in the
  formatter; `formatDay` renders the Europe/London day from a UTC instant.
  // DEMO-MOCK: Sonnet writes the bespoke copy behind this template.
- **`portal-link.ts`** — the signed portal-link token, **the format DEFINED HERE
  and consumed by Stage 9's OTP portal**. `signPortalLink({chaseId, expSeconds})`
  / `verifyPortalLink(token) → {chaseId} | invalid | expired`, HMAC over
  `{chaseId, exp}` with `PORTAL_LINK_SECRET` (node:crypto, the upload-token /
  session-cookie pattern). Fail-closed on an empty secret. The link is
  forwardable (SoT §8.3) — it grants nothing on its own; the OTP and the
  delegated RLS scope gate the data.
- **`sms-sender.ts` + `select-sms-sender.ts`** — `SmsSender { send(db, messages) }`
  + `DemoSmsSender`, which "sends" by writing the outbox (`chase_messages` update
  + `sms_log` insert) through the caller's `ScopedClient` — no Twilio. Selected
  by config not import, mirroring `selectExtractor` / `selectMediaFetcher`
  exactly. **`SMS_SENDER` now admits `demo` and `email`** (A13); see below.
- **`chase.module.ts`** — exposes the config-selected `SMS_SENDER` provider (the
  one provider with a runtime dep) and now the read surface: `ChasesController` +
  `ChasesService`. Composition, token and detection stay pure/scoped-client
  functions used directly, not injected. Registered in `app.module.ts`.

### The read surface — the three GETs (METH Stage 8)

`GET /v1/chases`, `/v1/chases/{chaseId}`, `/v1/sms-outbox`, all
`x-nt-side-effect: none` — **there is no write on this surface, and that is
structural.** A chase is created ONLY by the approved `chase.send` executor on
the Review → Approve spine; nothing here mutates, so no side-effect path outside
that spine can hide on it (the documents-surface discipline, applied to chases).

- **`chases.controller.ts`** — thin, `@Controller()` with explicit paths (the
  auth-controller shape, because `sms-outbox` is not under `chases`). Coerce the
  query (`coerceQuery` — Express gives strings; the schema types `limit` a number
  and `state` an array), `parseBoundary` with the generated zod
  (`listChasesQueryParams` / `getChaseParams` / `listSmsOutboxQueryParams`),
  resolve the context inside Nest's pipeline (a bad one is a 401 problem+json, not
  an Express crash), one service call, return. No `Idempotency-Key` — reads do not
  carry it.
- **`chases.service.ts`** — three reads, every query through `scopedDb`. Keyset
  pagination via `common/pagination/cursor` (chases newest-first on `createdAt`,
  outbox on `sentAt` — both required columns, so **not** nullable; a `nulls`
  clause on a required column 500s the list). The cursor fingerprint covers the
  filters, NOT the position (`cursor: undefined`, the documents page-2 regression
  shape). `businessId`/`state` are user FILTERS on an already-scoped set, never a
  tenancy guard — a hand-written clause that disagreed with RLS would be the more
  permissive of the two when it mattered. `getChase` fetches the chased items (by
  `itemRefs`) IN the same scoped transaction; a transaction RLS withheld is simply
  absent and the projection drops it. **404, never 403** (`NT-VAL-001`, since
  `NT-NOT-001` does not exist), detail names no id.
- **`chase-projection.ts`** — the pure row → contract projection (`toChaseSummary`
  / `toChaseDetail` / `toChaseItem` / `toChaseMessage` / `toSmsOutboxMessage`).
  Beside the service, not in `common/`, because chase is the ONLY module that
  projects these rows (unlike `document-response.ts`, which two share). **Money is
  integer pence, straight through** — no arithmetic on `amountPence` at all.
  Nullable columns project as explicit `null` (this app's
  `exactOptionalPropertyTypes`: a present key must carry a non-undefined value).
  `ChaseItem.received` is DERIVED — a `CLOSED_RECEIVED` chase means every item is
  received (SoT §8.5), and a non-`UNMATCHED` transaction has its paperwork; either
  counts it received (// DEMO-MOCK: per-item receipt tracking).
  ⚠ **Three of its functions are now on the public seam** (METH S9): `toChaseItem`,
  `chaseItemRefs` and `isChaseReceivedClose`. `GET /v1/portal/context` shows the
  CLIENT the same items this shows the accountant — the contract makes that
  explicit, one `ChaseItem` schema serving both "at two trust levels" — so the
  portal projects through these rather than growing a second opinion about what a
  chased item is or when it counts as received. The `itemRefs` narrowing that
  `chases.service.ts` kept privately (`itemRefsOf`) was folded into
  `chaseItemRefs` in the same change: one narrowing, three readers, no drift.
  `SmsOutboxMessage.portalUrl`
  is the link pulled out of the composed body's own `Upload securely: ` marker
  (`extractPortalUrl`) so the phone screen can tap it — it never signs or verifies,
  so it cannot mint or leak authority.
- **Proven:** `chase-projection.test.ts` + `chases.service.test.ts` (fake-Prisma
  recording harness — the assertions are on the `where`/`orderBy`/`take` that
  reach the DB, that money stays integer, and that a missing chase never queries
  its items) and `chases.integration.test.ts` against real Postgres RLS (a
  practice reads its own chase in full and its own outbox; another practice's
  list is empty and its chase is a 404; the boundary hides across, not down).
- **`auto-close.ts`** — auto-close on inbound match (SoT §4 Stage 8.5), the
  reserved seam now FILLED. `ChaseAutoClose { run(input) }` (interface +
  `PrismaChaseAutoClose` impl + `RecordingChaseAutoClose` fixture), plus the PURE
  `chaseMatchesDocument(document, transaction)` compare and its two tolerances
  (`CHASE_MATCH_AMOUNT_TOLERANCE_PENCE = 100`, `CHASE_MATCH_DATE_WINDOW_DAYS =
  10`). The compare is deterministic: supplier (normalised, leading-token
  contains, so `Currys` matches `CURRYS 1234 LONDON`), amount (ABSOLUTE pence
  within tolerance — integer only, R5; the txn is signed, the doc total unsigned),
  and an optional date window (an unread document date SKIPS the gate, never blocks
  — supplier + amount already identify the transaction). A document missing a
  supplier or a total matches nothing — no close on an amount coincidence. The
  impl resolves the practice SYSTEM actor (input carries `practiceId`, the one
  thing the hook cannot read for itself — `businesses` is policed) and, in ONE
  `scopedDb` transaction, closes each OPEN single-transaction chase the document
  matches (state → `CLOSED_RECEIVED`, `closedByDocumentId`/`closedReason`/`closedAt`
  stamped, compare-and-swap on the open states so a concurrent close is left
  alone), writes the close to the chase's event log (a `ChaseMessage` on
  `channel: 'event'` — there is NO ChaseEvent table and no schema change this
  stage, so a non-SMS ChaseMessage is the chase's audit surface; never an outbound
  send, no recipient), and writes the accountant's in-app `Notification`
  (`event: 'chase.closed'`, SoT §8.8). **Idempotent**: a chase this exact document
  already closed is skipped — no second close, event or notification (a
  re-extraction / redelivery never re-fires). Matching nothing is the normal,
  non-error case. Engine (a) single-transaction chases only — // DEMO-MOCK lists
  the b–e close paths and a real fuzzy/cross-type matcher.
- **`index.ts` — the PUBLIC SEAM.** Exports the detection service + suppression
  (including A13's `alreadyChasedTransactionIds`), the composition + formatters,
  the portal-link token functions, the `SmsSender` type + `selectSmsSender` +
  A13's `EmailChaseSender` / `CHASE_EMAIL_SUBJECT` / `CHASE_EMAIL_CHANNEL` /
  `ChaseEmailTransport`, and the **auto-close seam** (`ChaseAutoClose`,
  `PrismaChaseAutoClose`, `RecordingChaseAutoClose`, `chaseMatchesDocument` + the
  tolerances). The ingest processor calls `ChaseAutoClose.run` THROUGH this seam
  after extraction; the worker composition root (`worker/main.ts`) wires
  `PrismaChaseAutoClose`, and the ingest-processor unit tests use
  `RecordingChaseAutoClose`. It is chase's SECOND cross-module consumer, after the
  `chase.send` executor.

### The email transport (launch stage A13) — `email-chase-sender.ts`

**The chase's only real delivery.** SMS was cut for Initial Delivery, so before
this stage the module composed a message, minted a portal link, ran it through
Review → Approve, wrote an outbox row and reached nobody. `EmailChaseSender`
implements the **same `SmsSender` interface** the `chase.send` executor already
calls, so *the executor is unchanged and no call site moved* — an executor
performs one effect and decides nothing, least of all which wire it leaves by.

- **Config, not import.** `SMS_SENDER=email` (`select-sms-sender.ts`). ⚠ It
  points at a SECOND switch: the transport underneath is `EMAIL_SENDER`-selected,
  so `SMS_SENDER=email` + `EMAIL_SENDER=demo` still delivers nothing. **No new
  boot gate was added beside it, deliberately** — `config/env.ts` already refuses
  `EMAIL_SENDER=demo` under `NODE_ENV=production`, and one gate covering every
  outbound email beats a second that covers this caller only and can disagree.
  The full argument (including why the key was WIDENED rather than given a
  sibling, and why the name is now a value out of date) is written out at the
  `SMS_SENDER` declaration in `config/env.ts`.
- **⚠ The body is `message.body`, VERBATIM.** Nothing here composes. That string
  was produced by `composeChaseSms` at proposal time, stored on the proposal,
  rendered byte-for-byte by `render-summary.ts`, hashed into
  `rendered_summary_hash`, and written to `chase_messages.body`. The transport
  copies it. There is nothing here that could drift, which is the point.
  `notifications`' own `composeDocumentRequest` is a nicer email and is
  **deliberately unused** — it re-renders from the items, and a re-rendering is
  by definition not the thing the human approved. Adopting it means putting its
  output in the payload so review shows it: a change to the chase template and
  the Review → Approve path, and therefore Shakib's call.
- **The subject is a compile-time constant** (`CHASE_EMAIL_SUBJECT`, *"A document
  request from your accountant"*). The payload has no subject field and the
  contract is LAW, so the review never showed one — anything variable there is
  unreviewed text sent to a client. It also keeps untrusted content where it
  belongs: a supplier name and a bank descriptor are client-controlled strings,
  they already sit inside the reviewed body, and they never reach the envelope.
- **The address comes from the chase's NAMED recipient contact**, read through
  the caller's `ScopedClient`. A chase naming no contact **refuses** rather than
  falling back to "the primary contact" — that would be the transport choosing a
  recipient the reviewer never saw (and D45's inbound stance says the same from
  the other side: registered addresses only). A contact with no email, an
  undeliverable address, or `receives_chases = false` refuses too. Every refusal
  is `NT-PRP-006` and names no id and no address.
- **Refusing rolls the approval back, and that is the honest answer.** Nothing is
  recorded as sent that was not sent. The refusal is an `AppException` rather
  than `ProposalExecutionRefused` because importing that class would close a
  runtime cycle between two public seams; the wire response is identical.
- **Three phases: resolve every recipient → consume every ceiling → send.** A
  batch that was going to refuse refuses *before* the first irreversible act.
  ⚠ What remains, honestly: a transport failure on message N > 1 still rolls back
  an approval whose earlier emails are gone. It is bounded (one message per
  client, SoT §8.2) and visible. Making it impossible means moving the send to a
  post-commit follow-up — the shape `publish.batch`'s ledger call used, for
  exactly this reason — which is a change to the executor and the engine.
- **The rate limiter is the last-resort over-ask guard.** The notifications
  module's own per-address `document-request` ceiling (10/hour), consumed with no
  `ip` because an approved chase is a system-initiated send. Suppression at
  detection is the first guard and the one that matters; this catches what it
  missed.
- **No `sms_log` row, on purpose.** `sms_log.to_e164` is required and
  `SmsOutboxMessage.toE164` is a required contract field, so writing an email
  send there means inventing a phone number and the SMS-outbox screen would show
  an SMS nobody sent. The durable record is the `chase_messages` row — the same
  row that carries the exact text — stamped `channel: 'email'` (a free string in
  the contract), the provider id and `sentAt`.
- **⚠ The seam cycle, and why the import is dynamic.**
  `notifications/email-copy.ts` imports `chase/index.ts` (for `formatGbp` /
  `formatDay` — money and dates come from ONE implementation), and
  `chase/index.ts` re-exports `selectSmsSender`. A static VALUE import of the
  notifications seam from anything `chase/index.ts` reaches would therefore close
  a runtime cycle between two public seams — the hazard `publish-batch.ts` and
  `revoke-link.ts` each record refusing to create. `email-chase-sender.ts` takes
  **type-only** imports (erased) and receives its transport as a
  `ChaseEmailTransport`; `select-sms-sender.ts` builds that behind a `await
  import('../notifications/index.js')`, resolved on the first send and memoised.
  It pays for itself twice: a process configured for email that never chases
  constructs no SES client and opens no Redis connection, and **tests hand in a
  fixture so the factory never runs at all**.
- **Proven:** `email-chase-sender.test.ts` (byte-identity including length, the
  constant subject, markup in a supplier name staying out of the envelope, every
  refusal, the second-message-unsendable case sending nothing, the ceiling, and
  lazy/memoised resolution) and **`chase-email.integration.test.ts` against a
  real database through the REAL engine**: create → review → approve → the
  email's body `=== ` the string review rendered `=== ` the stored
  `chase_messages.body`, the portal link inside it verifies, no `sms_log` row,
  and a contact with no email refuses `NT-PRP-006` with nothing sent and nothing
  written. Id namespace `a13_`, torn down by explicit id list.
- **⚠ Flagged, not fixed — outside A13's fence.** `render-summary.ts` renders
  `recipientE164`, a phone number, because that is what `ChaseSendPayload`
  requires. Under this transport a reviewer therefore approves a send to a
  *contact* whose email address they were not shown. Closing it needs either an
  address on the payload (LAW, `packages/contracts`) or a render that names the
  contact (`modules/approvals`). Also unset by this stage: `.env.example` and
  `infra/envs/staging/services.tf` still say `SMS_SENDER=demo`, and the
  production boot refusal for `SMS_SENDER=demo` is withheld until that infra
  change lands in the same PR — see the `config/env.ts` comment.

**The `chase.send` executor lives in `validation-dedupe/proposals/chase-send.ts`**
(the #81 executor home — an executor is never reachable from a controller), NOT
here. It imports this module's seam (`SmsSender`, and composition ran at proposal
time). See that module's CLAUDE.md.

**Proven end to end** (`validation-dedupe/proposals/chase-send.integration.test.ts`):
create → review (verbatim SMS) → approve through the REAL engine → chase SENT,
outbox body === reviewed body, portal link verifies. Plus unit coverage for every
pure unit here. **Auto-close** is proven pure (`auto-close.test.ts` — tolerance,
supplier, date-window, sign, missing-field cases) AND against a real database
(`auto-close.integration.test.ts` — a matching document closes the chase and
writes the event + notification under RLS; a non-matching one leaves it open;
a re-run is idempotent).

**Known gaps, flagged not hidden:** the portal-link token names a `chaseId`, but
`chase.send` creates the chase at approve time — so composition and the executor
coordinate on chase identity (Stage 9 owns that reconciliation when it consumes
the token). ⚠ **Sharpened by METH S13:** no HTTP surface runs `composeChaseSms` +
`signPortalLink` at proposal time, so the chat's chase beat composes the SoT copy
client-side with a TOKENLESS portal path in the body (`<origin>/p/` — the outbox
renders no tap target rather than a dead one). The demo-script hop from the
chat-created chase's SMS into the portal (beat 6 → 7) does not work until a
server compose seam exists — either the engine composing `chase.send` payloads at
creation (the publish.batch recompute precedent) with the executor adopting the
token's chase id, or a dedicated compose endpoint. That touches the chase
template and the Review → Approve path, so it is Shakib's call, flagged on the
S13 PR (#142) — not something a stage session may slip in. Per-client suppression descriptors, engines (b)–(e), the policy
scheduler / reminders / quiet hours / STOP / item messaging remain out of this
stage. The read controllers landed (METH S8, see above); auto-close landed (METH
S8, `auto-close.ts` behind the `index.ts` seam, wired into the ingest processor).

## TODO

- [x] METH Stage 8: detection (a), composition, portal token, SMS sender seam,
      chase.send executor. Proven against a real DB through the engine.
- [x] Auto-close on inbound match (SoT §8.5) — `auto-close.ts` behind the
      `index.ts` seam: deterministic supplier + amount (+ date-window) compare,
      closes the chase, writes the chase event + the accountant notification,
      idempotent. Wired into the ingest processor after extraction (routed docs,
      READY/TO_REVIEW), real impl in `worker/main.ts`. Proven pure + real-DB.
- [x] Read controllers: `GET /v1/chases`, `/chases/{id}`, `/sms-outbox` (METH S8)
      — thin `ChasesController` + `ChasesService`, all through `scopedDb`, keyset
      paginated, proven against real Postgres RLS.
- [x] **Consumed by METH Stage 9** (`modules/portal`): `verifyPortalLink` is the
      portal session's first gate, unchanged, and `GET /v1/portal/context`
      projects the client's item list through this module's `toChaseItem` /
      `chaseItemRefs` / `isChaseReceivedClose`, all three added to `index.ts`.
      Three things Stage 9 recorded that belong here — (1) the portal SESSION bearer is signed with a **separate**
      `PORTAL_SESSION_SECRET`, so rotating the link secret does not invalidate
      live sessions; (2) the link token carries only `{chaseId, exp}`, so the
      portal must SWEEP practices to find the chase's tenant before any context
      exists. Giving `PortalLinkClaims` a `practiceId` (a change to this
      module's format and to the `chase.send` executor's mint call) collapses
      that sweep to one lookup — post-demo, and it is a chase-module decision.
- [x] **Launch stage A13 — chase by email.** `EmailChaseSender` behind the
      existing `SmsSender` seam, `SMS_SENDER=email`, carrying the reviewed body
      byte-for-byte; over-ask suppression at detection
      (`alreadyChasedTransactionIds`); engine (a) only. Proven pure and against
      a real DB through the real engine.
- [ ] **A13 leftovers, all outside its fence.** (1) `render-summary.ts` shows
      `recipientE164`, so the email recipient is not the reviewed one — needs a
      contract field or an approvals render change. (2) `.env.example` and
      `infra/envs/staging/services.tf` do not yet know `SMS_SENDER=email`.
      (3) The production boot refusal for `SMS_SENDER=demo` is written up in
      `config/env.ts` and withheld until (2) lands with it.
- [ ] Engines (b)–(e) — **(c) period-gap and (e) expected-recurring are the ID
      pair and are additive**, per SoT §24.2.3; A13 deliberately shipped (a)
      alone. Per-client suppression descriptors (G7 schema).
- [ ] Policy scheduler, reminders, escalation, quiet hours, STOP, item messaging.
      ⚠ Reminders interact with A13's over-ask gate: `alreadyChasedTransactionIds`
      suppresses on ANY chase precisely because there is no scheduler to own the
      second message. Whoever builds one owns relaxing it, in that function.
- [ ] Update this file on exit — it is how the next session picks up.
