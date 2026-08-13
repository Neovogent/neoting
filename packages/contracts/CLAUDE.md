# packages/contracts — **LAW** (Sprint-0 contract, G7/D15)

The OpenAPI spec is the **build-first contract**. Handlers are generated against it; they are never hand-drifted into agreement with it.

## What lives here

- `openapi.yaml` — the spec. The single description of every endpoint.
- Generated TypeScript client — what `apps/web` imports. Never hand-write an API type.
- Generated MSW mock handlers with fixtures shaped like the seed dataset.
- Shared Zod schemas used on both sides.

## Why frontend is never blocked

`NEXT_PUBLIC_API_MODE=mock` makes MSW intercept everything. **The frontend starts building any screen the moment its contract exists** — days before the endpoint does. When the contract changes, regeneration breaks the build loudly. That is the system working, not a problem to route around.

## Rules

- Changing anything here needs a **contract-change issue approved by Shakib before the PR opens** (G7). Contracts move first, code follows.
- After the Day-1 freeze, changes **batch at day boundaries** and both sides regenerate in one PR. An unbatched contract change is an R10 reject.
- Every drift fix flows *through* the contract. A hand-patched type is why integration takes a week instead of two days.
- REST under `/v1`, kebab-case, cursor pagination, `Idempotency-Key` on every mutation, RFC 7807 `problem+json` errors with stable `NT-` codes (Governance §3).

## Current state

Skeleton. The spec lands in S0 before the contract freeze.
