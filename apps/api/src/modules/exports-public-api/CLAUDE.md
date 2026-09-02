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

**A7 (the canonical model + the VT emitter), A8 (the source-document link) and A9 (the
HTTP surface) have all landed.** A7 is pure domain code. A8 added the module's first
Prisma access, its first NestJS module and `GET /d/{code}`, the one route in this API
outside the session wall. A9 added `GET`+`POST /v1/exports` — the contract surface the
whole release is delivered through — and is the first thing here that WRITES a row of its
own (`exports`).

```
api/document-to-canonical.ts     a `documents` row → one canonical row, or a NAMED refusal
api/export-record.ts             the `exports` row → contract `Export`, + the `filters` record
api/exports.service.ts           list + create. The cap, the refusals, the idempotency
api/exports.controller.ts        `GET`+`POST /v1/exports`, thin
api/exports.module.ts            the wiring; imports CapabilityLinkModule for the ONE minter
api/tokens.ts                    its own DI symbols — deliberately not `links/tokens.ts`'s


canonical/canonical-row.ts       the model — two record families, signed integer pence
canonical/money.ts               integer pence → 2dp, shared by the VT cells and the manifest
emitters/export-emitter.ts       the seam: one emitter per target
emitters/select-emitter.ts       target → emitter, typed Record<ExportTarget, …>
emitters/csv/csv.ts              the serialiser (hand-written, no dependency)
emitters/csv/encoding.ts         ⚠ THE ENCODING DECISION POINT — see below
emitters/vt/…                    the VT Transaction+ emitter, its format rules, its guards
emitters/generic-csv/…           GENERIC_CSV, because the contract enum admits it

links/capability-code.ts         ⚠ THE TOKEN. 40 bits from crypto.randomBytes — read it first
links/capability-url.ts          the origin, and `code` → CanonicalSourceLink
links/document-link.service.ts   minting, under the exporter's own scope. Reuse > mint
links/capability-link.service.ts ⚠ THE UNAUTHENTICATED RESOLVER, and the one unscoped query
links/capability-link.controller.ts  `GET /d/:code`, at the origin root
links/link-rate-limit.ts         per-code and per-IP ceilings, memory + Redis
links/capability-link.module.ts  the wiring; the only thing app.module.ts imports

bundle/zip.ts                    a STORED ZIP writer, hand-rolled — no dependency
bundle/manifest.ts               the manifest CSV, keyed by capability code
bundle/source-document-bundle.ts rung 4 assembled: manifest + originals named by code
index.ts                         the public seam
```

`pnpm --filter @neoting/api test -- exports` → 20 files, 251 tests (22 of them
integration, skipped without a database).

## ⚠ A8 — `GET /d/{code}`, the one route outside the session wall

**Read `links/capability-link.service.ts`'s header before touching anything in `links/`.**
It carries the full account; this is the index.

| Property | Where it lives | What proves it |
|---|---|---|
| Unguessable | `capability-code.ts` — **8 chars, Crockford base32, 40 bits from `crypto.randomBytes`** | `capability-code.test.ts` — alphabet, bit-slicing, resample, exhaustion |
| At least one letter | resample, **never** a forced position | same file; plus A7's `assertVtEntryDetailsSafe` and the canonical schema |
| View-only, one document | `findUnique` on the id the LINK named, nothing else | `capability-link.service.test.ts` |
| Expiring | `document-link.service.ts`, `practices.document_link_ttl_days` ?? 365 days | `document-link.service.test.ts`, and the real-DB expiry test |
| Revocable | `document.revoke-link` **proposal**, executor in `validation-dedupe/proposals/revoke-link.ts` | `revoke-link.test.ts` + the real-engine integration test |
| Access-logged | `document_links.access_count`/`last_accessed_at` + a `document_events` row | integration test asserts both move |
| Rate-limited | `link-rate-limit.ts` — 60/code/hour, 300/IP/hour, IP consumed **first** | `link-rate-limit.test.ts` |

