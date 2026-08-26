# exports-public-api

**Lane L** · **Source of Truth:** SoT §4 Stage 10, §15 · **Owner:** see the project board

## Purpose

CSV/XLSX/PDF/ZIP exports, admin-defined custom mappings, the public REST API, and signed webhooks.

## ⚠ Initial Delivery (ID) — read this before the sections below

**In ID this module is the ONLY way data leaves the product** (D42, SoT §24.3). There is no ledger adapter and no auto-publish, so the export is not a convenience feature here — it is the delivery.

- **The first client uses VT Software (VT Transaction+), so VT is the primary emitter and it gates the release** — not an afterthought, and not a generic CSV someone maps by hand. Build the export as a **canonical model plus per-target emitters** so VT is one emitter and not the architecture.
- **D43 is the acceptance test for the whole release:** every exported transaction carries a **resolvable link to its source document**, and the requirement is written on the *outcome*, not the mechanism. The accountant must get from a line in their accounting software to the document. SoT §24.3.2 specifies a four-rung fallback ladder in advance — read it before choosing an approach.
- **Known constraints, already researched — do not rediscover them the hard way:** VT’s import accepts **one nominal per row**, so a document spanning several nominals either collapses or splits; decide deliberately. Target reference fields are short and **truncate without warning** (one clips at 30 characters, another at ~25), so a link must survive that budget. Three of the five export targets cannot accept line items at all.
- **The public REST API and signed webhooks are v1, NOT ID** (SoT §24.6). Do not build them into the ID lane.
- **Capability URLs leave our control by design** — they sit inside a third party’s software. Unguessable per-document tokens, view-only scope, revocable, access-logged, expiry configurable per practice (SoT §21).

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- The public API is this same API with scoped OAuth clients — no second door to maintain. Large exports generate async into a download centre.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Boundaries

Exposes **only** its public providers. No other module reaches into its internals; cross-module work goes through those providers or through domain events on the transactional outbox. Import rules are lint-enforced, because this boundary is also the parallel-agent lane map.

## Tests

```bash
pnpm --filter @neoting/api test -- exports-public-api
```

## Current state

**Stage A7 has landed: the canonical model and the VT Transaction+ emitter.** Pure domain
code — no controller, no Prisma, no NestJS module, nothing registered in `app.module.ts`.
That is deliberate: A9 owns the HTTP surface and the screen, and this stage is the thing
A9 calls.

```
canonical/canonical-row.ts       the model — two record families, signed integer pence
emitters/export-emitter.ts       the seam: one emitter per target
emitters/select-emitter.ts       target → emitter, typed Record<ExportTarget, …>
emitters/csv/csv.ts              the serialiser (hand-written, no dependency)
emitters/csv/encoding.ts         ⚠ THE ENCODING DECISION POINT — see below
emitters/vt/…                    the VT Transaction+ emitter, its format rules, its guards
emitters/generic-csv/…           GENERIC_CSV, because the contract enum admits it
index.ts                         the public seam: the model, and `selectEmitter`
```

`pnpm --filter @neoting/api test -- exports` → 7 files, 67 tests.

## ⚠ A10 — the two lines you came here to change

Both are single exported constants, and nothing else in the module makes either decision.

| Question | Constant | File | Default |
|---|---|---|---|
| **What byte encoding does VT read?** | `CSV_ENCODING` | `emitters/csv/encoding.ts` | `'utf-8-with-bom'` |
| **Does the file carry a header row?** | `VT_CSV_INCLUDE_HEADER` | `emitters/vt/vt-transaction-plus-emitter.ts` | `true` |

`encoding.ts` carries a table of *what you will see in VT* → *what to change it to*, and
implements `utf-8`, `utf-8-with-bom` and `windows-1252` (the last hand-rolled, no
dependency, including the 0x80–0x9F block Latin-1 lacks). All three branches are tested,
so changing the constant is a one-line change against a green suite.

