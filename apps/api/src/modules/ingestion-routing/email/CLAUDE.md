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
- [ ] When the S3 event notification (Terraform) lands, wire the trigger →
      fetch raw bytes → `parse` → `processEmail`, and take `receivedAtSeconds`
      from the S3 event rather than the sender's `Date:` header. Inject the
      sharp-backed `createSharpPerceptualHasher()` here too (#40) — the hasher is
      a seam today, live only once a real call site constructs `processEmail`.
- [x] Store sanitised bytes to object storage (#16) — `storage/`, `w/` keys.
- [ ] Persist document RECORDS once `scopedDb` exists (bytes are in object
      storage + the queue today; no DB row yet).