**404 vs 410 — this route deliberately breaks the house rule, and both the contract and
`rls.sql` §4b instruct it to.** Unknown *or malformed* → **404 `NT-VAL-001`**; revoked or
expired → **410 `NT-EXP-002`**. There is no 403 and no 400 anywhere on the route (the
contract declares neither). The reasoning is written in both LAW files: the code is
CSPRNG-generated and rate-limited, so "this code once existed" is not a useful oracle,
while an accountant holding a dead link needs to know it was revoked rather than mistyped.
**Do not unify it back to a single 404 without changing `openapi.yaml` and `rls.sql` too.**

**The one unscoped query.** `app_resolve_document_link(code)` on the root client, isolated
in `CapabilityLinkService.resolveLinkRow`, bound-parameter only. `rls.sql` §4b spends fifty
lines on why it exists and which two alternatives were rejected. Everything after it
re-enters through `scopedDb(systemContext(...))`. The integration test proves both halves:
a contextless `SELECT … FROM document_links` returns **nothing**, and the function returns
exactly six opaque columns.

## ⚠ Three things A8 could not fix from inside this module

Each is one line somewhere outside `exports-public-api/`, and each is recorded rather than
worked around.

1. **`main.ts` does not `app.set('trust proxy', …)`.** Express's `req.ip` is therefore the
   *socket* address, so behind the ALB and CloudFront the per-IP ceiling degrades into one
   global ceiling on this route. It fails in the safe direction and `PER_IP_HOURLY` (300)
   is sized for the degraded mode, but it is not the control it is meant to be until that
   line exists. Reading `X-Forwarded-For` by hand would be worse than useless.
2. **There is no `CAPABILITY_LINK_ORIGIN` env key**, so `capability-url.ts` carries the
   contract's own declared origin as a default and `capability-link.module.ts` is where an
   override attaches. A code minted against the wrong origin is inside a customer's ledger
   before anyone notices.
3. **There is no `CAPABILITY_LINK_RATE_LIMIT` env key**, so the module takes a
   `sharedCounters: boolean` and `app.module.ts` currently derives it from
   `EMAIL_RATE_LIMIT` — the repo's only existing "are limits shared across processes?"
   switch, read for a purpose its name does not describe.

**The access log is a `document_events` row, not an `audit_events` one**, and that is a
recorded shortfall. The hash-chained writer lives in `modules/approvals/audit-writer.ts`
with no public seam; a second implementation of a hash chain is a chain that fails
verification the first time two canonicalisations disagree. Promoting it means moving that
writer to `common/audit/`.

## ✅ A10 — DONE, and it rewrote the target (27 Aug 2026)

**Read `emitters/vt/vt-transaction-plus-emitter.ts`’s header, then SoT §24.3.1.** Raw
evidence, including the double entry VT produced from our file, is in
`Desktop/A10-vt-roundtrip/VERDICT.md`.

A10 was scoped as "settle two constants against a real VT". It settled them — and found
the emitter was aimed at a dialog that cannot import.

| Was | Is |
|---|---|
| `Transaction ▸ Universal Input Sheet ▸ Import from CSV` | **`Transaction ▸ Journal ▸ Import…`** — the UIS opens a bank-side sheet with **no import command** |
| 11 columns led by `Type` = `PIN`/`SIN` | **7 columns**, no type code, no `Ref no`, **no date**, no `Transaction notes` |
| `VT_CSV_INCLUDE_HEADER = true` | **`false`** — the journal import is positional and reads row 1 as data |
| One CSV per export | **A ZIP of one CSV per (date, direction)** — VT applies one journal date to a whole file |
| Collapse a split analysis and warn | **One row per analysis line.** VT imports splits; `collapseAnalysis()` is deleted |
| `Entry details` ≤ 20 chars, URL to notes | **Column B took 104 characters untruncated** — code *and* URL both ride it |

**The two constants, settled:**

