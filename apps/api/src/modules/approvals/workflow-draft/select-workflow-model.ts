import type { AiBudget } from '../../../common/ai-budget.js';
import { replayBedrockMessages } from '../../../common/bedrock-replay.js';
import type { Env } from '../../../config/env.js';
import { BedrockWorkflowModel } from './bedrock-workflow.js';

/**
 * Pick the workflow-draft model from config — never by import, the house
 * pattern (`selectExtractor` / `selectCodingModel` / `selectSmsSender`).
 *
 * ## ⚠ It keys on `AI_CHAT`, where `selectCodingModel` keys on `EXTRACTOR`
 *
 * That file's argument for reusing `EXTRACTOR` is that the coding rung reads
 * the same document, in the same job, on the same meter as the extractor. None
 * of that is true here. This task is an accountant TALKING to the assistant —
 * free text in, a structured intent out, one call per click, nothing to do with
 * a document — which is exactly what `AI_CHAT` already names. A build with the
 * chat runtime on and workflow drafting off, or the reverse, would describe an
 * environment nobody wants, and that is the same test applied to the other
 * switch rather than a different one.
 *
 * `AI_CHAT=demo` therefore gets no model, and the operation answers an honest
 * 503 pointing at "Set it up by hand". ⚠ **The demo stand-in is deliberately
 * NOT extended to this task.** `chat-framework/CLAUDE.md` says why in as many
 * words: that switch *"degrades the judgement while the screen looks
 * identical"*, and a stand-in that filled a policy form with plausible stages
 * would be the same class of wrong one surface over — an accountant would save
 * it. A refusal with a working manual path is the honest degrade.
 *
 * `replay` behaves as it does everywhere: the REAL adapter with
 * `messages.create` served from cassettes, so the request building, the Zod
 * parse and the budget metering all run offline. Both `demo` and `replay` are
 * already refused under `NODE_ENV=production` by `config/env.ts`, so this
 * switch needs no gate of its own.
 */
export function selectWorkflowModel(
  env: Pick<Env, 'AI_CHAT' | 'BEDROCK_REGION'>,
  budget: AiBudget,
  logger?: { warn(message: string): void },
): BedrockWorkflowModel | undefined {
  switch (env.AI_CHAT) {
    case 'replay':
    case 'bedrock':
      return new BedrockWorkflowModel({
        region: env.BEDROCK_REGION,
        budget,
        ...(logger === undefined ? {} : { logger }),
        ...(env.AI_CHAT === 'replay' ? { client: replayBedrockMessages() } : {}),
      });
    case 'demo':
    default:
      return undefined;
  }
}
