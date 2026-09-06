import type { ScopedClient } from '../../common/db/scoped-db.js';
import {
  type StoredCodingSuggestion,
  StoredCodingSuggestionSchema,
} from '../../common/documents/coding-suggestion.js';
import type { AiCodingSuggestion, CodingEvidence, SupplierCodingResult } from '../rules-suggestions/index.js';
import { codingSuggestionFor, readStoredLines, type SupplierRuleOffer, supplierRuleOffer } from '../rules-suggestions/index.js';
import type { ExtractedDocument } from './document-extractor.js';

/**
 * **The seam between the pipeline and the coding ladder** — one interface, one
 * mapper, and the reason neither module has to know the other's shape.
 *
 * ## Why this file exists at all
 *
 * `rules-suggestions` shipped `decide()` with nobody calling it, and its own
 * seam header named this pipeline as the intended consumer: *"`decide(db,
 * businessId, supplierName)` takes a `ScopedClient`, so it can be consulted
 * inside the pipeline's own transaction."* This is that call, expressed as a
 * dependency the step is given rather than a service it constructs — so a unit
 * test drives the escalation branch with four lines and no database, and the
 * worker composition root is the one place the real ladder is built.
 *
 * ## What it is careful never to do
 *
 * **It does not code anything.** `documents.category_code` has exactly one
 * writer and this is not it; a document carrying a suggestion is still To
 * Review, because `resolveProcessedState`'s mandatory set (Total + Supplier +
 * Category) is untouched and a suggestion is not a category. The whole point is
 * that the accountant accepts it or does not.
 */

/**
 * What the pipeline needs from the coding ladder.
 *
 * `SupplierCodingService` satisfies this structurally — it is not implemented
 * against it — which keeps the dependency one-way and means `rules-suggestions`
 * has no idea the pipeline exists.
 */
export interface DocumentCodingAdvisor {
  decide(
    db: ScopedClient,
    businessId: string,
    supplierName: string | null,
    evidence?: Omit<CodingEvidence, 'supplier'>,
  ): Promise<SupplierCodingResult>;
  /**
   * The model tier (review item 19), run with **no transaction open**.
   *
   * ⚠ Optional, and the absence is a real configuration: an advisor without one
   * is the deterministic ladder, which is what every unit test in this module
   * drives and what `EXTRACTOR=demo` selects. The pipeline calls it if it is
   * there.
   */
  reconsider?(
    result: SupplierCodingResult,
    evidence: Omit<CodingEvidence, 'supplier'>,
    practiceId: string,
  ): Promise<SupplierCodingResult>;
}

/**
 * **Step one: the deterministic ladder**, inside the caller's transaction — the
 * decision for a document the pipeline has just read, or `null` when there is
 * nothing to ask about.
 *
 * ⚠ **`null` is returned for a document something already coded**, and that is
 * the load-bearing branch. A suggestion beside an accountant's rule is not extra
 * information, it is pressure to second-guess an explicit instruction — the
 * `CodingDecision` type refuses to carry one on a `CODE` for the same reason,
 * and this is the same rule at the call site.
 *
 * The other null is an honest absence rather than a failure: an **unrouted**
 * document has no client, therefore no chart, no rules and no history to decide
 * anything from.
 *
 * ⚠ It returns the RESULT, not the stored shape, because {@link finishCoding}
 * still has to run — outside every transaction. It used to return the stored
 * suggestion directly, when there was no model tier to reach.
 */
export async function adviseCoding(
  advisor: DocumentCodingAdvisor,
  db: ScopedClient,
  businessId: string | null,
  categoryCode: string | null,
  extracted: ExtractedDocument,
): Promise<SupplierCodingResult | null> {
  if (businessId === null) return null;
  if (categoryCode !== null) return null;

  return advisor.decide(db, businessId, extracted.supplierName, codingEvidenceOf(extracted));
}

/**
 * The evidence the ladder codes from, read the ladder's OWN way.
 *
 * Through `readStoredLines`, on the shape the pipeline is about to write, so a
 * first read and every later `resolveForDocument` see identical lines. Untrusted
 * content stays untrusted: a description is classified against patterns this
 * repository authored, never obeyed and never quoted back into a sentence.
 */