| Question | Constant | Answer |
|---|---|---|
| Byte encoding | `CSV_ENCODING` (`emitters/csv/encoding.ts`) | **`'utf-8-with-bom'` — unchanged, now verified.** `Café Noël, Sons & Co` survived parse *and* posting with accent, comma and separator intact |
| Header row | `VT_CSV_INCLUDE_HEADER` | **`false`** — was `true`, and would have imported the header as a transaction |

**Two behaviours to design around.** VT **type-guesses each cell**, so a bare `5001` renders
`5,001.00` — a number, not an account; the prefixed `Ledger: Account` form stays text and
auto-matches VT’s chart. And VT **replicates Column B onto every leg** of the double entry,
so the D43 link is wherever the accountant looks.

**One thing left open, deliberately.** A split analysis costs a cosmetic **£0.00 line** in
the supplier account, because the continuation row must repeat Column A (blank makes VT
refuse). Totals are unaffected and the emitter raises `split-analysis-zero-line`. The format
designer exposes a **"Repeated columns"** range, hinting several analysis triplets may fit
on one row — unproven, and worth one session if the £0.00 line ever bothers anyone.

**Onboarding cost, measured.** Every supplier must exist as a VT account or be assigned
during import, and **Auto Assign on partial matching resolved 1 of 8**. It is a one-off per
supplier, saved in a conversion table — but it is a real mapping session, and A9’s screen
should say so rather than let the accountant meet it mid-import.

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

## ⚠ A9 — `GET`+`POST /v1/exports`, the sole egress

**Nothing on this lane transmits anything.** `POST /exports` returns bytes behind a
short-lived link. There is no ledger client, no vendor, no outbound call, and *Published*
is an INTERNAL state meaning approved and released for export. The operation is
**"Export for VT"**; the contract calls a string implying transmission a D42 defect rather
than a copy preference, and `apps/web/src/views/ExportView.test.tsx` reads the rendered DOM
and fails on the forbidden vocabulary rather than trusting a review to catch it.

### The lifecycle is deliberately fake, and the cap is what pays for it

Generation is **synchronous in the request**: no `QUEUED` state on this lane, no BullMQ job,
no worker, no progress polling. `exports.state` goes straight to `succeeded`, because the
bytes exist before the row does — so the row is never a promise about work that has not
happened. `apps/api/CLAUDE.md`'s async spine is the shape this returns to when a real queue
is worth its cost.

**The batch cap is `MAX_EXPORT_DOCUMENTS`, and it is `MAX_LINKS_PER_CALL` (500) imported,
not restated.** The contract caps `ExportRequest.documentIds` at 500, A8's minter refuses
beyond 500 with the same `NT-EXP-003`, and a third ceiling would mean a request that passes
the body schema, passes the service check and then fails inside the minter with a different
message. The period query takes `cap + 1` as a probe row (Governance §5.1 forbids an
unbounded load), and over the cap the answer names the number — **never a truncated file**.

### This operation READS. It changes the state of nothing

`x-nt-side-effect: ingest` — one new `Export` record, and **no document moves**. That is
why there is no `ActionProposal`: the human authorisation already happened at Ready →
Published, the super-admin act (D44). ⚠ **Nothing in `api/` writes to `documents`, and in
particular nothing archives them.** A5 removed auto-archive on release precisely because
ARCHIVED is past the only state this query can see, so an export that archived its own input
would make the *second* export of the same month silently empty. The unit harness's fake
transaction has no document writer at all, so a refactor that adds one fails there; the
integration test re-reads the row and asserts `PUBLISHED` + `archivedAt IS NULL`.

### Refusals, and which status each is

