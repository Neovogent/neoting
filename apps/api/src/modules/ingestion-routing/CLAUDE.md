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

**Sanitisation pipeline (pure library) in progress** — `lib/sanitisation/`.
Governance §11.4 order, no controller / Prisma / API surface (those wait for the
frozen contracts). Branch `feat/api-ingest-sanitisation`.

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

Toolchain note: `apps/api` still has placeholder `typecheck`/`lint`/`test`
scripts. Tests currently run via `tsx --test` (zero new deps). The real gate
(Vitest + ESLint no-any + Zod at the boundary + `@types/node`) is pending the
dependency decision.

## TODO

- [ ] Shakib: approve deps for the toolchain (zod, vitest, eslint, @types/node)
      and the format libs (sharp/libvips, a PDF toolkit) — dependency issue filed
- [ ] Swap `tsx --test` → Vitest; wire real `typecheck`/`lint`/`test` scripts
- [ ] Add a Zod schema at the pipeline's public input boundary
- [ ] Replace the two BOOTSTRAP guards with the real dep-backed implementations
- [ ] Enforce the bank-statement 300-page cap in the PDF-safety step
- [ ] Await the frozen OpenAPI contract; map `Rejection` → NT-ING wire error at
      the controller boundary (NT-ING-001/002/004 already mirrored in `reasons.ts`)
- [ ] Update this file on exit — it is how the next session picks up
