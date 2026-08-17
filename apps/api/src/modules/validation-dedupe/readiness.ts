import type { Document as DocumentRow } from '@prisma/client';

/**
 * Readiness evaluation — issue #80, SoT §4 Stage 5.
 *
 * READY requires at minimum **Total + Supplier + Category**, computed from the
 * document's denormalised header fields (the projection the accepted
 * extraction writes — see prisma/CLAUDE.md open question 3). Anything absent,
 * or a failed validator, puts the document in TO_REVIEW instead: a human
 * finishes what the pipeline could not, and nothing half-read is ever
 * presented as ready to publish.
 *
 * ⚠ THE CONFIDENCE SEAM IS DELIBERATELY EMPTY. SoT Stage 5 gates readiness on
 * per-field confidence thresholds that are EVAL-CALIBRATED — they come out of
 * `pnpm test:eval` runs over the labelled corpus, and they do not exist yet.
 * Do not invent numbers here: a made-up 0.85 would gate real documents on a
 * threshold nobody measured. When calibration lands, it arrives as a new
 * field on {@link ReadinessContext} and a term in {@link evaluateReadiness} —
 * this comment is the seam's marker.
 */

export const READY_REQUIRED_FIELDS = ['total', 'supplier', 'category'] as const;
export type ReadinessField = (typeof READY_REQUIRED_FIELDS)[number];

/** What readiness reads off a document. A projection, so fakes stay small. */
export type ReadinessInput = Pick<DocumentRow, 'totalPence' | 'supplierName' | 'categoryCode'>;

export interface ReadinessContext {
  /**
   * A deterministic validator (packages/validators — VAT arithmetic, VRN,
   * dates, currency) said no. A validator failure blocks READY regardless of
   * field presence: the fields being *there* is not the same as the fields
   * being *coherent*.
   */
  readonly validatorFailed?: boolean;
}

export interface Readiness {
  readonly ready: boolean;
  /** What a human still has to supply, by name — empty exactly when ready would be true on fields alone. */
  readonly missing: readonly ReadinessField[];
  readonly blockedByValidator: boolean;
}

export function evaluateReadiness(document: ReadinessInput, context: ReadinessContext = {}): Readiness {
  const missing: ReadinessField[] = [];
  // null and 0 differ on purpose: a £0.00 credit line is a real total, an
  // unextracted one is not. Supplier and category are trimmed because a
  // whitespace-only value is an extraction artefact, not an answer.
  if (document.totalPence === null) missing.push('total');
  if (document.supplierName === null || document.supplierName.trim() === '') missing.push('supplier');
  if (document.categoryCode === null || document.categoryCode.trim() === '') missing.push('category');

  const blockedByValidator = context.validatorFailed === true;
  return { ready: missing.length === 0 && !blockedByValidator, missing, blockedByValidator };
}

/**
 * The state a processed document should land in: READY only when every
 * required field is present and no validator failed; TO_REVIEW otherwise.
 * This is the one place that choice is made, so the pipeline and the
 * unarchive-restore path (#81) cannot disagree about it.
 */
export function resolveProcessedState(document: ReadinessInput, context: ReadinessContext = {}): 'READY' | 'TO_REVIEW' {
  return evaluateReadiness(document, context).ready ? 'READY' : 'TO_REVIEW';
}
