import { invokeStructured } from '../../apps/api/src/modules/chat-framework/invoke-structured.js';
import { modelVersionOf } from '../../apps/api/src/modules/chat-framework/models.js';
import {
  ModelTurnSchema,
  RESPOND_TOOL_NAME,
  RESPOND_TOOL_SCHEMA,
} from '../../apps/api/src/modules/chat-framework/prompts/output-schema.js';
import { SYSTEM_PROMPT } from '../../apps/api/src/modules/chat-framework/prompts/system-prompt.js';
import { BedrockModelProvider } from '../../apps/api/src/modules/chat-framework/provider/bedrock-provider.js';
import { CircuitBreaker } from '../../apps/api/src/modules/chat-framework/provider/circuit-breaker.js';
import { buildMessages } from '../../apps/api/src/modules/chat-framework/chat.service.js';
import { FIXTURE_CATEGORIES, fixtureRecords } from './fixture-client.js';

/**
 * ONE live Bedrock call, so a misconfiguration costs one request instead of a
 * whole eval run.
 *
 * It answers the three questions the unit tests structurally cannot: does the
 * credential chain reach a principal with `bedrock:InvokeModel`, does the
 * pinned model accept the request shape this repo builds (forced tool +
 * temperature 0 + a cached system block), and does prompt caching actually
 * report a hit on the second call.
 *
 * Not part of `test:eval` — the gate scores a corpus; this proves the wire.
 */
async function main(): Promise<void> {
  const provider = BedrockModelProvider.fromRegion(process.env.BEDROCK_REGION ?? 'eu-west-2');
  const breaker = new CircuitBreaker();

  const ask = (utterance: string) =>
    invokeStructured(provider, breaker, {
      task: 'chatWorkspace',
      schema: ModelTurnSchema,
      system: SYSTEM_PROMPT,
      messages: buildMessages(utterance, [], fixtureRecords(), FIXTURE_CATEGORIES, 'smoke', 'prac_smoke'),
      toolName: RESPOND_TOOL_NAME,
      toolSchema: RESPOND_TOOL_SCHEMA,
      traceId: 'smoke',
      practiceId: 'prac_smoke',
      businessId: 'biz_smoke',
    });

  console.log(`\nsmoke — ${modelVersionOf('judgment')}\n`);

  const first = await ask('Whenever Bidfood invoices arrive, code them Cost of Sales Food with standard VAT');
  console.log('call 1  intent:', first.value.intent);
  console.log('        rule:  ', JSON.stringify(first.value.rule));
  console.log('        reply: ', first.value.reply);
  console.log(`        tokens: in ${first.inputTokens} out ${first.outputTokens} cacheRead ${first.cachedInputTokens} cacheWrite ${first.cacheCreationInputTokens}`);
  console.log(`        ${first.latencyMs}ms, ${first.costPence}p\n`);

  // Same system prefix, different question — this is where a cache hit shows.
  const second = await ask('what did we pay Currys');
  console.log('call 2  intent:', second.value.intent);
  console.log('        cited: ', JSON.stringify(second.value.grounded?.citedRecordIds));
  console.log('        reply: ', second.value.reply);
  console.log(`        tokens: in ${second.inputTokens} out ${second.outputTokens} cacheRead ${second.cachedInputTokens} cacheWrite ${second.cacheCreationInputTokens}`);
  console.log(`        ${second.latencyMs}ms, ${second.costPence}p\n`);

  if (second.cachedInputTokens > 0) console.log('prompt cache: HIT');
  else if (first.cacheCreationInputTokens === 0)
    console.log('prompt cache: NOT HONOURED — cache_control was accepted but nothing was written');
  else console.log('prompt cache: written but not read — something per-request is invalidating the prefix');
  console.log('\nOK\n');
}

await main();
