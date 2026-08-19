import { useMemo } from 'react';
import { useListBusinesses } from '@neoting/contracts/client';
import { listBusinessesResponse } from '@neoting/contracts/zod';
import type { BusinessSummary, ListBusinessesParams } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * The businesses slice, read from `GET /businesses` (METH Stage 6).
 *
 * The proof-of-pattern slice for the hydration architecture: the context
 * header and (later) the client switcher render from it. Unlike `documents`
 * and `transactions` it does NOT fill a seed array — nothing mutates a
 * business client-side, so the provider selects between this and the derived
 * synthetic rows with a plain `useMemo` instead of a state write.
 *
 * No money and no enum tables cross this boundary, so the contract's own
 * `BusinessSummary` IS the local shape — inventing a second identical type
 * would just be a hand-written API type with extra steps.
 */
export type { BusinessSummary };

export interface UseBusinessesOptions {
  /** Off when the app runs synthetic, and until a session exists. */
  enabled: boolean;
  params?: ListBusinessesParams;
}

/**
 * The caller's client workspaces, parsed through the generated Zod schema
 * before anything touches them — a contract drift surfaces here with the
 * field named, not as `undefined is not an object` in the header.
 */
export function useBusinesses({ enabled, params }: UseBusinessesOptions) {
  const query = useListBusinesses(params, { query: { enabled } });

  const parsed = useMemo(() => {
    const empty = { businesses: [] as BusinessSummary[], invalid: null as string | null };
    if (!query.data) return empty;

    const result = listBusinessesResponse.safeParse(unwrapBody(query.data));
    if (!result.success) {
      return {
        ...empty,
        invalid: result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
          .join('; '),
      };
    }

    return { businesses: result.data.data as BusinessSummary[], invalid: null };
  }, [query.data]);

  return {
    businesses: parsed.businesses,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The synthetic fallback: the same shape derived from the seeded clients and
 * the live documents array, so a screen reading this slice renders truthfully
 * in both modes. Counts follow the contract's meaning — `failed` is the
 * Rejected/Failed badge, which the local shape folds into one 'rejected'
 * status.
 */
export function deriveBusinessSummaries(
  clients: ReadonlyArray<{ id: string; name: string }>,
  documents: ReadonlyArray<{ clientId: string; status: string }>,
): BusinessSummary[] {
  return clients.map((client) => {
    const counts = { toReview: 0, ready: 0, failed: 0 };
    for (const doc of documents) {
      if (doc.clientId !== client.id) continue;
      if (doc.status === 'review') counts.toReview += 1;
      else if (doc.status === 'ready') counts.ready += 1;
      else if (doc.status === 'rejected') counts.failed += 1;
    }
    return { id: client.id, name: client.name, tradingName: null, counts };
  });
}
