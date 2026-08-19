/**
 * `FallbackExtractor` — try the real reader, fall back to the fixture one.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT.
 *
 * This is a DEMO SAFETY NET with a deliberately short life. A throttle, a
 * credential expiry, a region blip or a model outage during the 21 Aug client
 * demo would otherwise kill the beat the whole story is built on. With this, the
 * pipeline degrades to the deterministic fixture profiles and the demo continues.
 *
 * It is NOT an error-handling strategy for the real product, and it must not
 * survive as one. In production, an extraction that fails should land the
 * document in FAILED with a reason and be retryable — which is exactly what
 * `BedrockExtractor` already returns for a refusal, an unreadable answer or an
 * unsupported type. Those are ANSWERS and they pass through untouched. What this
 * catches is the class below them: the call did not complete at all.
 *
 * ⚠ THE FALLBACK IS FICTION, AND IT IS LOGGED AS SUCH. `DemoExtractor` returns
 * hand-authored fixture data keyed on the filename — it does not read the image.
 * A silent substitution would mean a client's document showing a confident
 * supplier and total that came from nowhere. Every fallback logs a WARNING
 * naming the document, and `// DEMO-MOCK` marks the whole file. Post-demo the
 * correct change is to delete this class and let failures be failures.
 */

import { Logger } from '@nestjs/common';

import { type DocumentExtractor, type ExtractionOutcome, type ExtractionRequest } from './document-extractor.js';

// DEMO-MOCK: delete this wrapper post-demo. A failed read must become a FAILED
// document with a reason (the Rejected/Failed surface already renders it and a
// reprocess proposal already retries it), never fixture data wearing a client's
// filename.
export class FallbackExtractor implements DocumentExtractor {
  private readonly logger = new Logger(FallbackExtractor.name);

  constructor(
    private readonly primary: DocumentExtractor,
    private readonly fallback: DocumentExtractor,
  ) {}

  async extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
    try {
      // An `ok: false` outcome is a considered answer — "I read it and could
      // not use it" — and is returned unchanged. Only a THROW reaches the catch.
      return await this.primary.extract(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `extract: the real extractor threw for ${request.filename} (hash ${request.byteHash.slice(0, 12)}) — ` +
          `FALLING BACK TO FIXTURE DATA, which does not read the image. Reason: ${reason}`,
      );
      return this.fallback.extract(request);
    }
  }
}