The case A10 must put in front of a real VT is **a supplier name containing both a comma
and an accented character** — `Épicerie Dubois, S.à r.l.` is in the test suite and is the
one that breaks hand-rolled serialisers and legacy code pages at the same time.

## ⚠ The two VT landmines — do not remove these guards

Both live in `emitters/vt/vt-safety.ts`, both are tested at the unit *and* through the
whole emitter, and both fail **inside the accountant's software, silently, on their
machine**. Neither produces a stack trace we would ever see.

1. **VT builds older than May 2025 crash on any numeric token longer than 16 digits** —
   in a reference, a note, or inside a URL. `breakLongNumericTokens` splits any run of 17+
   digits into 16-digit groups and the emitter raises a `long-numeric-token-broken`
   warning. Break rather than truncate (no digit is lost) and rather than refuse (one odd
   supplier reference must not block a month's export).
2. **`Entry details` coerces numeric-looking strings into 2-decimal numbers.** `123456`
   arrives as `123456.00`. That column holds D43 rung 1 — the capability code the release's
   acceptance test depends on — so `assertVtEntryDetailsSafe` **throws** rather than
   repairing: the only thing in that column is a code we mint, and a letterless one is a
   defect in the minting, not customer data. An empty cell is allowed. The canonical
   schema refuses a letterless code as well, so there are two locks on that door.

## Where A8 attaches

`CanonicalSourceLink { code, url }` in `canonical/canonical-row.ts` is the seam, and it is
nullable **only** because A8 has not merged. A8 fills it; nothing else has to change.

- **`code` → `Entry details`**, in `entryDetailsCell()`. Schema-enforced: contains a
  letter, at most 20 characters (targets truncate silently at 30 and ~25).
- **`url` → `Transaction notes`**, in `transactionNotesCell()`, with the code and
  `VT_PROVENANCE_TAG`.
- Until then every row raises a `source-link-missing` warning. An export that is quietly
  linkless is the D43 failure this surface exists to prevent.

## Decisions made here, with their reasons

- **One nominal per row: collapse, do not split** (§24.3.4). Splitting would make VT create
  several *transactions* from one invoice and misstate the creditor; collapsing keeps
  `Total` equal to the document gross — the number that reconciles against a supplier
  statement — and raises `analysis-collapsed` naming the nominals that did not travel.
- **Amounts are unsigned in the VT file**, because VT derives debit and credit from `Type`.
  The canonical model stores them signed (debit positive) per §24.3.4; the sign is dropped
  at the emitter and nowhere earlier.
- **`Ref no` is left blank.** VT assigns its own reference at post time.
- **`Primary account` is passed through byte-for-byte.** VT's Converter saves the supplier
  mapping against that exact string; re-casing or re-trimming it makes every future import
  manual (§24.3.1).
- **No CSV formula-injection prefixing**, for the same reason — it would change the
  Converter key on every export. The residual risk (an accountant opening the file in
  Excel first) is recorded in `csv/csv.ts` rather than mitigated silently.
- **`GENERIC_CSV` has an emitter** because the contract and Prisma enums admit the value
  and *an enum value with no emitter behind it is a 500*. It is not Xero and not Sage;
  D42 puts both out of this release and neither is built.

## TODO

- [ ] **A8** — the capability token, `GET /d/{code}`, and the manifest + ZIP bundle
      (D43 rungs 2 and 4). The model seam is ready; see "Where A8 attaches".
- [ ] **A9** — the HTTP surface (`listExports`, `createExport`) and the export screen.
      Nothing here is registered in `app.module.ts` yet, on purpose.
- [ ] **A10** — settle the two constants above against a real VT on Windows.
- [ ] Bank lines still ride the general UIS layout. §24.3.1 notes VT has a dedicated
      bank-statement import mode (Date / Description / Payment / Receipt); that second file
      is not built, and bank statement extraction is on the launch plan's cut list.
- [ ] The public REST API and signed webhooks are **v1, not ID** (§24.6). Do not build them.
- [ ] Update this file on exit — it is how the next session picks up.
