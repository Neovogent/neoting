import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

import type { AiBudget } from '../../../common/ai-budget.js';
import { costPence, MODELS, TASK_BUDGETS, TASKS } from '../../chat-framework/index.js';
import { BUSINESS_PROFILES } from '../chart-of-accounts/profiles.js';
import type { ClientChartOfAccounts } from '../chart-of-accounts/chart-of-accounts.service.js';
import type { AiCodingSuggestion, CodingEvidence, SuggestionChart } from './ai-suggestion.js';
import type { CapitalisationPolicy } from './capital-revenue.js';
import {
  buildCodingInstructions,
  type ClientCodingContext,
  CODING_TOOL_NAME,
  CODING_TOOL_SCHEMA,
  codingEvidenceBlock,
  parseModelCodingSuggestion,
} from './coding-instructions.js';
import {
  CORRECTION_OPINION_INSTRUCTIONS,
  CORRECTION_OPINION_TOOL_NAME,
  CORRECTION_OPINION_TOOL_SCHEMA,
  type CorrectionOpinion,
  type CorrectionOpinionEvidence,
  correctionOpinionBlock,
  parseCorrectionOpinion,
} from './correction-opinion.js';

/**
 * **The model behind the coding ladder's bottom rung, and behind the correction
 * second opinion** — review items 19, 48's tail, and 22/47's model half.
 *
 * The client half of the split `coding-instructions.ts` and
 * `correction-opinion.ts` describe: everything interesting is in those two
 * files, offline and free to test; this file is the wire, the meter and the
 * refusals. It is `bedrock-extractor.ts`'s shape, deliberately — the same
 * injected `Pick<AnthropicBedrock, 'messages'>` seam, so `EXTRACTOR=replay`
 * serves it from cassettes and no third code path exists.
 *
 * ## ⚠ EVERY FAILURE HERE IS `null`, AND THAT IS THE OPPOSITE OF EXTRACTION
 *
 * `BedrockExtractor` turns a failed read into a FAILED document with a reason,
 * because a document nobody read must not look read. Nothing on this path may
 * do that. Both callers already have a complete, honest answer before this file
 * is reached:
 *
 * - the coding rung is asked only after the DETERMINISTIC suggestion escalated,
 *   and that escalation is a real answer carrying a named reason;
 * - the correction second opinion is an advisory on top of deterministic checks
 *   that already ran, and the ruling is explicit that it *"NEVER blocks when the
 *   model is unreachable — the check silently absent beats coding deadlocked on
 *   Bedrock"*.
 *
 * So a throttle, an expired credential, a budget ceiling, a refusal, an
 * unparseable answer and a cassette miss all come back as `null`, and the caller
 * keeps the answer it had. There is no retry ladder and no degrade chain
 * (`DEGRADE_CHAIN.codingSuggestion` is empty, §9.3 — no lower tier has passed
 * this rung's evals, because until this change there was no rung).
 *
 * ## ⚠ IT RUNS OUTSIDE EVERY TRANSACTION, AND THE COST OF GETTING THAT WRONG IS
 * A TENANT TRANSACTION HELD OPEN ACROSS A NETWORK CALL
 *
 * `scopedDb` runs its callback inside `$transaction` with a **10 second**
 * timeout, and `SupplierCodingService.decide()` is called from inside the
 * extraction pipeline's own transaction. A judgment-tier call takes seconds. So
 * `decide()` stays deterministic and in-transaction, and the model rung is
 * `reconsider()` — a separate call the pipeline makes with no transaction open
 * (`extraction/coding-advice.ts` has the phase map). The approvals module makes
 * the same argument about its ledger follow-up in its own words.
 *
 * The one exception is `secondOpinion`, which the review path DOES call inside a
 * transaction — see {@link SECOND_OPINION_TIMEOUT_MS}, where the reasoning and
 * the rejected alternative are written out.
 *
 * ## Temperature 0, and no thinking
 *
 * `temperature: 0` is the #252 root-cause convention (`bedrock-extractor.ts`:
 * *"the only acceptable variance between two runs over one document is none"*),
 * and here it does a second job — the replay cassette key hashes the request
 * body, so a request that varied would be a fixture that could not exist.
 *
 * ⚠ **`TASKS.codingSuggestion.effort` is `high` and is NOT sent.** For this
 * family `effort` means thinking depth, and `models.ts` records that thinking
 * and `temperature: 0` cannot co-exist (a 400). Determinism wins here for the
 * cassette reason above; the effort value is recorded configuration, exactly as
 * `output_config.effort` is recorded and not sent. Opus 4.6 accepts
 * `temperature` (`FAMILY_PARAMS.judgment.supportsSampling`).
 */

