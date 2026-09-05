# ingestion-routing / web-upload

**Source of Truth:** SoT §4 Stage 1 (+ §4 Stage 8.4 for the delegated half) · **Added by:** issue #76, extended by METH Stage 9 · **Contract:** `POST /v1/document-uploads`, `POST /v1/document-uploads/{uploadId}/complete`

## Purpose

The first inbound lane with an HTTP surface. Two steps, because **the API never
touches the bytes**:

1. `POST /document-uploads` — declare what is coming. Checks the size against the
   channel cap and the MIME against the allowlist, resolves the business through
   RLS, presigns a direct `PUT` to object storage, and returns a signed
   `uploadId`.
2. `POST /document-uploads/{uploadId}/complete` — the bytes have landed. Verify
   the object exists, matches the declared size, and hashes to what the client
   declared, persist the `Document` in `RECEIVED` through `scopedDb`, and
   enqueue sanitisation.

Keeping the file off the request path is what makes a 100 MB accountant batch
viable and keeps the OTP portal light on a bad connection.

**Verification streams; it never buffers.** Completion used to `get()` the whole
object into one Buffer to hash it — up to the channel cap per in-flight request,
in the API process, which is exactly the weight this two-step design exists to
avoid. It now checks `head().byteLength` against the signed `byteSize` claim
(NT-ING-003 on mismatch, before a single byte is read) and hashes through
`DocumentStore.sha256(key)`, whose S3 implementation streams. A unit test pins
that `get()` is never called on the completion path.

## `uploadId` is a signed token, not a table

There is no `DocumentUpload` model — `prisma/` is LAW (G7) and this lane did not
justify a contract-change issue. `upload-token.ts` HMACs the claims (business,
practice, filename, declared MIME/size, split mode, s3 key, expiry) with
`UPLOAD_URL_SECRET` and hands the result back as the `uploadId`.

The consequence to know: **completion trusts the claims, not the request.** A
client cannot change the filename or the business between the two calls, because
neither is a parameter of step two — they are inside the signature. A forged or
edited token fails verification and is a 400.

Expiry lives in the claims as well as in the presigned URL, so an expired intent
is `410 NT-ING-005` with a plain reason rather than an opaque storage error.

## Step two has TWO callers: the workspace, and the OTP portal (METH Stage 9)

`openapi.yaml` puts `completeDocumentUpload` under **both** `workspaceSession`
and `portalSession`, and says why: *"a delegated session completes the intents it
created, and the RLS delegated policies keep it inside its own grant. One
completion path, two trust levels, no second door."* `POST /v1/portal/uploads`
(`modules/portal`) mints the intent; this endpoint finishes it.

**How the branch is taken.** `workspaceSession` is a cookie (`nt_session`), so on
*this operation* an `Authorization` header can only be the portal bearer — the
controller branches on its presence and nothing else. No header → the workspace
path, unchanged, and the portal resolver is never asked.

**Two contexts, because the delegated policies cover exactly two tables.**

| Write | Context | Why |
|---|---|---|
| the `documents` row | **delegated** (`delegatedScopeFor`) | `documents_delegated_upload` USING `id = ANY(app_granted_item_ids())` + WITH CHECK `business_id = app_business_id()` is what ADMITS it. The handler compares nothing. |
| the `document_events` row | practice **SYSTEM** (`systemScopeFor`) | `document_events` has **no delegated branch** — it reaches its tenant through `app_can_access_document`, which begins `app_session_scope() = 'user'`. A delegated context inserting one is refused by Postgres. |
| the `notifications` row | practice **SYSTEM** (inside `PortalUploadNotifier`) | same reason, same policy shape. |

That split is why `persistDocument` skips its own event write on the delegated
path and `recordDelegatedProvenance` runs after the transaction. It is best
effort **and the row does not depend on it**: `documents.submitter_label`
carries the provenance too, so a failure loses the timeline entry, not the
provenance. Failing the request instead would be worse — the document is
persisted by then, and a retry finds `created: false`, skips the enqueue, and
strands it in RECEIVED.

## `submitter_label` — who sent it, in words (5 Sep 2026, review items 21/43/62)

