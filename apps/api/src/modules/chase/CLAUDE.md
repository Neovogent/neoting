# chase

**Lane G** · **Source of Truth:** SoT §4 Stage 8 · **Owner:** see the project board

## Purpose

The five detection engines, chase composition, SMS with OTP secure links, the upload portal endpoints, the policy scheduler, and auto-close on matching inbound.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- The flagship. Every SMS is shown verbatim in review before sending. Chasing is SMS-only, but a client may reply through any inbound channel and that still closes the chase.
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
  visibility). Returns UNMATCHED, non-suppressed transactions — both the stored
  `chaseSuppressed` flag and the descriptor scan gate. // DEMO-MOCK lists engines
  (b)–(e); they are FIXTURE for the demo. The pure predicate is split from the DB
  read (both unit-tested).
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
  + `sms_log` insert) through the caller's `ScopedClient` — no Twilio. Selected by
  `SMS_SENDER=demo`, config not import, mirroring `selectExtractor` /
  `selectMediaFetcher` exactly. // DEMO-MOCK: Twilio Messaging.
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
- **`index.ts` — the PUBLIC SEAM.** Exports the detection service + suppression,
  the composition + formatters, the portal-link token functions, the `SmsSender`
  type + `selectSmsSender`, and now the **auto-close seam** (`ChaseAutoClose`,
  `PrismaChaseAutoClose`, `RecordingChaseAutoClose`, `chaseMatchesDocument` + the
  tolerances). The ingest processor calls `ChaseAutoClose.run` THROUGH this seam
  after extraction; the worker composition root (`worker/main.ts`) wires
  `PrismaChaseAutoClose`, and the ingest-processor unit tests use
  `RecordingChaseAutoClose`. It is chase's SECOND cross-module consumer, after the
  `chase.send` executor.

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
the token). Per-client suppression descriptors, engines (b)–(e), the policy
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
- [ ] Engines (b)–(e), per-client suppression descriptors (G7 schema).
- [ ] Policy scheduler, reminders, escalation, quiet hours, STOP, item messaging.
- [ ] Update this file on exit — it is how the next session picks up.
