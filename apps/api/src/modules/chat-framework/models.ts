/**
 * The one source of truth for the product's model usage (Governance §9.1).
 *
 * Governance names THIS PATH. Model IDs are pinned here and imported everywhere
 * — never hardcoded in a prompt, a service or a doc. A model upgrade is a PR
 * that changes this file **and** passes the full eval suite; it is never a
 * silent swap (§9.1).
 *
 * ⚠ The IDs below are D28-as-amended (ADR 0001), and they are load-bearing in a
 * way that is easy to undo by accident. Opus 4.8 and Haiku 4.5 are reachable in
 * eu-west-2 only through `eu.*` cross-region inference profiles, which process
 * outside the UK and are excluded by D30. The ECS task role holds region-pinned
 * **foundation-model** ARNs and no inference-profile ARN at all
 * (see `compute.tf` in each infra env), so adding an `eu.` or `global.` ID here does
 * not quietly send UK client documents abroad — it returns AccessDenied. That
 * is the design. Keep it.
 */

/** Bedrock model IDs, eu-west-2, all ON_DEMAND in-region (D28, ADR 0001). */
export const MODELS = {
  judgment: 'anthropic.claude-opus-4-6-v1', // chat, rules, cross-client analysis, final vision rung
  workhorse: 'anthropic.claude-sonnet-4-6', // per-document volume intelligence — the cost lever
  mechanical: 'amazon.nova-lite-v1:0', // triage, shortlists, text-assist (multimodal)
} as const;

export type Tier = keyof typeof MODELS;
export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface TaskConfig {
  readonly model: Tier;
  readonly effort?: Effort;
}

/**
 * Task → (model, effort) map (D28). Only the entries this surface actually
 * invokes are live today; the rest are declared because §9.1 says the map is
 * the config, not a per-call decision, and a task class that appears at a call
 * site without an entry here is the bug this shape exists to prevent.
 */
export const TASKS = {
  chatWorkspace: { model: 'judgment', effort: 'high' }, // one model, always — no split-personality chat
  crossClientAnalysis: { model: 'judgment', effort: 'max' },
  ruleParsing: { model: 'judgment', effort: 'high' },
  ruleConflictResolution: { model: 'judgment', effort: 'max' },
  extractionVisionFinal: { model: 'judgment', effort: 'max' },
  codingSuggestion: { model: 'workhorse', effort: 'medium' }, // THE volume call
  chaseComposition: { model: 'workhorse', effort: 'medium' }, // every SMS human-reviewed verbatim (§10)
  chaseValidation: { model: 'workhorse', effort: 'medium' },
  addresseeEscalation: { model: 'workhorse', effort: 'medium' },
  vaultSummary: { model: 'workhorse', effort: 'medium' },
  extractionVisionFirst: { model: 'workhorse', effort: 'high' },
  docTypeTriage: { model: 'mechanical' },
  addresseeShortlist: { model: 'mechanical' },
  dedupeTextAssist: { model: 'mechanical' },
} as const satisfies Record<string, TaskConfig>;

export type TaskName = keyof typeof TASKS;

/**
 * Which tiers a task class may DEGRADE to (§9.3: "a task class may only degrade
 * to a tier whose evals it passes").
 *
 * `chatWorkspace` has an empty chain, and that is a measured statement rather
 * than an oversight: `evals/` covers rule-parsing and injection on the judgment
 * tier only, so no lower tier has passed anything chat could degrade onto.
 * §9.3's floor rule then applies directly — "chat failure → honest error with
 * retry" — which is what the service does. The day a workhorse eval run passes,
 * this array grows and nothing else changes.
 */
export const DEGRADE_CHAIN: Readonly<Record<TaskName, readonly Tier[]>> = Object.freeze({
  chatWorkspace: [],
  crossClientAnalysis: [],
  ruleParsing: [],
  ruleConflictResolution: [],
  extractionVisionFinal: [],
  codingSuggestion: [],
  chaseComposition: [],
  chaseValidation: [],
  addresseeEscalation: [],
  vaultSummary: [],
  extractionVisionFirst: [],
  docTypeTriage: [],
  addresseeShortlist: [],
  dedupeTextAssist: [],
});

