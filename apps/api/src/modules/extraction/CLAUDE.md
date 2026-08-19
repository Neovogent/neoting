# extraction

**Lane C** · **Source of Truth:** SoT §4 Stage 2, §16 · **Owner:** see the project board

## Purpose

`DocumentExtractor` implementations (Textract plus fixture mode), the vision escalation ladder, per-field confidence and provenance.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Thresholds come from eval measurements, never from model self-reported confidence. Every extraction records model and prompt version so any historical decision is reproducible.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

## Tests

```bash
pnpm --filter @neoting/api test -- extraction
```

## Current state

### DemoExtractor + the extraction pipeline (METH Stage 4)

The step that finally moves a document out of RECEIVED. `DocumentExtractor` is the
seam (Textract + the vision ladder lands behind it post-demo); `DemoExtractor` is
the only implementation today — deterministic UK document profiles keyed by a
filename keyword, with a hash-derived generic fallback, selected by
`EXTRACTOR=demo`. **// DEMO-MOCK throughout** — this is a real system with a fake
vendor, not a fake system.

- **`document-extractor.ts`** — the interface + result types (`ExtractedDocument`,
  `ExtractedField` mirroring the contract's `ProvenanceClass`, `ExtractionOutcome`
  with a typed `failure` branch). `DEMO_MODEL_VERSION = 'demo-extractor-1'`.
- **`demo-profiles.ts`** — the cast (METH_MODE §7): Currys £1,299, Google £600,
  Bidfood, Adobe, Shell, Just Eat, plus a **To-Review** profile (a failed VAT-
  arithmetic validator) and a **Failed** profile (unreadable → `NT-EXT-001`).
  Money is integer pence; VAT computed integer-only (R5).
- **`extraction-pipeline.ts`** — `PrismaExtractionStep`, wired into the worker.
  `ExtractionInput` is just `{ documentId, practiceId, businessId, traceId }` —
  filename and byteHash are read off the ROW, so it works for every channel
  including web upload (whose job carries only a `documentId`, its bytes never
  having passed through the worker). Per document, under the practice SYSTEM actor
  through `scopedDb` (same as the sink): **RECEIVED → PROCESSING**, then the extractor
  runs OUTSIDE any transaction (a deterministic 2–4 s latency from the byte hash,
  so Processing renders), then one transaction writes the accepted `Extraction`,
  the coding `Suggestion`s, the denormalised header projection (THE one writer —
  prisma/CLAUDE.md open q3) and a `document_events` row, and drives
  **PROCESSING → READY | TO_REVIEW | FAILED** via `resolveProcessedState`.
  Idempotent and re-entrant: a redelivery or crash-retry re-reads the state and
  does nothing twice (guards on state; skips if an accepted extraction exists).
  **`run` now returns an `ExtractionCompletion | null`** (METH Stage 8): the
  header (supplier, total pence, document date) + final state for a LANDED
  document (READY | TO_REVIEW), or `null` for a FAILED read / no-op redelivery.
  This is what the ingest processor hands the chase auto-close hook — a chase
  never closes on a document we could not read. `RecordingExtractionStep` takes
  an optional completion so a processor test can drive that branch offline.
- **Rule honouring** — before coding, an active single-tier `SUPPLIER_CUSTOMER`
  rule for the routed business + supplier overrides the category, provenance
  DETERMINISTIC, `suggestion.sourceRuleId` recorded. **// DEMO-MOCK: four-tier
  priority engine.** Proven under RLS (the SYSTEM actor's practice-membership
  branch reaches the business's rules — same mechanism as #40 dedupe).
- Consumes `validation-dedupe`'s **public seam** (`index.ts`, created for this —
  its first cross-module consumer): `transitionDocument`, `resolveProcessedState`.
  The worker composition root wires it; the ingest processor takes it as a
  REQUIRED dep (a silently-skipped extraction is the "never leaves RECEIVED" bug
  this stage removes) and a `RecordingExtractionStep` fixture keeps that
  processor's unit tests offline.

Proven against a real DB (`extraction-pipeline.integration.test.ts`): READY with
header + extraction + suggestions + a gapless event log; idempotent re-run;
validator-fail → TO_REVIEW; unreadable → FAILED with reason; rule override.

**Known gaps, flagged not hidden:** line items ride in the existing `fields`
jsonb (METH §3.2: existing jsonb + note) — the `Extraction` row has no line-item
column though the contract carries `Extraction.lineItems`. **The read projection
(`toExtraction` in `common/documents/`) SEPARATES the smuggled key since METH
S7 (#137)**: it serves the contracted optional `Extraction.lineItems` array and
strips the key from `fields` — necessary, not cosmetic, because the generated
client parses `fields` as a STRICT map of `ExtractedField`, so the array left
in place failed every extracted `GET /documents/{id}` in the browser. The
persisted home is still the jsonb (a schema/contract call). The confidence seam
stays empty (eval-calibrated, does not exist yet) — To-Review is driven by a
missing field or a failed validator, never an invented threshold.

## TODO

- [x] METH Stage 4: DemoExtractor + pipeline, documents leave RECEIVED, proven
      against a real DB.
- [ ] Textract + the vision escalation ladder behind `DocumentExtractor`, `EXTRACTOR=textract`.
- [ ] Real `packages/validators` verdicts (VAT arithmetic, VRN, dates) replacing
      the pre-computed demo ones.
- [x] Surface `Extraction.lineItems` on the read projection — METH S7 (#137),
      `toExtraction` separates the smuggled key. Still open: their persisted
      home (a schema/contract call, currently the `fields` jsonb).
- [ ] Confidence gating when eval calibration lands (the seam in validation-dedupe/readiness.ts).
- [ ] Update this file on exit — it is how the next session picks up.
