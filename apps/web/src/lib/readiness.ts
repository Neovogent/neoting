import { defineMessages, type IntlShape } from 'react-intl';
import type { Document } from './types';

/**
 * Whether a document is allowed to move on, and what is stopping it.
 *
 * Ready is not a label someone applies — it is a claim that every check has
 * passed, and publishing acts on that claim by pushing the item into the
 * client's ledger. So the bar is the PRD's: a supplier, a total and a category
 * at minimum, plus whatever else the practice has made mandatory. An item
 * showing "Missing Category" in one column and an active Move to Ready in the
 * next is the app contradicting itself, and the coding lands wrong in the
 * accounts a step later.
 *
 * One function because four screens move documents to Ready — the client
 * inbox, the practice-wide inbox, the chat table and the archive — and a rule
 * enforced in three of them is not a rule.
 */

const m = defineMessages({
  outstanding: { id: 'pipeline.readiness.outstanding', defaultMessage: 'Something is still outstanding' },
});

/** The placeholders extraction leaves behind when it could not read a value. */
const EMPTY = ['', '—', '-', 'n/a', 'unknown', 'extracting…', 'extracting...'];

const isBlank = (value: string | undefined) => !value || EMPTY.includes(value.trim().toLowerCase());

export interface Readiness {
  ready: boolean;
  /** Field names still needed, in the order a person would fill them. */
  missing: string[];
  /**
   * The flag the extractor left on the document, when there is one. It is a
   * separate list because it is fixed differently — filling a field in, or
   * comparing two copies — and the button should say which.
   */
  flag?: string | undefined;
}

/**
 * Anything unresolved stops a document moving on, not only an empty field.
 *
 * The three the PRD names — supplier, total, category — are the floor, but a
 * document the extractor flagged is not finished either: "Missing VAT" means
 * the VAT was not read, and passing it to Ready hands an unreclaimed amount to
 * the ledger. So a live flag blocks too, and the row offers to fix it rather
 * than offering to move it on.
 */
export function readinessOf(doc: Document, mandatoryFields: string[] = []): Readiness {
  const missing: string[] = [];

  // The three the PRD names as the floor for every document.
  if (isBlank(doc.supplier)) missing.push(doc.kind === 'sales' ? 'Customer' : 'Supplier');
  if (!doc.total) missing.push('Total');
  if (isBlank(doc.category)) missing.push('Category');

  // Anything the practice has added on top, checked against the extraction
  // rather than the document's own columns — that is where they live.
  for (const label of mandatoryFields) {
    const field = doc.fields.find((f) => f.label.toLowerCase() === label.toLowerCase());
    if (!field || isBlank(field.value)) missing.push(label);
  }

  // A document still carrying its review flag has something outstanding even
  // when every required field is filled — "Missing VAT" is the obvious case.
  const flag = doc.status === 'review' && doc.statusNote ? doc.statusNote : undefined;

  return { ready: missing.length === 0 && !flag, missing, flag };
}

/**
 * One line saying what is stopping this document, whichever kind it is.
 *
 * `intl` is a parameter rather than a hook, and the return stays a string: two
 * of the three answers are not copy at all — the field names the document is
 * short of, and the extractor's own flag — so only the last one comes from the
 * catalogue, and the caller wants one sentence either way.
 */
export function blockedReason(r: Readiness, intl: IntlShape): string {
  if (r.ready) return '';
  if (r.missing.length) return describeMissing(r.missing);
  return r.flag ?? intl.formatMessage(m.outstanding);
}

/** "Category and Total are still missing" — for a tooltip or a dialog. */
export function describeMissing(missing: string[]): string {
  if (missing.length === 0) return '';
  if (missing.length === 1) return `${missing[0]} is still missing`;
  const last = missing[missing.length - 1];
  return `${missing.slice(0, -1).join(', ')} and ${last} are still missing`;
}

/**
 * Splits a selection into what can move and what cannot.
 *
 * `mandatoryFields` lost its default when `intl` arrived: a default in front of
 * a required parameter can never be taken, so it only read as optional.
 */
export function partitionByReadiness(docs: Document[], mandatoryFields: string[], intl: IntlShape) {
  const ready: Document[] = [];
  const blocked: { doc: Document; missing: string[]; reason: string }[] = [];
  for (const doc of docs) {
    const verdict = readinessOf(doc, mandatoryFields);
    if (verdict.ready) ready.push(doc);
    else blocked.push({ doc, missing: verdict.missing, reason: blockedReason(verdict, intl) });
  }
  return { ready, blocked };
}
