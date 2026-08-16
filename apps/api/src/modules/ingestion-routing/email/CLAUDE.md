# ingestion-routing / email

**Source of Truth:** SoT §4 Stage 1 (email channel) · **Added by:** issue #14

## Purpose

Turn an inbound email that SES dropped into S3 (`doc@…`) into ingested
documents. Pure library, same shape as `lib/sanitisation` — no controller, no
S3, no network, no database. The S3-event trigger that hands us the raw bytes is
Terraform (Shakib's), out of this lane.

`processEmail(parsedEmail, deps)`:
1. **Route by sender** (`decideRouting`, reused from the webhook) against a
   supplied map. None exists yet → pass empty → everything Unrouted, never
   dropped. AI-addressee detection (SoT step 2) is a deliberate seam, not built.
2. **Wrap** subject + body in `<untrusted_content>` (§9.6) — an email body is
   data, never instructions.
3. **Sanitise each attachment independently** via `sanitise()` (#2) on
   `channel: 'email'` (25 MB client cap). A rejection is visible with its reason
   and does **not** discard the rest — partial acceptance, never all-or-nothing.
4. **Store** each sanitised document via `DocumentStore` (#16) — bytes into object
   storage under a `w/` key — then **enqueue** through `IngestQueue` (#12) with the
   `storageKey`, so the job never describes a document that exists nowhere. The
   producer attaches the traceId from the request context, as the webhook does.

Between 3 and 4, the **perceptual hash** (#40) is computed from the sanitised
bytes while they are already in hand — never re-fetched from S3. The hasher is an
**injected** dependency (`PerceptualHasher`, type-only import so this lane never
loads `sharp`); absent → no hash, images only. It rides the job next to `sha256`.

## The MIME parser is behind an interface

`EmailParser.parse(raw) → ParsedEmail`. MIME parsing of hostile input is not
hand-rolled. **`postal-mime@3.0.0` approved on issue #14 (§19) and landed** —
MIT-0, zero runtime dependencies, pinned exact — as `PostalMimeEmailParser`
behind the interface. `processEmail` works off `ParsedEmail`, so the logic stays
tested offline with hand-built fixtures and the parser has its own
raw-MIME-on-disk test. Keep the interface: it is what makes the parser
replaceable without touching a call site.

## Inbound trigger (issue #78) — `inbound/`

`processEmail` was finished, tested and **idle** — nothing called it. `inbound/`
is the caller that gets raw MIME into it, the async-spine way (a poller, not an
HTTP request; a per-email failure costs one email, not the loop).

- **`EmailSource`** (interface + fixture + real, config-selected `EMAIL_SOURCE=fixture|mailhog|s3`):
  `poll()` pulls the currently-available raw emails, `ack(id)` removes one *after*
  it is processed. `FixtureEmailSource` (offline tests), `MailHogEmailSource`
  (the local SES stand-in's HTTP API on 8025 — this is what makes the lane
  exercisable on a laptop with no AWS), `S3EmailSource` (the SES receipt prefix).
- **`runEmailIntake(raw, deps)`** — parse (behind `EmailParser`) → resolve the
  practice from the recipient → `processEmail`, with the **`traceId` born here**
  inside `runWithTrace`, so the enqueued jobs inherit it exactly as the WhatsApp
  path does. `receivedAtSeconds` now comes from the **source's** observation time
  (SES write / MailHog receipt), not the sender's forgeable `Date:` header —
  `processEmail` gained an optional `receivedAtSeconds` for this.
- **`drainEmailSource`** — poll once, run each email, and **ack only the ones
  processed**. An unresolvable or unparseable email is left in the source (never
  dropped) and warned about **once** per id.
- **Practice from recipient** (`recipient-practice.ts`): the `doc+<practice>@`
  plus tag (the email lane already made `practiceId` a required caller dep for
  this). The envelope recipient wins over the `To` header.
- **Entrypoint** `src/worker/email-intake-main.ts` (`pnpm --filter @neoting/api worker:email`),
  a separate process like the ingest worker.

**Two infra gaps flagged on #78 (Terraform/IAM are Shakib's, never edited here):**
1. **No event-driven trigger exists** for the receipts bucket — only ClamAV's
   EventBridge notification. `S3EmailSource` **polls** the `inbound/` prefix
   (list → get → delete), which works today without the notification; when the
   S3→SQS/EventBridge wiring lands it replaces the poll loop.
2. The task role has `s3:GetObject` on `receipts/inbound/*`, but **`s3:ListBucket`
   and `s3:DeleteObject`** for that prefix must be confirmed — without them the S3
   source `AccessDenied`s in staging (unit tests pass regardless).

**Tenancy caveat (flagged, #17):** the recipient is sender-chosen, so a plus tag
is only as safe as the practice id is unguessable (cuid/uuid) — and a document
lands UNROUTED for a human to review, so a misdirected email surfaces in a queue
rather than granting access. The real fix is the SES receipt rules encoding the
mapping (#17), after which the parser is a fallback.

## Invariants

- Nothing silently dropped — unknown sender → Unrouted; a bad attachment → a
  visible rejection with a plain-English reason and NT-ING code.
- Untrusted content wrapped before it can reach a model.
- No Prisma, no DB writes (persistence blocked on `scopedDb`).
- **Nothing the sender controls may be the whole idempotency key.** The key is
  the BullMQ `jobId` and a duplicate jobId is discarded silently, so a key made
  only of `Message-ID` would let a forged header delete a real document with no
  rejection and no trace. The content sha256 is part of the key: a collision
  then requires identical bytes, which is the only case where dropping is right.
- The `Date:` header is the sender's clock. It feeds `receivedAtSeconds` today
  because nothing upstream offers a real receipt time — no freshness or triage
  decision may rest on it until the S3 trigger supplies one.

## Tests

```bash
pnpm --filter @neoting/api test
```

## TODO

- [x] Add the approved MIME parser + `PostalMimeEmailParser` behind
      `EmailParser`, and a raw-MIME-fixture-on-disk test — `postal-mime@3.0.0`.
- [x] #78: the trigger is wired — `inbound/` (`EmailSource` fixture|mailhog|s3,
      `runEmailIntake`, `drainEmailSource`) + `worker/email-intake-main.ts`.
      `receivedAtSeconds` now comes from the source, and the entrypoint injects
      `createSharpPerceptualHasher()`. Proven against a real DB. **Still Shakib's:**
      the S3→SQS/EventBridge event notification (polling stands in until then) and
      the `ListBucket`/`DeleteObject` IAM for `receipts/inbound/*` — both on #78.
- [ ] Recipient→practice via SES receipt rules (`doc+<practice>@`), issue #17 —
      the parser in `inbound/recipient-practice.ts` is the interim fallback.
- [x] Store sanitised bytes to object storage (#16) — `storage/`, `w/` keys.
- [ ] Persist document RECORDS once `scopedDb` exists (bytes are in object
      storage + the queue today; no DB row yet).
