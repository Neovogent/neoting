import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../../apps/api/src/modules/chat-framework/provider/model-provider.js';

/**
 * Record once against the real model; replay deterministically forever after.
 *
 * `check.yml` states the requirement plainly on the stage-7 job: *"evals must be
 * deterministic and must not spend Bedrock tokens per PR (§9.7, §13.5). Flip to
 * bedrock only for the scheduled calibration run, never for the merge gate."*
 * A gate that costs money and varies per run is a gate people switch off.
 *
 * So the merge gate replays `evals/recordings/chat-turns.json` — the actual
 * words the pinned model produced on a real calibration run. That keeps three
 * properties at once, which neither a live call nor a hand-written fixture can
 * manage alone:
 *
 * - **It measures the real model.** The recorded answers came out of
 *   `anthropic.claude-opus-4-6-v1`, not out of someone's idea of what it would
 *   say. A hand-written expectation measures the author.
 * - **It is free and deterministic.** Same input, same bytes, every run.
 * - **It cannot silently drift.** The key is a hash of the exact system prompt,
 *   messages and tool schema. Edit the prompt and every key changes, so the
 *   replay MISSES and the run fails telling you to re-record — which is exactly
 *   what §9.8 wants a prompt change to trigger.
 *
 * The last property is why a miss is a hard failure and never a fallthrough to
 * a live call. A gate that quietly reaches for the network the moment its
 * fixture goes stale is a gate that stops being deterministic on precisely the
 * PR that needed it to be.
 */

export interface Recording {
  readonly model: string;
  readonly promptVersion: string;
  readonly recordedAt: string;
  readonly turns: Record<string, ModelResponse>;
}

/** Stable across runs: the whole request as the model actually saw it. */
export function requestKey(request: ModelRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        tier: request.tier,
        system: request.system,
        messages: request.messages,
        toolName: request.toolName,
        toolSchema: request.toolSchema,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

export class ReplayModelProvider implements ModelProvider {
  readonly name = 'demo' as const;

  constructor(private readonly recording: Recording) {}

  static load(path: string): ReplayModelProvider {
    if (!existsSync(path)) {
      throw new Error(
        `no recording at ${path}. Run: AWS_PROFILE=<profile> EVAL_PROVIDER=bedrock EVAL_RECORD=1 pnpm test:eval`,
      );
    }
    return new ReplayModelProvider(JSON.parse(readFileSync(path, 'utf8')) as Recording);
  }

  describe(): string {
    return `${this.recording.model} recorded ${this.recording.recordedAt} (${this.recording.promptVersion})`;
  }

  invoke(request: ModelRequest): Promise<ModelResponse> {
    const key = requestKey(request);
    const hit = this.recording.turns[key];
    if (hit === undefined) {
      // Hard failure, never a live fallthrough. See the header.
      return Promise.reject(
        new Error(
          `no recorded turn for ${key}. The prompt, tool schema or fixture data changed since the recording — ` +
            're-record with EVAL_PROVIDER=bedrock EVAL_RECORD=1 and commit the result.',
        ),
      );
    }
    return Promise.resolve(hit);
  }
}

/** Wraps a live provider and writes every exchange to disk. */
export class RecordingModelProvider implements ModelProvider {
  readonly name = 'bedrock' as const;
  private readonly turns: Record<string, ModelResponse> = {};

  constructor(
    private readonly inner: ModelProvider,
    private readonly meta: { model: string; promptVersion: string; recordedAt: string },
  ) {}

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.inner.invoke(request);
    this.turns[requestKey(request)] = response;
    return response;
  }

  save(path: string): number {
    mkdirSync(dirname(path), { recursive: true });
    const recording: Recording = { ...this.meta, turns: sortKeys(this.turns) };
    // Sorted keys and a trailing newline: this file is committed, and a diff
    // that reorders on every re-record is a diff nobody reads.
    writeFileSync(path, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
    return Object.keys(this.turns).length;
  }
}

function sortKeys(turns: Record<string, ModelResponse>): Record<string, ModelResponse> {
  return Object.fromEntries(Object.entries(turns).sort(([a], [b]) => a.localeCompare(b)));
}
