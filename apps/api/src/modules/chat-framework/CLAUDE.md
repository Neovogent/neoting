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
| `budget.ts` | 9.7 | Per-practice daily ceiling in Redis. Warn 80%, hard stop 100% |
| `chat.service.ts` | — | The orchestrator. Loop caps, retrieval, assembly, citation checks, draft building |
| `grounding.ts` | 9.4 | RLS-scoped retrieval, the client's chart of accounts, **citation verification** |
| `prompts/system-prompt.ts` | 9.6, 9.8 | The versioned prompt. A byte-stable cache prefix |
| `prompts/output-schema.ts` | 9.2 | Strict Zod + the JSON Schema for the forced tool |
| `invoke-structured.ts` | 9.2, 9.3 | Retry-once-on-schema-failure, the degrade ladder, the breaker |
| `provider/*` | 9.1, 9.3 | Bedrock client, the offline stand-in, the circuit breaker |
| `drafts.ts` | 9.5 | Model turn → `rule.create` request, built from real rows |
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
| `AI_CHAT` | `demo` | `bedrock` is the real model. **Refused under `NODE_ENV=production`** — see below |
| `BEDROCK_REGION` | `eu-west-2` | Pinned by D30. Changing it is a residency decision |
| `AI_DAILY_BUDGET_PENCE` | `500` | Per practice, per UTC day |

`AI_CHAT=demo` is the only demo switch in `env.ts` that refuses to boot in
production. The others degrade something a user can see — no SMS arrives, no
bill reaches Xero. This one degrades the *judgement* while the screen looks
identical: same cards, same confident wording, same Review → Approve path. A
stand-in classifier answering a real accountant is a different class of wrong.

## Evals are the merge gate (§9.8)

`pnpm test:eval` — rule-parsing accuracy plus the adversarial injection corpus,
which must stay **100% blocked**. The runner imports THIS module's prompt and
schema by relative path, deliberately: an eval with its own copy would measure a
prompt nobody ships and stay green through exactly the change §9.8 exists to
gate.

`EVAL_PROVIDER=bedrock` is the gate. Running against the stand-in prints a
banner and always exits non-zero — a passing eval that never called a model is
worse than no eval, because CI output cannot tell them apart.

## Tests

```bash
pnpm --filter @neoting/api test -- chat-framework   # 63 unit tests, no socket, no DB
EVAL_PROVIDER=bedrock pnpm test:eval                # the §9.8 gate, needs AWS creds
```

## Current state

**Built and wired** (replacing the METH S13 client-side canned table, which is
gone from `apps/web/src/lib/demoIntents.ts`). Live on `POST /v1/chat/turns`.

## Not built yet — and why, so nobody rediscovers it

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