| Condition | Answer |
|---|---|
| Business RLS cannot reach | **404** `NT-VAL-001`. Never 403 — that would confirm it exists |
| Nothing Published in the period, or nothing exportable | 422 `NT-EXP-001`, naming the period in UK d/m/y |
| More than the cap | 422 `NT-EXP-003`, naming the cap |
| A named `documentId` that is not this client's / not Published / outside the period | **400** `NT-VAL-001` with one `errors` entry per id, and **nothing is written**. The contract's own rule: *"refused rather than silently skipped — a short export file that looked complete is the failure this whole surface is designed against"* |
| `periodEnd` before `periodStart` | 400, before anything is read |
| Same `Idempotency-Key`, different payload | 409 `NT-IDM-001` |

The three reasons a named id is refused are **not** distinguished in the message, on
purpose: telling them apart would answer "does this id exist somewhere else".

### What did not travel is reported, never dropped

Three sources of `ExportWarning` are merged onto the response and stored on the row:
`document-to-canonical.ts`'s refusals (a document missing a date, a total, a counterparty
or a category — none of which should reach PUBLISHED, and all of which are reported rather
than assumed away), the emitter's own (`analysis-collapsed`, `source-link-missing`,
`long-numeric-token-broken`, `analysis-account-unprefixed`), and the bundle's
(`source-document-unreadable`, `source-document-hash-mismatch`). A document with no link
keeps its row and is left out of the bundle; it is **not** warned about twice, because the
emitter has already raised `source-link-missing` for the same fact.

### ⚠ Three compromises `prisma/` forced, written down rather than hidden

`exports` is LAW and A9 does not open a contract-change issue for it, so:

1. **`documentCount` and `warnings` have no columns** and live in `exports.filters`, with
   `bundleS3Key` beside them because `s3_key` is singular and an export produces **two**
   artefacts. `ExportFiltersRecordSchema` parses it on the way out and a row that does not
   parse degrades to "nothing extra recorded" rather than felling a page of history.
2. **`file` and `bundle` are `null` on `GET /exports`.** `FileAccess.expiresAt` is "minutes
   away, not hours" by contract, so a row from last week has no live URL and inventing one
   that 403s at the storage host is worse than the honest null. Re-downloading is a new
   `POST` over the same period, which reuses the same capability codes and therefore
   produces a file the accountant's saved VT conversion table still matches.
3. **The two artefacts land under `w/<businessId>/documents/<sha256>`**, because
   `DocumentStore.put` derives the key itself and has no `putAt(key, bytes)` —
   `ingestion-routing/storage/` was outside A9's owned paths. Still under `w/` (the staging
   IAM policy grants nothing else), still naming the business, still content-addressed.

**The idempotency store is `InMemory` and per-process** (there is no durable one anywhere,
and no table, because `prisma/` is LAW). Behind more than one API task a replayed key can
land on a task that never saw it and generate the file twice. That fails in the safe
direction *here* — a second `exports` row and no document state change — which is exactly
why this surface can live with a gap a publish could not.

## The seam A8 left filled, and how A9 uses it

`CanonicalSourceLink { code, url }` in `canonical/canonical-row.ts` was A7's seam, A8 fills
it and A9 calls it once per batch:

```ts
const links = await documentLinkService.linksFor(ctx, documentIds); // Map<documentId, link>
const rows = documents.map((d) => ({ ...canonicalRow(d), sourceLink: links.get(d.id) ?? null }));
```

⚠ **`ExportsApiModule` imports `CapabilityLinkModule` rather than building a second
`DocumentLinkService`**, and that is not tidiness: the minter reuses a document's live link
instead of issuing a new one, so two instances would be two things holding one invariant and
the failure would surface as a customer's import going manual, months later.

- **`code` AND `url` both → Column B (`Paid to/invoice details`)**, in `detailsCell()`,
  with the reference and `VT_PROVENANCE_TAG`. There is one free-text column now, not two —
  `entryDetailsCell()` and `transactionNotesCell()` are gone. The code is still
  schema-enforced to contain a letter, because VT type-guesses a letterless one into a
  number.
- A row whose document was invisible, unrouted or absent gets **no** entry in that map and
  therefore still raises `source-link-missing`. Keep that: an export that is quietly
  linkless is the D43 failure this surface exists to prevent. Do not substitute a
  placeholder to make the warning stop.
