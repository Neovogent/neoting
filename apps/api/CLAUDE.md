# apps/api — NestJS modular monolith

Node 22, TypeScript strict, Prisma + Postgres 16 (RLS), BullMQ on Redis. One deploy, enforced module boundaries — which are also the parallel-agent lane map.

## Layering

`controllers → services → repositories/lib`. Never the reverse.

- Controllers are thin: parse and validate input (Zod/DTO), call **one** service, map the result. **Cap: 200 lines per controller file.**
- Services own business logic and are the only layer that touches Prisma.
- A module exposes its **public providers only**. Cross-module work goes through those providers or through domain events on the transactional outbox — never by reaching into another module's internals. **Lint-enforced** since the §14.3 sweep: `neoting/no-cross-module-internals` fails any `modules/<A>` import that resolves under `modules/<B>` anywhere but `modules/<B>/index.ts`, the module's public seam (rule and test in `apps/api/eslint/`). Composition roots (`app.module.ts`, `worker/`) and `*.integration.test.ts` are exempt — assembly is their job. The first seam is `ingestion-routing/index.ts`; a module needs one only when its first cross-module consumer arrives.

## Routing — `/v1`, and the three routes that are not

`main.ts` sets a global `v1` prefix. The value and the exclusion list live in `src/config/routing.ts`, not inline, so a test can pin them.

**The prefix is asserted against `packages/contracts/openapi.yaml`, not against the string `'v1'`.** The contract is authoritative (Governance §3, D10) and the API was the non-conforming half — it served at root while the generated frontend client called `/v1`, so every call 404'd and would have looked like a frontend bug.

Three routes are excluded, and each breaks something specific if that changes:

| Route | Who holds the URL |
|---|---|
| `GET /healthz` | The ALB target group and the deploy's post-check. Moving it fails the health check, trips the deployment circuit breaker, and reads as a broken image. |
| `GET /readyz` | The deploy gate and synthetic checks. |
| `GET`+`POST /webhooks/whatsapp` | **Meta**, in its own configuration. It does not follow redirects for delivery and reports a 404 nowhere we would see — messages just stop arriving (`docs/runbooks/whatsapp-sandbox.md`, trap 4). |

The webhook is also excluded on principle: an inbound webhook is not part of *our* REST contract. It is versioned by the provider, on the provider's schedule.

A test couples the exclusion to the controller's own `@Controller` path, so renaming one without the other fails rather than silently moving Meta's callback under `/v1`.

## Async spine

Anything over 5 seconds, any retryable external call, and every ingest/extract/publish/chase/export runs through BullMQ — never inline in a request. Handlers are idempotent (keyed by `idempotencyKey`), validate payloads with Zod, and use exponential backoff with a capped retry count. Exhausted retries land in a dead-letter queue that pages; poison messages auto-quarantine after 3 replays.

Every job carries the `traceId` of its origin. The per-document processing log records every stage — tool, duration, outcome — so any file's journey can be replayed end to end.

## Modules

See `src/modules/*/CLAUDE.md`. Read the module's file on entry, update it on exit.

## Tests run FILE-SERIALLY — the shared-DB reason (METH Stage 8 gate)

`vitest.config.ts` sets `fileParallelism: false`. Every `*.integration.test.ts`
suite owns a disjoint id namespace (`p4_`, `p40_`, `pac_`, …) and tears it down
with `deleteMany` in `beforeAll`/`afterAll` against the ONE shared local Postgres.
Run in parallel worker threads (the vitest default), those concurrent parent
DELETEs (`businesses`, `documents`) race on FK-constraint validation and row
locks against another suite's in-flight children — `documents_business_id_fkey` /
`duplicates_document_aid_fkey` tripped intermittently, red ~1 run in 2, with no
source fault. Serialising files removes the contention; the suite is DB-bound and
runs in the same wall-clock either way, so there is no speed traded. **Do not
re-enable file parallelism without first giving each worker its own database (or
a txn-rollback harness)** — tracked as post-demo work. A new integration suite
must keep the disjoint-prefix + full-teardown discipline the existing ones use.

