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
- **Pending my Docker install**: the live `docker compose up` → signed POST →
  worker-picks-it-up-with-same-traceId proof can't run on this machine yet
  (no Docker). The logic is unit-tested; the end-to-end capture is the one
  acceptance item outstanding.

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
- [ ] Await the frozen ingestion endpoints; map `Rejection` → NT-ING wire error
      at the controller boundary (NT-ING-001/002/004 mirrored in `reasons.ts`)
- [x] #12: BullMQ behind `IngestQueue` + the worker (DLQ, idempotency, traceId),
      controller unchanged — done; live docker e2e pending a Docker install
- [ ] Update this file on exit — it is how the next session picks up