`complete()` decides the row's `submitter_label` once, and the web renders it
off `DocumentSummary.submitterLabel` (the contract widening that lets list rows
say an honest "Received via"):

| Caller | Row label | Event outcome |
|---|---|---|
| chase-link session | `uploaded-via-chase-link` (from the signed claims) | `uploaded-by-delegated-session` — **SoT §4 Stage 8.3's exact audit string, do not reword** |
| signed-in portal member | `Uploaded by {member} ({business})` / `Captured by …` (composed in `portal/portal-provenance.ts` at intent time, signed into `UploadClaims.submitterLabel`) | the same human words |
| workspace session (WEB_UPLOAD / CHAT_UPLOAD) | `Uploaded by {accountant}` — `workspaceSubmitterLabel`, read from `users` by the session's own `actorId` (no RLS on `users`, the `resolveSystemActor` precedent); a SYSTEM actor or a nameless user writes NOTHING, and a lookup failure never costs the upload | `received`, unchanged |

⚠ A delegated token minted before the claim existed falls back to the legacy
`uploaded-by-delegated-session` — and rows written before 5 Sep 2026 carry that
value for BOTH portal kinds, so the web reads it as "Client portal" (true of
both) rather than as a chase that may never have happened. That asymmetry is
review item 21's whole point; do not "fix" the fallback to the chase slug.

**Three guards on the delegated path, in order:**

1. `verifyUploadToken` — the same signature as any other intent (`UPLOAD_URL_SECRET`
   is shared; a portal-specific key would mint intents nothing could complete).
