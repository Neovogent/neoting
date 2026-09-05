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
 * ⚠ A PLACEHOLDER IS NOT A VALUE. An extractor that cannot read a field does
 * not always answer null — a model may answer the literal word "Unknown", a
 * spreadsheet import an "n/a", a display layer a "—" — and every one of those
 * used to count as *present* here while every publish surface counted it as
 * *missing*. The result was the contradiction this rule exists to prevent: a
 * document classified READY (the tab that means "nothing left to do") wearing
 * a "Ready — blocked" badge and an unpublishable tooltip naming the very
 * fields readiness had just accepted. {@link READINESS_PLACEHOLDERS} mirrors
 * the web's `EMPTY` list (apps/web/src/lib/readiness.ts) — the product's one
 * definition of "the placeholders extraction leaves behind". Change them
 * together or the two gates disagree again.
 *
 * ⚠ THE CONFIDENCE SEAM IS DELIBERATELY EMPTY. SoT Stage 5 gates readiness on
 * per-field confidence thresholds that are EVAL-CALIBRATED — they come out of
 * `pnpm test:eval` runs over the labelled corpus, and they do not exist yet.
 * Do not invent numbers here: a made-up 0.85 would gate real documents on a
 * threshold nobody measured. When calibration lands, it arrives as a new
 * field on {@link ReadinessContext} and a term in {@link evaluateReadiness} —
 * this comment is the seam's marker.
 */

export const READY_REQUIRED_FIELDS = ['type', 'total', 'supplier', 'category'] as const;
export type ReadinessField = (typeof READY_REQUIRED_FIELDS)[number];

/** What readiness reads off a document. A projection, so fakes stay small. */
export type ReadinessInput = Pick<DocumentRow, 'totalPence' | 'supplierName' | 'categoryCode' | 'docType'>;

/**
 * The placeholder residue a pipeline leaves where a value should be. Compared
 * case-insensitively after trimming. ⚠ Mirrors the web's `EMPTY` list in
 * `apps/web/src/lib/readiness.ts` — the two must move together (see the file
 * header for why).
 */
const READINESS_PLACEHOLDERS: ReadonlySet<string> = new Set([
  '',
  '—',
  '-',
  'n/a',
  'unknown',
  'extracting…',
  'extracting...',
]);

/** Absent, whitespace-only, or placeholder junk — none of them an answer. */
function isBlank(value: string | null): boolean {
  return value === null || READINESS_PLACEHOLDERS.has(value.trim().toLowerCase());
}

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
  // The TYPE gate (2026-09-05, review items 36 + 47). A webcam selfie the
  // extractor honestly classified OTHER was walked to READY by typing junk
  // into the three field slots below — Type played no part in readiness, so a
  // non-financial image with fabricated Supplier/Total/Category satisfied the
  // whole rule. A document whose type is OTHER, or was never classified at
  // all, is not ready until a human corrects Type to a financial type
  // (`document.update-coding` carries `docType`). It is FIRST in `missing`
  // because "confirm what this document is" precedes filling its fields — the
  // Path-to-Ready panel renders the list in this order. STATEMENT is not
  // gated here: a statement can never reach READY anyway (it has no single
  // total), and refusing it under 'type' would mislabel the reason.
  if (document.docType === null || document.docType === 'OTHER') missing.push('type');
  // A zero total blocks READY alongside null, since 2026-09-03. This file used
  // to call £0.00 "a confirmed zero, a real total" — but both publish gates
  // (web `missingMandatory` and `readinessOf`) have ALWAYS refused a zero
  // total, so a 0p document classified READY here and sat unpublishable there:
  // "Ready — blocked", the tab and the badge contradicting each other. An
  // extractor that cannot read a total may also answer 0 rather than null, and
  // this projection cannot tell a placeholder zero from a confirmed one — so
  // the rare genuine £0.00 document goes to TO_REVIEW, where a human decides
  // (archive or reject; there is nothing worth releasing on a £0.00 line).
  // Negative pence (a credit) is a real total and passes.
  if (document.totalPence === null || document.totalPence === 0) missing.push('total');
  if (isBlank(document.supplierName)) missing.push('supplier');
  if (isBlank(document.categoryCode)) missing.push('category');

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
