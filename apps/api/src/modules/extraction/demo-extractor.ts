/**
 * `DemoExtractor` (METH Stage 4): a deterministic fixture extractor behind the
 * real `DocumentExtractor` interface. Keyed by filename keyword, hash-derived
 * fallback, per-field confidence and provenance — the demo is a real system with
 * a fake vendor, not a fake system.
 *
 * // DEMO-MOCK: Textract + the Sonnet→Opus→human vision ladder replaces this.
 */

import {
  DEMO_EXTRACTOR_KIND,
  DEMO_MODEL_VERSION,
  type DocumentExtractor,
  type ExtractionOutcome,
  type ExtractionRequest,
} from './document-extractor.js';
import { DEMO_PROFILES, FAILURE_KEYWORDS, genericProfile } from './demo-profiles.js';

export class DemoExtractor implements DocumentExtractor {
  readonly kind = DEMO_EXTRACTOR_KIND;
  readonly modelVersion = DEMO_MODEL_VERSION;

  async extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
    // Match keywords against whole filename TOKENS, not raw substrings: a substring
    // match mis-codes real uploads — `shell` would fire on `shellfish-invoice`,
    // `just` on `adjustment-note`, and the `blank` failure keyword on `blanket-
    // order`, quietly failing or mis-classifying a good document. Splitting on
    // non-alphanumerics and matching a whole token keeps `just-eat-payout` → Just
    // Eat while leaving `adjustment` alone.
    const tokens = new Set(request.filename.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

    if (FAILURE_KEYWORDS.some((keyword) => tokens.has(keyword))) {
      // A genuinely unreadable document — visible in the Rejected/Failed surface
      // with a reason, and retryable (a reprocess proposal), never a silent drop.
      return {
        ok: false,
        failure: {
          code: 'NT-EXT-001',
          message: 'This document could not be read — it looks blank or too degraded to extract. Re-upload a clearer copy.',
        },
      };
    }

    const matched = DEMO_PROFILES.find(([keyword]) => tokens.has(keyword));
    const profile = matched ? matched[1] : genericProfile(request.byteHash);
    return profile();
  }
}
