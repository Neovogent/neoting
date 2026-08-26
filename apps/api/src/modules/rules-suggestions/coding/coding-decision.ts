import type { CodingAuthority } from './authority.js';

/**
 * What this module answers when asked "how should this be coded?" — and, just
 * as importantly, the shape that makes "do not touch it" a first-class answer
 * rather than an absence.
 *
 * ## Nothing here writes anything
 *
 * A `CodingDecision` is a **read**. It is returned, rendered, and — when it is
 * strong enough to become a standing rule — turned into a `rule.create`
 * proposal that a human approves (`rule-proposal.ts`). Governance §10 forbids a
 * state change outside the ActionProposal / Review → Approve path, and A6's
 * brief is blunt about the specific case: *a rule that silently recodes a
 * document is exactly the thing §10 forbids.* So this module has no writer for
 * `documents.category_code` at all, and the type system is the reason it cannot
 * grow one by accident — there is nothing in this file a caller could hand to a
 * Prisma update.
 *
 * ## Why `LOCKED` is an outcome and not a low-confidence `CODE`
 *
 * *Nothing overrides a human's correction.* If that were expressed as "the
 * human rung outranks the others", then a future rung placed above it would
 * quietly break it. Expressed as a distinct outcome carrying no code to apply,
 * the only way to break it is to delete the branch.
 */

/** Why a document's coding may not be touched. */
export type CodingLock =
  /**
   * A human set this category through an approved `document.update-coding`, and
   * the accepted `extractions` row records it as `HUMAN_CONFIRMED`. Absolute.
   */
  | 'HUMAN_CORRECTION'
  /**
   * The document is `PUBLISHED` (released for export, D42) or `ARCHIVED`. The
   * `document.update-coding` executor refuses both — *after approval, item
   * details lock* — so proposing a change to one would be proposing an action
   * that cannot execute.
   */
  | 'RELEASED_OR_ARCHIVED';

export interface SupplierContext {
  /** As the document spells it. `null` for an unrouted or unread document. */
  readonly name: string | null;
  /** The comparison key — see `supplier-key.ts`. `''` when there is nothing comparable. */
  readonly key: string;
  /**
   * §24.4.1: *a new supplier is stated as such in the context and is
   * always-review* — §24.4.7 puts accuracy on an unseen category at roughly a
   * fifth of its seen-category level.
   *
   * "New" means: not named in the client's `typicalSuppliers` at intake, and no
   * prior document from them. It is a **statement**, not a gate — it can never
   * override a rule, because the authority order is absolute.
   */
  readonly isNew: boolean;
}

interface CodingDecisionBase {
  readonly supplier: SupplierContext;
  /** One sentence, written for an accountant to read on a card. Never a JSON blob. */
  readonly reason: string;
  /**
   * Rules whose `scopeKey` names this supplier under a different spelling.
   *
   * ⚠ These will **not** fire. `extraction-pipeline.ts` matches `scopeKey`
   * against the extracted `supplierName` by exact equality, so a rule saying
   * `Nisbets Ltd` does nothing for a document that says `NISBETS LTD`. That
   * failure is invisible — the rule exists, the card looked right, and the
   * document simply arrives uncoded — which is why it is surfaced here rather
   * than papered over by matching loosely and then disagreeing with the
   * pipeline about what actually happened.
   */
  readonly nearMissRuleScopeKeys: readonly string[];
}

export type CodingDecision =
  | (CodingDecisionBase & {
      readonly outcome: 'LOCKED';
      readonly lock: CodingLock;
      /** What it is already coded to, for display. Never something to re-apply. */
      readonly categoryCode: string | null;
    })
  | (CodingDecisionBase & {
      readonly outcome: 'CODE';
      readonly authority: CodingAuthority;
      /** The value that belongs in `documents.category_code`. */
      readonly categoryCode: string;
      /**
       * The ledger-prefixed form A7's VT emitter writes into `Analysis account`
       * — `Cost of sales: Purchases`.
       *
       * `null` when `categoryCode` is not on this client's chart. That happens
       * for real: an accountant's explicit rule outranks the chart and may name
       * a code the chart does not carry. It is surfaced rather than substituted,
       * because the export genuinely cannot prefix it and a guessed ledger would
       * put a wrong nominal in someone's books.
       */
      readonly analysisAccount: string | null;
      /** The `rules` row that decided it, when a rule did. */
      readonly sourceRuleId: string | null;
    })
  | (CodingDecisionBase & {
      readonly outcome: 'REVIEW';
      /**
       * Present when this client has coded this supplier before and did not
       * code it the same way twice. §24.4.6: *a change of treatment is itself
       * worth surfacing.* Two codes is not a tie to break — it is a question
       * for the accountant.
       */
      readonly conflictingCategoryCodes: readonly string[];
    });

/** Narrowing helper, so a caller reads `if (isCoded(decision))` rather than comparing strings. */
export function isCoded(
  decision: CodingDecision,
): decision is Extract<CodingDecision, { outcome: 'CODE' }> {
  return decision.outcome === 'CODE';
}
