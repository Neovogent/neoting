import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { approveActionProposal, createActionProposal, listBankTransactions, reviewActionProposal } from '@neoting/contracts/client';
import { listBankTransactionsResponse } from '@neoting/contracts/zod';
import type { BankTransaction as ApiBankTransaction, ListBankTransactionsParams, MatchKind as ApiMatchKind } from '@neoting/contracts/model';
import type { BankTransaction as LocalBankTransaction, MatchKind as LocalMatchKind } from '../lib/types';
import { fromIsoDate, fromPence } from './documents';
import { unwrapBody } from './envelope';
import { fetchAllPages, PAGE_LIMIT } from './paged';

/**
 * The bank feed, read from the API (METH Stage 11).
 *
 * The second screen migrated off local state, and it follows `documents.ts`
 * exactly: the response is parsed through the generated Zod schema before
 * anything touches it, money is divided ONCE here, and the result fills the
 * same array every existing mutator already writes to rather than becoming a
 * second source beside it.
 *
 * // DEMO-MOCK: TrueLayer. The feed is presented as connected — the seeded
 * `bank_connections` row says `provider: 'truelayer', consentState: ACTIVE` —
 * and the transactions are the seeded ones. The real implementation is a
 * provider adapter behind a config-selected `BankFeed` seam writing the same
 * `bank_transactions` rows this reads (SoT §4 Stage 7).
 */

/**
 * The contract's `MatchKind` from the app's own.
 *
 * A table rather than an `toUpperCase()`: `probable` is `PROBABILISTIC` and
 * `credit-note` is `CREDIT_NOTE`, so a mechanical transform would produce a
 * value the server rejects at the boundary — and only for the two kinds a
 * demo is least likely to exercise. `BATCH_PAYMENT` has no local counterpart
 * because batch payments are out of METH Stage 11's scope.
 */
const MATCH_KIND_TO_API: Record<LocalMatchKind, ApiMatchKind> = {
  exact: 'EXACT',
  probable: 'PROBABILISTIC',
  partial: 'PARTIAL_PAYMENT',
  'credit-note': 'CREDIT_NOTE',
};

/**
 * One API row in the shape the Bank screen already renders.
 *
 * `matchedDocId` is set from the server row SINCE Phase 4 (1 Sep 2026): the
 * contract's `BankTransaction` gained `matchedDocumentId` — the CONFIRMED
 * match's document, exactly the key `matching.ts` builds its `claimed` set
 * from and `ClientApprovalView` looks a transaction up by. A SUGGESTED match
 * deliberately arrives as `null` (a suggestion is a question, and the
 * document's own bank-match read carries it), so the caveat this comment used
 * to carry is closed for confirmations only.
 *
 * `missingItemId` still has no wire representation. The chase link is the
 * chase lane's, not the feed's.
 */
export function toLocalTransaction(
  row: ApiBankTransaction,
  clientNameFor: (businessId: string) => string,
): LocalBankTransaction {
  return {
    id: row.id,
    clientId: row.businessId,
    clientName: clientNameFor(row.businessId),
    description: row.descriptionRaw,
    date: fromIsoDate(row.bookedAt),
    // ⚠ THE TWO SIGN CONVENTIONS ARE OPPOSITE, so this NEGATES.
    //
    // The contract is a bank feed's: negative pence is money OUT. The app's
    // local shape is a ledger's, and always has been — `seed.ts` gives an
    // ordinary supplier payment a POSITIVE amount and a refund a negative one
    // (`t4: amount: -212.4, isCredit: true`), and `BankView` paints anything
    // negative emerald because that is a credit coming back.
    //
    // Copying the wire value through would flip every row on the screen: every
    // expense green, every refund white, and `currency()` printing the money
    // an accountant reads with the wrong sign. Converted here, once, so no
    // component has to know which side of the boundary a value came from.
    //
    // The zero branch is not defensive tidiness: negating 0 gives `-0`, and
    // `Object.is(-0, 0)` is false — so a zero-value line would carry an amount
    // that compares unequal to zero in a `Map` key or a strict assertion, and
    // some formatters print it as "-£0.00".
    amount: row.amountPence === 0 ? 0 : fromPence(-row.amountPence),
    isCredit: row.amountPence > 0,
    accountId: row.accountId,
    matchState: row.matchState,
    chaseSuppressed: row.chaseSuppressed,
    // Conditional spread, not `undefined` — exactOptionalPropertyTypes, and
    // the local shape's convention is that an unmatched line has NO key.
    ...(row.matchedDocumentId === null ? {} : { matchedDocId: row.matchedDocumentId }),
  };
}

export interface UseBankTransactionsOptions {
  /** Off entirely when the app is running on seed data. */
  enabled: boolean;
  params?: ListBankTransactionsParams;
  clientNameFor: (businessId: string) => string;
}

