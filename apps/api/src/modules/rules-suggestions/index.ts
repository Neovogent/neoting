/**
 * The public seam of rules-suggestions (Boundaries, `apps/api/CLAUDE.md`).
 *
 * What is exported here is the whole of what other modules' code may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional.
 *
 * Three consumers are named in advance, and each is the reason a name below is
 * on the seam rather than inside a service. All three are **one line** at the
 * call site — this module was shaped so that none of them is a rewrite:
 *
 * - **A7 / A9 · the export.** The VT emitter's `Analysis account` column must
 *   carry the ledger prefix — literally `Cost of sales: Purchases`. Map a
 *   document's `categoryCode` with `resolveAccount` + `analysisAccount`, or
 *   read the ready-made `{ code, name }` pairs off
 *   `ChartOfAccountsService.getChartOfAccounts(...).categories`, where `name`
 *   is already in that form.
 * - **A11 · client intake.** One call to
 *   `ChartOfAccountsService.ensureChartOfAccounts(ctx, businessId)` after the
 *   intake transaction commits gives the new client its chart immediately. It
 *   is an *optimisation*, not a requirement: every read seeds on first use, so
 *   a client that was never seeded gets a chart the first time anything asks.
 * - **The extraction pipeline (`modules/extraction`).** It already honours an
 *   active `SUPPLIER_CUSTOMER` rule by exact `scopeKey` match — that half needs
 *   no change. `SupplierCodingService.decide(db, businessId, supplierName)`
 *   takes a `ScopedClient`, so it can be consulted inside the pipeline's own
 *   transaction if a future stage wants the `LEARNED_HISTORY` rung to code a
 *   first read as well.
 *
 * ⚠ **Nothing on this seam writes `documents.category_code`, and nothing on it
 * writes a `rules` row.** A `CodingDecision` is a read; a `SupplierRuleProposal`
 * is a payload for `POST /v1/action-proposals`. Governance §10 has no exception
 * for a rule that is probably right.
 */

// The chart of accounts — D47's substitute for a ledger-synced one (§24.4.1).
export {
  analysisAccount,
  type ChartAccount,
  ChartAccountSchema,
  type Ledger,
  LEDGERS,
  resolveAccount,
  splitAnalysisAccount,
  TAX_CONSEQUENCES,
  type TaxConsequence,
  VAT_TREATMENTS,
  type VatTreatment,
} from './chart-of-accounts/account.js';

export {
  type ChartBasis,
  type ChartCategory,
  type ChartOfAccounts,
  chartOfAccountsFor,
  toCategories,
} from './chart-of-accounts/chart-of-accounts.js';

export {
  CHART_OF_ACCOUNTS_LIST_KIND,
  CHART_PAYLOAD_VERSION,
  ChartOfAccountsService,
  type ChartSource,
  type ClientChartOfAccounts,
} from './chart-of-accounts/chart-of-accounts.service.js';

export {
  BUSINESS_PROFILE_IDS,
  BUSINESS_PROFILES,
  type BusinessProfileDefinition,
  type BusinessProfileId,
} from './chart-of-accounts/profiles.js';

// The authority order — absolute, and the reason this module exists at all.
export {
  authorityForTier,
  authorityRank,
  CODING_AUTHORITIES,
  type CodingAuthority,
  outranks,
  RULE_TIER_PRECEDENCE,
} from './coding/authority.js';

export { type CodingDecision, type CodingLock, isCoded, type SupplierContext } from './coding/coding-decision.js';

// The AI_INFERENCE rung — a SUGGESTION, never a coding. Read `ai-suggestion.ts`
// before rendering one: `provenance` and `confidence` are on it because §13.3
// requires a surface to show an AI-produced value as one.
export {
  type AiCodingSuggestion,
  BASIS_SENTENCES,
  CONFIDENCE_FLOOR,
  type CodingEvidence,
  documentReconciles,
  NEW_SUPPLIER_CONFIDENCE_PENALTY,
  NO_CODING_EVIDENCE,
  SECOND_CHOICE_CONFIDENCE,
  suggestCoding,
  type SuggestionChart,
} from './coding/ai-suggestion.js';

// Tier 2 — this client's own remembered treatment of a supplier (review item
// 48). Pure; the confidence is CONSISTENCY, computed rather than looked up.
export {
  MEMORY_BASE_CONFIDENCE,
  MEMORY_CONFIDENCE_PER_REPEAT,
  MEMORY_MAX_CONFIDENCE,
  memoryConfidence,
  type SupplierMemoryHistory,
  supplierMemorySuggestion,
} from './coding/supplier-memory.js';