2. `assertGranted` — the derived `documentIdFor(uploadId)` must be in the
   session's grant. A session may complete only the intents it started; **404,
   never 403**. Without it the failure is still closed (Postgres refuses the
   INSERT's RETURNING) but arrives as a 500 on a phone, and a second session in
   the *same* business could complete another's intent.
3. Postgres. Proven, not assumed:
   `portal/portal-delegated-upload.integration.test.ts` forces the grant open to
   a foreign business's document id and asserts the refusal message is
   Postgres's own `row-level security` one.

**The replay store is namespaced per session** on this path
(`portal-complete:<otpSessionId>:<key>`). It is a flat map keyed by a
client-generated UUID; two sessions reusing one key must miss, never be handed
each other's document. Workspace keys are unchanged.

**The accountant's notification travels as a closure**, not as a service on
`WebUploadService`. `DelegatedCompletion.notifyUploadReceived` is built by
`delegated-completion.ts` (which already reaches the portal seam), so this module
never learns what a `notifications` row is and the service keeps its five
constructor dependencies.

**The enqueued job is identical to a web upload's** — `source: 'web_upload'`,
`documentId`, `practiceId`, `routing: {kind: 'matched', businessId}` — which is
exactly what the worker's already-persisted branch needs, so extraction and
Stage 8's auto-close run for a portal document with no second code path.

## Sanitisation — Stage A3, and where it lives

`upload-sanitisation.ts` (pure) + `prisma-upload-sanitisation.ts` (the step the
worker wires). **This lane skipped sanitisation entirely until 26 Aug 2026.** The
service persists the document from the signed claims, so the row's `mime_type`
was the browser's word for it, the EXIF (and its GPS) was never stripped, and an
iPhone HEIC reached extraction still a HEIC — `NT-EXT-003` on the most common
phone format, on a named §24.7 step.

The step is the WhatsApp lane's shape applied to bytes we already hold, and it is
deliberately **the same `sanitise()`** — magic-byte sniff, allowlist, channel
cap, virus hook, EXIF/orientation + HEIC→JPEG, PDF safety, ZIP caps. Three
phases: read the row under the practice SYSTEM actor, do the work outside any
transaction (sharp decodes, qpdf is a subprocess), then one short transaction to
make the row describe the bytes that now exist.

| Thing | Where it lands |
|---|---|
| the sanitised bytes | `store.put` → `w/<biz>/documents/<sha256>` (off the intent key at last) |
| the row | `s3_key`, `byte_hash`, `byte_size`, `mime_type`, `perceptual_hash` |
| the record | a `document_events` row, stage `sanitise` |
| a refusal | `state = REJECTED` + `failure_code`/`failure_message`, through `transitionDocument` |

**Five things that are easy to get wrong here, and are not:**

1. ⚠ **The pipeline's `detectedType` describes the INPUT.** `pipeline.ts` returns
   the bytes step 5 produced alongside the type step 1 sniffed, and step 5
   re-encodes every image to JPEG — so a converted HEIC comes back labelled
   `heic`. Writing `mimeForFormat(detectedType)` would put `image/heic` on a row
   whose object is a JPEG, and `BedrockExtractor` reads that column: the fix
   would have failed on the exact format it was for. `effectiveFormat()`
   re-sniffs the **stored** bytes. Do not "simplify" it away.
2. **Sanitisation is not a state transition** — the document stays RECEIVED and
   extraction moves it. So the state cannot be the idempotency marker: "still
   RECEIVED?" is true before AND after. The marker is the `sanitise` event, and
   the row write is compare-and-swap on the `s3Key` read in phase 1.
3. **A rejection is a REJECTED document, not a DLQ entry.** WhatsApp has to
   dead-letter because it has no row yet; this lane has one, so the reason lands
   where a human already looks and a `document.reprocess` proposal can retry it.
4. **No filename goes into `sanitise()`**, matching the email and WhatsApp lanes.
   The bytes decide the type. `extensionContradicts` would reject a PNG someone
   saved as `photo.jpg` — a mistake with no security content — and the declared
   MIME was already allowlisted at the door as a cheap pre-filter.
5. **The whole object is buffered** (`get()`, up to the 100 MB accountant cap, at
   worker concurrency 8). Sniffing, decoding and re-encoding cannot be streamed;
   this is why it is not on the request path.

⚠ **The original object is NOT deleted.** `DocumentStore` has no `delete(key)`,
so `w/<biz>/uploads/<nonce>` still holds the pre-sanitisation bytes, EXIF
included. The document we serve and process is clean; an orphaned intent object
is not. See the TODO.

`capChannelFor` is exported from `upload-policy.ts` so the door and the worker
read the cap from one map. Two opinions about which cap a web upload falls under
would mean presigning a file the worker then refuses, after the client has
already spent the upload.

## The tenancy check that is easy to miss

`createUpload` resolves the business through `scopedDb` **before anything is
signed**, and returns 404 when RLS returns no row.

Without it this endpoint mints a write URL into `w/<businessId>/uploads/…` from a
`businessId` taken straight out of the request body. Postgres would still refuse
the row at completion (`documents_tenant`'s WITH CHECK) — but by then the bytes
are already in another practice's S3 prefix, and **object storage has no RLS to
undo that**. The database check happens too late to be the guard; the guard has
to be here.

**404, never 403** — a 403 confirms the record exists (`packages/contracts/CLAUDE.md`).

The practice anchor on the document comes from the **business row**, not from the
caller's context. They coincide for practice staff, but a business-level actor
has no `practiceId` in scope, and taking it from there would file the same
document two different ways depending on who uploaded it.

## Error codes, and one that was wrong

Mapped at the controller/service boundary, from the `ErrorCode` enum in
`openapi.yaml`:

| Code | Status | When |
|---|---|---|
| `NT-ING-001` | 413 | declared size over the channel cap |
| `NT-ING-002` | 415 | declared MIME off the allowlist |
| `NT-ING-003` | 409 | **byte hash mismatch between client and storage** |
| `NT-ING-005` | 410 ⚠ | the upload intent expired |
| `NT-IDM-001` | 409 | `Idempotency-Key` replayed with a different payload |
| `NT-VAL-001` | 400 / 404 ⚠ | schema failure, forged token, unreachable business |

⚠ The hash mismatch is **`NT-ING-003`**. `NT-ING-004` is *file rejected by
sanitisation* — a different failure, at a different stage, that this endpoint
cannot produce because sanitisation has not run yet. It was wrong in the first
draft; the enum is the authority, not intuition.

⚠ **Two of those statuses are emitted but NOT declared on the operation.** The
codes are all in the `ErrorCode` enum — that part is fine — but a code being in
the enum and a status being declared on the operation are separate things, and
only the first was checked when this table was first written:

| Emitted | Operation | Declared in `openapi.yaml`? |
|---|---|---|
| `410` (`NT-ING-005`, expired) | `completeDocumentUpload` | **no** — 201/400/401/404/409/429/500 |
| `404` (`NT-VAL-001`, unreachable business) | `createDocumentUpload` | **no** — 201/400/401/**403**/409/413/415/429/500 |

The generated client therefore has no typed branch for either. The second is the
more interesting one: `createDocumentUpload` declares **403**, and
`packages/contracts/CLAUDE.md` states as a load-bearing convention that a
`businessId` the caller cannot reach returns *"`404`, never `403` — `403` would
confirm the record exists"*. So the spec contradicts its own rule on this
operation, and the code follows the rule.

**Nothing here is fixed by editing the code.** `openapi.yaml` is LAW (G7) and
both entries need a contract-change issue approved by Shakib. Raised on #76;
until it lands this table is the honest record of the divergence rather than a
claim the contract agrees.

`NT-VAL-001` is the house fallback for an otherwise-uncoded 4xx (see
`ProblemFilter.CODE_BY_STATUS`), which is why it covers both a 400 and the 404.

## The boundary is generated, never hand-written

Both operations parse with the generated schemas from `@neoting/contracts/zod`
via `common/validation/parseBoundary`. No DTO is written by hand — drift is the
thing the contract exists to prevent, and the schemas come from the same
`openapi.yaml` the frontend client is generated from.

Two details that follow from that:

- **The generated schemas are `.strict()`**, so a misspelled field is a 400, not
  a silent ignore. `parseBoundary` expands Zod's `unrecognized_keys` issue into
  one `Problem.errors` entry **per key** — Zod reports it against the parent
  object with an empty path, which renders as `(body)` and tells a caller who
  sent `businesId` nothing about which of their seven fields is wrong.
- **The service's request type is derived from the schema**
  (`z.infer<typeof createDocumentUploadBody>`), not from the generated
  `DocumentUploadRequest` interface. `exactOptionalPropertyTypes` is on; Zod
  infers `splitMode?: SplitMode | undefined` and the interface writes
  `splitMode?: SplitMode`, and under that flag a parsed body will not assign to
  the interface. Both are generated from the same spec, so this is still a
  generated type — it is just the one that actually validated the value, which
  avoids a cast at the controller.

Field errors name the field and never echo the **value**: a body carries
filenames and free text a client typed, and error responses are logged and
screenshotted far more freely than request bodies are.

⚠ **`document-response.ts` has MOVED to `common/documents/` (#77).** It is no
longer in this directory. The read surface projects the same Prisma row onto the
same contract `Document`, and a module may not reach into another's internals —
so the choice was move it or copy it, and a second copy is how the write surface
and the read surface start disagreeing about what a `Document` is. Import it from
`../../../common/documents/document-response.js`; `toDocumentResponse` behaves
exactly as it did here.

## `Idempotency-Key`

Required by the contract on both operations, so a missing header is a 400 rather
than a silent non-idempotent write. A replay returns the original response; the
same key with a different payload is `409 NT-IDM-001`.

`InMemoryIdempotencyStore` is per-process — enough for one API instance and the
tests. A durable store is a follow-up and stays behind the interface, because
there is no idempotency table and `prisma/` is LAW.

⚠ **`idempotency-store.ts` MOVED to `common/idempotency/` (METH S3, #122)** —
the Review → Approve engine became its second consumer, the same
move-don't-copy choice `document-response.ts` made in #77. Behaviour is
unchanged; import it from `../../../common/idempotency/idempotency-store.js`.

**The durable guarantee is not that store.** `completeUpload` derives the
document id from the `uploadId` (`documentIdFor`), so a replayed completion
finds the existing row instead of creating a second one, and a lost primary-key
race is caught as `P2002` and treated as the no-op it is — the same shape as the
worker's `PrismaDocumentSink` (#20).

`persistDocument` returns `{ row, created }` and **only a `created: true`
completion enqueues sanitisation.** That is not tidiness. `BullmqIngestQueue`
sets `removeOnComplete: true`, so its `jobId` dedupe holds only while the job is
still in the queue — once the first sanitisation job finishes and is removed, a
second completion of the same intent re-enqueues successfully. Harmless today
(the worker no-ops on a job that carries a `documentId`), a double-sanitisation
the moment the worker-side TODO below lands. Same shape, same reason, as
`PrismaDocumentSink`.

⚠ **The store is check-then-act, and that is a real race, not a theoretical
one.** `get(key)` → do the work → `put(key, response)` is not atomic. Two
concurrent `createUpload`s with the same `Idempotency-Key` both read null and
both run: two nonces, two presigned URLs, two signed tokens, and only one
response recorded. The caller whose response lost is holding a URL that no
replay will ever return. `completeUpload` is protected from the *document*
duplicating by the derived id, but both callers still fetch and hash the bytes.
The fix is store-before-work (`getOrReserve`, or `SET NX PX` once the store is
Redis), and it belongs with the durable store below rather than bolted onto a
`Map`.

## No side-effect endpoint outside Review → Approve

Both operations are `x-nt-side-effect: ingest` in the contract. Submitting
evidence creates a new record and changes no existing one, so it needs no
Approve. The architectural route-table test (Governance §10.6) reads that field,
so this is mechanical rather than a promise in prose.

## Wiring

`WebUploadModule` imports `PortalModule` for two providers —
`PORTAL_SESSION_CONTEXT` (resolve the bearer) and `PORTAL_UPLOAD_NOTIFIER` (tell
the practice). **The dependency runs one way and must stay that way:** the portal
mints its own intents from ingestion-routing's *mechanisms*
(`signUploadToken`, `uploadIntentKey`, `documentIdFor`, the cap and the
allowlist, all through `ingestion-routing/index.ts`) rather than injecting
`WebUploadService`, precisely so the two modules never need a `forwardRef`.

`WebUploadModule` imports `IngestQueueModule` — a **shared** producer. Nest
providers are per-module, so giving this lane its own `selectIngestQueue` factory
would open a second Redis connection the moment `INGEST_QUEUE=bullmq`. Invisible
under the fixture, real in staging.

Store and queue are config-selected (`OBJECT_STORE`, `INGEST_QUEUE`), never
import-selected, so `pnpm dev` and `pnpm test` run this lane offline while
staging runs the real thing through the same code.

## Tests

```bash
pnpm --filter @neoting/api test                          # unit, offline
RUN_S3_INTEGRATION=1 pnpm --filter @neoting/api test     # + the real end-to-end (needs docker compose up)
```

`web-upload.integration.test.ts` is the #76 acceptance and the only test that can
be: **intent → a real `PUT` to the presigned URL → complete**, against Postgres
and MinIO. Every unit test hands the service an `InMemoryDocumentStore` whose
`presignPut` returns `https://fixture.local/…` — a URL nothing ever fetches, which
proves the branching and nothing about the signature. The two failures only the
integration test can catch:

1. **The presigned PUT is rejected.** `presignPut` folds `content-type` and
   `content-length` into the signature; if the headers we hand the client are not
   the headers it covers, the browser's PUT 403s while the API reports success.
2. **The document does not land under RLS.** The row is business-anchored and
   written from a practice context — `documents_tenant`'s WITH CHECK decides
   whether that is allowed, and no fake can answer for it.

It also proves the cross-tenant hole is closed against the **real**
`businesses_tenant` policy: the unit test can only show the branch fires when
`findUnique` returns null; the integration test shows Postgres is what returns
null.

Run 16 Aug 2026 against `docker compose up -d`: 4/4 green. Vitest loads `.env`
itself, so `DATABASE_URL`/`DIRECT_URL` are picked up automatically; only
`RUN_S3_INTEGRATION=1` has to be set by hand.

Two things the unit tests pin that are easy to break silently, both added by the
review of #76:

- **The `created` gate.** `web-upload.service.test.ts` completes the same intent
  twice with **no** `Idempotency-Key`, so the replay store cannot short-circuit
  the second call — it runs the whole path and is stopped only by the derived id.
  One document, **one** enqueued job. The fake Prisma gained a documents map for
  this; without a row to find, `created: false` is unreachable and untestable.
- **Nothing is presigned for an unreachable business.** The integration test
  wraps the real store in `countingStore()` and asserts `presignPutCalls() === 0`.
  A 404 assertion alone does not prove that: a refactor moving the presign above
  the RLS lookup would still mint a URL into another practice's prefix and still
  return 404.

## Out of scope (issue #76)

- **Auto-split.** `splitMode` is accepted, carried in the claims and stored, but
  nothing splits yet. A caller passing `AUTO_SPLIT` gets the parent document, as
  the contract already documents.
- ~~**Sanitisation of web uploads.**~~ **Done — Stage A3**, see the section
  above. The job is still enqueued with `documentId` set (the worker's persist
  path must not fire on it — that would double-create); the already-persisted
  branch now sanitises before it dedupes and extracts.
- **Duplicate detection on this lane** — runs in the worker (#40), after the
  document exists.
- **Auth.** The request context comes from `common/context` (#75); real sessions
  are `auth-tenancy`.

## Out of scope (METH Stage 9, the delegated half)

- **`createUpload` is NOT reachable with a portal bearer.** Step one for the
  portal is `POST /v1/portal/uploads`, which is a different operation with a
  different body — this one takes a `businessId` from the caller, and a portal
  caller must never name a business.
- **The portal's mismatch feedback and status poll** live in `modules/portal`
  (`chase-verdict.ts`, `portal-upload-status.service.ts`). This lane creates the
  document and enqueues; everything said back to the client about it is read
  from there.
- **Auto-close stays Stage 8's**, in the worker's ingest hook. A portal document
  is business-anchored and carries a practice, so it closes a matching chase
  through the same path an email or WhatsApp arrival does — there is no second
  close here, and there must not be one.

## TODO

- [ ] Durable `IdempotencyStore` (Redis) — the in-memory one is per-instance, so
      a replay that hits a different API task does the work twice. The derived
      document id keeps that correct, not fast. **Do the store-before-work
      reservation in the same change** (see the race above); a durable store that
      is still check-then-act moves the race rather than closing it.
- [ ] Contract change (Shakib, G7): declare `410` on `completeDocumentUpload`,
      and `404` on `createDocumentUpload` — where the `403` it currently declares
      looks wrong against the contracts package's own "404, never 403" rule.
- [x] Worker-side sanitisation for `source: 'web_upload'` jobs, then map the
      pipeline's `Rejection` onto `NT-ING-004` on the document, not on a response
      (by then the HTTP call is long finished) — **Stage A3**.
- [ ] **Delete the original upload object** once sanitisation has re-keyed the
      document. `DocumentStore` has no `delete(key)` and `storage/` was outside
      Stage A3's owned paths, so `w/<biz>/uploads/<nonce>` still holds the
      un-stripped bytes. An S3 lifecycle rule on `w/*/uploads/*` closes the
      exposure without code; a `delete` on the store closes it properly. Until
      one of the two lands, "we strip EXIF" is true of the document we keep and
      not of everything in the bucket.
- [ ] Share `effectiveFormat` with `whatsapp-media-intake.ts`, which still
      labels its output with the pipeline's input-side `detectedType` — a HEIC
      arriving by WhatsApp is stored as `image/heic` carrying JPEG bytes.
- [ ] The delegated document's `document_events` row and its `notifications` row
      are written in **separate transactions** from the document itself, because
      neither table has a delegated RLS branch. Both are idempotent-ish and both
      are best effort; the durable fix is a delegated branch on `document_events`
      (a `prisma/sql/rls.sql` change, therefore G7) so the event can go back
      inside the document's own transaction.
- [ ] Re-key the object from `w/<biz>/uploads/<nonce>` to the content-addressed
      `w/<biz>/documents/<sha256>` once sanitisation has the final bytes. The
      intent key cannot be content-addressed — the sha256 is not known until the
      bytes land.
- [ ] Update this file on exit.
