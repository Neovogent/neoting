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

BOOTSTRAP shims (need a dependency — awaiting Shakib, see issue):
- Image normaliser (EXIF strip + HEIC→JPEG) — identity passthrough for now.
- PDF/Office guard — only the dep-free encrypted-PDF (`/Encrypt`) check is live;
  JS-flatten, embedded-file detach, encrypted-Office detection are dep-gated.

Toolchain: **stood up in issue #9** — real `typecheck` (tsc, Bundler
resolution), `lint` (eslint, `no-explicit-any`), `test` (Vitest). The 24
sanitisation tests were ported from `tsx --test` to Vitest and run in the suite.

## TODO

- [ ] Shakib (#7): `sharp` (prove on ARM64 first) + a named PDF toolkit, then
      replace the two BOOTSTRAP guards with real dep-backed implementations
- [ ] Enforce the bank-statement 300-page cap in the PDF-safety step
- [ ] Await the frozen ingestion endpoints; map `Rejection` → NT-ING wire error
      at the controller boundary (NT-ING-001/002/004 mirrored in `reasons.ts`)
- [x] #12: BullMQ behind `IngestQueue` + the worker (DLQ, idempotency, traceId),
      controller unchanged — done; live docker e2e pending a Docker install
- [ ] Update this file on exit — it is how the next session picks up