- `linksFor` is capped at `MAX_LINKS_PER_CALL` (500) and refuses beyond it with the
  contract's own `NT-EXP-003`, so A9's batch cap and this one are the same number.

For rung 4, `buildSourceDocumentBundle({ documents, readBytes })` returns the ZIP plus its
own warnings; hand it the config-selected `DocumentStore` as `{ read: (k) => store.get(k) }`.

✅ **A10 answered the measurement, and the answer was better than the design assumed.**
The full URL is 31 characters before the code (`https://neoacc.neovogent.com/d/`), which is
why D43 was built as a ladder. But the journal import has **no `Transaction notes` column
at all**, so rungs 1 and 3 had to collapse into `Paid to/invoice details` — and that field
took a **104-character value untruncated**, code and full URL together. The 25/30-character
truncation the ladder was designed around belongs to VT’s *reference* fields, not to this
one. `capability-url.test.ts` still pins the 31-character measurement; what changed is that
it no longer forces a split across two columns.

## Decisions made here, with their reasons

- **~~One nominal per row: collapse, do not split~~ — REVERSED by A10.** VT imports a split
  analysis; Column E documents it and a two-nominal invoice was observed posting correctly.
  The emitter writes **one row per analysis line** and `collapseAnalysis()` is gone. The old
  reasoning — that splitting would create several transactions and misstate the creditor —
  was a guess, and it was wrong.
- **Amounts are unsigned in the VT file.** Still true, but no longer *because of* `Type`,
  which does not exist in this format: direction comes from the data format the accountant
  picks, which is why the archive separates purchases from sales.
- **~~`Ref no` is left blank~~ — moot.** There is no `Ref no` column. The reference travels
  in Column B with the capability code and the URL.
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

- [x] **A8** — the capability token, `GET /d/{code}`, revocation on the Approve path, and
      the manifest + ZIP bundle. All four D43 rungs. **No new dependency was taken**: the
      ZIP writer is `bundle/zip.ts`, STORED-method only, and its tests read the archive
      back with an independent parser.
- [ ] **A8 follow-ups that need a path outside this module** — the three in
      "⚠ Three things A8 could not fix": `trust proxy` in `main.ts`, and the
      `CAPABILITY_LINK_ORIGIN` / `CAPABILITY_LINK_RATE_LIMIT` keys in `config/env.ts`.
      The trust-proxy one is the only one that is a real weakening today.
- [ ] A shaped review card for `document.revoke-link`. `approvals/render-summary.ts` falls
      back to naming every payload member, so a reviewer sees the id list and the reason —
      correct, but the contract asks for *"revoke the eleven links in January's export"*.
- [ ] A per-IP **miss** counter on `/d/{code}` (a third scope in `link-rate-limit.ts`).
      Legitimate traffic almost never 404s and a brute force is 100% misses, so it is the
      sharper control. Not load-bearing at 40 bits; worth having if the code ever shortens.
- [x] **A9** — the HTTP surface (`listExports`, `createExport`) in `api/`, plus the export
      screen in `apps/web/src/views/ExportView.tsx`. `app.module.ts` registers
      `ExportsApiModule` beside `CapabilityLinkModule`. Synchronous generation, capped at
      500, no worker and no `QUEUED`. Proven against a real database
      (`api/exports.integration.test.ts`, prefix `a9x_`, cleanup by explicit id list).
- [x] **The screen is REACHABLE** (28 Aug 2026). The four lines A9 could not write —
      a `lazy()` + `case 'Export':` in `App.tsx`, `'Export'` in `SIDEBAR_TABS`, and a
      `Download`-icon nav entry in `Sidebar.tsx` and `BottomNav.tsx` — landed once those
      files had no open PRs against them. `/export` no longer resolves to the AI
      Workspace, and `ExportView` is in the build graph: 4.80 kB gzip on its own chunk,
      floor +0.2 kB, worst route 245.8 kB against the 250 kB budget.