/** The tier whose price list these calls are billed at — resolved from the SAME task entry that picks the model. */
const CODING_TIER = TASKS.codingSuggestion.model;
const CODING_MODEL_ID = MODELS[CODING_TIER];

/**
 * How long the coding rung may take. From the task budget (§9.1), so moving it
 * is a config change rather than a number in a service.
 */
const CODING_TIMEOUT_MS = TASK_BUDGETS.codingSuggestion.timeoutMs;
const CODING_MAX_TOKENS = TASK_BUDGETS.codingSuggestion.maxTokens;

/**
 * ⚠ **The second opinion runs INSIDE the review transaction, and this number is
 * what makes that defensible.**
 *
 * `computeCorrectionAdvisory` is called from `ActionProposalsService.review()`,
 * inside the `scopedDb` transaction that reads the proposal, renders the summary
 * and writes it back. `scopedDb`'s timeout is 10 s, so an unbounded model call
 * there could turn a slow moment at Bedrock into a failed review of a
 * correction, and — worse — hold a tenant transaction open while it did.
 *
 * Four seconds leaves six for the three row reads and the update, which are
 * single-row and local. The trade is real and is worth stating: a slow answer is
 * DISCARDED rather than waited for, so this check is the first thing to go when
 * Bedrock is having a bad minute. That is the correct direction — the ruling
 * says the check must never block a correction, and an accountant who cannot
 * approve a coding fix is a worse outcome than one who does not get a hint.
 *
 * ⚠ **The alternative was considered and rejected as more machinery than the
 * problem.** Computing it before the transaction opens (the pipeline's shape)
 * would mean a pre-read of the proposal row outside the write path, a second
 * read inside it, and a review that reads the same row twice on every kind, to
 * remove up to four seconds from a human-paced, once-per-correction, single-row
 * transaction that takes no locks anybody contends for. If this check ever grows
 * a second model call, or reviews stop being human-paced, revisit it — the seam
 * is a structural reader argument and moving it costs one call site.
 */
export const SECOND_OPINION_TIMEOUT_MS = 4_000;
const SECOND_OPINION_MAX_TOKENS = 256;

export interface BedrockCodingModelDeps {
  readonly region: string;
  /**
   * The per-firm daily ceiling (§9.7). **Required, for `BedrockExtractor`'s
   * reason:** an unmetered model client does not fail, it just spends, and the
   * only defence against a hazard nobody can see is to make the object
   * impossible to build. Two spenders became three.
   */
  readonly budget: AiBudget;
  /** Injected in tests and by `EXTRACTOR=replay`; the real client is built once per instance. */
  readonly client?: Pick<AnthropicBedrock, 'messages'>;
  /** Optional, and absence is silence — this class never fails a caller, so it has nothing to report through. */
  readonly logger?: { warn(message: string): void };
}

/** What the coding rung is asked. */
export interface ModelCodingRequest {
  readonly practiceId: string;
  readonly chart: SuggestionChart;
  readonly policy: CapitalisationPolicy;
  readonly client: ClientCodingContext;
  readonly evidence: CodingEvidence;
}

/** What the second opinion is asked. */
export interface ModelCorrectionRequest {
  readonly practiceId: string;
  readonly evidence: CorrectionOpinionEvidence;
}

