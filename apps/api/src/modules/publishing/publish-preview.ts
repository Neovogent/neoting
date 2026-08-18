/**
 * The server-computed publish preview and the per-item minimum (METH Stage 10,
 * SoT §4 Stage 10).
 *
 * Pure functions, no database, no clock: the same three inputs give the same
 * three numbers whether they are computed at proposal time (to fill
 * `PublishBatchPayload.preview`, which is exactly what Read review renders —
 * "Publish 43 bills to Xero — gross £84,925, VAT £10,402") or re-computed at
 * execution time. The contract's description is normative on that second run:
 * execution RE-VALIDATES the minimum, and an item that no longer meets it
 * refuses with `NT-PUB-001` "rather than publishing half-coded books".
 *
 * ⚠ THE MINIMUM IS NOT DEFINED HERE. Total + Supplier + Category is the
 * READINESS rule (`validation-dedupe/readiness.ts`, SoT Stage 5), reached
 * through that module's public seam. Publishing asking the same question a
 * second way is how the two answers drift, and the drift would show up as a
 * document that is Ready on the inbox and unpublishable in the batch. What
 * publishing owns is the CONSEQUENCE — the code, the wording, and the refusal.
 */

import { evaluateReadiness, type ReadinessField, type ReadinessInput } from '../validation-dedupe/index.js';

/**
 * `NT-PUB-001` — "document not publishable, mandatory fields missing". This
 * one IS in the contract's `ErrorCode` enum, because it is an HTTP answer: the
 * proposal is refused before it is created, or execution refuses before it
 * posts. Row-level ledger failures use the codes in ledger-adapter.ts.
 */
export const PUBLISH_MINIMUM_CODE = 'NT-PUB-001';

/**
 * What a preview reads off a document: the readiness projection (total,
 * supplier, category) plus its identity and its VAT. Deliberately a
 * projection, not the row, so a caller can build one and a test can fake one.
 */
export interface PublishPreviewItem extends ReadinessInput {
  readonly id: string;
  readonly taxPence: number | null;
}

/** The `PublishBatchPayload.preview` object, exactly. Integer pence, both. */
export interface PublishPreview {
  readonly itemCount: number;
  readonly grossPence: number;
  readonly vatPence: number;
}

/** One document that may not enter a batch, and precisely why. */
export interface PublishItemRefusal {
  readonly documentId: string;
  readonly code: typeof PUBLISH_MINIMUM_CODE;
  /** By name, so the message and the UI can both say WHICH fields. */
  readonly missing: readonly ReadinessField[];
  readonly message: string;
}

export type PublishPreviewOutcome =
  | { readonly ok: true; readonly preview: PublishPreview }
  | { readonly ok: false; readonly refusals: readonly PublishItemRefusal[] };

/** Plain English for the accountant reading the refusal, not for a log line. */
const FIELD_WORDS: Readonly<Record<ReadinessField, string>> = {
  total: 'total',
  supplier: 'supplier',
  category: 'category',
};

/**
 * The per-item minimum. Null when the document may be published; a refusal
 * naming the missing fields when it may not.
 *
 * A failed deterministic validator is NOT consulted here on purpose: it blocks
 * READY, and a document that is not READY cannot legally transition to
 * PUBLISHED anyway (the state machine owns that gate). Re-checking it here
 * would be the same second-opinion drift the file header warns about.
 */
export function checkPublishMinimum(item: PublishPreviewItem): PublishItemRefusal | null {
  const { missing } = evaluateReadiness(item);
  if (missing.length === 0) return null;

  return {
    documentId: item.id,
    code: PUBLISH_MINIMUM_CODE,
    missing,
    message: `This document has no ${listWords(missing.map((field) => FIELD_WORDS[field]))}. A bill enters a publish batch only with a total, a supplier and a category — fill in what is missing, then propose the publish again.`,
  };
}

/**
 * The totals. **Integer adds only** (R5): gross is the sum of `totalPence`,
 * VAT the sum of `taxPence`. No rate is applied, no percentage is derived and
 * nothing is rounded, because there is nothing here to round — the per-document
 * figures were rounded once, at extraction, and re-deriving VAT from a rate
 * would silently disagree with the document.
 *
 * A null `taxPence` contributes nothing. It is not the same as £0.00 VAT (a
 * confirmed zero, which a non-VAT-registered client's bills genuinely carry),
 * but the preview must publish an integer, and the minimum does not require
 * VAT — Total + Supplier + Category is the whole rule.
 *
 * An empty list sums to zero, and that is left to say so rather than refuse:
 * the contract's `minItems: 1` on `documentIds` is what rejects an empty
 * batch, at the boundary, before anything gets here.
 */
export function computePublishPreview(items: readonly PublishPreviewItem[]): PublishPreview {
  let grossPence = 0;
  let vatPence = 0;
  for (const item of items) {
    grossPence += item.totalPence ?? 0;
    vatPence += item.taxPence ?? 0;
  }
  return { itemCount: items.length, grossPence, vatPence };
}

/**
 * The composition both call sites use: every item is checked BEFORE any total
 * is offered, so a preview never describes a batch that cannot run. All
 * refusals are returned, not the first — one round trip tells a human
 * everything they have to fix.
 */
export function previewPublishBatch(items: readonly PublishPreviewItem[]): PublishPreviewOutcome {
  const refusals = items.map(checkPublishMinimum).filter((refusal): refusal is PublishItemRefusal => refusal !== null);
  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, preview: computePublishPreview(items) };
}

/** `[a]` → `a` · `[a,b]` → `a and b` · `[a,b,c]` → `a, b and c`. */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}