- [ ] **Three columns on `exports` would retire the `filters` compromise** —
      `document_count`, `warnings jsonb`, and a second key for the bundle (or an
      `export_artefacts` child). A contract-change candidate, not taken here.
- [ ] **A dedicated `exports/` object prefix.** `DocumentStore` has no `putAt(key, bytes)`,
      so an export CSV and its ZIP land under the business's `documents/` prefix. Harmless
      (content-addressed, still under `w/`), but it is not what that prefix means.
- [ ] **A durable idempotency store.** The in-memory one is per-process; see the note above
      for why this surface can live with that and a publish could not.
- [x] **A10** — settled, and it rewrote the target rather than two constants. See the
      section above. Click-through is **still unconfirmed**, so rung 4 stays shipped.
- [ ] **The £0.00 split line.** Try the designer’s "Repeated columns" range — several
      analysis triplets on one row would remove the artefact entirely.
- [ ] **`ExportWarning`’s description in `openapi.yaml` is now wrong** — it cites
      `analysis-collapsed` and states "VT accepts one nominal per row". The G7 ceremony was
      retired on 1 Sep 2026, so this is now just an unclaimed edit rather than a blocked
      one. The `code` field is a free string, so the new codes
      (`split-analysis-zero-line`, `credit-note-direction-unverified`) are already legal.
      ⚠ The neighbouring **`POST /exports` `file` description was the same class of stale
      A10 claim** ("the Universal Input Sheet layout… VT derives debit and credit from
      `Type`") and **was corrected on 2 Sep 2026**; this one is what is left.
- [ ] Bank lines still ride the general UIS layout. §24.3.1 notes VT has a dedicated
      bank-statement import mode (Date / Description / Payment / Receipt); that second file
      is not built, and bank statement extraction is on the launch plan's cut list.
- [ ] The public REST API and signed webhooks are **v1, not ID** (§24.6). Do not build them.
- [ ] Update this file on exit — it is how the next session picks up.

## ⚠ "Nothing to export" was a dead end, and the code was never the bug (2 Sep 2026)

Reported from the live app. A practice had exactly one Published document —
supplier *Nexora Solutions LLC*, **dated 12 May 2025**, $54,352.51 — and the
export screen, on its default period of **01/08/2026 – 31/08/2026**, answered:

> `NT-EXP-001` — No documents reached Published in 01/08/2026 to 31/08/2026 for
> this client.

The owner read that as *"published, but it will not export"* and concluded the
feature was broken. **It was not.** `selectDocuments` filters on `documentDate`,
May 2025 is genuinely outside an August 2026 window, and every line of it was
correct. What was wrong is that the refusal told the one person who could fix it
nothing they could act on — no count, no dates, no hint that the document existed
just outside the window.

**The filter did not change, and must not be changed casually.** Selecting on the
document's own date is the accounting answer (an invoice belongs to the period it
is dated in), it is what makes re-exporting a closed month reproducible, and it is
what the VT journal import needs, since VT applies one date to a whole file
(§24.3.1). It is now **stated in the contract** on `ExportRequest.periodStart`,
where it previously was not stated anywhere — that silence is what let the
ambiguity live.

What changed instead:

| | |
|---|---|
| `nothingToExport()` | Builds the refusal. Two sentences: what is true, and what to do. |
| `publishedOutsidePeriod()` | One `aggregate` — count, `_min`, `_max` — through **the same `scopedDb`** as the export. |
| `publishedWhere()` / `periodWhere()` | The predicate, split so the export's selection and the refusal's count **cannot drift**. The count is `publishedWhere` + `NOT periodWhere`, so it is literally the export's own query with the date clause removed. |
| `Problem.publishedOutsidePeriod` | The contract's one RFC 7807 extension member. The web renders it and offers the period as a button; it computes nothing. |

