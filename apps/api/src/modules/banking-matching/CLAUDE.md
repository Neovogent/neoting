# banking-matching

**Lane F** · **Source of Truth:** SoT §4 Stage 7 · **Built by:** METH S11 · **Contract:** `GET /v1/bank-transactions`

## Purpose

TrueLayer feeds, statement import, the normalised transaction schema, the match engine, cash coding, and chase-suppression descriptors.

## ⚠ Initial Delivery (ID) — read this before the sections below

**D40 supersedes D4 for ID: manual statement upload is the ONLY bank input** (SoT §24.2 Stage 7). No TrueLayer, no consent lifecycle, no 90-day reconfirmation, no feed normalisation in the first client release.

- **Statement import is not the fallback here — it is the product.** The invariant below still reads “statement upload is the fallback that means books never stall”. In ID it is the *only* path, which raises the stakes on everything downstream: a transaction the extractor drops is a document that is never chased, and nothing else will catch it.
- **D41 makes that a hard gate, not a confidence score.** Statement extraction must prove completeness: balance continuity to the penny, page accounting, date monotonicity, in-statement dedupe, and cross-statement period-gap detection. A statement with no running-balance column is a **distinct reduced-assurance class**, not a silent pass. Accepted formats are PDF, CSV and XLSX, uploadable by accountant *and* client, per client, per period.
- **The normalised `bank_transactions` schema stays exactly as it is.** It is what the statement extractor targets, and keeping it is precisely what makes TrueLayer a later addition rather than a later rewrite.

D4 stands unchanged for v1.

**Built today: the read surface only.** One GET over the normalised
`bank_transactions` schema. The *write* half of matching lives on the Review →
Approve spine as the `bank.confirm-match` executor — in
`validation-dedupe/proposals/confirm-match.ts`, beside the other ten, because
that is where the registry composes them.

## Contracts it must honour

- `packages/contracts` — endpoints, DTOs and error codes (**LAW**, G7)
- `prisma/` — schema and RLS policies (**LAW**, G7)
- `packages/validators` — deterministic validator config where this module validates

Changing any of those is a contract-change issue approved by Shakib **before** a PR opens. Code follows contracts; contracts never follow code.

## Invariants

- Matching links documents to existing transactions — it never creates transactions. Statement upload is the fallback that means books never stall.
- Every Prisma query goes through `scopedDb(ctx)` — an unscoped query is a tenancy leak (Governance §5.2).
- Money is integer pence. No floats, ever.
- Every state change creates an `ActionProposal` and executes only after a human Approve (Governance §10). No side-effect path may exist outside it.
- Zod at every boundary; external content wrapped in `<untrusted_content>` before any model sees it.
- Audit events emitted for every new state change.

## Current state — the read surface (METH S11)

`GET /v1/bank-transactions` — the normalised feed, newest booked first,
`x-nt-side-effect: none`.

- `bank-transactions.controller.ts` — thin: `coerceQuery` → `parseBoundary`
  against the generated `listBankTransactionsQueryParams` → **one** service
  call. `coerceQuery` first, because Express delivers every query value as a
  string and a once-given repeatable filter as a bare value, while the schema
  types `limit` as a number and `matchState` as an array — without it the exact
  call the Bank screen makes is a 400.
- `bank-transactions.service.ts` — one method, `listBankTransactions`, and **no
  method that writes**. That is structural, the same way `modules/documents`
  has no write: there is no `PATCH /bank-transactions/{id}` and none may exist,
  so the absence of a mutating method is the enforcement rather than a promise.
  A unit test pins the method list.
- `bank-transaction-response.ts` — the row → contract projection, in its own
  file so the second surface that needs it uses the same one.

Three decisions worth knowing before changing anything here:

- **The sort is a CONSTANT, not a lookup table.** `listBankTransactions`
  declares no `sort`/`order` parameter; the contract fixes the answer in prose
  ("newest booked first"). There is no caller-supplied column to validate, and
  offering one would be inventing contract surface. `nullable: false` on the
  `bookedAt` sort field is load-bearing — Prisma throws at runtime on
  `orderBy: { col: { sort, nulls } }` for a required column.