/**
 * Tier 3 — the model. **The only runtime export on this seam that opens a
 * socket**, and it is here for the reason the extractor's own adapter is
 * reachable from `worker/main.ts`: a composition root has to be able to build
 * it, and two of them do (the worker for the coding rung, `approvals.module.ts`
 * for the correction second opinion, which runs in the api process).
 *
 * `selectCodingModel` is the only sanctioned constructor — it keys on
 * `EXTRACTOR` and its file argues why. Nothing else in the product should build
 * a `BedrockCodingModel` by hand; an unmetered one is deliberately impossible,
 * but an unselected one would be a fifth environment nobody chose.
 */
export {
  BedrockCodingModel,
  type BedrockCodingModelDeps,
  clientCodingContext,
  type ModelCodingRequest,
  type ModelCorrectionRequest,
  SECOND_OPINION_TIMEOUT_MS,
} from './coding/bedrock-coding.js';
export { selectCodingModel } from './coding/select-coding-model.js';

// The second opinion's pure half — the verdict vocabulary `validation-dedupe`
// turns into a `CorrectionCheck`, and the offline prompt/parse behind it.
export {
  AGREEMENT_VERDICTS,
  type AgreementVerdict,
  CORRECTION_OPINION_INSTRUCTIONS,
  CORRECTION_OPINION_PROMPT_VERSION,
  CORRECTION_OPINION_TOOL_NAME,
  CORRECTION_OPINION_TOOL_SCHEMA,
  type CorrectionOpinion,
  type CorrectionOpinionEvidence,
  correctionOpinionBlock,
  parseCorrectionOpinion,
  PRESENCE_VERDICTS,
  type PresenceVerdict,
} from './coding/correction-opinion.js';

export {
  type CapitalisationPolicy,
  capitalisesAsHardware,
  classifyLine,
  CODING_BASES,
  type CodingBasis,
  type CodingLine,
  type LineContext,
  type LineTreatment,
  type LineVerdict,
  PLATFORM_DEFAULT_CAPITALISATION_POLICY,
  thresholdVerdictFor,
  treatmentOf,
} from './coding/capital-revenue.js';

export {
  ADVISORY_NOTES,
  CODING_ADVISORIES,
  CODING_ESCALATION_REASONS,
  type CodingAdvisory,
  type CodingEscalationReason,
  ESCALATION_PROMPTS,
  escalationSeverity,
  MODEL_ANSWERABLE_ESCALATIONS,
  moreSevere,
} from './coding/escalation.js';

// The model-facing half: the instructions, the tool schema and the strict parse
// that refuses an off-chart code. No client, no credentials, no network.
export {
  buildCodingInstructions,
  type ClientCodingContext,
  CODING_DECISION_RULES,
  CODING_OUTPUT_RULES,
  CODING_PROMPT_VERSION,
  CODING_TOOL_NAME,
  CODING_TOOL_SCHEMA,
  codingEvidenceBlock,
  MAX_REASONING_CHARS,
  type ModelCodingAnswer,
  modelCodingAnswer,
  parseModelCodingSuggestion,
  sanitiseReasoning,
} from './coding/coding-instructions.js';

export {
  buildSupplierRulePayload,
  buildSupplierRuleProposal,
  type SupplierRuleProposal,
  type SupplierRuleRefusal,
} from './coding/rule-proposal.js';

export {
  // The one mapping from a ladder decision to the opinion a surface renders —
  // including this client's remembered treatment, which had no consumer before
  // 6 Sep 2026 (review item 48).
  codingSuggestionFor,
  HISTORY_WINDOW,
  // On the seam because the extraction pipeline consults `decide()` on a
  // document it has just read but not yet written, so it holds the line items in
  // memory rather than in `extractions.fields`. Reading them through the SAME
  // parser `resolveForDocument` uses is what stops the first read and every
  // later one disagreeing about what the document's lines say.
  readStoredLines,
  type SupplierCodingResult,
  SupplierCodingService,
  type SupplierHistory,
  type SupplierHistoryEntry,
} from './coding/supplier-coding.service.js';

export { normaliseSupplierKey, sameSupplier } from './supplier-key.js';

// The module and its DI tokens, so a consuming module can
// `imports: [RulesSuggestionsModule]` and `@Inject(...)`.
export { RulesSuggestionsModule } from './rules-suggestions.module.js';
export { CHART_OF_ACCOUNTS_SERVICE, SUPPLIER_CODING_SERVICE } from './tokens.js';
