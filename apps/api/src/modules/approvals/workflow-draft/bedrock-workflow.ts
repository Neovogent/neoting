import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

import type { AiBudget } from '../../../common/ai-budget.js';
import { costPence, MODELS, TASK_BUDGETS, TASKS } from '../../chat-framework/index.js';
import {
  buildWorkflowInstructions,
  type ModelWorkflowDraft,
  parseModelWorkflowDraft,
  WORKFLOW_TOOL_NAME,
  WORKFLOW_TOOL_SCHEMA,
  workflowDescriptionBlock,
} from './workflow-instructions.js';

/**
 * The model behind "Describe it instead" (review item 52).
 *
 * `bedrock-coding.ts`'s shape, deliberately: the same injected
 * `Pick<AnthropicBedrock, 'messages'>` seam, so the eval runner and any replay
 * transport drive the REAL adapter and no third code path exists.
 *
 * ⚠ **This is the THIRD copy of the forced-tool-call wire** — after
 * `bedrock-extractor.ts` and `bedrock-coding.ts` — and the duplication is
 * recorded rather than removed. Extracting it would mean a shared helper that
 * needs `costPence` (a `modules/chat-framework` seam export) from `common/`,
 * which inverts the layering, or an injected pricing function, which is more
 * machinery than eighty lines. It is worth doing on the day a FOURTH arrives;
 * doing it inside a review package, in a file whose request body is a cassette
 * key, is not the moment.
 *
 * ## Failure is an honest error here, unlike coding
 *
 * `BedrockCodingModel` turns every failure into `null`, because its callers
 * already hold a complete deterministic answer. This one has no such fallback:
 * the accountant clicked "Build the workflow" and is waiting. So a failure
 * returns a REASON, the contract's 503 carries it, and the editor's "Set it up
 * by hand" is the way through — §9.3's floor, which is an honest error with a
 * retry rather than a guess from a model nobody measured.
 */

/** The tier this is billed at — resolved from the SAME task entry that picks the model. */
const WORKFLOW_TIER = TASKS.codingSuggestion.model;
const WORKFLOW_MODEL_ID = MODELS[WORKFLOW_TIER];

/**
 * ⚠ It runs on the JUDGMENT tier by riding `TASKS.codingSuggestion`, and that
 * is a deliberate reuse rather than a new task entry.
 *
 * Compiling a policy is the same class of work as the coding rung — reading an
 * accountant's intent against their own chart — and §9.1's rule is that model
 * IDs are pinned in `models.ts` and imported, never hardcoded. A task entry of
 * its own would be a second place to keep the pin in step for no behavioural
 * difference; the day this task wants a different tier or budget from coding,
 * it earns its own entry and this line is where that starts.
 */
const WORKFLOW_TIMEOUT_MS = TASK_BUDGETS.codingSuggestion.timeoutMs;
const WORKFLOW_MAX_TOKENS = TASK_BUDGETS.codingSuggestion.maxTokens;

export interface BedrockWorkflowModelDeps {
  readonly region: string;
  /** The per-firm daily ceiling (§9.7). Required — an unmetered client does not fail, it spends. */
  readonly budget: AiBudget;
  /** Injected by tests and by the eval runner's replay transport. */
  readonly client?: Pick<AnthropicBedrock, 'messages'>;
  readonly logger?: { warn(message: string): void };
}

export interface WorkflowDraftRequest {
  readonly practiceId: string;
  readonly description: string;
  /** The client's own chart, by NAME. Empty is legal and narrows what the model may say. */
  readonly categoryNames: readonly string[];
}