- **There is no hidden default filter.** `GET /documents` excludes ARCHIVED
  when `state` is omitted; this excludes nothing, because a bank feed has no
  archive and a transaction quietly missing from the screen is a
  reconciliation that silently never balances. An explicitly *empty*
  `matchState` array is treated as no filter — `{ in: [] }` matches nothing and
  reads on screen as "the feed is empty".
- **`chaseSuppressed` is read off the column, never recomputed.** The
  descriptor rules (SERVICE CHARGE, STRIPE PAYOUT…) belong to the chase lane; a
  second implementation on the read path is how the Bank screen and the chase
  list start disagreeing about which lines have paperwork to chase.

## Tenancy: RLS, and deliberately no second mechanism

Every query runs inside `scopedDb`. The `businessId` filter **narrows** a set
RLS has already bounded; nothing here adds a tenancy clause to *enforce* scope,
because a hand-written filter that disagreed with a policy would be the more
permissive of the two exactly when it mattered. A unit test asserts the `where`
clause is empty when no filter was asked for.

Asking for a business the caller cannot reach returns an **empty page** — not
404, not 403. The rows were already invisible, so the filter matches none of
them, and the answer never confirms whether that business exists.

## The unmatched set is the chase list's set

The contract says it in as many words: *"the unmatched set this returns is the
same set chase detection reads, so the Bank screen and the chase list can never
disagree."* Both read `match_state` and `chase_suppressed` off these rows.

That is why the confirm-match executor flips `match_state` and does not merely
write a `matches` row: a match recorded without the flip leaves the line in the
unmatched set, and the client is chased by SMS for the receipt the accountant
just filed. `bank-matching.integration.test.ts` asserts the disappearance
directly, against a real database.

## Tests

```bash
pnpm --filter @neoting/api test -- banking-matching            # unit, offline
# integration (needs docker compose up + .env): the METH S11 acceptance —
# the feed lists in pence newest-first; another practice sees an empty page;
# confirming persists across a fresh read and leaves the UNMATCHED set;
# a suggested pairing is PROMOTED not duplicated; cross-practice refusal.
```

⚠ The integration suite cleans by **explicit id list, never `startsWith`**.
Prisma compiles `startsWith: 'x_'` to `LIKE 'x_%'` without escaping the `_`,
which is LIKE's single-character wildcard — so a prefix cleanup silently
deletes another suite's fixtures. API test files run in parallel workers, so
that collision surfaces as an intermittent foreign-key violation in the *other*
file's `beforeAll`.

## Boundaries

Exposes **only** its public providers. There is no `index.ts` seam yet, and
that is deliberate: a module needs one when its first cross-module consumer
arrives, and nothing imports this module today. The `bank.confirm-match`
executor writes `matches` and `bank_transactions` through the engine's
`ScopedClient` directly, so it needs nothing from here.

## TODO

- [ ] **// DEMO-MOCK: TrueLayer.** No feed adapter exists. The seeded
      `bank_connections` row is presented as connected. The real
      implementation is a provider adapter behind a config-selected `BankFeed`
      seam (interface + fixture + real, chosen by CONFIG not import) writing
      the same `bank_transactions` rows this reads.
- [ ] **Contract change (Shakib, G7): `BankTransaction` carries `matchState`
      but not the id of the document that matched it.** The Bank screen needs
      it — `apps/web`'s local shape uses `matchedDocId` as a real key (one
      receipt may not answer two lines; `ClientApprovalView` looks a
      transaction up by it) — so today `apps/web` sets it to `undefined` for
      server rows and answers "is this matched" from `matchState` instead.
- [ ] `bank.unmatch` has no `ProposalKind`, so breaking a confirmed match has
      no approved path. The executor refuses rather than overwriting.
- [ ] **ID-critical** (D40/D41) — statement upload wiring with the completeness gates,
      cash coding, partial/batch payments
      server-side, consent lifecycle and configurable match windows — all
      explicitly out of METH S11's scope.
- [ ] Update this file on exit — it is how the next session picks up.