/**
 * Per-family decoding parameters (§9.1: "the per-family parameter mapping lives
 * in the same config as `MODELS`, so a new family is a config change with an
 * eval run, never a scattering of conditionals at call sites").
 *
 * Two things this encodes that a flat "always send temperature: 0" would get
 * wrong, and one that is deliberately conservative:
 *
 * 1. **Opus 4.8 rejects `temperature` outright** (measured 13 Aug 2026,
 *    §9.1). Opus 4.6 accepts it. Same vendor, different families — so the
 *    parameter is a property of the family, not of the provider.
 * 2. **Thinking and `temperature: 0` do not co-exist.** A family that thinks
 *    fixes its own sampling; sending both is a 400. `chatWorkspace` runs with
 *    thinking on (that is what `effort: high` means for this family), so it
 *    sends no temperature at all. The §9.1 determinism obligation lands instead
 *    on the forced-tool output shape and the strict Zod parse — the output is
 *    schema-pinned even where the decoding is not.
 * 3. **`output_config.effort` is NOT sent on Bedrock.** It is GA on the first
 *    party API; its availability on this Bedrock family in eu-west-2 has not
 *    been verified by live invocation here, and §9.1's whole point is that an
 *    unverified parameter assumption is what fails closed on some models and
 *    silently misleads on others. `effort` therefore maps to thinking depth
 *    below and the flag stays off until someone measures it. Flip
 *    `supportsEffortParam` after a live check, in a PR with an eval run.
 */
export interface FamilyParams {
  /** Family accepts `temperature`/`top_p`. False → sending one is a 400. */
  readonly supportsSampling: boolean;
  /** Family supports adaptive thinking. */
  readonly supportsThinking: boolean;
  /** Family accepts `output_config.effort` on THIS provider. */
  readonly supportsEffortParam: boolean;
}

export const FAMILY_PARAMS: Readonly<Record<Tier, FamilyParams>> = Object.freeze({
  judgment: { supportsSampling: true, supportsThinking: true, supportsEffortParam: false },
  workhorse: { supportsSampling: true, supportsThinking: true, supportsEffortParam: false },
  // Amazon Nova is a different vendor behind the same Bedrock door. It is
  // unreachable from chat today (empty DEGRADE_CHAIN) and the entry exists so
  // that the day it is reachable, its parameters are a fact here rather than a
  // guess at a call site.
  mechanical: { supportsSampling: true, supportsThinking: false, supportsEffortParam: false },
});

/** `max_tokens` and timeout budgets per use case (§9.1). */
export const TASK_BUDGETS: Readonly<Record<TaskName, { maxTokens: number; timeoutMs: number }>> = Object.freeze({
  chatWorkspace: { maxTokens: 4096, timeoutMs: 30_000 },
  crossClientAnalysis: { maxTokens: 8192, timeoutMs: 60_000 },
  ruleParsing: { maxTokens: 2048, timeoutMs: 20_000 },
  ruleConflictResolution: { maxTokens: 4096, timeoutMs: 30_000 },
  extractionVisionFinal: { maxTokens: 8192, timeoutMs: 60_000 },
  codingSuggestion: { maxTokens: 2048, timeoutMs: 20_000 },
  chaseComposition: { maxTokens: 2048, timeoutMs: 20_000 },
  chaseValidation: { maxTokens: 1024, timeoutMs: 15_000 },
  addresseeEscalation: { maxTokens: 1024, timeoutMs: 15_000 },
  vaultSummary: { maxTokens: 4096, timeoutMs: 30_000 },
  extractionVisionFirst: { maxTokens: 4096, timeoutMs: 45_000 },
  docTypeTriage: { maxTokens: 512, timeoutMs: 10_000 },
  addresseeShortlist: { maxTokens: 512, timeoutMs: 10_000 },
  dedupeTextAssist: { maxTokens: 512, timeoutMs: 10_000 },
});

/**
 * Bedrock on-demand rates, eu-west-2, pence per million tokens. Used for the
 * per-firm budget ledger (§9.7) — an approximation of the invoice, not the
 * invoice. It exists so a spend ceiling can be enforced BEFORE the call rather
 * than discovered in next month's bill, which is the only moment a ceiling is
 * worth anything.
 */
export const TIER_RATES_PENCE_PER_MTOK: Readonly<Record<Tier, { input: number; output: number }>> = Object.freeze({
  judgment: { input: 400, output: 2000 },
  workhorse: { input: 240, output: 1200 },
  mechanical: { input: 5, output: 20 },
});

/**
 * Bumped whenever anything above changes. Recorded on every turn so a
 * historical answer is reproducible (§9.8) — the model ID alone is not enough,
 * because the parameters around it move independently of it.
 */
export const MODEL_CONFIG_REVISION = '2026-08-21.1';

/** What lands in `ChatTurn.modelVersion`. */
export function modelVersionOf(tier: Tier): string {
  return `${MODELS[tier]}@${MODEL_CONFIG_REVISION}`;
}

/** Integer-pence cost of one call. Rounded up: a budget must never under-count. */
export function costPence(tier: Tier, inputTokens: number, outputTokens: number): number {
  const rate = TIER_RATES_PENCE_PER_MTOK[tier];
  return Math.ceil((inputTokens * rate.input + outputTokens * rate.output) / 1_000_000);
}
