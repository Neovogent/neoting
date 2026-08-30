/**
 * Record the Bedrock replay cassettes (`EXTRACTOR=replay` / `AI_CHAT=replay`).
 *
 * ## Running it
 *
 *   pnpm --filter @neoting/api record:cassettes            # synthetic — offline, free
 *   pnpm --filter @neoting/api record:cassettes -- --live  # real Bedrock — needs AWS credentials, costs pennies
 *
 * (`packages/contracts` must be built first — `pnpm build` on a cold clone —
 * for the same reason every bare `tsx` run of this app needs it.)
 *
 * ## What it does
 *
 * Runs the REAL adapters — `BedrockExtractor` and `invokeStructured` →
 * `BedrockModelProvider` — over the canonical corpora
 * (`src/modules/extraction/replay-corpus.ts`,
 * `src/modules/chat-framework/replay-corpus.ts`) with a recording transport
 * wrapped around `messages.create`, and writes one cassette per exchange into
 * `fixtures/cassettes/bedrock/`. The adapters build every request; nothing
 * here assembles a prompt, so the recorded keys are the keys replay will
 * compute. Recording through the real code is what keeps that true — the same
 * argument as `scripts/measure/extraction-cost.ts`'s tapped client.
 *
 * ## Synthetic vs live
 *
 * Without `--live`, the transport is scripted from each corpus case's
 * `syntheticResponses` — shape-faithful answers, marked `synthetic: true` in
 * cassette metadata. With `--live`, the happy-path cases run against real
 * Bedrock (the pinned models, eu-west-2, the AWS default credential chain) and
 * record what the model actually said; at the measured ~1.3p/document this
 * whole set is pennies. Two cases are ALWAYS synthetic, because a live model
 * cannot be made to misbehave on demand:
 *
 *   - extraction `malformed-answer` — proves replay drives the real Zod-parse
 *     failure path (`NT-EXT-006`);
 *   - chat `schema-retry` — proves replay drives §9.2's real retry assembly.
 *
 * ## Redaction
 *
 * Structural and unconditional: every write goes through
 * `RecordingBedrockClient`, which sweeps ARNs, account ids, request/message
 * ids, emails and phone numbers out of the response before it can land in a
 * committed fixture (`common/bedrock-replay.ts`). The request body is never
 * stored at all — only its hash.
 *
 * Re-run whenever a replay test fails on a cassette miss: that means a prompt,
 * tool schema, model pin or corpus input moved, which is the mechanism working.
 */

import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

import { InMemoryAiBudget } from '../src/common/ai-budget.js';
import {
  type BedrockMessagesCreate,
  DEFAULT_CASSETTE_DIR,
  RecordingBedrockClient,
  recordingBedrockMessages,
} from '../src/common/bedrock-replay.js';
import { invokeStructured } from '../src/modules/chat-framework/invoke-structured.js';
import { BedrockModelProvider } from '../src/modules/chat-framework/provider/bedrock-provider.js';
import { CircuitBreaker } from '../src/modules/chat-framework/provider/circuit-breaker.js';
import { CHAT_REPLAY_CASES } from '../src/modules/chat-framework/replay-corpus.js';
import { BedrockExtractor } from '../src/modules/extraction/bedrock-extractor.js';
import { EXTRACTION_REPLAY_CASES } from '../src/modules/extraction/replay-corpus.js';
import type { DocumentStore } from '../src/modules/ingestion-routing/index.js';

const LIVE = process.argv.includes('--live');
const REGION = process.env.BEDROCK_REGION ?? 'eu-west-2';

/** The corpus cases that must stay synthetic even under --live. See the header. */
const ALWAYS_SYNTHETIC = new Set(['malformed-answer', 'schema-retry']);

/** Bytes from memory instead of S3 — the measure script's stand-in, for the same reason. */
function storeOf(bytes: Buffer): DocumentStore {
  return { get: () => Promise.resolve(bytes) } as unknown as DocumentStore;
}

/** The real wire. Constructed once, only under --live. */
function liveCreate(): BedrockMessagesCreate {
  const real = new AnthropicBedrock({ awsRegion: REGION, maxRetries: 0 });
  return (body, options) =>
    (real.messages.create as unknown as (b: unknown, o?: unknown) => Promise<unknown>)(body, options);
}

/** Scripted answers, in call order — exhausting them is a corpus bug, said plainly. */
function scripted(responses: readonly Record<string, unknown>[]): BedrockMessagesCreate {
  let served = 0;
  return () => {
    const next = responses[served];
    if (next === undefined) {
      return Promise.reject(new Error(`scripted transport exhausted after ${served} answers — the corpus case promises too few syntheticResponses`));
    }
    served += 1;
    return Promise.resolve(structuredClone(next));
  };
}

async function main(): Promise<void> {
  const recordedAt = new Date().toISOString().slice(0, 10);
  process.stdout.write(`\nRecording Bedrock replay cassettes -> ${DEFAULT_CASSETTE_DIR}\n`);
  process.stdout.write(`  mode   ${LIVE ? `LIVE (region ${REGION} — this spends real money, pennies)` : 'synthetic (offline, free)'}\n\n`);

  const wire = LIVE ? liveCreate() : undefined;

  for (const kase of EXTRACTION_REPLAY_CASES) {
    const synthetic = wire === undefined || ALWAYS_SYNTHETIC.has(kase.name);
    const recorder = new RecordingBedrockClient(
      synthetic ? scripted([kase.syntheticResponse]) : wire,
      DEFAULT_CASSETTE_DIR,
      { synthetic, recordedAt },
    );
    recorder.description = kase.description;

    // The REAL extractor: real prompt assembly, real size guards, real Zod
    // parse, real metering (against a throwaway ledger — recording measures
    // nothing, so the ceiling only needs to not bite).
    const extractor = new BedrockExtractor({
      store: storeOf(kase.bytes),
      region: REGION,
      budget: new InMemoryAiBudget(1_000_000),
      client: recordingBedrockMessages(recorder),
    });
    const outcome = await extractor.extract(kase.request);
    process.stdout.write(
      `  extraction/${kase.name}${synthetic ? ' (synthetic)' : ''}: ${outcome.ok ? 'read' : outcome.failure.code}\n`,
    );
  }

  for (const kase of CHAT_REPLAY_CASES) {
    const synthetic = wire === undefined || ALWAYS_SYNTHETIC.has(kase.name);
    const recorder = new RecordingBedrockClient(
      synthetic ? scripted(kase.syntheticResponses) : wire,
      DEFAULT_CASSETTE_DIR,
      { synthetic, recordedAt },
    );
    recorder.description = kase.description;

    // The REAL call path: invokeStructured owns §9.2's retry, so a corpus case
    // whose first answer fails the schema records BOTH exchanges — the second
    // keyed off the correction request the real code assembles.
    const provider = new BedrockModelProvider(recordingBedrockMessages(recorder));
    const result = await invokeStructured(provider, new CircuitBreaker(), kase.input);
    process.stdout.write(
      `  chat/${kase.name}${synthetic ? ' (synthetic)' : ''}: intent ${result.value.intent}, ${result.inputTokens} in + ${result.outputTokens} out tokens\n`,
    );
  }

  process.stdout.write('\ndone. Commit the cassette files with the change that required re-recording.\n\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
