# chat-framework — the AI runtime

**Lane J** · **Source of Truth:** SoT §8, §16 · **Governs:** Engineering Governance **§9** (all of it) · **Contract:** `POST /v1/chat/turns`

## Purpose

The workspace assistant. One operation: an accountant says something, this
classifies it with the pinned model, grounds any question in that client's own
RLS-scoped records, and returns a structured turn — plus, where relevant, a
**draft** of the action they described.

**It changes nothing.** `x-nt-side-effect: none`, and that is not a technicality:
a draft is a suggestion the caller takes to `POST /action-proposals`, which a
human then approves. §9.5 says the only side-effect path available to a model is
creating an ActionProposal; here the model does not even do that much. There is
no second door to close.

## The file map, in the order a turn flows through it

| File | §  | What it owns |
|---|---|---|
| `models.ts` | 9.1 | **Governance names this path.** Pinned Bedrock IDs, the task→(model, effort) map, per-family decoding params, task budgets, tier rates, the config revision |
| `../../common/ai-budget.ts` | 9.7 | Per-practice daily ceiling in Redis. Warn 80%, hard stop 100%. **Moved out of this module by S5 (27 Aug 2026)** — `modules/extraction` is now a second spender, `no-cross-module-internals` forbids it reaching in here, and re-exporting a Redis-backed ledger through this module's seam would break that seam's own rule (it carries configuration, not behaviour). `common/` is the one place both may import from |
| `chat.service.ts` | — | The orchestrator. Loop caps, retrieval, assembly, citation checks, draft building |
| `grounding.ts` | 9.4 | RLS-scoped retrieval, the client's chart of accounts, **citation verification** |
| `prompts/system-prompt.ts` | 9.6, 9.8 | The versioned prompt. A byte-stable cache prefix |
| `prompts/output-schema.ts` | 9.2 | Strict Zod + the JSON Schema for the forced tool |
| `invoke-structured.ts` | 9.2, 9.3 | Retry-once-on-schema-failure, the degrade ladder, the breaker |
| `provider/*` | 9.1, 9.3 | Bedrock client, the offline stand-in, the circuit breaker |
| `drafts.ts` | 9.5 | Model turn → `rule.create` request, built from real rows |
| `display.ts` | 9.4 | Model's `{kind, subject}` display request → a contract `ChatDisplayBlock` filled from RLS-scoped rows. GROUNDED_ANSWER only, attached only when citations stood; cells travel as typed strings (pence as digits — the WEB's money boundary renders them), bars are counts only, an empty subject is NO block. The drafts.ts posture applied to rendering |
| `telemetry.ts` | 9.7 | The `ai.call` / `ai.fallback` / `ai.injection_signal` lines |

## The five things that will bite you

**1. The system prompt is a cache prefix. Never interpolate into it.**
§9.7 makes caching mandatory on stable prefixes, and caching is a byte-exact
prefix match. A client name, a date or a trace id in `SYSTEM_PROMPT` silently
drops the hit rate to zero and nobody notices until the bill. `buildMessages`
assembles everything volatile into the message body, after the breakpoint. A
unit test asserts the prompt contains no `${`.

**2. The model never picks numbers, ids, or transactions.**
It picks an *intent* and writes *words*. The server derives which transactions
get chased and which documents get published from real rows. `REVIEW_DOCUMENT`
carries a `documentQuery` ("the Currys receipt"), never a `documentId` — there
is no field in the output schema for an id, so a model cannot guess one. That
division is the safety property, and it is why `drafts.ts` is short.

**3. A fabricated citation fails the whole turn.**
`verifyCitations` returns `null` if *any* cited id was not in the set the server
supplied, and the service then renders §9.4's literal fallback. It does not
filter the bad citation out and render the rest — an answer standing on a source
that does not exist is precisely what the citation requirement exists to catch.

**4. `DEGRADE_CHAIN.chatWorkspace` is empty, deliberately.**
§9.3 allows degrading only onto a tier whose evals that task class has passed.
`evals/` covers the judgment tier only, so chat has nowhere to fall and §9.3's
floor applies: an honest error with a retry (`NT-MDL-001`), never a guess from a
model nobody measured. The day a workhorse eval run passes, that array grows and
nothing else changes.

**5. A schema failure is not an availability failure.**
`ModelOutputInvalidError` does not trip the breaker and does not walk the ladder.
Retrying a schema problem on a *less* capable tier spends money to get a worse
answer, and counting it as a provider failure would take chat down for 60 s over
a prompt bug. Only `ModelUnavailableError` (5xx / timeout / 429) does either.

