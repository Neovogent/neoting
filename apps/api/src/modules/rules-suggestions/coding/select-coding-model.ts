import { replayBedrockMessages } from '../../../common/bedrock-replay.js';
import type { AiBudget } from '../../../common/ai-budget.js';
import type { Env } from '../../../config/env.js';
import { BedrockCodingModel } from './bedrock-coding.js';

/**
 * Pick the coding model from config — never by import, the house pattern shared
 * with `selectExtractor` / `selectOcrReader` / `selectSmsSender`.
 *
 * ## ⚠ IT KEYS ON `EXTRACTOR`, AND THAT IS A DECISION, NOT A SHORTCUT
 *
 * The obvious move was a fourth switch (`CODING_MODEL=demo|bedrock|replay`).
 * `EXTRACTOR` is the right one to reuse, for four reasons that all point the
 * same way:
 *
 * 1. **It is the same document, in the same job, on the same meter.** The coding
 *    rung runs immediately after the extractor, over what the extractor read,
 *    metered against the same per-firm daily ledger (§9.7). A switch that could
 *    say "read this document with a real model but do not code it with one" —
 *    or, worse, the reverse — describes an environment nobody wants.
 * 2. **`EXTRACTOR=demo` means the document was never read.** `DemoExtractor`
 *    derives supplier, date and total from a hash of the filename. Sending a
 *    judgment-tier model to reason about what a fictional supplier sold is spend
 *    on a question with no answer, so `demo` gets no model rung and the
 *    deterministic ladder stands exactly as it did — which is also what keeps a
 *    laptop offline and free.
 * 3. **The production boot gates already cover it.** `config/env.ts` refuses
 *    `EXTRACTOR=demo` and `EXTRACTOR=replay` under `NODE_ENV=production`, with
 *    the argument written out at each. A new switch would need its own two
 *    gates, its own `.env.example` entry, its own row in
 *    `scripts/check-env-parity.mjs`, and its own line in two Terraform
 *    environments — four places for a fifth environment nobody asked for.
 * 4. **Staging needs no infrastructure change.** `EXTRACTOR` is in
 *    `common_environment` in `infra/envs/staging/services.tf`, so BOTH the api
 *    and the workers task families already carry it — which matters because the
 *    two consumers live in different processes: the coding rung runs in the
 *    worker, the correction second opinion in the api.
 *
 * `replay` behaves exactly as it does for extraction: the REAL adapter with
 * `messages.create` served from `fixtures/cassettes/bedrock/`, so the request
 * building, the Zod parse and the budget metering all run offline. A miss is a
 * loud `CassetteMissError` naming the record command; it never falls through to
 * live Bedrock.
 *
 * ⚠ **`undefined` is a supported configuration, not a degraded one** — the same
 * stance `ocr` takes in the extraction pipeline. Without a model the ladder is
 * the deterministic one it has been since 2 Sep 2026: rules, practice defaults,
 * this client's own history, then the rule-based suggestion. Nothing downstream
 * branches on having one.
 */
export function selectCodingModel(
  env: Pick<Env, 'EXTRACTOR' | 'BEDROCK_REGION'>,
  budget: AiBudget,
  logger?: { warn(message: string): void },
): BedrockCodingModel | undefined {
  switch (env.EXTRACTOR) {
    case 'replay':
    case 'bedrock':
      return new BedrockCodingModel({
        region: env.BEDROCK_REGION,
        budget,
        ...(logger === undefined ? {} : { logger }),
        ...(env.EXTRACTOR === 'replay' ? { client: replayBedrockMessages() } : {}),
      });
    case 'demo':
    default:
      return undefined;
  }
}