export function codingEvidenceOf(extracted: ExtractedDocument): Omit<CodingEvidence, 'supplier'> {
  return {
    currency: extracted.currency,
    totalPence: extracted.totalPence,
    taxPence: extracted.taxPence,
    lines: readStoredLines({ lineItems: extracted.lineItems }),
  };
}

/**
 * **Step two: the model tier, and then the answer to store** — run with NO
 * transaction open.
 *
 * ⚠ **The split is not tidiness; it is the transaction boundary.** `decide()`
 * takes a `ScopedClient`, so its caller holds an open transaction, and
 * `scopedDb` gives that transaction ten seconds. A judgment-tier model call
 * takes seconds of somebody else's network, and holding a tenant transaction
 * open across one is the thing `modules/approvals` refuses by name for its
 * ledger follow-up. So the pipeline reads the ladder in a short transaction of
 * its own, closes it, and calls this — which touches no database at all.
 *
 * `reconsider` absent (no model configured) makes this a pure mapping, which is
 * exactly what it was before the model rung existed.
 */
export async function finishCoding(
  advisor: DocumentCodingAdvisor,
  result: SupplierCodingResult,
  extracted: ExtractedDocument,
  practiceId: string,
): Promise<StoredCodingSuggestion | null> {
  const reconsidered =
    advisor.reconsider === undefined ? result : await advisor.reconsider(result, codingEvidenceOf(extracted), practiceId);
  // `codingSuggestionFor` is the ladder's own mapping, not this module's: it
  // answers the REVIEW rung's suggestion, this client's remembered treatment for
  // a `LEARNED_HISTORY` coding (review item 48), and `null` beside an
  // accountant's rule or a human's correction — where an opinion is pressure to
  // second-guess an explicit instruction rather than extra information.
  const suggestion = codingSuggestionFor(reconsidered);
  if (suggestion === null) return null;
  // ⚠ The offer is computed from the RESULT, not from the suggestion: it is a
  // fact about this client's history, and only `buildSupplierRuleProposal` —
  // which owns every refusal — gets to say whether a standing rule is available
  // (review item 48's follow-on). `null` is the usual answer, and most documents
  // should not be offering to write a rule.
  return toStoredCodingSuggestion(suggestion, supplierRuleOffer(reconsidered));
}

/**
 * `AiCodingSuggestion` → the stored (and contracted) shape.
 *
 * Every property is written, nullable rather than omitted, so a reader can tell
 * "this release had nothing to say" from "this release did not have the
 * concept". The result is parsed on the way *in* as well as on the way out: a
 * value that would not survive the read projection must never reach the column,
 * because a suggestion that silently vanishes on the detail screen is the same
 * empty Category field this whole change exists to remove.
 */
export function toStoredCodingSuggestion(
  suggestion: AiCodingSuggestion,
  ruleOffer: SupplierRuleOffer | null = null,
): StoredCodingSuggestion {
  const base = {
    provenance: suggestion.provenance,
    basis: suggestion.basis,
    note: suggestion.note,
    advisories: [...suggestion.advisories],
    ruleOffer: ruleOffer === null ? null : { ...ruleOffer, unmatchedSpellings: [...ruleOffer.unmatchedSpellings] },
  };

  const stored: StoredCodingSuggestion =
    suggestion.outcome === 'SUGGEST'
      ? {
          ...base,
          outcome: 'SUGGEST',
          categoryCode: suggestion.categoryCode,
          analysisAccount: suggestion.analysisAccount,
          confidence: suggestion.confidence,
          treatment: suggestion.treatment,
          secondChoice:
            suggestion.secondChoice === null
              ? null
              : {
                  categoryCode: suggestion.secondChoice.categoryCode,
                  analysisAccount: suggestion.secondChoice.analysisAccount,
                  confidence: suggestion.secondChoice.confidence,
                },
          escalationReason: null,
          candidateCategoryCodes: [],
        }
      : {
          ...base,
          outcome: 'ESCALATE',
          categoryCode: null,
          analysisAccount: null,
          confidence: null,
          treatment: null,
          secondChoice: null,
          escalationReason: suggestion.reason,
          candidateCategoryCodes: [...suggestion.candidateCategoryCodes],
        };

  return StoredCodingSuggestionSchema.parse(stored);
}
