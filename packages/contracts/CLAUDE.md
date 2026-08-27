# packages/contracts — **LAW** (Sprint-0 contract, G7/D15)

The OpenAPI spec is the **build-first contract**. Handlers are generated against it; they are never hand-drifted into agreement with it.

## What lives here

- `openapi.yaml` — the spec. The single description of every endpoint.
- Generated TypeScript client — what `apps/web` imports. Never hand-write an API type.
- Generated MSW mock handlers with fixtures shaped like the seed dataset.
- Shared Zod schemas used on both sides.

## Why frontend is never blocked

`VITE_API_ENABLED=true` plus `VITE_API_MOCKING=enabled` makes MSW intercept everything (the flags `apps/web/src/api/config.ts` actually reads — `NEXT_PUBLIC_*` died with Next.js in D37 and is never defined in a Vite build). **The frontend starts building any screen the moment its contract exists** — days before the endpoint does. When the contract changes, regeneration breaks the build loudly. That is the system working, not a problem to route around.

## Rules

- Changing anything here needs a **contract-change issue approved by Shakib before the PR opens** (G7). Contracts move first, code follows.
- After the Day-1 freeze, changes **batch at day boundaries** and both sides regenerate in one PR. An unbatched contract change is an R10 reject.
- Every drift fix flows *through* the contract. A hand-patched type is why integration takes a week instead of two days.
- REST under `/v1`, kebab-case, cursor pagination, `Idempotency-Key` on every mutation, RFC 7807 `problem+json` errors with stable `NT-` codes (Governance §3).

## Conventions this spec commits to

Four decisions are load-bearing. Change them and every consumer moves, so they are recorded here rather than left to be inferred from the YAML.

**1. Resources are flat; `businessId` is a filter, not a path segment.**
`GET /documents?businessId=…`, never `/businesses/{id}/documents`. Cross-client questions ("which clients have 10+ missing documents", SoT §5.4) are first-class, and nesting would force a second top-level endpoint to answer them — a second door for the same resource. The tenancy boundary is RLS, not the URL. A `businessId` the caller cannot reach returns `404`, never `403`: `403` would confirm the record exists.

**2. Every operation declares `x-nt-side-effect`.**
`none` · `ingest` · `proposal` · `execute`. Governance §10.6 requires an architectural test that walks the route table proving no side-effect endpoint exists outside the Review → Approve contract. That test reads this field, so it can be mechanical instead of a prose promise. **Exactly one operation in the whole API may ever carry `execute`** — `POST /action-proposals/{id}/approval` — and the contract checker fails the build if a second appears.

**3. Mutations are proposals, uniformly.**
There is no `PATCH /documents/{id}`. Confirming a document's coding is named in SoT §8.2 as a state change, so it is `document.update-coding` like everything else. Retry, reject, move, split and archive are batched kinds taking `documentIds[]` — the review card for "retry 43 extractions" is more useful than 43 separate approvals, and it keeps the bulk path and the single path identical.

**4. Approval echoes the rendered hash.**
`POST .../review` returns `renderedSummaryHash` and records it. `POST .../approval` requires the caller to send it back. If the underlying facts move in between, the hashes diverge and the approval is refused with `NT-PRP-004` — the human re-reads rather than approving something they never saw. This is what makes "what was approved is what was shown" provable instead of asserted.

## Provenance is contract, not presentation

SoT §13.3 makes the provenance class **visible by default** — human-confirmed · deterministic · AI-suggested with confidence. A UI cannot display what the API does not send, so every extracted value is an `ExtractedField` carrying `provenance`, `confidence`, `source` and `boundingBox`. A bare value is not a valid extraction response. `boundingBox` is what makes the editable-OCR overlay possible: the client taps the wrong number on the image and fixes it in five seconds.

## Codegen

`pnpm --filter @neoting/contracts generate` — or just `pnpm build`, which the turbo graph wires up for you.

```
openapi.yaml ──orval──┬─> src/generated/client/   TanStack Query hooks + MSW handlers   -> apps/web
                      ├─> src/generated/model/    TypeScript types for every DTO        -> both
                      └─> src/generated/zod/      strict Zod schemas                    -> apps/api + apps/web
```

The generate script chains four post-steps, each verified by `check-contract.mjs` so none can be skipped silently: `enforce-money-int` (`.int()` on `*Pence`), `strip-zod-describe` (spec prose out of the browser bundle — see the bit list below), `add-js-extensions` (Node-resolvable specifiers), then the checker itself.

