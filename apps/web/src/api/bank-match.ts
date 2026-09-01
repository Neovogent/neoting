import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { getDocumentBankMatch } from '@neoting/contracts/client';
import { getDocumentBankMatchResponse } from '@neoting/contracts/zod';
import { confirmMatchProposal } from './bank';
import { fromIsoDate, fromPence } from './documents';
import { unwrapBody } from './envelope';

/**
 * A document's bank match — `GET /documents/{documentId}/bank-match` (Phase 4).
 *
 * The read surface PR #230 could not have: DocumentPreview's match section was
 * left unbuilt "rather than a fabricated one", because nothing exposed a
 * document's suggested transaction. The server's automatic suggester now
 * writes SUGGESTED rows (the same deterministic compare that auto-closes a
 * chase), and this module reads the one live match back.
 *
 * ⚠ This module must stay OFF the bundle floor: it is imported only by
 * `DocumentPreview` (a lazy chunk), and it deliberately calls the plain
 * generated function inside its own `useQuery` rather than the generated hook
 * machinery — the `proposals.ts` reasoning, verbatim.
 */

export interface DocumentBankMatchView {
  readonly matchId: string;
  readonly state: 'SUGGESTED' | 'CONFIRMED';
  readonly kind: string;
  /** Signed pounds, the screen's unit — negative is money out. */
  readonly amount: number;
  /** "09 Aug 2026" — what every screen renders. */
  readonly date: string;
  /** The merchant when the feed named one, else the client's own bank descriptor. */
  readonly label: string;
  readonly transactionId: string;
  readonly businessId: string;
  readonly confidence: number | null;
}

const responseShape = getDocumentBankMatchResponse as z.ZodType<{
  match: {
    id: string;
    state: 'UNMATCHED' | 'SUGGESTED' | 'CONFIRMED' | 'EXCLUDED';
    kind: string;
    confidence: number | null;
    matchedBy: string | null;
    transaction: {
      id: string;
      businessId: string;
      bookedAt: string;
      amountPence: number;
      descriptionRaw: string;
      merchantName: string | null;
    };
  } | null;
}>;

function toView(parsed: z.infer<typeof responseShape>): DocumentBankMatchView | null {
  const match = parsed.match;
  if (match === null) return null;
  // The contract admits the full MatchState enum; this surface renders the two
  // live states and treats anything else as absence rather than inventing copy.
  if (match.state !== 'SUGGESTED' && match.state !== 'CONFIRMED') return null;
  return {
    matchId: match.id,
    state: match.state,
    kind: match.kind,
    amount: fromPence(match.transaction.amountPence),
    date: fromIsoDate(match.transaction.bookedAt),
    label: match.transaction.merchantName ?? match.transaction.descriptionRaw,
    transactionId: match.transaction.id,
    businessId: match.transaction.businessId,
    confidence: match.confidence,
  };
}

export interface DocumentBankMatchResult {
  match: DocumentBankMatchView | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

export function useDocumentBankMatch(documentId: string, enabled: boolean): DocumentBankMatchResult {
  const query = useQuery({
    queryKey: ['document-bank-match', documentId],
    enabled,
    queryFn: async () => toView(responseShape.parse(unwrapBody(await getDocumentBankMatch(documentId)))),
  });
  return {
    match: query.data ?? null,
    loading: query.isLoading && enabled,
    error: query.isError,
    refetch: () => void query.refetch(),
  };
}

/**
 * Confirm the suggestion — the same three-call Review → Approve ritual the
 * Bank screen's confirm uses (`confirmMatchProposal`: create, review, approve
 * echoing the hash; the middle call cannot be skipped, `NT-PRP-002`).
 */
export async function confirmDocumentBankMatch(documentId: string, match: DocumentBankMatchView): Promise<void> {
  await confirmMatchProposal({
    businessId: match.businessId,
    transactionId: match.transactionId,
    documentId,
    // The suggester writes EXACT/PROBABILISTIC; the local vocabulary maps back
    // onto the same two API values, so the round trip is loss-free.
    kind: match.kind === 'EXACT' ? 'exact' : 'probable',
    ...(match.confidence === null ? {} : { confidence: match.confidence }),
  });
}
