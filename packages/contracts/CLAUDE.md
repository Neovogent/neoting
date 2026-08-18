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
                      └─> src/generated/zod/      strict Zod schemas                    -> apps/api
```

Import by subpath — `@neoting/contracts/zod`, `/model`, `/client` — so `apps/api` never drags React Query and MSW in behind the schemas it actually wants.

**The generated tree is untracked and gitignored — since issue #90, and not before.** Governance §1.4 says never commit generated output, and `.gitignore` said so too, but the 159 files under `src/generated/` were tracked before that rule landed and an ignore rule has no effect on already-tracked paths — so for a while this paragraph was a lie the repo told itself: a fresh clone got the tree from git, where a stale commit could silently disagree with `openapi.yaml`. #90 untracked it. Now the only way the tree exists is `pnpm build` producing it: `packages/contracts/turbo.json` makes `build` generate it, and `typecheck`/`test` depend on `build` through the root graph (`dev` does **not** — a bare `pnpm dev` on a cold clone needs one prior `pnpm build`). CI stage 5c fails the build if any file under `src/generated/` ever becomes tracked again.

### Three things that bit, recorded so they don't bite twice

**orval does not honour `type: integer`.** It emits a bare `zod.number()` — with or without `format: int32`, measured on v7.21, not assumed. That would let `totalPence: 12.34` through a boundary, which is R5 under the most-guarded invariant in the codebase. `pnpm generate` therefore chains `scripts/enforce-money-int.mjs`, which puts `.int()` back on every `*Pence` field, and `check-contract.mjs` fails the build if that step is ever skipped. **Do not run bare `orval` and commit the result.** If orval ever learns to do this itself, the script becomes a no-op and can be deleted — the check is what makes that safe to notice.

**`exactOptionalPropertyTypes` is off in this package, and only here.** orval's MSW fixture generator emits `{ min: undefined, max: undefined }` and assigns `T | undefined` into required-but-nullable properties. The base config turns the flag on deliberately, so this is a real loss, confined to a package whose hand-written surface is about 150 lines. **`apps/web` will meet the same wall** when it imports the handlers as workspace source: decide it there — match this setting, or exclude `**/*.msw.ts` from its typecheck and keep the flag on for its own code. Do not inherit it silently.

**`query.signal` is off.** It is shaped for orval's axios client, where the second argument is a config object carrying `signal`. With `httpClient: 'fetch'` orval emits `getThing(id, signal)` against a mutator whose second parameter is a `RequestInit`, and the generated file does not typecheck. Callers wanting cancellation pass `{ signal }` as the options argument; `ntFetch` spreads it onto the request.

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

**Pass 1 drafted — NOT frozen.** `openapi.yaml`, 26 operations, 67 schemas, covering:

| Surface | Operations |
|---|---|
| Documents | list · get · original-url · processing log · extraction history |
| Ingestion | upload intent · upload complete · WhatsApp webhook verify + receive |
| Review → Approve | create proposal · get · review · approve · cancel |
| Auth (minimal, METH Stage 1 #118) | login · logout · `GET /me` |
| Chases (METH Stage 2 #120) | list · get · SMS outbox (`x-demo: true`) |
| OTP portal (METH Stage 2 #120) | create session · context · delegated upload intent |
| Publishing (METH Stage 2 #120) | list publishes |
| Banking (METH Stage 2 #120) | list bank transactions |
| Businesses (METH Stage 2 #120) | list with waiting-work counts |

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

### Before this can freeze

1. **Shamim's list of the frontend's required API calls.** Freezing without it freezes the wrong shapes — this is the one input that cannot be derived from the schema.
2. **Shakib's provisioning-under-RLS decision** (`prisma/CLAUDE.md`), which the auth-tenancy surface in pass 2 depends on.

### Still to write, in order

- **Pass 2 — auth-tenancy.** `GET /me` first: the §13.3 persistent context header (who am I, what role, which client) is a binding design mandate and no workspace screen is buildable without it. Then sessions and memberships.
- **Pass 3 — chase + OTP portal, the rest of it:** policy scheduler, item messaging, STOP handling. The demo slice (list/get/outbox, portal session/context/upload) landed with METH Stage 2. Still includes the open question flagged on `ProposalKind`: whether a client correcting a misread number on their own just-uploaded receipt goes through Read review → Approve. It reads like the wrong application of §8.2 — that pattern governs the accountant workspace, not a client in a car park — but it touches the enforcement path, so it is Shakib's call, not an agent's. (For the demo, METH Stage 9 records portal corrections as document events, settling nothing.)
- **Pass 4 — banking, matching, approvals, publishing, exports, public API, the rest of it:** consent lifecycle, statement upload, partial/batch payments, reference sync, workflow builder, exports. The demo read surfaces and the four proposal kinds landed with METH Stage 2.
- **Next-best-action surface** (§13.3 mandate 2) needs aggregate endpoints that do not exist yet.

### Known gap: the mocks are not seed-shaped yet

This file promises "MSW mock handlers with fixtures shaped like the seed dataset". They are not, yet. orval's faker output gives `supplierName: "kFmqxbTplR"` — structurally valid, and useless for judging whether a screen reads well. An inbox of random alphabet strings will not tell Shamim the Costs table is too dense.

The handlers already take an `overrideResponse`, so the fix is additive and does not touch generated code: a `src/fixtures/` module built from the same 40 documents, 3 clients and 26 bank lines as `prisma/seed.ts`, layered over the generated handlers. Worth doing before the frontend builds screens against them, not after.

### Single file, for now

The spec is one file while it is one surface. It splits into `paths/` + `components/` with a bundle step when it stops being readable — orval bundles `$ref`s across files, so the split is cheap whenever it is wanted.
