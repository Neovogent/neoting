# ingestion-routing

**Lane B** · **Source of Truth:** SoT §4 Stage 1 · **Owner:** see the project board

## Purpose

Web upload and auto-split, email-in via SES, WhatsApp inbound, the sanitisation pipeline, sender-identity then AI-addressee routing, and the Unrouted queue.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Nothing is ever silently dropped. Ambiguous documents land in the Unrouted queue; rejections are visible with a plain-language reason. The sanitisation order in Governance §11.4 is fixed, not a suggestion.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

Concretely: `index.ts` is the public seam — today `DocumentStore` (type) and `selectDocumentStore`, nothing else — and `neoting/no-cross-module-internals` (`apps/api/eslint/`, with its test) fails any other module's import that lands deeper than it. Growing the seam is a boundary decision; read the note in `index.ts` before adding a name. Composition roots (`app.module.ts`, `worker/`) and `*.integration.test.ts` wire internals directly, by design.

## Tests

```bash
pnpm --filter @neoting/api test -- ingestion-routing
```

## Current state

### WhatsApp inbound webhook + NestJS bootstrap (issue #9 — this branch)

`webhooks/whatsapp/` plus the app skeleton that had to exist first (there was no
NestJS app before this): `src/main.ts` (port 3000, `rawBody: true`),
`src/app.module.ts`, `config/env.ts` (Zod, fail-fast, the only `process.env`
reader), `common/problem/` (RFC 7807 filter using `@neoting/contracts/model`
codes), `common/untrusted-content.ts`, `modules/health/` (`/healthz` + `/readyz`).

- **GET** `/webhooks/whatsapp` — Meta's unsigned challenge; echoes `hub.challenge`
  as `text/plain` only when `hub.verify_token` matches, else 403.
- **POST** `/webhooks/whatsapp` — `WhatsAppSignatureGuard` verifies
  `X-Hub-Signature-256` HMAC over the **raw body** before any parsing (401
  `NT-INT-001` on fail); then Zod-parses the envelope, dedupes on `wamid` via
  `ReplayStore`, wraps the caption in `<untrusted_content>`, and hands off to the
  `IngestQueue`. 200 no-body ack. **Freshness is a triage flag, not a gate**: a
  correctly-signed message outside the ±5-min window is enqueued with
  `stale: true`, never 401'd — age must not turn our downtime into document loss.
