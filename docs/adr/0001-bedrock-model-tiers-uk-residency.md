# ADR 0001 — Bedrock model tiers under UK-first residency

**Status:** Accepted · **Date:** 13 August 2026 · **Decider:** Shakib (eng), ratified by CEO
**Closes:** Kickoff verification 8.1 and 8.3 · **Amends:** D28 · **Preserves:** D30, D22

---

## Context

D28 pinned three Claude tiers: **Opus 4.8** (judgment) · **Sonnet 4.6** (workhorse) · **Haiku 4.5** (mechanical). D30 requires all storage and processing in **eu-west-2 (London)**, with only two named non-UK fallbacks, neither of which covers model inference.

Measured in eu-west-2 on 13 Aug 2026 (`bedrock list-foundation-models`, confirmed by live `Converse` calls in account 252959251643):

| Model | In-region route | Verified |
|---|---|---|
| `anthropic.claude-sonnet-4-6` | **ON_DEMAND** | ✅ invoked |
| `anthropic.claude-opus-4-6-v1` | **ON_DEMAND** | ✅ invoked |
| `anthropic.claude-opus-4-8` | `eu.` inference profile **only** | ✅ invoked, but cross-region |
| `anthropic.claude-haiku-4-5` | `eu.` inference profile **only** | ✅ invoked, but cross-region |

`eu.*` inference profiles route requests across **multiple EU regions**, not the UK. D28's exact tiers therefore cannot run UK-only.

Two additional findings:

- **Opus 4.8 rejects the `temperature` parameter** (`ValidationException: temperature is deprecated for this model`). Governance §9.1 mandates "temperature 0" for pipeline tasks — that instruction is unsatisfiable for that model regardless of which way this decision goes.
- Going UK-pure by promoting triage to Sonnet would have pushed blended per-document cost toward **£0.022–0.026** against the **£0.02** guardrail (D28).

## Decision

**Keep D30 intact. Amend D28's model IDs.**

| Tier | Was (D28) | Now | Route |
|---|---|---|---|
| Judgment — chat, rule parsing, conflict resolution, cross-client analysis, final vision rung | Opus 4.8 | **`anthropic.claude-opus-4-6-v1`** | ON_DEMAND, eu-west-2 |
| Workhorse — coding suggestions, chase composition/validation, addressee escalation, vault summaries, first vision rung | Sonnet 4.6 | **`anthropic.claude-sonnet-4-6`** (unchanged) | ON_DEMAND, eu-west-2 |
| Mechanical — doc-type triage, addressee shortlisting, dedupe text-assist | Haiku 4.5 | **`amazon.nova-lite-v1:0`** | ON_DEMAND, eu-west-2 |

The **three-tier structure, the effort map, the per-class tier flags, the eval gate on every flip, and the exemption of judgment surfaces from cost-driven demotion all survive unchanged.** Only the model IDs move.

### Why the residency promise outranked the model IDs

D30 is a customer-facing commitment to accounting practices handling their clients' financial documents — *"your clients' documents never leave the UK"* is a sales asset and a DPIA line. D28's model IDs are already declared soft: Governance §9.1 pins them in `models.ts` and changes them by PR plus a full eval run. Amending the softer of the two was the cheaper trade.

The counter-argument, recorded honestly: **Opus 4.6 is a generation behind 4.8, and the chat workspace is where accountant trust is won** (D28's own reasoning for exempting judgment surfaces from demotion). If W2 evals show 4.6 materially underperforming on chat or rule parsing, the options are (a) reopen D30 for the chat surface alone as a third named exception, or (b) accept. Do not let this quietly degrade — measure it.

### Why Nova Lite, and why not Gemini or DeepSeek's own API

The ask was for a cheaper mechanical tier. Constraints: D22 (single cloud, Bedrock, IAM auth) and D30 (UK).

- **Gemini is not on Bedrock.** It is Google Vertex AI — a second cloud, a second DPA, a new subprocessor-register entry, and its own residency analysis. Rejected on D22.
- **DeepSeek's own API** is served from China. For bulk UK client financial documents that is not a residency question with a good answer. Rejected.
- **`deepseek.v3.2` and `google.gemma-3-*` on Bedrock** are a different thing entirely: AWS-operated inference in eu-west-2 under the existing AWS DPA, with no traffic to either vendor. Both are legitimate candidates — but they are open-weights models of Chinese and US origin respectively, which is a subprocessor-register and customer-question matter, not a data-flow one.
- **`amazon.nova-lite-v1:0`** wins the mechanical tier: cheapest credible option in-region, multimodal (so triage can read the document image rather than only Textract's text), and **zero new vendor relationships** — same account, same DPA, same IAM, same region. It also resolves the £0.02 guardrail tension that promoting triage to Sonnet would have created.

All five candidates were verified callable in eu-west-2: Nova Lite, Nova Micro, DeepSeek v3.2, Gemma 3 12B, Ministral 3 8B.

## Consequences

1. **`models.ts` changes** (Governance §9.1). `MODELS.judgment` → `claude-opus-4-6-v1`, `MODELS.mechanical` → `amazon.nova-lite-v1:0`. The `TASKS` map is unchanged in shape.
2. **Temperature handling is now per-family.** Nova and Claude take different inference parameters. The model-config layer must express "temperature 0 where supported, deterministic decoding otherwise" rather than assuming one API shape. Governance §9.1's flat "temperature 0" needs rewording.
3. **Prompts are no longer one-family.** Schema-enforced output (Governance §9.2) absorbs most of the difference, but mechanical-tier prompts will need their own tuning and their own eval rows. Budget for it in W2.
4. **The eval gate applies to every mechanical class.** Nova Lite does not enter production for triage, addressee shortlisting, or dedupe text-assist until it passes evals for that (class, model) pair — D28's rule, unchanged.
5. **Enforced in IAM, not by convention.** `nt-staging-app` may invoke only region-pinned `eu-west-2` foundation-model ARNs; **no inference-profile ARNs are granted at all**, so a cross-region call fails with AccessDenied instead of silently processing UK documents elsewhere. (`infra/envs/staging/compute.tf`, `BedrockInRegionModelsOnly`.)
6. **W2 calibration gains a cost question worth real money:** `deepseek.v3.2` against `claude-sonnet-4-6` on the **coding-suggestion class** — D28 calls that "THE volume call". If DeepSeek passes evals at materially lower cost, that is the largest single lever on the per-document guardrail. Judgment surfaces stay exempt either way.
7. **Newer models exist and were not chosen.** Opus 5, Sonnet 5, Haiku 4.5 and Fable 5 are all present in eu-west-2 — but every one of them is `eu.` inference-profile only, so all are excluded by the same residency logic. Re-check at each model release: the moment a newer model lands ON_DEMAND in London, this ADR should be revisited.

## Follow-ups

- [ ] SoT amendment: D28 model IDs, and §22 open decisions #2/#4 marked decided (versioned bump per Governance §19).
- [ ] Governance §9.1: reword "temperature 0" to be family-agnostic; update the `MODELS` block.
- [ ] W2: eval Nova Lite on all three mechanical classes; benchmark DeepSeek v3.2 vs Sonnet 4.6 on coding suggestions.
- [ ] Remove losing candidates from `BedrockEvalCandidates` in `compute.tf` when W2 concludes.
- [ ] Re-verify pricing against the guardrail once real Bedrock invoice data exists (the £0.02 composition in SoT §16 assumed Haiku).
