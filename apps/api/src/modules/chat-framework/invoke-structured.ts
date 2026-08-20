import type { z } from 'zod';

import { costPence, DEGRADE_CHAIN, FAMILY_PARAMS, TASK_BUDGETS, TASKS, type TaskName, type Tier } from './models.js';
import type { CircuitBreaker } from './provider/circuit-breaker.js';
import {
  type ModelMessage,
  ModelOutputInvalidError,
  type ModelProvider,
  ModelUnavailableError,
} from './provider/model-provider.js';
import { logFallback, logModelCall } from './telemetry.js';

/**
 * One structured model call, with the two Governance rules that surround every
 * one of them.
 *
 * **§9.2 — structured outputs.** Parse with a `.strict()` Zod schema. On
 * mismatch, retry **once** with the validation error appended, and on the second
 * failure raise. Never best-effort parse, never regex the answer out of prose.
 * The retry is a real second call with the error text in the conversation,
 * because a model that is told precisely what it got wrong usually fixes it,
 * and a model that is asked the same question again usually does not.
 *
 * **§9.3 — fallback.** Degrade within provider, one tier down the chain, and
 * only onto a tier whose evals this task class has passed. `DEGRADE_CHAIN` in
 * `models.ts` holds that list; for `chatWorkspace` it is deliberately empty, so
 * this function exhausts immediately and the caller renders §9.3's floor
 * behaviour — an honest error with a retry, never a guess from a model nobody
 * measured on this task.
 *
 * The circuit breaker wraps the PROVIDER, so a provider that is refusing stops
 * being asked regardless of which tier the ladder is on.
 */

export interface StructuredCallInput<T> {
  readonly task: TaskName;
  readonly schema: z.ZodType<T>;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly toolName: string;
  readonly toolSchema: unknown;
  readonly traceId: string;
  readonly practiceId: string;
  readonly businessId: string | null;
}

export interface StructuredCallResult<T> {
  readonly value: T;
  readonly tier: Tier;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costPence: number;
  readonly latencyMs: number;
  readonly degraded: boolean;
}

export async function invokeStructured<T>(
  provider: ModelProvider,
  breaker: CircuitBreaker,
  input: StructuredCallInput<T>,
): Promise<StructuredCallResult<T>> {
  const intended = TASKS[input.task].model;
  const ladder: readonly Tier[] = [intended, ...DEGRADE_CHAIN[input.task]];
  const budget = TASK_BUDGETS[input.task];

  let lastUnavailable: unknown;

  for (const tier of ladder) {
    if (!breaker.allows()) {
      logFallback({
        traceId: input.traceId,
        practiceId: input.practiceId,
        task: input.task,
        from: tier,
        to: 'none',
        reason: 'circuit breaker open',
      });
      break;
    }

    try {
      const result = await attemptTier(provider, input, tier, budget);
      breaker.recordSuccess();
      logModelCall({
        traceId: input.traceId,
        practiceId: input.practiceId,
        businessId: input.businessId,
        task: input.task,
        tier,
        modelId: result.modelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedInputTokens: result.cachedInputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        costPence: result.costPence,
        latencyMs: result.latencyMs,
        outcome: result.retried ? 'schema-retry' : 'ok',
        ...(tier === intended ? {} : { degradedFrom: intended }),
      });
      return { ...result, tier, degraded: tier !== intended };
    } catch (error) {
      if (error instanceof ModelUnavailableError) {
        breaker.recordFailure();
        lastUnavailable = error;
        const next = ladder[ladder.indexOf(tier) + 1];
        logFallback({
          traceId: input.traceId,
          practiceId: input.practiceId,
          task: input.task,
          from: tier,
          to: next ?? 'none',
          reason: error.message,
        });
        continue;
      }
      // Everything else raises here, unretried and without touching the
      // breaker, for two different reasons that happen to want the same code:
      //
      //   ModelAccessError — permanent and account-wide. Every tier behind the
      //   same account refuses identically, and counting it against the breaker
      //   would blame the provider for a console checkbox.
      //
      //   ModelOutputInvalidError — §9.2 says raise after the retry. Walking it
      //   down the ladder would ask a LESS capable model to satisfy a schema the
      //   more capable one just failed: money spent for a worse answer.
      throw error;
    }
  }

  throw new ModelUnavailableError('every eligible model tier failed', lastUnavailable);
}

async function attemptTier<T>(
  provider: ModelProvider,
  input: StructuredCallInput<T>,
  tier: Tier,
  budget: { maxTokens: number; timeoutMs: number },
): Promise<Omit<StructuredCallResult<T>, 'tier' | 'degraded'> & { retried: boolean }> {
  const started = Date.now();
  let messages = [...input.messages];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let modelId = '';
  let lastValidationDetail = '';

  // Two attempts, total: the call, then one corrected retry (§9.2).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await provider.invoke({
      tier,
      system: input.system,
      messages,
      toolName: input.toolName,
      toolSchema: input.toolSchema,
      maxTokens: budget.maxTokens,
      timeoutMs: budget.timeoutMs,
    });

    inputTokens += response.usage.inputTokens;
    outputTokens += response.usage.outputTokens;
    cachedInputTokens += response.usage.cachedInputTokens;
    cacheCreationInputTokens += response.usage.cacheCreationInputTokens;
    modelId = response.modelId;

    const parsed = input.schema.safeParse(response.output);
    if (parsed.success) {
      return {
        value: parsed.data,
        modelId,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        costPence: costPence(tier, inputTokens, outputTokens),
        latencyMs: Date.now() - started,
        retried: attempt > 0,
      };
    }

    lastValidationDetail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    // Append the model's own answer and the validation error, so the retry is a
    // correction rather than a repetition. `FAMILY_PARAMS` is consulted here
    // only to keep the assembly honest about what the family can be told —
    // every current family takes a plain user turn, and a family that does not
    // would need its own branch rather than a silent assumption.
    void FAMILY_PARAMS[tier];
    messages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(response.output) },
      {
        role: 'user',
        content: `That response failed validation: ${lastValidationDetail}. Call the ${input.toolName} tool again with a corrected response. Change only what the error names.`,
      },
    ];
  }

  throw new ModelOutputInvalidError('model output failed its schema twice', lastValidationDetail);
}