Import by subpath — `@neoting/contracts/zod`, `/model`, `/client` — so `apps/api` never drags React Query and MSW in behind the schemas it actually wants.

**The generated tree is untracked and gitignored — since issue #90, and not before.** Governance §1.4 says never commit generated output, and `.gitignore` said so too, but the 159 files under `src/generated/` were tracked before that rule landed and an ignore rule has no effect on already-tracked paths — so for a while this paragraph was a lie the repo told itself: a fresh clone got the tree from git, where a stale commit could silently disagree with `openapi.yaml`. #90 untracked it. Now the only way the tree exists is `pnpm build` producing it: `packages/contracts/turbo.json` makes `build` generate it, and `typecheck`/`test` depend on `build` through the root graph (`dev` does **not** — a bare `pnpm dev` on a cold clone needs one prior `pnpm build`). CI stage 5c fails the build if any file under `src/generated/` ever becomes tracked again.

### Three things that bit, recorded so they don't bite twice

**orval does not honour `type: integer`.** It emits a bare `zod.number()` — with or without `format: int32`, measured on v7.21, not assumed. That would let `totalPence: 12.34` through a boundary, which is R5 under the most-guarded invariant in the codebase. `pnpm generate` therefore chains `scripts/enforce-money-int.mjs`, which puts `.int()` back on every `*Pence` field, and `check-contract.mjs` fails the build if that step is ever skipped. **Do not run bare `orval` and commit the result.** If orval ever learns to do this itself, the script becomes a no-op and can be deleted — the check is what makes that safe to notice.

**`exactOptionalPropertyTypes` is off in this package, and only here.** orval's MSW fixture generator emits `{ min: undefined, max: undefined }` and assigns `T | undefined` into required-but-nullable properties. The base config turns the flag on deliberately, so this is a real loss, confined to a package whose hand-written surface is about 150 lines. **`apps/web` will meet the same wall** when it imports the handlers as workspace source: decide it there — match this setting, or exclude `**/*.msw.ts` from its typecheck and keep the flag on for its own code. Do not inherit it silently.

**`query.signal` is off.** It is shaped for orval's axios client, where the second argument is a config object carrying `signal`. With `httpClient: 'fetch'` orval emits `getThing(id, signal)` against a mutator whose second parameter is a `RequestInit`, and the generated file does not typecheck. Callers wanting cancellation pass `{ signal }` as the options argument; `ntFetch` spreads it onto the request.

**orval copies every spec `description` into the generated Zod as `.describe('…')`, unconditionally.** No option turns it off (measured on v7.21). The descriptions are this contract's design prose — multi-paragraph notes on `ProposalKind` and friends — and Zod stores them as metadata nothing in this repo reads, while `apps/web` ships the schemas it parses responses with: METH S12 measured ~10 kB gzip of spec prose sitting on the bundle floor of every route. `pnpm generate` therefore chains `scripts/strip-zod-describe.mjs`, and `check-contract.mjs` fails the build if any generated Zod file still carries a `.describe(`. The prose survives where it is read — `openapi.yaml` itself and the JSDoc on `model/`.

**`allOf` + `.strict()` emits an intersection that rejects every input.** Both halves are `.strict()`, so each rejects the other's keys — the generated whole-schema parse can never succeed for a composed type. Known consumers work around it by parsing the halves separately: `apps/api/src/modules/approvals/proposal-body.ts` (the original discovery, for `CreateActionProposalRequest`) and `apps/web/src/api/chases.ts` (`Chase = ChaseSummary & {items, messages}`, hit in METH S12). Both pin the gap with a test so an orval fix surfaces as a deletable workaround, not a mystery.

## The contract checker

`scripts/check-contract.mjs`, run by `pnpm lint` and again at the end of `pnpm generate`. Every rule below has been negative-tested — each one was deliberately broken and confirmed to fail the build, rather than assumed to work:

| Assertion | Rule it enforces |
|---|---|
| Spec parses; every `$ref` and discriminator mapping resolves | — |
| Enums match `prisma/schema.prisma` **verbatim** | The schema is LAW; drift here becomes a frontend bug in week 6 |
| No `*Pence` field is a float, and each carries `x-nt-money` | R5, Governance §1.7 |
| Generated Zod has `.int()` on every money field | R5 at runtime, where it actually matters |
| Every operation declares a valid `x-nt-side-effect` | Governance §10.6 |
| **Exactly one** operation is `execute` | The Review → Approve guarantee, as an assertion |
| Every mutation takes an `Idempotency-Key` | Governance §3 |
| No list uses offset pagination; every list returns `pageInfo` | Governance §3 |