## Build and container

`pnpm --filter @neoting/api build` runs `tsc -p tsconfig.build.json` and emits `dist/`.

**You may import values from `@neoting/contracts` — parse every boundary with the generated Zod schemas.** That is new as of #88: this file used to say the opposite, because the package was consumed as `.ts` source through its exports map and Node cannot load that, so a value import compiled clean and died at runtime with `ERR_UNKNOWN_FILE_EXTENSION`. `packages/contracts` now emits a real build and its exports map points at the JS, which is precisely the fix this file predicted would be needed.

Two consequences:

- **`packages/contracts` must be built before this app runs or typechecks.** Turbo wires `typecheck` and `test` to depend on it (**not `dev`** — root `turbo.json` gives `dev` no `dependsOn`, so a cold clone needs one `pnpm build` before `pnpm dev`), so the checked commands are fine; a bare `tsx`/`node` against a cold tree is not. This matters more since #90 untracked `src/generated/` — the checkout no longer carries the tree at all. `apps/api/Dockerfile` builds contracts explicitly, because it uses `pnpm --filter` rather than `turbo run` and so resolves no dependency graph.
- **The Dockerfile guard is inverted, not gone.** It used to fail the image build on any runtime contracts import. It now fails when the compiled output imports contracts *without* the contracts build shipping alongside it, or when that build contains an extensionless relative specifier Node cannot resolve. Same failure class, caught at the point it can still be fixed.

`apps/api/Dockerfile` builds **one image for three commands** (build context is the repo root):

| Command | Entry |
|---|---|
| api | `node apps/api/dist/main.js` (the image `CMD`) |
| workers | `node apps/api/dist/worker/main.js` (explicit `command` on the task definition — inheriting the `CMD` would silently run a second API) |
| migrate | `node apps/api/dist/db/migrate.js`, `ecs run-task` only — a wrapper that composes `DATABASE_URL`/`DIRECT_URL` and then execs `prisma migrate deploy` |
| seed | `node apps/api/dist/db/seed.js`, a **command override** on the migrate task definition (METH Stage 15). Same composition wrapper, `prisma db seed` underneath. Not a task definition of its own: the migrate family already carries the only credential that may `TRUNCATE`, and carries it for seconds rather than for the life of a service. |

Task definitions pin **ARM64**, so CI builds `--platform linux/arm64`. An x86 image dies with `exec format error` and nothing else.

**What is deployed to staging: migrations, api and workers** — in that order, which is the expand-contract order (§5.3). The two composition gaps that used to keep migrations and workers off were the same bug in two places, and both are closed. An ECS `secrets` entry cannot be interpolated into another environment variable, so the join has to happen in the process that reads them:

| Gap | Where it is joined |
|---|---|
| Task gets `REDIS_HOST`/`PORT`/`TLS` + a `REDIS_AUTH_TOKEN` secret; app reads `REDIS_URL` | `config/env.ts` derives it via `withDerivedRedisUrl`. An explicit `REDIS_URL` still wins, so `.env` and docker-compose are unchanged. |
| Migrate task gets `DATABASE_HOST`/`PORT`/`NAME` + `DB_MIGRATOR_USER`/`PASSWORD`; Prisma reads `DATABASE_URL`/`DIRECT_URL` | `src/db/migrate.ts`, which the task definition's `command` points at. It **cannot** be `config/env.ts` — `prisma migrate deploy` is a CLI invocation that never loads application code. |

Both compose through `config/connection-urls.ts`, which percent-encodes the credentials. That is not defensive tidiness: RDS generates the master password itself and guarantees punctuation in it, and an unencoded `/`, `#` or `?` stops the string being a URL at all. It surfaces on a seven-day rotation, on a day nobody expects it.

