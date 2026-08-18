import { useMemo } from 'react';
import { approveActionProposal, createActionProposal, reviewActionProposal, useListBankTransactions } from '@neoting/contracts/client';
import { listBankTransactionsResponse } from '@neoting/contracts/zod';
import type { BankTransaction as ApiBankTransaction, ListBankTransactionsParams, MatchKind as ApiMatchKind } from '@neoting/contracts/model';
import type { BankTransaction as LocalBankTransaction, MatchKind as LocalMatchKind } from '../lib/types';
import { fromIsoDate, fromPence } from './documents';

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
 * Two things are deliberately absent, and both are honest rather than
 * forgotten:
 *
 *   `matchedDocId` is NEVER set from a server row. The contract's
 *   `BankTransaction` carries `matchState` but not the id of the document that
 *   satisfied it, and that id is used elsewhere as a real key — `matching.ts`
 *   builds a `claimed` set from it so one receipt cannot answer two lines, and
 *   `ClientApprovalView` looks a transaction up BY it. A placeholder would
 *   corrupt both. "Is this matched" is answered by `matchState` instead (see
 *   `isMatched`), and the missing id is a contract change for Shakib (G7).
 *
 *   `missingItemId` likewise has no wire representation. The chase link is the
 *   chase lane's, not the feed's.
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
  };
}

/**
 * ⚠ The generated response type says `{ status, data }`; the runtime value is
 * the RAW BODY.
 *
 * orval's `httpClient: 'fetch'` types every operation as a status-discriminated
 * envelope, but the configured mutator — `packages/contracts/src/http-client.ts`
 * — returns `await response.json()`, which is the body itself. The two
 * disagree and TypeScript believes the type, so a caller that trusts it reaches
 * one level too deep and hands a Zod schema the wrong object.
 *
 * Unwrapped by SHAPE rather than by type, so this is correct today and still
 * correct if the mutator is ever changed to return the envelope the types
 * describe. Flagged, not papered over: `api/documents.ts` reads
 * `query.data.data` on the same assumption — see `apps/web/CLAUDE.md`.
 */
function unwrapBody(value: unknown): unknown {
  if (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    'status' in value &&
    typeof (value as { status: unknown }).status === 'number'
  ) {
    return (value as { data: unknown }).data;
  }
  return value;
}

export interface UseBankTransactionsOptions {
  /** Off entirely when the app is running on seed data. */
  enabled: boolean;
  params?: ListBankTransactionsParams;
  clientNameFor: (businessId: string) => string;
}

/**
 * The feed, from `GET /bank-transactions`.
 *
 * Parsed through the generated Zod schema before anything touches it.
 * TypeScript is not a runtime gate — the types describe what the server
 * promised, and this checks what it actually sent, so a contract drift
 * surfaces here with the field named instead of as `undefined is not an
 * object` three components deep.
 */
export function useBankTransactions({ enabled, params, clientNameFor }: UseBankTransactionsOptions) {
  const query = useListBankTransactions(params, { query: { enabled } });

  const parsed = useMemo(() => {
    const empty = {
      transactions: [] as LocalBankTransaction[],
      invalid: null as string | null,
      pageInfo: null as { nextCursor?: string | null; hasMore: boolean } | null,
    };
    if (!query.data) return empty;

    const result = listBankTransactionsResponse.safeParse(unwrapBody(query.data));
    if (!result.success) {
      return {
        ...empty,
        invalid: result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
          .join('; '),
      };
    }

    return {
      transactions: result.data.data.map((row) => toLocalTransaction(row as ApiBankTransaction, clientNameFor)),
      invalid: null,
      pageInfo: result.data.pageInfo,
    };
  }, [query.data, clientNameFor]);

  return {
    transactions: parsed.transactions,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    pageInfo: parsed.pageInfo,
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
