import type { ExtractionRequest } from './document-extractor.js';

/**
 * The canonical replay corpus for `EXTRACTOR=replay` — the ONE definition of
 * which extraction requests have cassettes.
 *
 * Three consumers, and the coupling is the point:
 *
 * - `scripts/record-cassettes.ts` runs the REAL `BedrockExtractor` over exactly
 *   these requests and records the exchanges into
 *   `fixtures/cassettes/bedrock/`.
 * - `replay-extractor.test.ts` runs the same extractor over the same requests
 *   with the replay transport, proving the committed cassettes drive the real
 *   code — the request building, the Zod parse, the budget metering.
 * - A developer running `EXTRACTOR=replay` gets a deterministic answer for
 *   these requests and a loud, named miss for anything else.
 *
 * Change a request here, or anything that shapes the request (the system
 * prompt, the tool schema, the model pin), and every cassette key moves: the
 * replay tests fail on a miss that names the record command. That is the
 * eval-recording property (`evals/src/replay-provider.ts`), on purpose — a
 * fixture that cannot silently go stale.
 *
 * `syntheticResponse` is what the recorder writes when it has no AWS
 * credentials (or for the malformed case, always): shape-faithful to a real
 * InvokeModel answer, marked `synthetic: true` in the cassette. A live
 * re-record (`--live`) replaces the happy-path answers with the real model's;
 * the replay tests pin the CURRENT cassette contents, so a live re-record that
 * changes an answer updates those expectations in the same commit — the same
 * contract the eval recordings live under.
 */

export interface ExtractionReplayCase {
  readonly name: string;
  readonly description: string;
  readonly request: ExtractionRequest;
  /** What the DocumentStore serves on the byte path. Empty on the OCR path, which never fetches. */
  readonly bytes: Buffer;
  /** Recorded verbatim (post-redaction) when not recording live. */
  readonly syntheticResponse: Record<string, unknown>;
}

/**
 * A real, deterministic 1×1 PNG. Deliberately committed bytes rather than an
 * image rendered at record time: the cassette key hashes the request, the
 * request carries the base64 bytes, and a renderer whose output shifts by one
 * byte across versions or platforms would orphan the cassette. A live
 * recording against this image reads almost nothing — which is a legitimate
 * recording of the byte path's request shape, not a defect.
 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** OCR lines shaped like the Bidfood receipt the measure script renders. */
const RECEIPT_OCR_LINES: readonly string[] = [
  'BIDFOOD WHOLESALE LTD',
  '18 Priory Road, Manchester M3 4LX',
  'VAT No. GB 412 8836 21',
  'SALES INVOICE',
  'Invoice No. BF-2026-118374',
  'Date 04/08/2026',
  '12 x Beef patties 6oz (case) 84.60',
  '8 x Brioche buns (pack of 48) 39.20',
  '4 x Vegetable oil 20L 112.00',
  'Subtotal 235.80',
  'VAT @ 20% 47.16',
  'TOTAL DUE 282.96',
];

export const EXTRACTION_REPLAY_CASES: readonly ExtractionReplayCase[] = [
  {
    name: 'receipt-image',
    description: 'extraction · byte path (image block) · happy read',
    request: {
      filename: 'replay-receipt.png',
      byteHash: 'replay-receipt-image',
      s3Key: 'cassettes/replay-receipt-image',
      mimeType: 'image/png',
      practiceId: 'prac_replay',
    },
    bytes: ONE_PIXEL_PNG,
    syntheticResponse: {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_REDACTED',
          name: 'record_extraction',
          input: {
            docType: 'RECEIPT',
            supplierName: 'BIDFOOD WHOLESALE LTD',
            customerName: null,
            documentDate: '2026-08-04',
            dueDate: null,
            currency: 'GBP',
            totalPence: 28296,
            taxPence: 4716,
            netPence: 23580,
            reference: 'BF-2026-118374',
            vatNumber: 'GB 412 8836 21',
            lineItems: [
              { description: '12 x Beef patties 6oz (case)', quantity: 12, totalPence: 8460, taxPence: null },
              { description: '8 x Brioche buns (pack of 48)', quantity: 8, totalPence: 3920, taxPence: null },
              { description: '4 x Vegetable oil 20L', quantity: 4, totalPence: 11200, taxPence: null },
            ],
            confidence: { supplier: 0.97, date: 0.96, total: 0.98, tax: 0.95 },
          },
        },
      ],
      usage: { input_tokens: 3122, output_tokens: 424 },
    },
  },
  {
    name: 'invoice-ocr',
    description: 'extraction · OCR text path · happy read',
    request: {
      filename: 'replay-invoice.pdf',
      byteHash: 'replay-invoice-ocr',
      s3Key: 'cassettes/replay-invoice-ocr',
      mimeType: 'application/pdf',
      practiceId: 'prac_replay',
      ocr: {
        pages: [{ pageNumber: 1, grid: [], lines: [...RECEIPT_OCR_LINES] }],
        grid: [],
        text: RECEIPT_OCR_LINES.join('\n'),
      },
    },
    bytes: Buffer.alloc(0),
    syntheticResponse: {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_REDACTED',
          name: 'record_extraction',
          input: {
            docType: 'INVOICE',
            supplierName: 'BIDFOOD WHOLESALE LTD',
            customerName: null,
            documentDate: '2026-08-04',
            dueDate: null,
            currency: 'GBP',
            totalPence: 28296,
            taxPence: 4716,
            netPence: 23580,
            reference: 'BF-2026-118374',
            vatNumber: 'GB 412 8836 21',
            lineItems: [],
            confidence: { supplier: 0.99, date: 0.98, total: 0.99, tax: 0.98 },
          },
        },
      ],
      usage: { input_tokens: 812, output_tokens: 288 },
    },
  },
  {
    // ⚠ ALWAYS SYNTHETIC, even under --live: a real model cannot be made to
    // misbehave on demand, and this cassette exists to prove the replay path
    // exercises the REAL Zod-parse failure (`NT-EXT-006`) — `docType` has no
    // `.catch()`, so an invented enum value and a missing `confidence` fail the
    // parse rather than being papered over.
    name: 'malformed-answer',
    description: 'extraction · OCR text path · malformed model output (SYNTHETIC by design)',
    request: {
      filename: 'replay-malformed.pdf',
      byteHash: 'replay-malformed',
      s3Key: 'cassettes/replay-malformed',
      mimeType: 'application/pdf',
      practiceId: 'prac_replay',
      ocr: {
        pages: [{ pageNumber: 1, grid: [], lines: ['A DOCUMENT THE MODEL ANSWERS BADLY'] }],
        grid: [],
        text: 'A DOCUMENT THE MODEL ANSWERS BADLY',
      },
    },
    bytes: Buffer.alloc(0),
    syntheticResponse: {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_REDACTED',
          name: 'record_extraction',
          // Not the shape the tool schema demands: an invented docType and no
          // confidence object. `input_schema` instructs; it does not enforce —
          // which is exactly why the adapter's Zod parse exists.
          input: { docType: 'NOT_A_TYPE', supplierName: 'Acme Ltd' },
        },
      ],
      usage: { input_tokens: 640, output_tokens: 41 },
    },
  },
];
