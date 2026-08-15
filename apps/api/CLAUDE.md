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
| migrate | `node apps/api/dist/db/migrate.js`, `ecs run-task` only — a wrapper that composes `DATABASE_URL`/`DIRECT_URL` and then execs `prisma migrate deploy` |

Task definitions pin **ARM64**, so CI builds `--platform linux/arm64`. An x86 image dies with `exec format error` and nothing else.

**What is deployed to staging: migrations, api and workers** — in that order, which is the expand-contract order (§5.3). The two composition gaps that used to keep migrations and workers off were the same bug in two places, and both are closed. An ECS `secrets` entry cannot be interpolated into another environment variable, so the join has to happen in the process that reads them:

| Gap | Where it is joined |
|---|---|
| Task gets `REDIS_HOST`/`PORT`/`TLS` + a `REDIS_AUTH_TOKEN` secret; app reads `REDIS_URL` | `config/env.ts` derives it via `withDerivedRedisUrl`. An explicit `REDIS_URL` still wins, so `.env` and docker-compose are unchanged. |
| Migrate task gets `DATABASE_HOST`/`PORT`/`NAME` + `DB_MIGRATOR_USER`/`PASSWORD`; Prisma reads `DATABASE_URL`/`DIRECT_URL` | `src/db/migrate.ts`, which the task definition's `command` points at. It **cannot** be `config/env.ts` — `prisma migrate deploy` is a CLI invocation that never loads application code. |

Both compose through `config/connection-urls.ts`, which percent-encodes the credentials. That is not defensive tidiness: RDS generates the master password itself and guarantees punctuation in it, and an unencoded `/`, `#` or `?` stops the string being a URL at all. It surfaces on a seven-day rotation, on a day nobody expects it.

⚠ **Consequence to know before debugging staging, still true:** `INGEST_QUEUE` is unset there, so it defaults to `fixture`. A WhatsApp message reaching the deployed api is signature-verified and then enqueued **in memory**, where the workers service cannot see it. Workers running is necessary for the ingest lane and is not sufficient.

⚠ Workers has no load balancer and no container health check, so ECS steady state proves the task **started**, not that it reached Redis. A worker that connects and then silently stops consuming looks identical to an idle one.

## Definition of Done (Guideline §8.6)

Checks green · Zod on every new boundary · queries through `scopedDb` · money in pence · tests for changed logic with property tests on money paths · seed updated so screens stay honest · module `CLAUDE.md` updated · migration additive or via the contract process · no `# BOOTSTRAP` shim without an issue link.