**Three deliberate silences.** Zero outside the period sends no extension at all
(an always-present one makes its absence meaningless). A count whose documents
are all UNDATED sends none either — there is no period a widening could reach, so
naming one would be inventing it. And a named `documentIds` set narrows the count
to those ids, so the fact can never become an oracle for "does this id exist
somewhere else?" — though in practice `assertEveryNamedIdSurvived` refuses first.

⚠ **Do not let the web compute this.** The exporter is the only thing that knows
its own predicate; a second query in the browser could disagree with it and would
be a second read of a client's records written by someone not looking at this
file. That is why the fact rides on the refusal rather than on a new endpoint.

Pinned in `api/exports.service.test.ts` (the sentence, the extension, the three
silences, and that the aggregate's `where` carries the export's own clauses) and
in `api/exports.integration.test.ts` — which also proves the reported dates are a
period that **actually works**, and that the count cannot cross a practice.

## ⚠ Trash cannot enter an export selection (3 Sep 2026)

Soft delete (`documents.deleted_at`) landed with this module fenced off.
`publishedWhere()` now spreads `notDeleted()` from
`common/documents/deleted-documents.ts` — the one place "deleted" is spelled,
never an inline `deletedAt: null`.

⚠ **`state: 'PUBLISHED'` does not save this query.** Deletion is a **timestamp,
not a `DocumentState`**, so a Published document keeps its state when it is
deleted and would otherwise walk straight into a file an accountant hands to a
client.

**The predicate belongs in `publishedWhere()` and not in `selectDocuments`, and
that is the whole reason that function exists.** Two callers read it and they
must count the same set:

- `selectDocuments` — the export's actual selection.
- `publishedOutsidePeriod` — the `NT-EXP-001` diagnostic's count **and** its
  `_min`/`_max` period-widening bounds.

Filtering only the selection would have made this the worse bug rather than
fixing one: the refusal would say *"there are 3 Published documents outside that
period, widen it to include them"*, the accountant would widen it exactly as
instructed, and the export would come back empty again — with the suggested
bounds having been read off a document that can never be selected. **A
diagnostic that counts a set its own selection cannot reach is advice that
cannot be followed**, which is the failure the 2 Sep "Nothing to export" work
existed to end.

`assertEveryNamedIdSurvived` inherits it too, and that is right: a caller naming
a deleted document's id is **refused** with the existing "not exportable"
message rather than having it silently dropped from a file that would then look
complete (§24.3.4).

⚠ **`GET /d/{code}` is deliberately NOT filtered.** D43 requires every exported
transaction to carry a resolvable link to its source, and an accountant holding
that URL inside their own ledger must not be affected by housekeeping they
cannot see. Deletion is reversible and `document.purge` already refuses a
document that appears in any export, so the link cannot outlive its target.

`exports.service.test.ts` pins it as an identity — everything but the date clause
must be common to the selection and the diagnostic — so a future clause added to
one and not the other fails there too.

## The entry preview — `previewEntries`, and why it cannot drift (2 Sep 2026)

*"Before publishing show the accountant the actual accounting entry that will be
put into the VT software."* The publish review used to show a count and two
totals; an accountant approving a release was authorising rows they had never
seen, which is the exact failure Review → Approve exists to prevent.

`ExportEmitter` gained **`previewEntries(rows): ExportEntryPreview`**, and
`api/entry-preview.ts` composes `documentToCanonicalRow` + `selectEmitter` into
`previewExportEntries(target, documents)` — the one name on the seam that
`modules/approvals` uses.

⚠ **The contract on `previewEntries` is stronger than "returns a preview": an
implementation must build its rows with the same FUNCTION `emit` builds them
with.** In the VT emitter that is `buildVtFiles`, which now returns rows tagged
with their `documentId`; `emit` serialises those rows and `previewEntries`
regroups them, and neither transforms a cell. The generic CSV emitter has the
same split (`buildGenericRows`). A preview that merely *described* the file would
pass every test written about it and still be wrong — so
`vt-transaction-plus-emitter.test.ts` emits the real archive, **parses the bytes
back out of the ZIP**, and compares cell for cell in both directions. That test
is the guard that survives a refactor.

