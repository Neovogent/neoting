import type { ScopedClient } from '../../common/db/scoped-db.js';
import {
  type StoredCodingSuggestion,
  StoredCodingSuggestionSchema,
} from '../../common/documents/coding-suggestion.js';
import type { AiCodingSuggestion, CodingEvidence, SupplierCodingResult } from '../rules-suggestions/index.js';
import { readStoredLines } from '../rules-suggestions/index.js';
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
}

/**
 * The decision for a document the pipeline has just read, or `null` when there
 * is nothing to say.
 *
 * ⚠ **`null` is returned for a document something already coded**, and that is
 * the load-bearing branch. A suggestion beside an accountant's rule is not extra
 * information, it is pressure to second-guess an explicit instruction — the
 * `CodingDecision` type refuses to carry one on a `CODE` for the same reason,
 * and this is the same rule at the call site.
 *
 * The other two nulls are honest absences rather than failures: an **unrouted**
 * document has no client, therefore no chart, no rules and no history to decide
 * anything from; and a decision that came back as anything other than `REVIEW`
 * carries no `suggestion` field at all.
 */
export async function adviseCoding(
  advisor: DocumentCodingAdvisor,
  db: ScopedClient,
  businessId: string | null,
  categoryCode: string | null,
  extracted: ExtractedDocument,
): Promise<StoredCodingSuggestion | null> {
  if (businessId === null) return null;
  if (categoryCode !== null) return null;

  const result = await advisor.decide(db, businessId, extracted.supplierName, {
    currency: extracted.currency,
    totalPence: extracted.totalPence,
    taxPence: extracted.taxPence,
    // Through the ladder's OWN parser, on the shape the pipeline is about to
    // write, so a first read and every later `resolveForDocument` see identical
    // lines. Untrusted content stays untrusted: a description is classified
    // against patterns this repository authored, never obeyed and never quoted
    // back into a sentence.
    lines: readStoredLines({ lineItems: extracted.lineItems }),
  });

  // `LOCKED` and `CODE` structurally carry no suggestion — the type system, not
  // a runtime check, is what stops a model opinion riding along beside a rule.
  if (result.decision.outcome !== 'REVIEW') return null;
  return toStoredCodingSuggestion(result.decision.suggestion);
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
export function toStoredCodingSuggestion(suggestion: AiCodingSuggestion): StoredCodingSuggestion {
  const base = {
    provenance: suggestion.provenance,
    basis: suggestion.basis,
    note: suggestion.note,
    advisories: [...suggestion.advisories],
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