It depends on `js-yaml` and nothing else, on purpose: it has to run before the codegen toolchain does, so it cannot depend on it.

## Current state

**Pass 1 drafted — NOT frozen.** `openapi.yaml`, 40 operations, 97 schemas, covering:

| Surface | Operations |
|---|---|
| Documents | list · get · original-url · processing log · extraction history |
| Ingestion | upload intent · upload complete · WhatsApp webhook verify + receive |
| Review → Approve | create proposal · get · review · approve · cancel · **list** (METH S12 #140 — the approval queue; sign-off recorded on the issue) |
| Auth (minimal, METH Stage 1 #118) | login · logout · `GET /me` |
| Chases (METH Stage 2 #120) | list · get · SMS outbox (`x-demo: true`) |
| OTP portal (METH Stage 2 #120) | create session · context · delegated upload intent |
| Publishing (METH Stage 2 #120) | list publishes |
| Banking (METH Stage 2 #120) | list bank transactions |
| Businesses (METH Stage 2 #120) | list with waiting-work counts |
| Practices (ID LAW batch) | signup |
| Clients & team (ID LAW batch) | create client · list members · invite member |
| Export (ID LAW batch) | list · create · resolve capability link |
| Billing (ID LAW batch) | checkout session · customer-portal session · Stripe webhook |
| Portal onboarding (ID LAW batch) | request sign-in code · open onboarding session |

The auth trio is the demo-spine slice of pass 2, pulled forward under the
standing approval in METH_MODE §3.1: one stateless cookie session, the §13.3
context header, and a new `NT-AUTH-003` (one code for every login failure — an
enumeration oracle otherwise). Login and logout are `x-nt-side-effect: none`
**deliberately**: a stateless cookie changes no product state and creates no
record, so they need no `Idempotency-Key` and sit legitimately outside Review →
Approve. `WorkspaceRole` joined the prisma-mirrored enum list in
`check-contract.mjs`. The REST of pass 2 (memberships, invites, session
management) is still to write.

**METH Stage 2 (#120) — the demo contract pass.** The demo-spine slices of
passes 3–4, frozen in one PR so the rest of the push implements against a fixed
surface. What it decided, beyond the table above:

- **`ProposalKind` gained `chase.send`, `publish.batch`, `bank.confirm-match`
  and `rule.create` — with NO Prisma migration, deliberately.** METH_MODE §3.2
  pre-approved "additive enum values", but `action_proposals.kind` is `TEXT`
  in the schema, not a Postgres enum, so there is nothing in prisma to add to
  and the checker comment in `check-contract.mjs` records why `ProposalKind`
  is absent from `MIRRORED_ENUMS`. The enforcement points are the contract
  enum (`NT-PRP-001` at the boundary) and the executor registry's mapped type
  in `apps/api`, which is total over the enum — all four kinds are registered
  there as `ProposalNotImplementedError` stubs until stages 8/10/11/13 land
  executors. Each kind has a typed payload in the discriminated union.
- **Seven enums joined `MIRRORED_ENUMS`:** `ChaseDetectionEngine`,
  `ChaseState`, `MatchState`, `MatchKind`, `PublishMode`, `PublishState`,
  `RuleTier`.
- **Portal uploads complete through the existing
  `/document-uploads/{uploadId}/complete`**, which now also accepts the
  `portalSession` bearer — one completion path at two trust levels, no second
  door; RLS keeps a delegated session inside its own grant.
- **`x-demo: true`** marks demo-only operations (today: `GET /sms-outbox`,
  the dev "phone screen"). Everything else added is real product surface.
- **New error codes:** `NT-OTP-001` (portal link/OTP failed, one code — the
  NT-AUTH-003 stance), `NT-OTP-002` (portal session stale), `NT-PUB-001`
  (item missing mandatory fields refuses the publish batch).

Every shape derives from the applied Prisma schema. Enum values are copied verbatim and drift is checked mechanically, not by eye.

**The ID LAW batch (launch stage S0, issue #164)** — one contract-change issue, one
approval, one migration, one PR, for the whole of Initial Delivery's contract
need. Batched deliberately: three people block on this file, and the four
surfaces below would otherwise have been four separate blocks. Twelve
operations, thirty schemas, five error codes, one `ProposalKind`.

| Surface | Operations |
|---|---|
| Practices | `POST /practices` — signup, and the only door a tenant that does not yet exist can come through |
| Clients & team | `POST /businesses` · `GET`+`POST /businesses/{businessId}/members` |
| Export (D42/D43) | `GET`+`POST /exports` · `GET /d/{code}` |
| Billing (D48) | `POST /billing/checkout-sessions` · `POST /billing/portal-sessions` · `POST /webhooks/stripe` |
| Portal onboarding (D47) | `POST /portal/sign-in-codes` · `POST /portal/onboarding-sessions` |

Three enums joined `MIRRORED_ENUMS`: **`IntegrationKind`** (the reason the list
earns its keep — its contents decide whether a document can reach Published at
all, and it was wrong), `ExportTarget`, `SubscriptionStatus`.

New error families: **`EXP`** (export and the capability URL) and **`BIL`**
(billing). Both have runbook entries in `docs/runbooks/error-codes.md`, per
Governance §13.4. Stripe's webhook signature reuses `NT-INT-001` rather than
minting a code — that family is exactly "inbound webhook auth".

**Five decisions in it worth knowing before reading the YAML:**

- **`POST /businesses`, not `POST /clients`.** The launch plan says "clients";
  the resource is the one `GET /businesses` already serves, `businessId` already
  filters on, and prisma already calls `Business`. "Client" is UI vocabulary. A
  second name for one resource is a second door — convention 1 above.

- **Signup answers `202` and says nothing.** Whether an email is already
  registered is not something an unauthenticated caller may learn; the
  verification mail is what distinguishes the outcomes. Same stance as
  `NT-AUTH-003`, and it is also exactly the flow A1 needs, since the account is
  unusable until the address is verified. `POST /portal/sign-in-codes` answers
  `202` for the same reason.

- **`POST /exports` is `ingest`, not `execute`.** The human authorisation lives
  at the Ready → Published transition, which is the super-admin act (D44); the
  export reads the result of it, creates one new record and changes the state of
  nothing. Exactly one operation may ever be `execute`, and the checker asserts
  it.

- **`GET /d/{code}` is served at the ORIGIN ROOT and is deliberately not
  generated.** The capability URL has to survive a ledger reference field that
  truncates silently at 30 and ~25 characters (SoT §24.3.2), and `/v1/` is three
  characters it cannot spare. orval ignores a path-item `servers` override
  (measured on v7.21) and `ntFetch` builds `baseUrl() + url` with `/v1` already
  inside `baseUrl()` — so a generated caller would request `/v1/d/{code}`, a URL
  nothing serves, failing as a 404 that reads like a missing document. The
  operation therefore carries its own `capability-links` tag, which
  `orval.config.ts` excludes from **both** projects. It stays declared here
  because it is real public surface the checker must see, and
  `apps/api/src/config/routing.test.ts` couples it to `UNVERSIONED_ROUTES` so
  the spec and the Nest prefix cannot drift apart silently.

- **`ProposalKind` gained `document.revoke-link`, with no migration** — the METH
  Stage 2 precedent, and for the same reason: `action_proposals.kind` is TEXT,
  so the contract enum is the only registry. Revoking a capability URL turns a
  working entry inside someone's ledger into a `410`, which is a real outward
  act and belongs on the proposal spine rather than behind a `DELETE`. It is
  registered as a `ProposalNotImplementedError` stub until A8 lands the
  executor; adding it later would have been a second LAW change for one enum
  value.

Two response fields were added **optional rather than required** on purpose —
`BusinessSummary.subscription` and `Document.links`. Both are contracted ahead
of the lane that populates them, and a required field would have obliged every
producer to move in this PR, which is scope this batch does not own.

**The signup chain (launch stage A14, issue #195)** — three operations, five
schemas, five error codes, one shared `409` response, **no Prisma migration**.
The ID LAW batch shipped `POST /practices` and METH Stage 1 shipped
`POST /auth/sessions`, and between them was a gap nobody had noticed was
load-bearing: signup minted an email-verification token **no operation
consumed**, and there was **no TOTP enrolment operation at all**. Under
`OTP_MODE=totp` — what staging runs — the second factor fails closed for an
account with no enrolment, so the contract described a product nobody could sign
in to.

| Surface | Operations |
|---|---|
| Auth (A14) | `POST /auth/email-verification` · `POST /auth/totp-enrolment` · `POST /auth/totp-enrolment/confirm` |

**Three decisions in it worth knowing before reading the YAML:**

- **`beginTotpEnrolment` is `x-nt-side-effect: none`, and that is a claim about
  the implementation.** It writes nothing: the candidate enrolment goes back to
  the caller as a signed short-lived `enrolmentToken` and is stored nowhere, so
  an abandoned attempt costs nothing. That is not an optimisation — writing at
  step one is what turned a single mis-scanned QR into a permanent lockout in
  the code A14 replaced. If it ever starts writing, the field is wrong and
  Governance §10.6's route-table test is what should catch it. It consequently
  takes **no `Idempotency-Key`**, which the checker agrees with.

- **`TotpEnrolmentConfirmRequest` carries `enrolmentToken`, which #195's sketch
  did not.** The issue's own binding constraint — *"the ref is persisted only
  after the user posts back a valid code"* — cannot hold with the sketched
  `{email, password, totp}` body: the candidate has to survive between two
  calls, and with no migration approved there is no column to hold it. The
  alternatives were storing it against the user (the lockout the constraint
  exists to prevent) or letting the client post the *seed* back (a
  caller-chosen secret). Flagged on #195 rather than done quietly.

- **All five codes join the `AUTH` family; none is collapsed and none is
  invented elsewhere.** `-004`/`-005` split invalid from expired exactly as
  `-001`/`-002` do. `-006`/`-007` are reachable **only after the password has
  verified**, so naming them answers nothing an unauthenticated caller could
  learn — which is what lets them be two actionable messages instead of one
  useless one. Runbook pages for all five, per Governance §13.4.

### Before this can freeze

1. **Shamim's list of the frontend's required API calls.** Freezing without it freezes the wrong shapes — this is the one input that cannot be derived from the schema.
2. ~~Shakib's provisioning-under-RLS decision~~ — **settled 14 Aug 2026**, and the ID LAW batch is the first surface to lean on it. `users`, `practices`, `memberships` and `sessions` carry no RLS, so `POST /practices` creates a tenant in one transaction with no bypass of any kind; the membership row exists before the first policed insert needs it. The reasoning and the live-database transcript are in `prisma/CLAUDE.md`. **That exemption is for provisioning and nothing else** — every subsequent query in the request is scoped to the practice just created.

### Still to write, in order

- **Pass 2 — auth-tenancy.** `GET /me` first: the §13.3 persistent context header (who am I, what role, which client) is a binding design mandate and no workspace screen is buildable without it. Then sessions and memberships.
- **Pass 3 — chase + OTP portal, the rest of it:** policy scheduler, item messaging, STOP handling. The demo slice (list/get/outbox, portal session/context/upload) landed with METH Stage 2. Add to the list: **`Chase.items` requires `minItems: 1`, but the projection can legitimately serve zero items** — a chase whose refs resolve to no transaction (seeded `chs_003`), and structurally any chase whose every item RLS withheld. The server currently emits a body its own contract refuses; the web degrades that row to its summary (METH S12). Either the constraint relaxes or the projection must never emit an item-less chase — Shakib's call. Still includes the open question flagged on `ProposalKind`: whether a client correcting a misread number on their own just-uploaded receipt goes through Read review → Approve. It reads like the wrong application of §8.2 — that pattern governs the accountant workspace, not a client in a car park — but it touches the enforcement path, so it is Shakib's call, not an agent's. (For the demo, METH Stage 9 records portal corrections as document events, settling nothing.)
- **Pass 4 — banking, matching, approvals, publishing, exports, public API, the rest of it:** consent lifecycle, statement upload, partial/batch payments, reference sync, workflow builder, exports. The demo read surfaces and the four proposal kinds landed with METH Stage 2.
- **Next-best-action surface** (§13.3 mandate 2) needs aggregate endpoints that do not exist yet.

### Known gap: the mocks are not seed-shaped yet

This file promises "MSW mock handlers with fixtures shaped like the seed dataset". They are not, yet. orval's faker output gives `supplierName: "kFmqxbTplR"` — structurally valid, and useless for judging whether a screen reads well. An inbox of random alphabet strings will not tell Shamim the Costs table is too dense.

The handlers already take an `overrideResponse`, so the fix is additive and does not touch generated code: a `src/fixtures/` module built from the same 40 documents, 3 clients and 26 bank lines as `prisma/seed.ts`, layered over the generated handlers. Worth doing before the frontend builds screens against them, not after.

### Single file, for now

The spec is one file while it is one surface. It splits into `paths/` + `components/` with a bundle step when it stops being readable — orval bundles `$ref`s across files, so the split is cheap whenever it is wanted.
