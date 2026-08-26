import type { Env } from '../../config/env.js';
import type { DocumentStore } from '../ingestion-routing/index.js';
import type { DocumentExtractor } from './document-extractor.js';
import { DemoExtractor } from './demo-extractor.js';
import { BedrockExtractor } from './bedrock-extractor.js';

/**
 * Pick the extractor from config — never by import, the house pattern shared
 * with `selectIngestQueue` / `selectDocumentStore`.
 *
 *   demo     `DemoExtractor` — deterministic fixture profiles keyed on the
 *            filename. Reads nothing. The default.
 *   bedrock  `BedrockExtractor` — Claude reads the document image. One model,
 *            one attempt; a failed read is a FAILED document with a reason.
 *
 * ⚠ THERE IS NO FALLBACK, AND THERE MUST NOT BE ONE. A `FallbackExtractor` used
 * to wrap the real reader here, catching a throw and answering with
 * `DemoExtractor`'s output for the same real client document. It was written as
 * a dated concession for the 21 Aug demo and its own header said it must not
 * survive as an error-handling strategy. It has been deleted, because the demo
 * has passed and the failure mode is severe: for a filename matching no demo
 * keyword, `genericProfile()` invents a supplier, total, tax, reference, VAT
 * number and category — every field non-null — so `resolveProcessedState` reads
 * READY and the pipeline stamps invented financial data onto a real client's
 * document at 0.8 confidence, marked ready to post. A Bedrock throttle, an
 * expired credential or an oversized image was enough to trigger it, and the
 * only trace was a WARN that does not survive into the record a human approves.
 *
 * A failed read must be a failed read. `BedrockExtractor` already answers
 * `ok: false` with an NT- code for every refusal it can characterise, and those
 * land the document in FAILED with a visible reason, retryable through a
 * reprocess proposal.
 *
 * ⚠ THE STORE IS REQUIRED FOR `bedrock` AND ONLY FOR IT. A real extractor needs
 * the bytes; the fixture one never did, which is why this used to take only
 * `Env`. Selecting `bedrock` without a store is a wiring bug, so it throws here
 * at construction rather than returning an extractor that fails on first use.
 */
export function selectExtractor(env: Pick<Env, 'EXTRACTOR' | 'BEDROCK_REGION'>, store?: DocumentStore): DocumentExtractor {
  switch (env.EXTRACTOR) {
    case 'bedrock': {
      if (store === undefined) {
        throw new Error('EXTRACTOR=bedrock needs a DocumentStore to read the document bytes from.');
      }
      return new BedrockExtractor({ store, region: env.BEDROCK_REGION });
    }
    case 'demo':
    default:
      return new DemoExtractor();
  }
}

export { DemoExtractor } from './demo-extractor.js';
export { BedrockExtractor } from './bedrock-extractor.js';
