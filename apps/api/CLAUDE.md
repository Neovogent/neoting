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

**Launch stage S4 added `BILLING=demo` to that stated set, and 28 Aug 2026 flipped it to `BILLING=stripe`.** `demo` was not merely a weaker environment: `businesses.subscription_status` is written ONLY by the Stripe webhook, so it stayed null, `mayIngest(null)` was false, and every upload 402'd — the client walkthrough died at the step after sign-in, with no way for anyone to fix it from inside the product. Staging runs the real `HttpStripeClient`. Entitlement is read from `subscription_status` either way, so neither value ever meant "free".

⚠ **The staging Stripe key is `rk_live_…` — LIVE MODE, whatever this paragraph
used to say about a sandbox** (the secret is `/neoting/staging/stripe`;
`scripts/billing/create-promotion-code.ts` records the same correction, and the
4 Sep 2026 staging pass confirmed it from a real checkout session — `cs_live_`,
no Sandbox badge, real cards only). Consequences: `4242 4242 4242 4242` does
NOT work on staging; a completed checkout charges a real card; test
subscriptions travel on 100%-off coupons (`NEOTEST100`, or the script). One
more measured fact from that pass: **the hosted checkout's "Add promotion
code" field refuses every code when Stripe's adaptive-pricing currency
conversion is active** (a non-GBP visitor sees BDT/etc.), so a coupon for a
test subscription has to be attached SERVER-SIDE (`discounts[0][coupon]` on
the session or subscription), not typed at checkout. The full lifecycle is
proven live end to end: session (£8.50 + VAT rendered correctly) → webhook →
`ACTIVE` → portal Plan panel → cancel → `CANCELED`. ⚠ The webhook resolves its
tenant from the SUBSCRIPTION's `metadata.practiceId` — an API-created
subscription must stamp `businessId` AND `practiceId` or every event for it is
refused by name.

**Seeding a deployed environment** — `docs/runbooks/staging-demo.md` §3. `src/db/seed-environment.ts` is the guard, and it is worth reading before touching it: `prisma/seed.ts` refuses under `NODE_ENV=production`, which staging sets for build parity, so the wrapper asserts the real property (`NEOTING_ENV` is in an allow-list of synthetic-data environments) and only then relaxes `NODE_ENV` for the child process. Assert, *then* relax — in that order, or the seed can reach production.

⚠ Workers has no load balancer and no container health check, so ECS steady state proves the task **started**, not that it reached Redis. A worker that connects and then silently stops consuming looks identical to an idle one.

**The Dockerfile has a fourth stage, `dev` — never deployed, and `runtime` must stay the LAST stage** (an untargeted `docker build` produces the final stage, and CI/deploy assume that is the production image). `docker compose --profile full up -d --build` runs the whole app in containers with staging's adapter switches (`INGEST_QUEUE=bullmq`, `OBJECT_STORE=s3`, `IMAGE_NORMALISER=sharp`, `DOCUMENT_GUARD=qpdf`, `AUTH_MODE=session`) against the local stand-ins: one dev image, api/workers/web as three commands — the ECS shape — plus a `migrate` one-shot (migrations → `app-role.sql` → seed only into an empty database) gating them, source bind-mounted for hot reload with anonymous volumes over every node_modules. `docker/dev-entrypoint.sh` rebuilds `packages/contracts` into the mounted tree when its dist is missing **or older than its sources** — the staleness branch fires on every pull that touches the contract, and was added because the existence-only check shipped a stale dist on its first real run. Local divergences from staging, all deliberate and documented in the compose env anchor: `EXTRACTOR`/`AI_CHAT`/`OTP_MODE` stay demo, `STATEMENT_READER` stays `none` (Textract cannot read MinIO). The default `docker compose up -d` is still infra-only — the 10-minute clone target is untouched. `pnpm verify:parity` asserts the five switch pins inside the running api container and then runs the same golden-path smoke that gates a staging deploy. CI stage 0a (`scripts/check-env-parity.mjs`) reconciles every `.env.example` key against the ECS task definitions — composed, allowlisted-with-reason, or red.

