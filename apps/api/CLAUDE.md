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

## Definition of Done (Guideline §8.6)

Checks green · Zod on every new boundary · queries through `scopedDb` · money in pence · tests for changed logic with property tests on money paths · seed updated so screens stay honest · module `CLAUDE.md` updated · migration additive or via the contract process · no `# BOOTSTRAP` shim without an issue link.