## The Analysis account — what the preview exposed, and the fix (2 Sep 2026)

**The defect.** `documentToCanonicalRow` passed `documents.category_code`
**straight into** the VT `Analysis account` column, so an accountant's import
file carried a bare `SUBSCRIPTIONS` where VT Transaction+ wants the
ledger-prefixed `Cost of sales: Purchases`. VT's format designer type-guesses
each cell, so a bare *numeric* code (`5001`) arrived as the NUMBER `5,001.00`
rather than an account, and a lettered one still had to be hand-mapped in VT's
Converter on every import. `rules-suggestions/index.ts` has named this exact
consumer on its seam since A6 — *"map a document's `categoryCode` with
`resolveAccount` + `analysisAccount`, or read the ready-made `{ code, name }`
pairs off `ChartOfAccountsService.getChartOfAccounts(...).categories`"* — and
nothing called it. A previous agent found it and deliberately left it, because
changing what an exported file contains is a correctness decision rather than a
refactor. It is now fixed.

**Where it resolves, and where it must not.** Resolution happens **where the
rows are assembled** — `api/document-to-canonical.ts`, which takes the chart as
a third argument — and **never inside an emitter**. `buildVtFiles` is still a
pure function over canonical rows with no idea a chart exists; giving the writer
a database read would have put the file's contents behind a query that
`previewEntries` would then have had to make too, which is exactly how the
preview and the file come apart. Two callers hand the chart in:

- **`api/exports.service.ts`** — one `getChartOfAccounts` per export, before a
  single row is built, through the `ChartOfAccountsReader` port that
  `ChartOfAccountsService` satisfies structurally. `api/exports.module.ts`
  imports `RulesSuggestionsModule` and injects `CHART_OF_ACCOUNTS_SERVICE`; the
  seam is the only thing this module names.
- **`approvals.module.ts`** — the composition root, for the publish review card.
  It resolves against the batch's own client *inside the executor's own
  transaction* (`ChartOfAccountsService.resolve` takes a `ScopedClient` for
  exactly this), so the chart and the documents are one read at one moment.
  `ExportEntryPreviewer` became async and takes that client for this reason.

`api/analysis-account-chart.ts` is the handshake: `{ code, name }` pairs in, a
`ReadonlyMap` out. `name` is **already** the emittable form — `analysisAccount()`
in `rules-suggestions` is the one place `Ledger: Account` is joined, and nothing
here splits, re-cases or rebuilds it, because VT's Converter saves the
accountant's mapping against the exact string it was given.

**⚠ When it cannot resolve, the answer is the bare code AND a warning.** Three
answers were available and two are worse. *Guessing* a ledger for an off-chart
code puts a wrong nominal in somebody's books (§24.4.6 ranks that above every
other coding error), and there is no near-miss matching — exact code or nothing.
*Refusing* the document drops a row an accountant asked for, and a short file
that looked complete is the failure this whole surface is designed against
(§24.3.4) — worse here, because `documents.category_code` is free text in the
schema and an accountant's own explicit rule may legitimately name a code the
chart does not carry. So the row travels with exactly what the column held and
the emitter raises `analysis-account-unprefixed` against that document. That
warning is on the export's warnings panel **and on the publish review card**, so
it is met before the release rather than inside VT afterwards.

A chart that cannot be read at all degrades the same way — every row keeps its
bare code and every one of them warns. A picklist is not worth making a client's
month unexportable over, and D42 makes this the only egress there is.

**`sourceLink` is null in a preview, deliberately.** The D43 capability code is
minted by the export, later, against a document that has already reached
PUBLISHED. Minting one here would be a write on a read path and inventing one
would put a string on a review card that resolves to nothing — so the emitter
does exactly what it does for any linkless row, raises `source-link-missing`, and
the card carries that warning. It is now the **only** column that differs from
the final file, and the one the preview declares it does not yet know.
