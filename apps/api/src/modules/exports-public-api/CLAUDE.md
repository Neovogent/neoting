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

- **`code` → `Entry details`**, in `entryDetailsCell()`. Schema-enforced: contains a
  letter, at most 20 characters (targets truncate silently at 30 and ~25).
- **`url` → `Transaction notes`**, in `transactionNotesCell()`, with the code and
  `VT_PROVENANCE_TAG`.
- A row whose document was invisible, unrouted or absent gets **no** entry in that map and
  therefore still raises `source-link-missing`. Keep that: an export that is quietly
  linkless is the D43 failure this surface exists to prevent. Do not substitute a
  placeholder to make the warning stop.
- `linksFor` is capped at `MAX_LINKS_PER_CALL` (500) and refuses beyond it with the
  contract's own `NT-EXP-003`, so A9's batch cap and this one are the same number.

For rung 4, `buildSourceDocumentBundle({ documents, readBytes })` returns the ZIP plus its
own warnings; hand it the config-selected `DocumentStore` as `{ read: (k) => store.get(k) }`.

⚠ **A measurement A10 should carry into the field:** the full URL is **31 characters before
the code** (`https://neoacc.neovogent.com/d/`). It does not fit a 25- or 30-character
reference field and never could. That is not a defect — it is why D43 is a ladder: the bare
**code** goes in `Entry details` (8 characters, fits anything), the **URL** goes in
`Transaction notes` (VT documents it as unlimited), and the **bundle** works when neither
does. `capability-url.test.ts` pins the measurement.

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
- [ ] **A9 left the screen UNREACHABLE, and it is one line in four of Mubasshir's files.**
      `ExportView` is written, tested and under 5 kB gzip on its own chunk, but `App.tsx`,
      `AppContext.tsx` (`SIDEBAR_TABS`), `Sidebar.tsx` and `BottomNav.tsx` are the shell and
      were outside A9's owned paths while he had open PRs in them. Until those four lines
      land the view is dead code and `/export` resolves to the AI Workspace. The exact diff
      is on the A9 PR.
- [ ] **Three columns on `exports` would retire the `filters` compromise** —
      `document_count`, `warnings jsonb`, and a second key for the bundle (or an
      `export_artefacts` child). A contract-change candidate, not taken here.
- [ ] **A dedicated `exports/` object prefix.** `DocumentStore` has no `putAt(key, bytes)`,
      so an export CSV and its ZIP land under the business's `documents/` prefix. Harmless
      (content-addressed, still under `w/`), but it is not what that prefix means.
- [ ] **A durable idempotency store.** The in-memory one is per-process; see the note above
      for why this surface can live with that and a publish could not.
- [ ] **A10** — settle the two constants above against a real VT on Windows, and confirm
      the click-through. If the URL is inert, rung 4 becomes the primary route.
- [ ] Bank lines still ride the general UIS layout. §24.3.1 notes VT has a dedicated
      bank-statement import mode (Date / Description / Payment / Receipt); that second file
      is not built, and bank statement extraction is on the launch plan's cut list.
- [ ] The public REST API and signed webhooks are **v1, not ID** (§24.6). Do not build them.
- [ ] Update this file on exit — it is how the next session picks up.
