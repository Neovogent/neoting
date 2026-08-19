import type { Env } from '../../config/env.js';
import type { DocumentStore } from '../ingestion-routing/index.js';
import type { DocumentExtractor } from './document-extractor.js';
import { DemoExtractor } from './demo-extractor.js';
import { BedrockExtractor } from './bedrock-extractor.js';
import { FallbackExtractor } from './fallback-extractor.js';

/**
 * Pick the extractor from config — never by import, the house pattern shared
 * with `selectIngestQueue` / `selectDocumentStore`.
 *
 *   demo     `DemoExtractor` — deterministic fixture profiles keyed on the
 *            filename. Reads nothing. The default, and what the 21 Aug demo
 *            rehearses on.
 *   bedrock  `BedrockExtractor` — Claude reads the document image (METH Stage
 *            15), wrapped so a throw degrades to the fixture profiles rather
 *            than breaking the pipeline mid-demo.
 *
 * ⚠ THE STORE IS REQUIRED FOR `bedrock` AND ONLY FOR IT. A real extractor needs
 * the bytes; the fixture one never did, which is why this used to take only
 * `Env`. Selecting `bedrock` without a store is a wiring bug, so it throws here
 * at construction rather than returning an extractor that fails on first use.
 */
export function selectExtractor(env: Pick<Env, 'EXTRACTOR' | 'BEDROCK_MODEL_ID' | 'BEDROCK_REGION'>, store?: DocumentStore): DocumentExtractor {
  switch (env.EXTRACTOR) {
    case 'bedrock': {
      if (store === undefined) {
        throw new Error('EXTRACTOR=bedrock needs a DocumentStore to read the document bytes from.');
      }
      const real = new BedrockExtractor({
        store,
        modelId: env.BEDROCK_MODEL_ID,
        region: env.BEDROCK_REGION,
      });
      // DEMO-MOCK: the fallback is a dated demo concession — see
      // fallback-extractor.ts. Post-demo, return `real` directly and let a
      // failed read be a FAILED document with a reason.
      return new FallbackExtractor(real, new DemoExtractor());
    }
    case 'demo':
    default:
      return new DemoExtractor();
  }
}

export { DemoExtractor } from './demo-extractor.js';
export { BedrockExtractor } from './bedrock-extractor.js';
export { FallbackExtractor } from './fallback-extractor.js';
