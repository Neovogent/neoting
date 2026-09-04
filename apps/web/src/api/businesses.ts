import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listBusinesses } from '@neoting/contracts/client';
import { listBusinessesResponse } from '@neoting/contracts/zod';
import type { BusinessSummary, ListBusinessesParams } from '@neoting/contracts/model';
import { fetchAllPages, PAGE_LIMIT } from './paged';

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
 *
 * ## ⚠ Every page, not the first hundred clients
 *
 * The third instance of the same defect: the caller asked for `{ limit: 100 }`
 * and nothing read `pageInfo`. It is the widest of the three, because this
 * slice is not merely a list — it is the DICTIONARY. `clientNameFor`, the
 * seed↔server id bridge and `statsFor` all resolve through it, so a client past
 * position 100 lost its name, lost its upload target, and fell off
 * `liveStats` onto a derived-from-nothing zero score. See `paged.ts`.
 */
export function useBusinesses({ enabled, params }: UseBusinessesOptions) {
  const query = useQuery({
    queryKey: ['businesses', 'all', params],
    enabled,
    queryFn: () =>
      fetchAllPages((cursor) =>
        listBusinesses({ ...params, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) }),
      ),
  });

  const parsed = useMemo(() => {
    const empty = { businesses: [] as BusinessSummary[], invalid: null as string | null, truncated: false };
    if (!query.data) return empty;

    const businesses: BusinessSummary[] = [];
    for (const body of query.data.bodies) {
      const result = listBusinessesResponse.safeParse(body);
      if (!result.success) {
        return {
          ...empty,
          invalid: result.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
            .join('; '),
        };
      }
      businesses.push(...(result.data.data as BusinessSummary[]));
    }

    return { businesses, invalid: null, truncated: query.data.truncated };
  }, [query.data]);

  return {
    businesses: parsed.businesses,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    /** The safety cap was reached and the server had more. Screens must SAY so. */
    truncated: parsed.truncated,
    loaded: parsed.businesses.length,
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
    // All ten, because the contract requires all ten. The four this function
    // can see are folded from the seeded documents; the rest are zero rather
    // than absent — the same rule the server's own fold follows, and the reason
    // the contract made them required: an omitted count and a zero count look
    // identical on screen, so the shape must force the producer to say which.
    //
    // The six zeroes are not a gap being papered over. This function exists to
    // give SYNTHETIC mode a `BusinessSummary`-shaped answer for the context
    // header and the client switcher, neither of which reads them; the Clients
    // board in synthetic mode scores from `deriveClientStats` over the seeded
    // arrays, never from here.
    const counts = {
      toReview: 0,
      ready: 0,
      failed: 0,
      published: 0,
      missing: 0,
      requested: 0,
      overdue: 0,
      unmatched: 0,
      statementGaps: 0,
      approvals: 0,
    };
    for (const doc of documents) {
      if (doc.clientId !== client.id) continue;
      if (doc.status === 'review') counts.toReview += 1;
      else if (doc.status === 'ready') counts.ready += 1;
      else if (doc.status === 'rejected') counts.failed += 1;
      else if (doc.status === 'published') counts.published += 1;
    }
    return { id: client.id, name: client.name, tradingName: null, counts };
  });
}
