import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

import { FAMILY_PARAMS, MODELS } from '../models.js';
import {
  ModelAccessError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  ModelUnavailableError,
} from './model-provider.js';

/**
 * The real model call: Amazon Bedrock, eu-west-2, IAM (D22, ADR 0001).
 *
 * **No credentials are constructed here.** `AnthropicBedrock` with no static
 * keys falls through to the AWS default provider chain, which on ECS is the
 * task role — the same role whose policy pins region-scoped foundation-model
 * ARNs and grants no inference profile (§9.1's residency enforcement). Passing
 * keys here would route around the one control that makes D30 true, so the
 * constructor deliberately takes a region and nothing else.
 *
 * ## Why a forced tool call rather than `output_config.format`
 *
 * §9.2 requires schema-enforced output. Forced tool use is the shape that
 * behaves identically on the first-party API and on Bedrock, and §9.1 is
 * explicit that assuming one API shape across providers is the trap. The strict
 * Zod parse downstream is the real gate; this only makes the first attempt
 * likely to pass it.
 *
 * ## Why thinking is off, and temperature is 0
 *
 * §9.1: "deterministic decoding with JSON-schema-enforced outputs —
 * `temperature: 0` on every model family that accepts the parameter". This
 * family accepts it. Extended thinking and `temperature: 0` are mutually
 * exclusive, and forced tool choice does not combine with thinking either — so
 * enabling thinking here would cost determinism AND the output guarantee, on an
 * interactive surface, for a classification task. The `effort` in `TASKS` is
 * recorded on the turn for reproducibility and not sent (`supportsEffortParam`
 * is false for this provider until someone verifies it by live invocation).
 */
export class BedrockModelProvider implements ModelProvider {
  readonly name = 'bedrock' as const;

  constructor(private readonly client: Pick<AnthropicBedrock, 'messages'>) {}

  static fromRegion(awsRegion: string): BedrockModelProvider {
    // maxRetries: 0 — retries are OUR decision, not the SDK's. §9.3 defines the
    // fallback ladder and the breaker counts consecutive failures; an SDK
    // retrying underneath would hide two of every three failures from the
    // breaker and make "3 consecutive failures" mean nine real ones.
    return new BedrockModelProvider(new AnthropicBedrock({ awsRegion, maxRetries: 0 }));
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const modelId = MODELS[request.tier];
    const family = FAMILY_PARAMS[request.tier];

    try {
      const response = await this.client.messages.create(
        {
          model: modelId,
          max_tokens: request.maxTokens,
          // The cache breakpoint sits on the system block, which is the last
          // byte-stable thing in the request (§9.7: caching is mandatory on
          // stable prefixes). Render order is tools → system → messages, so
          // this covers the tool schema too; everything volatile — the client's
          // records, the utterance, the history — is in `messages`, after it.
          //
          // ⚠ MEASURED 21 Aug 2026, eu-west-2, opus-4-6: Bedrock ACCEPTS this
          // and writes nothing. Two live calls with an identical ~1.5k-token
          // prefix both returned cache_creation_input_tokens: 0 and
          // cache_read_input_tokens: 0. So caching is declared and currently
          // ineffective on this provider — every turn is billed at full input
          // rate. Left in place deliberately: it costs nothing, it is correct
          // against the first-party API, and it starts working the day Bedrock
          // honours it. `cacheCreationInputTokens` in the telemetry is what
          // will say so — see this module's CLAUDE.md.
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          tools: [
            {
              name: request.toolName,
              description: 'Reply to the accountant. This is the only way to answer.',
              input_schema: request.toolSchema as { type: 'object' },
            },
          ],
          tool_choice: { type: 'tool', name: request.toolName },
          ...(family.supportsSampling ? { temperature: 0 } : {}),
        },
        { timeout: request.timeoutMs },
      );

      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (toolUse === undefined || toolUse.type !== 'tool_use') {
        // Not a transport failure, so NOT ModelUnavailableError — falling this
        // onto another tier would be answering a schema problem with money.
        // The caller's retry-once (§9.2) handles it, then it raises.
        throw new Error(`model returned no ${request.toolName} tool call (stop_reason: ${response.stop_reason})`);
      }

      return {
        output: toolUse.input,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        modelId,
      };
    } catch (error) {
      if (isAccessFailure(error)) {
        throw new ModelAccessError(`bedrock will not serve ${modelId}`, providerMessage(error));
      }
      if (isAvailabilityFailure(error)) {
        throw new ModelUnavailableError(`bedrock ${modelId} unavailable`, error);
      }
      throw error;
    }
  }
}

/**
 * A permanent refusal to serve this model, as opposed to a bad minute.
 *
 * Every classifier here reads the error STRUCTURALLY rather than with the SDK's
 * error classes: `@anthropic-ai/sdk` is a transitive dependency of the Bedrock
 * SDK, not a declared one here, so importing it would be a phantom dependency
 * that breaks the day the tree is hoisted differently.
 */
function isAccessFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  // 403 is the IAM refusal; 404 is Bedrock's answer for a model the account may
  // not use, which is NOT the same as a model that does not exist — the models
  // list fine either way, which is exactly why this is worth naming.
  return status === 403 || status === 404;
}

function providerMessage(error: unknown): string {
  const nested = (error as { error?: { message?: unknown } }).error?.message;
  if (typeof nested === 'string') return nested;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The §9.3 trigger set: HTTP 5xx, timeout, or 429 after backoff. Everything
 * else is ours to fix, and must not be retried onto another tier.
 */
function isAvailabilityFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return true;

  // Timeouts and connection resets surface as an APIConnectionError/AbortError
  // rather than a status. Name-matched because there is no status to read.
  const name = (error as { name?: unknown }).name;
  return name === 'APIConnectionTimeoutError' || name === 'APIConnectionError' || name === 'AbortError';
}