**Staging runs the real ingest lane since 17 Aug 2026:** the task definitions set `INGEST_QUEUE=bullmq`, `OBJECT_STORE=s3`, `IMAGE_NORMALISER=sharp` and `AUTH_MODE=session` (infra/envs/staging/services.tf). METH Stage 15 (#146) added the rest: `SESSION_SECRET`, `PORTAL_LINK_SECRET` and `PORTAL_SESSION_SECRET` injected from the `/neoting/staging/auth` secret, and the four adapter switches stated rather than left to their defaults.

**S1 turned most of that from documentation into a boot requirement.** Staging is the launch target (`docs/launch/PLAN.md`) and it runs `NODE_ENV=production`, so `config/env.ts` now REFUSES to start with any of: an empty `SESSION_SECRET` / `PORTAL_LINK_SECRET` / `PORTAL_SESSION_SECRET`, `EXTRACTOR=demo`, `OTP_MODE=demo`, `IMAGE_NORMALISER=fixture` or `DOCUMENT_GUARD=fixture` — joining `AUTH_MODE`, `AI_CHAT` and `UPLOAD_URL_SECRET`, which were already gated. Every one of those has its argument written out at the declaration. The earlier stance — that the three signing keys deliberately had no boot gate, so a missing one could not crash-loop `/healthz` — was correct while the secret was empty and is retired now that it is not.

Consequently staging sets `EXTRACTOR=bedrock`, `OTP_MODE=totp` and `DOCUMENT_GUARD=qpdf` (with the binary now in the image). The two costs that stance carried are both paid: **A4** taught BedrockExtractor the PDF document content block (and the downscale), and **A2** implemented the real TOTP verifier. Still fixture on staging, by design: `EMAIL_SOURCE` (the s3 poller in `worker/email-intake-main.ts` has no ECS service yet).

**S5 closed what the `EXTRACTOR=bedrock` flip left open.** Real extraction is metered against the same per-practice daily ceiling as chat (`common/ai-budget.ts`, §9.7) — it previously answered to no budget at all, which made staging an environment with unbounded model spend — and a throw from Bedrock now lands the document FAILED with a reason on the job's last attempt rather than stranding it in PROCESSING, where nothing surfaced it and `document.reprocess` refused to retry it. Measured at ~1.3p/document against the £0.02 guardrail; re-run `pnpm tsx scripts/measure/extraction-cost.ts` when the model pin moves.

⚠ `infra/envs/prod/services.tf` sets none of these and does not set `AI_CHAT` either, so it already described an environment that could not boot before S1 — prod was destroyed on 25 Aug 2026 and its rebuild has to reconcile more than this stage. Do not read it as a working example.

**Launch stage S4 added `BILLING=demo` to that stated set.** `DemoStripeClient` mints hosted-session URLs on the reserved `.invalid` TLD, so **no card can be charged from staging**; entitlement is read from `businesses.subscription_status` either way, so `demo` never means "free".

**Seeding a deployed environment** — `docs/runbooks/staging-demo.md` §3. `src/db/seed-environment.ts` is the guard, and it is worth reading before touching it: `prisma/seed.ts` refuses under `NODE_ENV=production`, which staging sets for build parity, so the wrapper asserts the real property (`NEOTING_ENV` is in an allow-list of synthetic-data environments) and only then relaxes `NODE_ENV` for the child process. Assert, *then* relax — in that order, or the seed can reach production.

⚠ Workers has no load balancer and no container health check, so ECS steady state proves the task **started**, not that it reached Redis. A worker that connects and then silently stops consuming looks identical to an idle one.

## Definition of Done (Guideline §8.6)

Checks green · Zod on every new boundary · queries through `scopedDb` · money in pence · tests for changed logic with property tests on money paths · seed updated so screens stay honest · module `CLAUDE.md` updated · migration additive or via the contract process · no `# BOOTSTRAP` shim without an issue link.
