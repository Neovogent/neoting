import type { PrismaClient } from '../../../common/db/prisma.js';
import { resolveSystemActor } from '../../../common/db/resolve-system-actor.js';
import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import {
  CHASE_MATCH_AMOUNT_TOLERANCE_PENCE,
  chaseMatchesDocument,
} from '../../chase/index.js';

/**
 * The automatic match SUGGESTER (Phase 4, 1 Sep 2026) — the server-side half
 * `confirm-match.ts` predicted in code: *"The seed (and, later, an automatic
 * suggester) writes SUGGESTED rows"*. Until this, the only suggestion
 * arithmetic in the product was display-tier float pounds in
 * `apps/web/src/lib/matching.ts`, no server row was ever written outside the
 * seed, and a chased document that ARRIVED still left its transaction
 * UNMATCHED on the Bank screen until a human found the pairing by eye.
 *
 * **One ruler, deliberately.** The compare is the chase module's own
 * `chaseMatchesDocument` — normalised supplier containment, absolute pence
 * within `CHASE_MATCH_AMOUNT_TOLERANCE_PENCE`, the optional date window — so a
 * document that auto-closes a chase and the suggestion written for it can
 * never disagree about what matches. A second tolerance here would be the
 * two-rulers drift this module's CLAUDE.md warns about from the other side.
 *
 * **Exactly one candidate, or nothing.** The house stance
 * (`extraction/field-geometry.ts`: ambiguity never guesses): a document whose
 * amount+supplier fit two bank lines suggests neither — the human sees both
 * on the Bank screen and decides. A wrong suggestion is worse than none: a
 * SUGGESTED line leaves the chase-detection set (`matchState = UNMATCHED` is
 * the gate), so guessing wrong would silently stop chasing a line whose
 * paperwork never actually came.
 *
 * **A suggestion gates nothing** (Governance §9.5). It writes a `matches` row
 * in SUGGESTED and flips the transaction's `matchState` — both of which the
 * human-only `bank.confirm-match` proposal was already built to consume ("an
 * existing SUGGESTED row is promoted, not duplicated"). Nothing is published,
 * closed or released by this class.
 */
export interface MatchSuggestion {
  readonly matchId: string;
  readonly transactionId: string;
}

export interface MatchSuggesterInput {
  readonly documentId: string;
  readonly businessId: string;
  readonly practiceId: string;
  readonly supplierName: string | null;
  readonly totalPence: number | null;
  readonly documentDate: Date | null;
  readonly traceId: string;
}

export interface MatchSuggesterResult {
  /** The suggestion written, or null — ambiguous, no candidate, or already matched. */
  readonly suggested: MatchSuggestion | null;
}

export interface MatchSuggester {
  run(input: MatchSuggesterInput): Promise<MatchSuggesterResult>;
}

/** For composition roots with no banking concern — the NO_STATEMENT_STEP shape. */
export const NO_MATCH_SUGGESTER: MatchSuggester = {
  async run(): Promise<MatchSuggesterResult> {
    return { suggested: null };
  },
};

/** The offline fixture: records every input, suggests nothing (or a canned answer). */
export class RecordingMatchSuggester implements MatchSuggester {
  readonly runs: MatchSuggesterInput[] = [];

  constructor(private readonly answer: MatchSuggesterResult = { suggested: null }) {}

  async run(input: MatchSuggesterInput): Promise<MatchSuggesterResult> {
    this.runs.push(input);
    return this.answer;
  }
}

/**
 * How many amount-window candidates the compare will look at. The amount range
 * is the index-friendly pre-filter, so the set reaching the in-memory compare
 * is already tiny for any real business; the cap is the Governance §5.1
 * unbounded-load stance, not an expected ceiling.
 */
const CANDIDATE_LIMIT = 100;

export class PrismaMatchSuggester implements MatchSuggester {
  constructor(private readonly prisma: PrismaClient) {}

  async run(input: MatchSuggesterInput): Promise<MatchSuggesterResult> {
    // The compare's own rule, applied before any query: a document missing a
    // supplier or a total matches nothing — no suggestion on an amount
    // coincidence alone.
    if (input.supplierName === null || input.totalPence === null) return { suggested: null };
    const total = Math.abs(Math.trunc(input.totalPence));

    const systemUserId = await resolveSystemActor(this.prisma, input.practiceId);

    return scopedDb(this.prisma, systemContext(input.practiceId, systemUserId), async (db) => {
      // Idempotent per document: one live suggestion (or a confirmation) is
      // the most a document may hold — a redelivery or re-extraction writes
      // no second row. An unmatched row (unmatchedAt set) does not block:
      // facts changed and the document is genuinely free again.
      const existing = await db.match.findFirst({
        where: { documentId: input.documentId, unmatchedAt: null },
        select: { id: true },
      });
      if (existing !== null) return { suggested: null };

      // The index-friendly pre-filter: UNMATCHED lines of this business whose
      // signed pence sit within the tolerance of ±total. The precise gates
      // (supplier containment, date window) run in memory on that small set —
      // through the SAME predicate the chase closes on.
      const tolerance = CHASE_MATCH_AMOUNT_TOLERANCE_PENCE;
      const candidates = await db.bankTransaction.findMany({
        where: {
          businessId: input.businessId,
          matchState: 'UNMATCHED',
          OR: [
            { amountPence: { gte: total - tolerance, lte: total + tolerance } },
            { amountPence: { gte: -total - tolerance, lte: -total + tolerance } },
          ],
        },
        select: { id: true, amountPence: true, bookedAt: true, merchantName: true, descriptionRaw: true },
        orderBy: { bookedAt: 'desc' },
        take: CANDIDATE_LIMIT,
      });

      const document = {
        supplierName: input.supplierName,
        totalPence: input.totalPence,
        documentDate: input.documentDate,
      };
      const matching = candidates.filter((t) => chaseMatchesDocument(document, t));
      if (matching.length !== 1 || matching[0] === undefined) return { suggested: null };
      const target = matching[0];

      // Flip FIRST, guarded on UNMATCHED: the compare-and-swap is what makes a
      // race with a concurrent confirm (or a second worker) safe — the loser
      // flips nothing and writes no orphan match row.
      const flipped = await db.bankTransaction.updateMany({
        where: { id: target.id, matchState: 'UNMATCHED' },
        data: { matchState: 'SUGGESTED' },
      });
      if (flipped.count !== 1) return { suggested: null };

      const exact = Math.abs(target.amountPence) === total;
      const match = await db.match.create({
        data: {
          businessId: input.businessId,
          documentId: input.documentId,
          transactionId: target.id,
          kind: exact ? 'EXACT' : 'PROBABILISTIC',
          // Deterministic, not a model opinion: 1 for pence-equal, a stated
          // notch down for within-tolerance. Triage only — it gates nothing.
          confidence: exact ? 1 : 0.9,
          state: 'SUGGESTED',
          matchedBy: 'auto-suggester',
        },
        select: { id: true, transactionId: true },
      });

      return { suggested: { matchId: match.id, transactionId: match.transactionId } };
    });
  }
}
