import type { Env } from '../../../config/env.js';
import { BedrockModelProvider } from './bedrock-provider.js';
import { DemoModelProvider } from './demo-provider.js';
import type { ModelProvider } from './model-provider.js';

/**
 * Config-selected, never import-selected — the house pattern (`selectExtractor`,
 * `selectSmsSender`, `selectDocumentStore`, `selectLedgerAdapter`).
 *
 * The consequence that matters: `chat.service.ts` has one code path and never
 * learns which provider it got. A test injects the demo provider, staging gets
 * Bedrock, and neither is a branch inside the service.
 */
export function selectModelProvider(env: Env): ModelProvider {
  return env.AI_CHAT === 'bedrock' ? BedrockModelProvider.fromRegion(env.BEDROCK_REGION) : new DemoModelProvider();
}