/**
 * The client's trade as coding context, from the chart the ladder already
 * resolved.
 *
 * `basis === 'NO_PROFILE'` yields a null label deliberately: `profileId` is
 * `GENERAL_BUSINESS` for a client who answered nothing AND for one whose answers
 * matched no specialist, and telling a model "this client is a general business"
 * when nobody said so is inventing the one fact this context exists to supply.
 * `clientContextBlock` has an honest sentence for the null case.
 */
export function clientCodingContext(chart: ClientChartOfAccounts): ClientCodingContext {
  return {
    tradeLabel: chart.basis === 'NO_PROFILE' ? null : BUSINESS_PROFILES[chart.profileId].label,
    profile: chart.profile,
  };
}

export class BedrockCodingModel {
  readonly modelVersion = CODING_MODEL_ID;

  private readonly client: Pick<AnthropicBedrock, 'messages'>;

  constructor(private readonly deps: BedrockCodingModelDeps) {
    // maxRetries: 0 — the pin `bedrock-extractor.ts` and `bedrock-provider.ts`
    // both carry, for the same reason: retries are OUR decision. Here there are
    // none at all, because a failure is silence and a second attempt would
    // double the latency of a call the caller is waiting on inside a job.
    this.client = deps.client ?? new AnthropicBedrock({ awsRegion: deps.region, maxRetries: 0 });
  }

  /**
   * The `AI_INFERENCE` rung's model half — a code from THIS client's chart, or
   * `null`.
   *
   * Never returns a bare escalation dressed as an answer: `parseModelCodingSuggestion`
   * enforces the chart and turns a refusal into a named `ESCALATE`, and the
   * caller (`SupplierCodingService.reconsider`) keeps the deterministic
   * escalation over a model one — a reason the deterministic layer worked out is
   * more specific than "the model did not pick anything".
   */
  async suggest(request: ModelCodingRequest): Promise<AiCodingSuggestion | null> {
    const answer = await this.call(request.practiceId, 'coding', {
      max_tokens: CODING_MAX_TOKENS,
      system: buildCodingInstructions(request.chart, request.policy, request.client),
      toolName: CODING_TOOL_NAME,
      toolSchema: CODING_TOOL_SCHEMA as unknown as Record<string, unknown>,
      toolDescription: 'Record the coding suggestion for this document.',
      // Our question is the last thing said, AFTER the wrapped document — the
      // instruction that frames it is the system prompt, outside the wrapper.
      text: `${codingEvidenceBlock(request.evidence)}\n\nCode this document.`,
      timeoutMs: CODING_TIMEOUT_MS,
    });
    if (answer === null) return null;
    return parseModelCodingSuggestion(answer, request.chart);
  }

  /**
   * The correction second opinion — closed-set verdicts, or `null`.
   *
   * `null` covers every failure AND a model that answered about nothing. The
   * caller renders no check either way; see `correction-opinion.ts` for why
   * silence rather than a warning is the honest degrade here.
   */
  async secondOpinion(request: ModelCorrectionRequest): Promise<CorrectionOpinion | null> {
    const answer = await this.call(request.practiceId, 'second opinion', {
      max_tokens: SECOND_OPINION_MAX_TOKENS,
      system: CORRECTION_OPINION_INSTRUCTIONS,
      toolName: CORRECTION_OPINION_TOOL_NAME,
      toolSchema: CORRECTION_OPINION_TOOL_SCHEMA as unknown as Record<string, unknown>,
      toolDescription: 'Record what the document does and does not support.',
      text: `${correctionOpinionBlock(request.evidence)}\n\nCheck this correction.`,
      timeoutMs: SECOND_OPINION_TIMEOUT_MS,
    });
    if (answer === null) return null;
    return parseCorrectionOpinion(answer);
  }