- **Error codes** (issue #11): signature → `NT-INT-001`, verify-token → 403
  `NT-INT-002`, unexpected 500 → `NT-SRV-001` (global `ProblemFilter`).
- **Fixtures, not infra** (issue #9): `IngestQueue`/`ReplayStore`/`Clock` are
  interfaces with in-memory fixtures (same pattern as the sanitisation
  `VirusScanner`). No BullMQ, no Redis, no Prisma, no auth.
- **Toolchain stood up**: real `typecheck` (tsc), `lint` (eslint, `no-any`),
  `test` (Vitest — the 24 sanitisation tests were ported here; 57 tests total).
  `apps/api/tsconfig.json` uses **Bundler** resolution so the generated
  `@neoting/contracts` `.ts` source resolves. Runs under tsx/vitest, so DI uses
  explicit `@Inject` tokens (no reliance on emitted decorator metadata).
- **Pending Meta sandbox creds** (Shakib holds them): signature path proven
  against a locally-set secret in unit tests; real end-to-end handshake is a
  separate step once `META_APP_SECRET`/`META_VERIFY_TOKEN` are issued.

### Ingest queue + worker (issue #12)

`queue/` + `src/worker/main.ts`. The webhook enqueues through the **same**
`IngestQueue` interface as before — `whatsapp.controller.ts` is unchanged; only
the module swaps the provider by config (`INGEST_QUEUE=fixture|bullmq`).

- `BullmqIngestQueue` — real producer: `jobId = wamid` (producer idempotency),
  capped attempts + exponential backoff, failed jobs kept for the DLQ. Attaches
  the `traceId` read from `common/trace` (AsyncLocalStorage) at enqueue, so the
  trace born at the webhook survives into the job without the controller passing
  it — a `TraceMiddleware` opens the context per request.
- The **worker** (`src/worker/main.ts`, `pnpm --filter @neoting/api worker`) is a
  separate process. Per job: Zod-parse the payload (boundary), idempotent on
  `wamid` (a redelivery is a logged no-op), log with the `traceId`. On exhausted
  retries → DLQ (`ingest-dlq`); `classifyFailure` quarantines a poison message
  after `MAX_REPLAYS`. No DB writes (blocked on `scopedDb`).
- **Fixtures stay** (`FixtureIngestQueue`, `InMemoryProcessedStore`) so tests run
  offline; the real path is config-selected, not import-selected.
- **Docker is now installed** (confirmed 16 Aug 2026 during #76 — postgres, redis,
  minio and mailhog all healthy under `docker compose up -d`), so the old blocker
  on this item is gone. The live `docker compose up` → signed POST →
  worker-picks-it-up-with-same-traceId capture has **still not been run**; it is
  now just an unstarted task rather than an impossible one. The logic remains
  unit-tested.

### Email intake (issue #14)

`email/` — a pure lane (own `CLAUDE.md`). `processEmail(parsedEmail, deps)`:
route by sender (`decideRouting`, empty map → Unrouted) → wrap subject+body in
`<untrusted_content>` → sanitise **each attachment independently** on
`channel: 'email'` (25 MB) → enqueue each accepted through `IngestQueue`.
**Partial acceptance is the point**: a password-protected PDF next to a clean one
is one accepted document and one visible rejection, never all-or-nothing.
Extends `IngestJob.source` to `'whatsapp' | 'email'` (+ optional `filename` /
`sha256`) and adds the `email` channel (25 MB, client cap).

The MIME parser sits behind an `EmailParser` interface: **`postal-mime@3.0.0`
approved (§19, issue #14) and landed** — MIT-0, zero runtime deps, pinned exact.
The logic stays tested with `ParsedEmail` fixtures; the parser has its own
raw-MIME-on-disk test. No DB, no S3 (the S3-event trigger is Terraform,
Shakib's). The idempotency key carries the content sha256 alongside the
`Message-ID` — the key is the BullMQ `jobId`, a duplicate jobId is dropped
silently, and a sender-controlled header must not be able to delete a document.

**Routing-by-sender is wired (METH Stage 5).** `email/inbound/sender-map.ts`:
`buildSenderMap` (PURE) keys a practice's contacts on lower-cased email + E164
phone → businessIds; `PrismaSenderMapLoader` reads them through `scopedDb` under
the practice SYSTEM context (same policed path as the sink — `contacts` RLS
admits the SYSTEM actor via the practice-membership branch). `runEmailIntake`
loads the map for the RESOLVED practice and hands it to `processEmail`; the
loader is optional (absent → empty map = prior behaviour). `decideRouting` and
the schema are untouched. See `email/CLAUDE.md`.

### Document persistence through `scopedDb` (issue #20)

`queue/document-sink.ts` — the worker now *writes*. `DocumentSink.persist(input)`
resolves the practice's SYSTEM actor (`common/db/resolveSystemActor`), then writes
the `Document` and its first `DocumentEvent` in ONE `scopedDb` transaction under
`systemContext(practiceId, systemUserId)`, so RLS — not convention — enforces the
tenancy anchor.

- **Idempotent on `idempotencyKey`, NOT `byteHash`.** The document id is derived
  `doc_${sha256(idempotencyKey).slice(0,24)}` (`documentIdFor`). The same receipt
  legitimately forwarded for two clients has identical bytes but two jobs → two
  documents; a redelivery of one job has the same key → one row, `created: false`.
  A sender-controlled header must not be able to collapse two clients' documents
  into one, nor delete one.
- **Persist only when the bytes are in hand.** The processor calls the sink only
  when the payload carries `practiceId + storageKey + sha256 + mimeType +
  byteSize + filename` — email does (it stored and sanitised the attachment).
  WhatsApp does not yet (its media is a Meta id needing a Graph fetch — a later
  task), so those jobs are logged and left unpersisted rather than written as an
  orphan with no bytes behind it.
- **Unknown business → `Inbox.UNROUTED`** anchored on the practice; known business
  → its workspace (`COSTS` by default, the Costs-vs-Sales split is later
  classification).
- **`InMemoryDocumentSink`** keeps the processor unit-testable offline; the real
  path is config/DI-selected in `worker/main.ts` (`PrismaDocumentSink`), not
  import-selected. `PrismaClient` is received, never constructed here — the type
  is imported from `common/db/prisma.ts` (the one directory allowed to name it).
- **Idempotency is claimed and RELEASED, in that order.** `ProcessedStore.markProcessed`
  is a claim taken *before* the work; the processor wraps everything after it in
  a `try`/`catch` that calls `release(key)` and rethrows. Without that, a persist
  that throws leaves the key claimed, BullMQ's retry sees "already processed",
  and the job reports **success having written nothing** — the document lost
  silently, never reaching the DLQ. That is the one outcome this module's
  "nothing is ever silently dropped" invariant forbids, and it is the reason
  `release` exists on the interface at all.
- **The durable guarantee is the derived primary key, not that store.**
  `InMemoryProcessedStore` is per-process; SES redelivering produces a *second*
  BullMQ job another worker task can run concurrently. Both find nothing, both
  create, one loses on the primary key — so `PrismaDocumentSink` catches `P2002`
  and returns `created: false`. Under RLS the loser's `findUnique` cannot even
  see a winning row belonging to another practice, so the collision is the only
  signal available; without the catch a correctly-handled redelivery becomes a
  DLQ entry and a page.
- **Proven against a real database** (`queue/document-sink.integration.test.ts`,
  the #20 acceptance): an unrouted document is visible to its own practice and
  invisible to another; same job twice = one row; a practice with no SYSTEM actor
  fails loudly, writing nothing. Skips when no DB is configured, fails when one is
  configured but unreachable.

### Duplicate detection — byte hash + perceptual hash (issue #40)

SoT Stage 6, the two nets that work with **no extracted fields**: an exact
re-send, and the same paper photographed twice.

- **`lib/dedupe/perceptual-hash.ts`** — a pure dHash (resize 9×8 greyscale via
  `sharp`, compare adjacent pixels → 64 bits), a Hamming-distance helper, and the
  `PerceptualHasher` interface + sharp-backed factory. **The threshold is
  measured, not guessed**: `perceptual-hash.test.ts` records the distances on
  every run (re-encode q92→q25 = 0, downscale 4× = 0, different image = 28), and
  `PERCEPTUAL_HASH_MAX_DISTANCE = 10` sits clear of both. No new dependency —
  `sharp` was already approved and in the sanitisation lane.
- **Computed where the bytes are already in hand.** `email-intake` hashes
  `result.document.bytes` (the sanitised output) right after it computes the
  sha256 — never a round-trip back to S3. The hasher is **injected** (type-only
  import) so the email lane stays pure and offline; images only, `null` for PDFs
  and undecodable rasters. Carried on the job next to `sha256`, written to
  `documents.perceptual_hash` by the sink.
- **`queue/duplicate-detector.ts`** runs after a document persists. Within the
  **same business**: exact = same `byteHash` (the indexed `@@index([businessId,
  byteHash])` lookup); near = an image whose `perceptualHash` is within the
  threshold (Hamming computed in memory — no index can answer it). One
  `Duplicate` row per matched pair: `signals` (`byteHash` / `pHash`), a `score`
  (1 for exact, `1 − distance/64` for near), verdict `PENDING`.
- **The perceptual scan is CAPPED, and the cap announces itself.** Governance
  §5.1 forbids unbounded loads, and "bounded per business" is not a bound — it is
  every image that business has ever sent, growing forever. So the candidate
  query takes `PERCEPTUAL_CANDIDATE_LIMIT` (500) ordered `receivedAt desc`, which
  is index-backed (`@@index([businessId, receivedAt])`) and puts the newest
  candidates first, where duplicates actually live.
  **A cap on a search can cost a miss**, and a missed duplicate must not look
  like a clean run — so `detect()` returns `candidatesTruncated` and the
  processor logs a warning when it fires. The real fix is an index-supported
  search (hash banding or a BK-tree), which is a `prisma/` change and therefore a
  contract-change issue under G7, not a quiet migration.

**The unrouted decision (written down, as required).** `Duplicate.business_id` is
`NOT NULL`, and an UNROUTED document has `business_id = null`, so it *cannot* have
a `Duplicate` row as the schema stands. This is **not** a schema bug: SoT Stage 6
runs after routing, and the only indexed dedupe lookup is per-business. So
detection runs **for routed documents only** (`business_id` present); an unrouted
document is persisted and left undeduped, and will be deduped when routing gives
it a business (a later stage). The schema encodes the pipeline order; we honour
it rather than change LAW.

**Tenancy finding (verified before building, then in a live test).** A worker runs
under a practice-only `systemContext` (no `app.business_id`). The `duplicates`
WITH CHECK is `app_can_access_business(business_id)`, whose **practice-membership
branch** (rls.sql) admits a SYSTEM actor whose practice owns the target business.
So the worker *can* write the `Duplicate` — proven in
`duplicate-detector.integration.test.ts`, not just reasoned.

**Two review hazards from #20, carried in (both: a failure turning into a silent
success).**
1. `queue/processed-store.ts` gained `release(key)`; the processor releases the
   idempotency claim if the work throws, so a retry redoes it instead of logging
   "already processed" and reporting a success that wrote nothing.
2. Concurrent writes rest on the **primary/unique key**, not `find`-then-`create`:
   the sink catches `P2002` as the no-op it is, and the detector writes via
   `createMany({ skipDuplicates })` with a **deterministically ordered pair**, so
   two workers detecting the same pair at once collapse to one row.

### WhatsApp media fetch (issue #79 — this branch)

`queue/media-fetcher.ts` + `queue/graph-media-fetcher.ts` + `queue/select-media-fetcher.ts`
+ `queue/whatsapp-media-intake.ts`, and the wiring in `webhooks/whatsapp/`,
`queue/ingest-processor.ts`, `queue/document-sink.ts` and `worker/main.ts`. A
WhatsApp webhook carries a Meta **media id**, not the bytes; until this, those
jobs were logged and left unpersisted (a silent loss on the only live channel).
Now the worker resolves the id to bytes and persists through the **same** path
email takes from the point the bytes are in hand.

- **`MediaFetcher` is interface + fixture, config-selected** (`MEDIA_FETCH=fixture|graph`)
  — the sixth thing in the house shape, deliberately not a sixth shape.
  `FixtureMediaFetcher` **never fabricates bytes** for an unseeded id (it throws
  `not_found`): `fixture` is the default, so a fabricating fixture would turn
  every real staging receipt into a made-up document that looks ingested.
- **`GraphMediaFetcher` — two GETs on Node 22's built-in `fetch`, no new
  dependency.** Metadata → download URL → bytes. Two things carry the weight:
  an **SSRF allowlist** (the download URL comes from a JSON field and we send a
  bearer to it, so a non-Meta host is refused *before* the token goes on the
  wire — dotted-suffix match, `evil-fbcdn.net` does not pass; both GETs also use
  `redirect: 'manual'` and refuse a 30x, so a bounce cannot steer the bearer past
  the first, validated hop), and a **stream cap** enforced per-chunk (`Content-Length` is only a hint; the running total
  breaks out of the `for await`, which cancels the stream). `failureForStatus`
  is what decides retry-vs-DLQ, so it is the precise part: 401/403→unauthorised,
  429/5xx→upstream (retryable), 404/400 + Meta code 100 / subcode 33→expired.
- **`fetchWhatsAppMedia` fetch → `sanitise` → perceptual-hash → `store.put`,
  then returns; it does not persist.** The processor owns the sink write, so
  WhatsApp and email converge on one idempotency rule. A fetch failure **throws**
  (`MediaFetchError`); a sanitisation refusal **returns** `{ok:false, rejection}`
  to the processor, which then **throws `TerminalJobError`** so the job
  dead-letters. The shape difference is deliberate — a rejection is a decision
  about the document, a fetch failure is the world being unavailable, and only
  the worker knows whether that is a backoff or a dead-letter
  (`withFetchClassification`: retryable rethrows for BullMQ, terminal →
  `TerminalJobError` → `UnrecoverableError`). The review of #96 turned the
  refusal from warn-and-return into a dead-letter: returning null completed the
  job, so with the wamid replay-blocked and Meta's media id expiring (~30 days)
  a rejected receipt was one warn line from being unrecoverable. The DLQ entry
  keeps `job.data` (mediaId, caption, practiceId, traceId) visible and
  replayable until the s3_key nullability change (#79, G7) lets it become a
  REJECTED document row.
- **The caption becomes `documents.description`, STILL WRAPPED** in
  `<untrusted_content>` (§9.6) — never unwrapped, not even to log it. The
  unmapped-number warning names the wamid only.
- **`safe-basename.ts` was EXTRACTED from `email-intake.ts`** (which now imports
  it) so two channels cannot reduce an attacker-controlled name two ways. A
  WhatsApp image has no filename and `original_filename` is NOT NULL, so one is
  synthesised from the sha256 and the **detected** type, never Meta's declared
  mime.
- **Demo seed (METH Stage 5).** `FixtureMediaFetcher` throws `not_found` for an
  unseeded id — which is exactly right for staging, but means the `demo:whatsapp`
  driver's webhook would dead-letter with no document. `seedDemoMedia(fetcher)`
  (in `media-fetcher.ts`, marked `// DEMO-MOCK`) pre-seeds the ONE demo media id
  `DEMO_WHATSAPP_MEDIA_ID = 'demo-media-currys'` with a PNG-signature buffer, and
  `selectMediaFetcher` calls it on the **fixture branch only**. The graph fetcher
  is untouched — no real Meta id is ever fabricated (unit + select tests prove
  both: fixture resolves the demo id to PNG bytes, graph mode does not).

**Three things raised on the issue for @shakibbinkabir before this can be marked
complete** (all posted, awaiting his call):

1. **The media-fetch token is a SEPARATE credential.** `META_APP_SECRET` is the
   webhook HMAC key and `META_VERIFY_TOKEN` the handshake echo; neither
   authenticates a Graph call. Added `META_MEDIA_ACCESS_TOKEN` (a System User
   bearer with `whatsapp_business_messaging`) blank in `.env.example`;
   `MEDIA_FETCH=graph` **refuses to boot** without it. Issuing the real bearer is
   a secrets change — Shakib's.
2. **No `practiceId` source exists for a WhatsApp job.** The controller never set
   one, `Practice` has no phone-number column, nothing in `prisma/` maps a Meta
   number to a practice. Interim: `WHATSAPP_PRACTICE_MAP` env (JSON
   `phone_number_id → practiceId`), keyed on the number that RECEIVED the message
   (never the sender), mirroring how email made `practiceId` a caller-supplied
   dep — so a future `Practice.whatsappPhoneNumberId` column (`prisma/`, G7)
   replaces it without touching a call site. Fails **closed and loud**: an
   unmapped number enqueues (never 4xx's Meta), then dead-letters in the worker.
3. **Acceptance criterion 3 is unwritable as the schema stands.**
   `documents.s3_key` (and `byte_hash`/`byte_size`/`mime_type`/`original_filename`)
   are NOT NULL, and every named fetch/sanitise failure happens *before* bytes
   are stored — so a REJECTED/FAILED WhatsApp document cannot be written to the
   Rejected/Failed surface yet. Refused to fabricate five NOT NULL columns.
   Proposed the exact migration (`ALTER COLUMN s3_key DROP NOT NULL` + a
   `CHECK (s3_key IS NOT NULL OR state IN ('REJECTED','FAILED'))`) as a **G7
   contract change**. Until it lands, a rejection is a `logger.warn` with the
   NT-ING code + traceId **plus a DLQ entry** (review of #96 — see the
   fetch-vs-refusal bullet above), not a row.

Also corrected two errors in the issue text: `channel: 'whatsapp'` does not exist
(used `'client'`, which `channels.ts` already documents as WhatsApp intake at
25 MB), and flagged `MEDIA_FETCH` vs the house-consistent `MEDIA_FETCHER`
spelling. Tests: unit coverage for all four new units (incl. the offline Graph
fetcher via a `fetchImpl` seam — SSRF and stream-cap proven), `mediaOf` +
per-change `phone_number_id`, the controller media/practice path, and a **real-DB
integration test** (`queue/whatsapp-intake.integration.test.ts`) proving the
WhatsApp lane persists through `scopedDb` with the caption kept wrapped.

### Web upload — the first HTTP surface in this lane (issue #76)

`web-upload/` — a lane with its own `CLAUDE.md`; read that before changing it.
`POST /v1/document-uploads` (presign) then `POST /v1/document-uploads/{id}/complete`
(verify, persist in `RECEIVED` through `scopedDb`, enqueue sanitisation). **The
API never touches the bytes** — the client PUTs them straight to storage.

Three things worth knowing from here, without opening that file:

- **`uploadId` is an HMAC-signed stateless token, not a table row.** There is no
  `DocumentUpload` model, because `prisma/` is LAW and this did not justify a
  contract-change issue. Completion therefore trusts the *claims*, not the
  request: filename, business and declared type are inside the signature and are
  not parameters of step two.
- **The business is resolved through RLS before anything is signed.** The
  presigned key is `w/<businessId>/uploads/…` built from the request body, so
  without that check a caller could mint a write URL into another practice's
  prefix. `documents_tenant` would still refuse the row at completion — but the
  bytes would already be in someone else's bucket prefix, and **object storage
  has no RLS to undo that**. 404, never 403.
- **This is the first module to import values from `@neoting/contracts/zod`**
  (unblocked by #88). `common/validation/parseBoundary` is the one place a
  generated schema meets a request; it renders Zod issues into the contract's
  `Problem.errors`, expanding `.strict()`'s `unrecognized_keys` so a misspelled
  field is named instead of reported as `(body)`.

`queue/ingest-queue.module.ts` was added with it: a **shared** `INGEST_QUEUE`
producer, now that web upload is a second inbound lane in the same process.
Nest providers are per-module, so a second `selectIngestQueue` factory would mean
a second Redis connection — invisible under `INGEST_QUEUE=fixture`, real the
moment it is not. `whatsapp.module.ts` now imports it rather than declaring its
own.

Proven end to end against Postgres + MinIO (`web-upload.integration.test.ts`),
including the presigned PUT actually being accepted — the signature covers
`content-type` and `content-length`, so a fixture URL can never prove it.

### What the documents read surface took out of this lane (issue #77)

**The read surface is NOT in this module.** `GET /documents…` lives in
`modules/documents/` — read that `CLAUDE.md` before changing anything it touches.
Two things it changed *here*, and one it deliberately did not:

- **`storage/` gained `presignGet`.** The signed `ResponseContentType` /
  `ResponseContentDisposition` overrides and the filename-header sanitising are
  described in `storage/CLAUDE.md`. Nothing about `presignPut` changed.
- **`web-upload/document-response.ts` moved to `common/documents/`.** Two modules
  now project the same Prisma row onto the same contract `Document`, and a module
  may not reach into another's internals — so it moved rather than being copied.
  A second copy is how the write surface and the read surface start disagreeing
  about what a `Document` is, which is the drift the generated contract exists to
  prevent. `web-upload.service.ts` imports it from its new home; behaviour is
  unchanged.
- **No `POST /documents/{id}/retry` was added**, and none may be. `retryable` on
  the summary is *derived* (`state === REJECTED || FAILED`) and is a hint to the
  UI, not a route. A retry is a `document.reprocess` proposal on the Review →
  Approve spine (Governance §10). All five read operations are
  `x-nt-side-effect: none`.

### Sanitisation pipeline (merged, PR #3)

**Pure library** — `lib/sanitisation/`.
Governance §11.4 order, no controller / Prisma / API surface (those wait for the
frozen contracts).

Implemented and unit-tested (24 tests green):
- `sniff` magic-byte type detection for all accepted formats incl. HEIC ftyp
  brands and ZIP-container refinement (docx/odt/zip), with extension-spoof
  detection. Extensions are never trusted.
- Extension allowlist, per-channel size caps (`channels.ts`, SoT §4 Stage 1).
- Virus-scan **interface** + offline `fixtureVirusScanner` (flags EICAR).
- ZIP-bomb caps (`zip-safety.ts`): file-count / total-uncompressed / ratio /
  nesting-depth, read from the central directory without inflating. Zero-dep.
- Orchestrator (`pipeline.ts`) enforces the fixed §11.4 order and returns a
  `Rejection { kind, NT-ING code, plain-English message }` for every refusal —
  nothing fails silently; password-protected files rejected visibly.

**Image normalisation is real** (#21, #23). `createSharpImageNormaliser` applies
and strips EXIF, decodes HEIC via `heic-decode` (WASM libheif — sharp's prebuilt
binaries carry no HEIF, because that needs x265 and x265 is GPL), and re-encodes
to JPEG. Selected by `IMAGE_NORMALISER=fixture|sharp`, config not import, so unit
tests keep running on hand-built magic-byte stubs that a real decoder would
rightly refuse.

Two things worth knowing before changing it:

- **`normalise` returns a result, not a Buffer.** Images are the one input we
  *decode*, and a 200 KB file can describe a 40,000 × 40,000 surface — 6.4 GB of
  RGBA. The channel byte cap cannot see that, so normalisation has to be able to
  refuse. `decode.all` is used for HEIC precisely because it exposes dimensions
  *before* producing pixels; `decode` would allocate first and let us measure
  afterwards, which is not a check.
- **The fixture refuses HEIC on purpose.** It cannot decode one, and passing it
  through was the original bug — the file sailed through sanitisation and failed
  in extraction looking corrupt, so the accountant was told the wrong thing about
  a photo that was fine.

**The PDF guard is real** (#22). `createQpdfDocumentGuard` runs `qpdf`
(Apache-2.0) as a SUBPROCESS with a timeout — this is the code path that parses
bytes a stranger emailed us, and a malicious PDF must cost one failed document
rather than the worker. Selected by `DOCUMENT_GUARD=fixture|qpdf`.

- **Encryption** via `--is-encrypted`, which walks the xref chain. This is what
  the shim got wrong: it greps the first and last 8 KB for `/Encrypt` and misses
  a mid-file trailer in an incrementally-updated PDF — anything signed,
  form-filled or annotated. Those passed as clean and failed in extraction
  looking corrupt rather than locked, so the client was told the wrong thing.
- **Active content** via `qpdf --empty --pages in 1-z -- out`. **`--empty` is
  the mechanism, not a detail.** qpdf is content-*preserving* by design, so
  without it the JavaScript name tree, OpenAction and embedded files are copied
  straight through and the guard silently does nothing. Verified against
  qpdf 11.9.1 both ways; pinned by a test on the argument vector.
- The guard REWRITES as well as refuses, so `sanitise` continues with the
  stripped bytes. A form-bearing invoice is kept and cleaned, not rejected.

Still shimmed: **encrypted Office detection**. qpdf knows nothing about OOXML,
and a guard that reports clean because it never looked is worse than one that
admits the gap.

Toolchain: **stood up in issue #9** — real `typecheck` (tsc, Bundler
resolution), `lint` (eslint, `no-explicit-any`), `test` (Vitest). The 24
sanitisation tests were ported from `tsx --test` to Vitest and run in the suite.

## TODO

- [x] #7/#21/#22/#23: `sharp` + `heic-decode` + `qpdf` approved and landed; both
      BOOTSTRAP guards replaced. Two things NOT yet proven: decoding a real HEIC
      (no fixture exists — nothing available can encode one) and the ARM64 image
      (no Dockerfile yet). sharp picks its binary via optional dependencies at
      INSTALL time, so building on x64 and copying node_modules into an ARM64
      image ships the wrong one and fails at runtime, not at build.
- [ ] Encrypted Office (OOXML) detection — qpdf does not cover it
- [ ] Enforce the bank-statement 300-page cap in the PDF-safety step
- [x] #76: the ingestion endpoints exist (`web-upload/`), and the **upload-time**
      NT-ING codes are mapped at the controller boundary: NT-ING-001 (over cap),
      NT-ING-002 (MIME off the allowlist), NT-ING-003 (byte-hash mismatch),
      NT-ING-005 (intent expired).
- [ ] The other half of that old TODO was **mis-stated and is recorded here
      rather than silently dropped**: a sanitisation `Rejection` can never be a
      wire error on this path. Sanitisation runs in the worker, after the HTTP
      call has returned `201 RECEIVED`, so NT-ING-004 belongs on the *document*
      (state + failure code, which the client polls) and not on a response. Doing
      it as a controller mapping would mean sanitising inline, which Governance §7
      forbids. Still to do: set it on the document from the worker.
- [x] #12: BullMQ behind `IngestQueue` + the worker (DLQ, idempotency, traceId),
      controller unchanged — done. The live docker e2e is still outstanding, but
      Docker is installed as of 16 Aug 2026, so it is now runnable here.
- [x] #20: worker persists `Document` + `DocumentEvent` through `scopedDb`
      (`queue/document-sink.ts`), idempotent on `idempotencyKey`, proven against a
      real DB.
- [x] #79: WhatsApp media fetch — `MediaFetcher` (fixture|graph), the two-step
      Graph fetcher (SSRF allowlist + per-chunk stream cap, no new dep), the
      intake lane and the worker wiring, so those jobs persist too. Proven against
      a real DB. **Three items await Shakib** before the PR can be marked done:
      the `META_MEDIA_ACCESS_TOKEN` secret, the `WHATSAPP_PRACTICE_MAP` → future
      `Practice.whatsappPhoneNumberId` column (G7), and the `documents.s3_key`
      nullability migration for the Rejected/Failed surface (G7). All posted on #79.
- [x] #76: web upload, two-step presign + complete, proven end to end against
      Postgres and MinIO. See `web-upload/CLAUDE.md`. Not yet: auto-split,
      worker-side sanitisation of these jobs, a durable idempotency store.
- [x] #40: duplicate detection on byte hash + perceptual hash
      (`lib/dedupe/`, `queue/duplicate-detector.ts`), routed documents only,
      proven against a real DB. Not yet: dedupe on route (so unrouted docs get
      deduped when they gain a business), and the OCR/field nets (need extraction).
- [x] #77: `storage/presignGet` added and `web-upload/document-response.ts` moved
      to `common/documents/`. The endpoints themselves are `modules/documents/`,
      not this lane. Not yet: a MinIO round-trip proving the GET signature, and an
      HTTP-level test (blocked — needs `@nestjs/testing`/`supertest` added as
      devDependencies, which needs a human).
- [ ] Update this file on exit — it is how the next session picks up
