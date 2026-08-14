# apps/api — NestJS modular monolith

Node 22, TypeScript strict, Prisma + Postgres 16 (RLS), BullMQ on Redis. One deploy, enforced module boundaries — which are also the parallel-agent lane map.

## Layering

`controllers → services → repositories/lib`. Never the reverse.

- Controllers are thin: parse and validate input (Zod/DTO), call **one** service, map the result. **Cap: 200 lines per controller file.**
- Services own business logic and are the only layer that touches Prisma.
- A module exposes its **public providers only**. Cross-module work goes through those providers or through domain events on the transactional outbox — never by reaching into another module's internals.

## Async spine

Anything over 5 seconds, any retryable external call, and every ingest/extract/publish/chase/export runs through BullMQ — never inline in a request. Handlers are idempotent (keyed by `idempotencyKey`), validate payloads with Zod, and use exponential backoff with a capped retry count. Exhausted retries land in a dead-letter queue that pages; poison messages auto-quarantine after 3 replays.

Every job carries the `traceId` of its origin. The per-document processing log records every stage — tool, duration, outcome — so any file's journey can be replayed end to end.

## Modules

See `src/modules/*/CLAUDE.md`. Read the module's file on entry, update it on exit.

## Build and container

`pnpm --filter @neoting/api build` runs `tsc -p tsconfig.build.json` and emits `dist/`. That plain `tsc` emit only works because **every import of `@neoting/contracts` in this app is `import type`** — the package is consumed as `.ts` source through its exports map, which Node cannot load, so a value import would compile clean and then die at runtime with `ERR_UNKNOWN_FILE_EXTENSION`. `apps/api/Dockerfile` greps the compiled output for exactly that and fails the build. If you ever need a *value* from contracts, give contracts a real build output and point its exports map at the JS — do not reach for a bundler.

`apps/api/Dockerfile` builds **one image for three commands** (build context is the repo root):

| Command | Entry |
|---|---|
| api | `node apps/api/dist/main.js` (the image `CMD`) |
| workers | `node apps/api/dist/worker/main.js` (explicit `command` on the task definition — inheriting the `CMD` would silently run a second API) |
| migrate | `pnpm prisma migrate deploy`, `ecs run-task` only |

Task definitions pin **ARM64**, so CI builds `--platform linux/arm64`. An x86 image dies with `exec format error` and nothing else.

**What is deployed to staging today: the api only.** Two composition gaps keep the rest off, and both are app-side, not infra:

- **workers** — the task is given `REDIS_HOST` / `REDIS_PORT` / `REDIS_TLS` and a `REDIS_AUTH_TOKEN` secret; `config/env.ts` reads `REDIS_URL`, which defaults to `redis://localhost:6379`. A worker task would reconnect-loop against itself.
- **migrations** — the migrate task is given `DATABASE_HOST` / `PORT` / `NAME` and `DB_MIGRATOR_USER` / `PASSWORD`; Prisma reads `DATABASE_URL` and `DIRECT_URL`.

Both are one change to `config/env.ts`: accept the parts and derive the URL when the URL itself is unset. An ECS `secrets` entry cannot be interpolated into another environment variable, which is why this cannot be fixed in Terraform.

Consequence to know before debugging staging: `INGEST_QUEUE` is unset there, so it defaults to `fixture`. A WhatsApp message reaching the deployed api is signature-verified and then enqueued **in memory**, where it is dropped.

## Definition of Done (Guideline §8.6)

Checks green · Zod on every new boundary · queries through `scopedDb` · money in pence · tests for changed logic with property tests on money paths · seed updated so screens stay honest · module `CLAUDE.md` updated · migration additive or via the contract process · no `# BOOTSTRAP` shim without an issue link.
