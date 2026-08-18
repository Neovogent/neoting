import type { Env } from '../../config/env.js';
import type { DocumentExtractor } from './document-extractor.js';
import { DemoExtractor } from './demo-extractor.js';

/**
 * Pick the extractor from config — never by import, the house pattern shared with
 * `selectIngestQueue` / `selectDocumentStore`. `demo` is the only value today
 * (METH Stage 4); Textract lands behind the same seam post-demo.
 */
export function selectExtractor(_env: Pick<Env, 'EXTRACTOR'>): DocumentExtractor {
  // Only `demo` exists, and the enum makes it the only value the type admits, so
  // the switch is a single arm — kept as a switch so adding `textract` is a
  // compile-guided edit, not a search for the call site.
  return new DemoExtractor();
}

export { DemoExtractor } from './demo-extractor.js';