  /**
   * One forced tool call, metered, and incapable of throwing.
   *
   * The order is `bedrock-extractor.ts`'s and the reasons are its reasons:
   * **check the ceiling first** (over budget we are not sending this anywhere),
   * **record the spend before the answer is judged** (a refusal and an
   * unparseable reply cost exactly what a good answer costs, and metering only
   * successes under-counts precisely on the days something is wrong).
   */
  private async call(
    practiceId: string,
    what: string,
    request: {
      max_tokens: number;
      system: string;
      toolName: string;
      toolSchema: Record<string, unknown>;
      toolDescription: string;
      text: string;
      timeoutMs: number;
    },
  ): Promise<unknown> {
    const before = await this.budgetAllows(practiceId, what);
    if (!before) return null;

    let response: unknown;
    try {
      response = await this.client.messages.create(
        {
          model: CODING_MODEL_ID,
          max_tokens: request.max_tokens,
          // See the file header: zero, and no thinking with it.
          temperature: 0,
          system: request.system,
          tools: [{ name: request.toolName, description: request.toolDescription, input_schema: request.toolSchema }],
          // Forced: prose is not an answer this path can persist.
          tool_choice: { type: 'tool', name: request.toolName },
          messages: [{ role: 'user', content: [{ type: 'text', text: request.text }] }],
        } as Parameters<AnthropicBedrock['messages']['create']>[0],
        { timeout: request.timeoutMs },
      );
    } catch (error) {
      // ⚠ Every throw is swallowed, and this is the one place in the repo where
      // that is right: a throttle, a 400, an expired credential and a cassette
      // miss all leave the caller with the answer it already had. The WARN is
      // the whole of the report, and a cassette miss deliberately keeps its own
      // message in it — a developer whose replay went stale needs to see the
      // record command, not a shrug.
      this.warn(`coding model: ${what} failed (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }

    await this.record(practiceId, response);

    if (isObject(response) && response['stop_reason'] === 'refusal') {
      this.warn(`coding model: ${what} was declined by the model`);
      return null;
    }

    const blocks: readonly { type?: unknown; name?: unknown; input?: unknown }[] = isObject(response) && Array.isArray(response['content']) ? (response['content'] as never) : [];
    const call = blocks.find((block) => block.type === 'tool_use' && block.name === request.toolName);
    if (call === undefined) {
      this.warn(`coding model: ${what} returned no ${request.toolName} call`);
      return null;
    }
    return call.input;
  }

  /** Over the ceiling is a WARN and silence — never a document failure, unlike extraction's NT-EXT-008. */
  private async budgetAllows(practiceId: string, what: string): Promise<boolean> {
    try {
      const verdict = await this.deps.budget.check(practiceId);
      if (verdict.allowed) return true;
      this.warn(`coding model: ${what} skipped — this practice has reached its daily AI limit`);
      return false;
    } catch (error) {
      // A ledger that cannot be read must not become a ledger that is not
      // enforced. `RedisAiBudget.check` already fails closed on a corrupt value;
      // this closes the connection-level case the same way.
      this.warn(`coding model: ${what} skipped — the spend ledger could not be read (${error instanceof Error ? error.message : String(error)})`);
      return false;
    }
  }

  /** Tokens → pence, on the firm's daily ledger. `costPence` rounds up, so the meter never under-counts. */
  private async record(practiceId: string, response: unknown): Promise<void> {
    const usage = isObject(response) && isObject(response['usage']) ? (response['usage'] as Record<string, unknown>) : null;
    const input = typeof usage?.['input_tokens'] === 'number' ? (usage['input_tokens'] as number) : 0;
    const output = typeof usage?.['output_tokens'] === 'number' ? (usage['output_tokens'] as number) : 0;
    if (input === 0 && output === 0) return;
    try {
      await this.deps.budget.record(practiceId, costPence(CODING_TIER, input, output));
    } catch (error) {
      // A meter that throws must not undo an answer that succeeded — but an
      // unrecorded spend is exactly the invisible hazard the required-budget
      // argument above is about, so it is loud.
      this.warn(`coding model: SPEND WAS NOT RECORDED (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private warn(message: string): void {
    this.deps.logger?.warn(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
