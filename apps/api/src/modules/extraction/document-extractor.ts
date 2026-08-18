/**
 * The `DocumentExtractor` interface (METH Stage 4, SoT §4 Stage 2).
 *
 * Extraction is the step where a document finally leaves RECEIVED: header fields,
 * per-field confidence and provenance, a document classification, and coding
 * suggestions. Textract plus the vision-escalation ladder is the committed real
 * implementation (D20); this interface is the seam it drops in behind, exactly
 * like `DocumentStore` / `IngestQueue` / `DocumentExtractor`'s siblings.
 *
 * // DEMO-MOCK: `DemoExtractor` is the only implementation today. Textract +
 * // the Sonnet→Opus→human vision ladder replaces it post-demo, behind THIS
 * // interface, selected by env — no call site changes.
 */

import type { DocumentType } from '@prisma/client';

/** The house extractor kind + model version stamped on every demo extraction. */
export const DEMO_EXTRACTOR_KIND = 'demo';
export const DEMO_MODEL_VERSION = 'demo-extractor-1';

/** Source-of-Truth §13.3 provenance, mirrored from the contract `ProvenanceClass`. */
export type ProvenanceClass = 'HUMAN_CONFIRMED' | 'DETERMINISTIC' | 'AI_SUGGESTED';

/**
 * One extracted value and everything needed to judge it — the contract's
 * `ExtractedField`. Money is integer pence; dates are `YYYY-MM-DD`; everything
 * else a string. `confidence` is present for `AI_SUGGESTED`, null otherwise.
 */
export interface ExtractedField {
  readonly value: string | number | boolean | null;
  readonly provenance: ProvenanceClass;
  readonly confidence: number | null;
  /** What produced it — the extractor id, or a rule/guidance id for DETERMINISTIC. */
  readonly source: string | null;
}

/** A line on the document — the contract's `Extraction.lineItems[]` shape. */
export interface ExtractedLineItem {
  readonly description: ExtractedField;
  readonly quantity: ExtractedField;
  readonly totalPence: ExtractedField;
  readonly taxPence: ExtractedField;
}

/**
 * A deterministic validator verdict (`packages/validators` will produce these for
 * real). A failure sends the document to To Review regardless of field presence
 * — rules beat model opinions (SoT §4 Stage 2). Pre-computed per demo profile.
 */
export interface ValidatorVerdict {
  readonly ok: boolean;
  readonly detail?: string;
}

/** A coding suggestion (SoT §4 Stage 4) — one row per suggested field. */
export interface CodingSuggestion {
  readonly field: string;
  readonly value: string;
  readonly confidence: number;
  readonly reasoning: string;
}

/**
 * A successfully-read document. `categoryCode` is the coding the extractor would
 * pick with NO rule in play; the pipeline overrides it when a supplier rule is in
 * scope (single-tier match). `null` on a header field means the extractor left it
 * for a human — which is how a document lands in To Review rather than Ready,
 * without inventing a confidence threshold (that seam is eval-calibrated and
 * deliberately empty — see validation-dedupe/readiness.ts).
 */
export interface ExtractedDocument {
  readonly docType: DocumentType;
  readonly supplierName: string | null;
  readonly customerName: string | null;
  /** `YYYY-MM-DD`, or null when unread. */
  readonly documentDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string | null;
  readonly totalPence: number | null;
  readonly taxPence: number | null;
  readonly reference: string | null;
  readonly vatNumber: string | null;
  /** The extractor's default coding, before any rule override. Null → To Review. */
  readonly categoryCode: string | null;
  /** The per-field map written to `extractions.fields` (contract `ExtractedField`). */
  readonly fields: Readonly<Record<string, ExtractedField>>;
  readonly lineItems: readonly ExtractedLineItem[];
  readonly validatorResults: Readonly<Record<string, ValidatorVerdict>>;
  /** True when any validator verdict failed — blocks Ready (readiness.ts). */
  readonly validatorFailed: boolean;
  readonly overallConfidence: number;
  readonly suggestions: readonly CodingSuggestion[];
}

/** Why a document could not be read — lands it FAILED with a visible reason. */
export interface ExtractionFailure {
  /** A stable NT- machine code (§13.4). */
  readonly code: string;
  /** Plain English a client can act on. */
  readonly message: string;
}

export type ExtractionOutcome =
  | { readonly ok: true; readonly document: ExtractedDocument }
  | { readonly ok: false; readonly failure: ExtractionFailure };

/** What the extractor is given: the sanitised bytes' identity, never the bytes. */
export interface ExtractionRequest {
  /** The submitter-facing filename (already basename-reduced upstream). */
  readonly filename: string;
  /** Content hash of the sanitised bytes — the deterministic key for a fixture. */
  readonly byteHash: string;
}

export interface DocumentExtractor {
  extract(request: ExtractionRequest): Promise<ExtractionOutcome>;
}

/** An AI-suggested field: carries confidence and the extractor id as its source. */
export function aiField(value: string | number | boolean | null, confidence: number): ExtractedField {
  return { value, provenance: 'AI_SUGGESTED', confidence, source: DEMO_MODEL_VERSION };
}
