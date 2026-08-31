import { expect, test } from 'vitest';

import { replayBedrockMessages } from '../../common/bedrock-replay.js';
import { loadEnv } from '../../config/env.js';
import { invokeStructured } from './invoke-structured.js';
import { BedrockModelProvider } from './provider/bedrock-provider.js';
import { CircuitBreaker } from './provider/circuit-breaker.js';
import { DemoModelProvider } from './provider/demo-provider.js';
import { selectModelProvider } from './provider/select-model-provider.js';
import { CHAT_REPLAY_CASES, type ChatReplayCase } from './replay-corpus.js';

/**
 * `AI_CHAT=replay` through the REAL call path, against the COMMITTED cassettes.
 *
 * `invokeStructured` → `BedrockModelProvider` all run for real — request
 * assembly, forced-tool narrowing, §9.2's schema retry, the strict Zod parse —
 * with only `messages.create` served from `fixtures/cassettes/bedrock/`. The
 * expectations are pinned to the current cassettes; a re-record that changes
 * an answer updates them in the same commit (the eval-recording contract).
 */

function caseNamed(name: string): ChatReplayCase {
  const found = CHAT_REPLAY_CASES.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no chat replay corpus case named ${name}`);
  return found;
}

function replayProvider(): BedrockModelProvider {
  return new BedrockModelProvider(replayBedrockMessages());
}

test('the three AI_CHAT values select what they say: stand-in, real, and real-over-cassettes', () => {
  expect(selectModelProvider(loadEnv({}))).toBeInstanceOf(DemoModelProvider);
  expect(selectModelProvider(loadEnv({ AI_CHAT: 'bedrock' } as NodeJS.ProcessEnv))).toBeInstanceOf(BedrockModelProvider);
  // Replay is the SAME adapter class — a dedicated provider would be a third
  // code path, which is exactly what the mode exists to avoid.
  expect(selectModelProvider(loadEnv({ AI_CHAT: 'replay' } as NodeJS.ProcessEnv))).toBeInstanceOf(BedrockModelProvider);
});

test('a replayed turn runs the real provider and comes back parsed, priced and attributable', async () => {
  const kase = caseNamed('happy-turn');

  const result = await invokeStructured(replayProvider(), new CircuitBreaker(), kase.input);

  // Through the strict ModelTurnSchema — the same gate a live answer passes.
  expect(result.value.intent).toBe('SHOW_INBOX');
  expect(result.value.navigation?.statusFilter).toBe('review');
  // `costPence` is what chat.service.ts records against the per-firm ledger
  // (§9.7): a replayed call feeds the meter exactly as a live one does.
  expect(result.costPence).toBeGreaterThan(0);
  expect(result.degraded).toBe(false);
});

test("§9.2's retry runs FOR REAL over cassettes: bad first answer, corrected second, both recorded exchanges served", async () => {
  const kase = caseNamed('schema-retry');

  const result = await invokeStructured(replayProvider(), new CircuitBreaker(), kase.input);

  // The corrected second answer is what comes back…
  expect(result.value.intent).toBe('LIVE_RULE');
  expect(result.value.rule?.supplier).toBe('Bidfood');
  // …and the token count is the SUM of both exchanges, which is only possible
  // if the real retry assembled the correction request (the model's JSON plus
  // the validation error) and the cassette recorded under THAT key answered.
  const recordedInputTokens = kase.syntheticResponses
    .map((response) => (response as { usage: { input_tokens: number } }).usage.input_tokens)
    .reduce((sum, tokens) => sum + tokens, 0);
  expect(kase.syntheticResponses).toHaveLength(2);
  expect(result.inputTokens).toBe(recordedInputTokens);
});

test('an unrecorded conversation misses loudly, naming the record command — never live Bedrock', async () => {
  const kase = caseNamed('happy-turn');
  const unrecorded = {
    ...kase.input,
    messages: [{ role: 'user' as const, content: 'The accountant says: something never recorded.' }],
  };

  const attempt = invokeStructured(replayProvider(), new CircuitBreaker(), unrecorded);

  // The miss carries no `status` and none of the availability names, so the
  // provider's classifier rethrows it intact: no tier fallback, no breaker
  // count, no money spent chasing a missing fixture.
  await expect(attempt).rejects.toThrow(/no cassette/);
  await expect(attempt).rejects.toThrow(/record:cassettes/);
});