## Model IDs are LAW-adjacent — read this before changing one

The IDs in `models.ts` are D28-as-amended (ADR 0001). Opus 4.8 and Haiku 4.5 are
reachable in eu-west-2 only through `eu.*` cross-region inference profiles,
which process outside the UK and are **excluded by D30**. The ECS task role
holds region-pinned foundation-model ARNs and *no* inference-profile ARN, so an
`eu.*` id here returns AccessDenied rather than quietly sending UK client
documents abroad. A unit test asserts no id starts with `eu.` or `global.`.

§9.1: a model upgrade is a PR that changes this file **and** passes the full
eval suite. Never a silent swap. The current pin is behind the latest Claude
generation; moving it is a deliberate decision with a residency check, a
Terraform change to the ARNs in both envs, and an eval run — not a drive-by.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `AI_CHAT` | `demo` | `bedrock` is the real model; `replay` is the real `BedrockModelProvider` served from recorded cassettes (see below). **Both `demo` and `replay` are refused under `NODE_ENV=production`** |
| `BEDROCK_REGION` | `eu-west-2` | Pinned by D30. Changing it is a residency decision |
| `AI_DAILY_BUDGET_PENCE` | `2500` | Per practice, per UTC day. £25, raised from £5 by S1 — it is a hard stop, not a warning, and £5 was 250 documents at the £0.02/document guardrail. **Extraction counts against it since S5** (27 Aug 2026): one meter, two spenders, so a practice that exhausts the ceiling in chat will see that day's documents land FAILED and vice versa. Deliberate — §9.7 is a per-*firm* budget — and both refusals are visible. Measured at ~1.3p/document, so £25 is ~1,250 documents/day as the meter counts them |

`AI_CHAT=demo` refuses to boot in production. Some demo switches degrade
something a user can see — no SMS arrives, no bill reaches a ledger. This one
degrades the *judgement* while the screen looks identical: same cards, same
confident wording, same Review → Approve path. A stand-in classifier answering
a real accountant is a different class of wrong.

It used to be the **only** switch here that refused to boot. S1 gave the same
treatment to `EXTRACTOR=demo`, which is the same failure with more of the
product behind it — DemoExtractor derives supplier, date, total, tax and a VAT
number from a hash of the filename at 0.8 confidence, and `resolveProcessedState`
reads 0.8 as Ready. `OTP_MODE`, `IMAGE_NORMALISER`, `DOCUMENT_GUARD` and the
three HMAC signing keys are gated too; `apps/api/src/config/env.ts` carries the
argument for each.

**`AI_CHAT=replay`** runs the real `BedrockModelProvider` under
`invokeStructured` with `messages.create` served from
`fixtures/cassettes/bedrock/` (`common/bedrock-replay.ts`; corpus in
`replay-corpus.ts`, tests in `replay-provider.test.ts`). The schema-retry
corpus case records BOTH exchanges of a conversation, so §9.2's
correction-request assembly is replayed for real — and because the zod
validation message text participates in the second exchange's key, a zod bump
can orphan that cassette; the test failing is the re-record demand working. A
miss names `pnpm --filter @neoting/api record:cassettes`; it never falls
through to live Bedrock, and replayed turns are metered like real ones.

## Evals are the merge gate (§9.8)

`pnpm test:eval` — rule-parsing accuracy plus the adversarial injection corpus,
which must stay **100% blocked**. The runner imports THIS module's prompt and
schema by relative path, deliberately: an eval with its own copy would measure a
prompt nobody ships and stay green through exactly the change §9.8 exists to
gate.

**The gate replays a recording, it does not call the model.** `check.yml`
requires stage 7 to be deterministic and to spend no Bedrock tokens per PR, so
`pnpm test:eval` defaults to replaying `evals/recordings/chat-turns.json` — the
real model's answers from a live calibration run. Free, offline, and still a
measurement of the model rather than of an author's expectation.

The replay key hashes the prompt and the tool schema, so **editing either misses
every key and fails the run**, demanding a re-record. Changing this module's
prompt therefore cannot merge without someone re-running against the real model
and committing the diff — §9.8 as a cache key rather than as a promise.

```bash
pnpm test:eval                                                     # the gate
AWS_PROFILE=nt EVAL_PROVIDER=bedrock EVAL_RECORD=1 pnpm test:eval  # re-record
```

## Tests

```bash
pnpm --filter @neoting/api test -- chat-framework   # 79 unit tests, no socket, no DB
EVAL_PROVIDER=bedrock pnpm test:eval                # the §9.8 gate, needs AWS creds
```

