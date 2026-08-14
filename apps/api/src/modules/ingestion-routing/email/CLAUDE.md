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
4. **Enqueue** each accepted document through `IngestQueue` (#12); the producer
   attaches the traceId from the request context, as the webhook does.

## The MIME parser is behind an interface

`EmailParser.parse(raw) → ParsedEmail`. MIME parsing of hostile input is not
hand-rolled — the concrete parser is a dependency proposed on issue #14 (§19)
and **not added until Shakib approves**. `processEmail` works off `ParsedEmail`,
so it is fully tested offline with hand-built fixtures; the raw-MIME-on-disk test
lands with the approved parser.

## Invariants

- Nothing silently dropped — unknown sender → Unrouted; a bad attachment → a
  visible rejection with a plain-English reason and NT-ING code.
- Untrusted content wrapped before it can reach a model.
- No Prisma, no DB writes (persistence blocked on `scopedDb`).

## Tests

```bash
pnpm --filter @neoting/api test
```

## TODO

- [ ] Add the approved MIME parser + `PostalMimeEmailParser` (or Shakib's pick)
      behind `EmailParser`, and a raw-MIME-fixture-on-disk test.
- [ ] When the S3 event notification (Terraform) lands, wire the trigger →
      fetch raw bytes → `parse` → `processEmail`.
- [ ] Persist accepted documents once `scopedDb` exists (currently enqueue-only).