/**
 * The feed, from `GET /bank-transactions` — **every page of it**.
 *
 * Parsed through the generated Zod schema before anything touches it.
 * TypeScript is not a runtime gate — the types describe what the server
 * promised, and this checks what it actually sent, so a contract drift
 * surfaces here with the field named instead of as `undefined is not an
 * object` three components deep.
 *
 * ## ⚠ It follows the cursor now, and that is a data-integrity fix
 *
 * This used to be `useListBankTransactions` — the generated single-page hook —
 * and its caller asked for `{ limit: 100 }`. `pageInfo` came back, was returned
 * from here, and **nothing outside the tests ever read it**. A real client with
 * 2,288 transactions had 2,188 of them unreachable, with no message and no
 * control: the table showed 100 rows, and every figure derived from the array
 * (the "unexplained" total, the unmatched counts, the chase candidates) was
 * computed over the same 4.4% and looked entirely normal.
 *
 * `fetchAllPages` walks `pageInfo.nextCursor` to the end. The contract caps
 * `limit` at 100 and forbids offset pagination, so there is no larger request
 * to make — the whole list is the only honest answer, and `truncated` says so
 * out loud on the rare occasion the safety cap is reached.
 *
 * Using the plain generated function inside our own `useQuery` is the
 * `proposals.ts` idiom, and here it also costs LESS: the generated hook's
 * query-key and options builders stop being reachable from the bundle floor.
 */
export function useBankTransactions({ enabled, params, clientNameFor }: UseBankTransactionsOptions) {
  const query = useQuery({
    queryKey: ['bank-transactions', 'all', params],
    enabled,
    queryFn: () =>
      fetchAllPages((cursor) =>
        listBankTransactions({ ...params, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) }),
      ),
  });

  const parsed = useMemo(() => {
    const empty = {
      transactions: [] as LocalBankTransaction[],
      invalid: null as string | null,
      truncated: false,
    };
    if (!query.data) return empty;

    const transactions: LocalBankTransaction[] = [];
    for (const body of query.data.bodies) {
      const result = listBankTransactionsResponse.safeParse(body);
      if (!result.success) {
        return {
          ...empty,
          invalid: result.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
            .join('; '),
        };
      }
      for (const row of result.data.data) {
        transactions.push(toLocalTransaction(row as ApiBankTransaction, clientNameFor));
      }
    }

    return { transactions, invalid: null, truncated: query.data.truncated };
  }, [query.data, clientNameFor]);

  return {
    transactions: parsed.transactions,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    /**
     * The safety cap was hit and the server had more. **A screen reading this
     * slice must SAY so** — `sliceStatus` carries it to `DataSourceBadge`.
     */
    truncated: parsed.truncated,
    /** How many rows are actually in hand, so a count can be honest about itself. */
    loaded: parsed.transactions.length,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface ConfirmMatchRequest {
  businessId: string;
  transactionId: string;
  documentId: string;
  kind: LocalMatchKind;
  /** The suggesting engine's score. Recorded for triage; it gates nothing. */
  confidence?: number;
}

/**
 * Confirm a match — **through Review → Approve, because there is no other
 * door** (Governance §10).
 *
 * Three calls, in the one order the server permits: create the proposal, open
 * the review, then approve echoing back the hash the review returned. Approve
 * is unreachable until the review has been opened, and that is enforced
 * server-side (and again by a database trigger), so this sequence is not a
 * convention this file could shortcut — skipping the middle call is
 * `NT-PRP-002`.
 *
 * The echoed `renderedSummaryHash` is the point of the middle call: it proves
 * the human approved the thing they were shown. It is taken from the review
 * response and never recomputed here — a client that computed its own hash
 * would be attesting to its own render.
 *
 * `Idempotency-Key` is not set here and must not be: `ntFetch` mints a fresh
 * UUID per mutation, which is exactly right for three distinct logical
 * operations.
 */
export async function confirmMatchProposal(request: ConfirmMatchRequest): Promise<void> {
  const created = await createActionProposal({
    kind: 'bank.confirm-match',
    businessId: request.businessId,
    payload: {
      transactionId: request.transactionId,
      documentId: request.documentId,
      matchKind: MATCH_KIND_TO_API[request.kind],
      ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
    },
  });

  const proposal = unwrapBody(created) as { id?: string };
  if (typeof proposal.id !== 'string') {
    throw new Error('the proposal was created without an id');
  }

  const reviewed = unwrapBody(await reviewActionProposal(proposal.id)) as { renderedSummaryHash?: string };
  if (typeof reviewed.renderedSummaryHash !== 'string') {
    throw new Error('the review returned no summary hash to echo');
  }

  await approveActionProposal(proposal.id, { renderedSummaryHash: reviewed.renderedSummaryHash });
}