## Current state

**Built and wired** (replacing the METH S13 client-side canned table, which is
gone from `apps/web/src/lib/demoIntents.ts`). Live on `POST /v1/chat/turns`.

**The export ask is answered server-side (3 Sep 2026).** "Export all the ready
docs for VT" used to fall through to the GENERAL capability list — the
contract's `ChatIntent` (LAW) has no export value, so the model cannot route
the product's SOLE egress (D42) and its only legal answers were GENERAL or
SCOPE_REFUSAL. `chat.service.ts` now recognises an export ask AFTER the model
returns one of those two and replaces the reply with `EXPORT_GUIDANCE`: the
Export tab is where exports live, an export carries Published documents only,
and Ready → Published is a publish batch through Review → Approve with the
super admin's release (D44). Deterministic, no model call, no prompt edit —
which is why the §9.8 recording needed no re-record for it. It keys on the
MODEL's own intent, so `decorate()`'s degradations (the §9.4 citation
fallback) outrank it, and it can never fire over a routed turn. The demo
stand-in's GENERAL fallback also now names what was asked before listing
capabilities, instead of ignoring the question.

## Not built yet — and why, so nobody rediscovers it

- **A real EXPORT intent.** `ChatIntent` in `packages/contracts` (LAW) has no
  export value and `ChatNavigation` has no way to address the Export screen, so
  the `EXPORT_GUIDANCE` override in `chat.service.ts` is the honest stand-in.
  Doing it properly is a G7 contract-change issue for Shakib (an enum value,
  and probably a navigation target for the Export view), then the prompt
  teaches the model the new intent — a `PROMPT_VERSION` bump and a §9.8
  re-record. ADD_CLIENT (573a2e1) is the worked precedent for exactly this
  shape of change. Note the chat may only ever *describe or draft* around an
  export — `POST /v1/exports` releases client data as a download, and this
  surface is `x-nt-side-effect: none`.
- **⚠ The §9.8 recording is STALE and the replay gate is red — pre-existing.**
  `evals/recordings/chat-turns.json` is `chat-workspace/2026-08-21.1`; the
  prompt has been `chat-workspace/2026-08-28.1` since ADD_CLIENT (573a2e1),
  whose own commit message records the owed re-record. Every replay key misses
  and `pnpm test:eval` FAILs on all 36 cases (26 rule-parsing, 10 injection). The export work touched no hash
  input (prompt, tool schema, `buildMessages`, fixtures all byte-identical) —
  re-record with `AWS_PROFILE=<profile> EVAL_PROVIDER=bedrock EVAL_RECORD=1
  pnpm test:eval` and commit the diff.
- **`chase.send` and `publish.batch` drafts.** Chat returns the intent; the
  existing web cards build those payloads. `chase.send` needs every SMS
  byte-for-byte *including the signed portal link*, and the contract says
  composition is server-side and "never free-typed by a caller" — the composer
  is in the chase module and the signing secret is not this module's to hold.
  `publish.batch` needs a server-computed preview from the publishing module. A
  preview assembled by a chat model is a number a human approves that was never
  derived from the ledger. Moving chase composition to proposal time is the
  known seam that ALSO fixes the dead SMS portal link.
- **`output_config.effort`.** `supportsEffortParam` is false for every family
  until someone verifies it on Bedrock by live invocation. `effort` is recorded
  on the turn and not sent.
- **Prompt caching does not work on Bedrock today. Measured, not assumed.**
  21 Aug 2026, eu-west-2, `opus-4-6`: two live calls with an identical
  ~1.5k-token prefix (tools + system, comfortably over the ~1024 minimum) both
  returned `cache_creation_input_tokens: 0` **and** `cache_read_input_tokens: 0`.
  Bedrock accepts `cache_control` and writes nothing. §9.7 calls caching
  mandatory, so this is a real open gap: every turn is billed at full input
  rate — roughly 2p per turn at ~2.7k input tokens.

  It is left in the request deliberately — it costs nothing, it is correct
  against the first-party API, and it begins working the day Bedrock honours it.
  The telemetry distinguishes the two failure modes on purpose: zero WRITES
  means the provider ignored it; non-zero writes with zero reads would mean
  something per-request is invalidating the prefix. Re-check with
  `evals/src/smoke-bedrock.ts`, which prints both.
- **Streaming.** One request, one answer. Fine at 4096 max tokens; revisit if
  the reply cap grows.
- **The other §9.8 eval families** — extraction per-field, addressee-routing,
  chase-validation. Only rule-parsing and injection exist.