export type WorkflowDraftAnswer =
  | { readonly ok: true; readonly draft: ModelWorkflowDraft; readonly modelVersion: string }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export class BedrockWorkflowModel {
  readonly modelVersion = WORKFLOW_MODEL_ID;

  private readonly client: Pick<AnthropicBedrock, 'messages'>;

  constructor(private readonly deps: BedrockWorkflowModelDeps) {
    // maxRetries: 0 — retries are OUR decision, the pin every Bedrock client
    // in this repo carries.
    this.client = deps.client ?? new AnthropicBedrock({ awsRegion: deps.region, maxRetries: 0 });
  }

  async draft(request: WorkflowDraftRequest): Promise<WorkflowDraftAnswer> {
    const allowed = await this.budgetAllows(request.practiceId);
    if (!allowed) {
      return {
        ok: false,
        retryable: false,
        reason: 'Your practice has reached its daily AI limit. Set the workflow up by hand, or try again tomorrow.',
      };
    }

    let response: unknown;
    try {
      response = await this.client.messages.create(
        {
          model: WORKFLOW_MODEL_ID,
          max_tokens: WORKFLOW_MAX_TOKENS,
          // Zero, and no thinking with it — the #252 convention, and the reason
          // a replay cassette over this request can exist at all.
          temperature: 0,
          system: buildWorkflowInstructions(request.categoryNames),
          tools: [
            {
              name: WORKFLOW_TOOL_NAME,
              description: 'Record the structured workflow this description compiles to.',
              input_schema: WORKFLOW_TOOL_SCHEMA as unknown as Record<string, unknown>,
            },
          ],
          // Forced: prose is not an answer this path can fill a form with.
          tool_choice: { type: 'tool', name: WORKFLOW_TOOL_NAME },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  // Our question is the last thing said, AFTER the wrapped
                  // description — the instruction that frames it is the system
                  // prompt, outside the wrapper.
                  text: `${workflowDescriptionBlock(request.description)}\n\nCompile this into a workflow.`,
                },
              ],
            },
          ],
        } as Parameters<AnthropicBedrock['messages']['create']>[0],
        { timeout: WORKFLOW_TIMEOUT_MS },
      );
    } catch (error) {
      this.warn(`workflow draft failed (${error instanceof Error ? error.message : String(error)})`);
      return {
        ok: false,
        retryable: true,
        reason: 'The assistant could not be reached. Try again in a moment, or set the workflow up by hand.',
      };
    }

    // Recorded BEFORE the answer is judged: a refusal and an unparseable reply
    // cost what a good answer costs, and metering only successes under-counts
    // precisely on the days something is wrong.
    await this.record(request.practiceId, response);

    if (isObject(response) && response['stop_reason'] === 'refusal') {
      this.warn('workflow draft was declined by the model');
      return { ok: false, retryable: false, reason: 'The assistant declined to answer that. Set it up by hand.' };
    }

    const blocks: readonly { type?: unknown; name?: unknown; input?: unknown }[] =
      isObject(response) && Array.isArray(response['content']) ? (response['content'] as never) : [];
    const call = blocks.find((block) => block.type === 'tool_use' && block.name === WORKFLOW_TOOL_NAME);
    if (call === undefined) {
      this.warn(`workflow draft returned no ${WORKFLOW_TOOL_NAME} call`);
      return { ok: false, retryable: true, reason: 'The assistant answered in a shape this screen cannot fill in.' };
    }

    const draft = parseModelWorkflowDraft(call.input);
    if (draft === null) {
      // ⚠ No retry-once-with-the-error, unlike `invokeStructured`. A human is
      // waiting on a click and the fallback — the form, by hand — is already
      // on screen; doubling the wait to maybe salvage a schema failure is a
      // worse trade here than it is inside a background turn.
      this.warn('workflow draft did not match its schema');
      return { ok: false, retryable: true, reason: 'The assistant answered in a shape this screen cannot fill in.' };
    }

    return { ok: true, draft, modelVersion: WORKFLOW_MODEL_ID };
  }

  private async budgetAllows(practiceId: string): Promise<boolean> {
    try {
      return (await this.deps.budget.check(practiceId)).allowed;
    } catch (error) {
      // A ledger that cannot be read must not become a ledger that is not
      // enforced.
      this.warn(`workflow draft skipped — the spend ledger could not be read (${error instanceof Error ? error.message : String(error)})`);
      return false;
    }
  }

  private async record(practiceId: string, response: unknown): Promise<void> {
    const usage = isObject(response) && isObject(response['usage']) ? (response['usage'] as Record<string, unknown>) : null;
    const input = typeof usage?.['input_tokens'] === 'number' ? (usage['input_tokens'] as number) : 0;
    const output = typeof usage?.['output_tokens'] === 'number' ? (usage['output_tokens'] as number) : 0;
    if (input === 0 && output === 0) return;
    try {
      await this.deps.budget.record(practiceId, costPence(WORKFLOW_TIER, input, output));
    } catch (error) {
      this.warn(`workflow draft: SPEND WAS NOT RECORDED (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private warn(message: string): void {
    this.deps.logger?.warn(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
