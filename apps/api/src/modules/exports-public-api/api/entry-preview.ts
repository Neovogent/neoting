import type { ExportTarget } from '@neoting/contracts/model';

import type { CanonicalRow } from '../canonical/canonical-row.js';
import type { ExportEntryPreview, ExportEntryRefusal } from '../emitters/export-emitter.js';
import { selectEmitter } from '../emitters/select-emitter.js';

import type { AnalysisAccountChart } from './analysis-account-chart.js';
import { documentToCanonicalRow, type ExportableDocumentRow } from './document-to-canonical.js';

/**
 * Documents → the bookkeeping entry the export file will carry, per document.
 *
 * ## Why this exists at all
 *
 * *"Before publishing, show the accountant the actual accounting entry that will
 * be put into the VT software."* Until this, the publish review showed a count
 * and two totals — the accountant approving a release was authorising rows they
 * had never seen, which is precisely the thing Review → Approve exists to
 * prevent. `modules/approvals` renders this on the review card.
 *
 * ## Why it lives HERE and not in the approvals lane
 *
 * Because the emitter does, and the emitter is the only thing that knows what it
 * writes. Every cell below is produced by `emitter.previewEntries`, which is
 * built by the same function as `emitter.emit` (see the ⚠ on
 * `ExportEmitter.previewEntries`, and `buildVtFiles`). Nothing in the approvals
 * lane formats a VT cell, chooses a file, or decides which column carries the
 * ledger prefix — a second implementation of any of those would agree with the
 * export right up until it did not, and the failure would be a human approving
 * rows that are not the rows.
 *
 * ## ⚠ `sourceLink` is NULL here, deliberately, and it is not a gap
 *
 * The D43 capability code is minted by the EXPORT (`DocumentLinkService`, A8),
 * which runs later and against a document that has already reached PUBLISHED. A
 * publish preview that minted one would be a write on a read path — and a
 * preview that INVENTED a plausible-looking code would put a string on a review
 * card that resolves to nothing.
 *
 * So the preview passes `null`, the emitter does exactly what it does for a
 * linkless row — writes the reference and the provenance tag, and raises
 * `source-link-missing` — and the card carries that warning. The one column
 * that will differ between this preview and the file is therefore the one the
 * preview declares it does not yet know, rather than the one it quietly guessed.
 *
 * ## ⚠ `chart` is how the Analysis account column does NOT differ
 *
 * `sourceLink` is the only column the preview may be honest about not knowing.
 * The nominal is not on that list: the export resolves `category_code` against
 * the client's chart of accounts, so a preview that did not would show the
 * accountant `SUBSCRIPTIONS` and a "no ledger prefix" warning for a document the
 * file will carry as `Expenses: Software and subscriptions` with no warning at
 * all — a card raising an alarm about a defect that no longer exists, which is
 * the fastest way to teach somebody to skip the warnings that matter.
 *
 * The caller reads the chart (it holds the scoped transaction; this function
 * does not) and hands it in. `null` is still accepted and still means "resolve
 * nothing" — a proposal composed without a chart reader previews exactly as it
 * always did, warnings included, rather than failing.
 *
 * ## Refusals are named, never dropped
 *
 * A document that cannot become a canonical row (no date, no total, no
 * counterparty, no nominal) is returned in `refusals`. It should not happen —
 * READY already requires Total + Supplier + Category and the publish minimum is
 * that same rule — but "the state machine guarantees it" is exactly the
 * assumption that produces a file quietly missing a row.
 */
export function previewExportEntries(
  target: ExportTarget,
  documents: readonly ExportableDocumentRow[],
  chart: AnalysisAccountChart | null = null,
): ExportEntryPreview {
  const rows: CanonicalRow[] = [];
  const refusals: ExportEntryRefusal[] = [];

  for (const document of documents) {
    const built = documentToCanonicalRow(document, null, chart);
    if (!built.ok) {
      refusals.push({ documentId: document.id, code: built.code, message: built.message });
      continue;
    }
    rows.push(built.row);
  }

  const preview = selectEmitter(target).previewEntries(rows);
  // `refusals` is omitted rather than sent empty: the payload this lands in is
  // hashed and stored per proposal, and an always-present empty array is bytes
  // on every review that say nothing.
  return refusals.length === 0 ? preview : { ...preview, refusals };
}
