import { replayBedrockMessages } from '../../../common/bedrock-replay.js';
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
  switch (env.AI_CHAT) {
    case 'bedrock':
      return BedrockModelProvider.fromRegion(env.BEDROCK_REGION);
    // `replay` is the REAL adapter — request building, forced-tool narrowing,
    // §9.2's schema retry above it, §9.3's error classification — with the
    // transport served from recorded cassettes (`common/bedrock-replay.ts`).
    // A miss fails loudly naming the record command; it never falls through to
    // live Bedrock. Refused in production (`env.ts`). The provider still names
    // itself `bedrock`, which is what it is: the same class, whose recorded
    // answers came out of (or are shaped exactly like) that provider's wire.
    case 'replay':
      return new BedrockModelProvider(replayBedrockMessages());
    case 'demo':
    default:
      return new DemoModelProvider();
  }
}
