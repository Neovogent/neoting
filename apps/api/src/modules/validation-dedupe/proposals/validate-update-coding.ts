import type { UpdateCodingPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type CorrectionCheck,
  type CorrectionCheckContext,
  evaluateCorrectionChecks,
  todayInLondon,
} from '../correction-checks.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

/**
 * The `document.update-coding` CREATION gate and its review advisory — the
 * correction-integrity package (review items 22, 46, 47), on the same seam
 * `computePublishBatchPayload` and `computeChaseSendPayload` occupy: the engine
 * calls this in `create()` (and `review()`) so the rules run server-side,
 * whatever client staged the correction.
 *
 * ## The one HARD rule: a category must be a code on the client's chart
 *
 * Review item 47 typed the free string "jhngbhf" into Category and the pipeline
 * accepted it at every layer. The product's own rule for AI drafts — *refuse
 * any category not on the client's synced chart of accounts, never
 * fuzzy-match* (`chat-framework/drafts.ts`, `rules-suggestions`'
 * `parseModelCodingSuggestion`) — was simply not applied at the manual
 * boundary. It is now: `assertUpdateCodingAllowed` refuses a `categoryCode`
 * that is not EXACTLY a code on the chart. No near-miss matching, for the
 * standing reason: a near miss is how food costs quietly become drink costs.
 *
 * This is a refusal, not an advisory — there is no Ignore button on it,
 * because chart membership is a rule, not an opinion. Everything else the
 * package checks (arithmetic, dates, non-financial documents) is advisory and
 * lives in `correction-checks.ts`.
 *
 * ⚠ The chart arrives through a STRUCTURAL reader seam, composed in
 * `approvals.module.ts` from `rules-suggestions`' `ChartOfAccountsService`
 * (the `ExportEntryPreviewer` reasoning: this module must not import another
 * public seam at runtime). A reader that answers `null` — or is absent —
 * SKIPS the check rather than refusing: a correction boundary that locked
 * every client out of coding because a picklist could not be read would be a
 * worse failure than the junk string, and `ChartOfAccountsService.resolve`
 * derives a chart even for a client with no stored row, so null is the
 * exceptional path, not the common one.
 *
 * ## The advisory, computed where the document can be read
 *
 * `computeCorrectionAdvisory` runs the deterministic checks against the
 * document's stored figures with the correction applied over them. The engine
 * calls it when the review is FIRST opened and freezes the result into the
 * rendered summary (see `approvals/action-proposals.service.ts` for why review
 * time rather than creation time — the payload schema is the contract's and
 * `.strict()`, so computed facts cannot ride in the payload without a G7
 * change; the rendered summary is the engine's own record and its hash is what
 * the approver echoes).
 */

/** The chart, as the validation needs it: codes, or null when unreadable. */
export interface ChartCategoriesReader {
  (db: ScopedClient, businessId: string): Promise<readonly { readonly code: string }[] | null>;
}

const DOCUMENT_SELECT = {
  id: true,
  businessId: true,
  docType: true,
  totalPence: true,
  taxPence: true,
  documentDate: true,
  currency: true,
} as const;

/**
 * The creation-time refusals. Throws `ProposalExecutionRefused` (the engine
 * maps it to a 422, the compute-seam pattern); returns quietly when the
 * correction is admissible.
 */
export async function assertUpdateCodingAllowed(
  db: ScopedClient,
  payload: UpdateCodingPayload,
  readChartCategories?: ChartCategoriesReader,
): Promise<void> {
  const document = await db.document.findUnique({
    where: { id: payload.documentId },
    select: { id: true, businessId: true },
  });
  // Unreachable and absent are one refusal (404-never-403, the route/chase
  // pattern): a correction over a document the caller cannot see refuses now
  // rather than at approve.
  if (document === null) {
    throw new ProposalExecutionRefused('document.update-coding', 'no document with that id');
  }

  const typed = payload.fields.categoryCode;
  if (typed === undefined || readChartCategories === undefined) return;
  // An unrouted document has no client and therefore no chart to validate
  // against; routing is the step that gives it one.
  if (document.businessId === null) return;

  const categories = await readChartCategories(db, document.businessId);
  if (categories === null) return; // chart unreadable — cannot validate, must not deadlock coding
  if (categories.some((category) => category.code === typed)) return;

  throw new ProposalExecutionRefused(
    'document.update-coding',
    `"${typed}" is not a code on this client's chart of accounts, so it was refused rather than stored — a category that is not on the chart cannot be coded against, and near misses are never matched. Pick a code from the client's chart.`,
  );
}

/**
 * The deterministic checks for THIS correction, read against the document as
 * it stands. Empty when nothing fires, or when the document cannot be read
 * (an unreadable document will refuse at execution anyway — an advisory about
 * a document nobody can see would be invented context).
 */
export async function computeCorrectionAdvisory(
  db: ScopedClient,
  payload: UpdateCodingPayload,
  todayIso: string = todayInLondon(),
): Promise<CorrectionCheck[]> {
  const document = await db.document.findUnique({
    where: { id: payload.documentId },
    select: DOCUMENT_SELECT,
  });
  if (document === null) return [];

  const accepted = await db.extraction.findFirst({
    where: { documentId: document.id, isAccepted: true },
    orderBy: { createdAt: 'desc' },
    select: { fields: true },
  });

  const context: CorrectionCheckContext = {
    docType: document.docType,
    totalPence: document.totalPence,
    taxPence: document.taxPence,
    documentDate: document.documentDate === null ? null : document.documentDate.toISOString().slice(0, 10),
    currency: document.currency,
    extractionHadValues: extractionHasValues(accepted?.fields ?? null),
  };
  return evaluateCorrectionChecks(context, payload.fields, todayIso);
}

/**
 * Did extraction read ANYTHING off this document? The stored shape is
 * `{ [field]: { value, provenance, … } }` (jsonb — parsed, never trusted); a
 * selfie's row is every `value` null. Human-confirmed fields do not count as
 * extraction having read something: they are what a person typed, and this
 * flag exists to say whether the DOCUMENT had readable content.
 */
function extractionHasValues(fields: unknown): boolean {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return false;
  return Object.values(fields).some((field) => {
    if (typeof field !== 'object' || field === null) return false;
    const record = field as Record<string, unknown>;
    const value = record['value'];
    if (value === null || value === undefined || value === '') return false;
    return record['provenance'] !== 'HUMAN_CONFIRMED';
  });
}