**`EXTRACTOR` and `AI_CHAT` have a third value, `replay`:** the REAL Bedrock adapters run with `messages.create` served from `apps/api/fixtures/cassettes/bedrock/` (`common/bedrock-replay.ts`) — same Zod parse, §9.2 retry, error classification and budget metering, offline. A cassette miss fails loudly naming `pnpm --filter @neoting/api record:cassettes` (`--live` records the real model, pennies); it never falls through to live Bedrock. Refused under `NODE_ENV=production`, tests pinning both refusals. Cassettes store the response and the request's hash only — no request bodies, so no document bytes or prompts in fixtures — and every write is structurally redacted. Editing a prompt, tool schema or the model pin orphans every cassette key: the replay tests then fail demanding a re-record, which is the mechanism working (the eval-recording property, one seam lower). The committed cassettes are **synthetic** (marked `synthetic: true`); a `--live` re-record is owed — ⚠ and it is BLOCKED on the corpus: `replay-corpus.ts`'s byte-path item sends `ONE_PIXEL_PNG`, which the live API refuses with a 400 (measured 5 Sep 2026 while re-recording for extraction's new `temperature: 0`). Swapping in a small real receipt image is the prerequisite.

## ⚠ Every practice needs a SYSTEM actor, and until 28 Aug 2026 signup made none

Everything with no human behind it resolves one per practice — the ingest and
extract workers, the chase portal's session lookup, the capability-link
resolver, and the invited client's `POST /v1/portal/sign-in-codes`. Every RLS
policy requires an actor, and `resolveSystemActor` **throws** when a practice
has none.

The only thing that ever created one was `prisma/seed.ts`. So a practice born
through `POST /v1/practices` had none, and all of that was dead for it — while
every seeded demo worked perfectly, which is why it survived so long.

**It surfaced as an invited client pressing "send me a code" and nothing
arriving**: a `202` on screen, no email, and not one line in the logs. Each
layer was individually correct and the combination was undiagnosable — the
sweep found no candidate practice and returned the same silent refusal it gives
an unknown token, which is right for the caller and was wrong for the operator.

Three things changed together, and none of them is sufficient alone:

| | |
|---|---|
| `common/db/resolve-system-actor.ts` | `createSystemActor` — one definition of what the actor IS: `SYSTEM` kind, no email, no password hash (so it cannot sign in even if it reaches a screen), `PRACTICE_STANDARD` on a practice-wide membership. Never an admin role: D44 reserves release authority for a human, and a machine that could release could publish. |
| `auth-tenancy/practice-signup.service.ts` | Creates it **inside the signup transaction**. A practice that exists without its actor is one whose first upload lands in a DLQ, so rolling back beats repairing. |
| `db/backfill-system-actors.ts` | Repairs the practices that predate the fix. Idempotent, insert-only, runs on the **api** task family because it needs no elevated privilege. |

## The second backfill — `db/backfill-import-fingerprints.ts` (2 Sep 2026)

Keys every `bank_transaction` that predates
`20260902160000_bank_transaction_import_fingerprint`, so re-uploading a
statement whose lines were imported before the fix adds nothing. Idempotent
(`WHERE import_fingerprint IS NULL`), reversible in one `UPDATE … SET NULL`, and
it **deletes nothing** — already-duplicated rows stay and are counted for the
operator, because removing a line from an accounting ledger is a human's call.
Same task family and same reasoning as the actor backfill above.

⚠ **Unlike that one it CANNOT read the root client, and the difference is the
whole trap.** `practices`, `users` and `memberships` carry no RLS; the actor
backfill therefore works unscoped. `bank_transactions` is in the `direct_tables`
RLS loop with FORCE ROW LEVEL SECURITY, so the same shape **returns an empty
list and does not error** — the first draft printed "nothing to do" against a
database holding six un-keyed rows. It now resolves each practice's SYSTEM actor
and works inside `scopedDb`, through the same predicate a human's query goes
through. One transaction per row, deliberately: a unique violation aborts the
transaction it happens in, so a batched write that hit one would poison every
statement after it.

## Definition of Done (Guideline §8.6)

Checks green · Zod on every new boundary · queries through `scopedDb` · money in pence · tests for changed logic with property tests on money paths · seed updated so screens stay honest · module `CLAUDE.md` updated · migration additive or via the contract process · no `# BOOTSTRAP` shim without an issue link.
