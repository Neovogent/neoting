/**
 * The per-slice hydration architecture (METH Stage 6).
 *
 * The app migrates to the API surface by surface, and for a while some slices
 * are live while the rest run on the synthetic generators. This module is the
 * vocabulary for that: each slice declares where its data actually came from,
 * and a screen can say so instead of rendering seed rows that look like
 * server truth.
 *
 * The three sources:
 *
 *   'seed'          — the API was never asked (synthetic mode, or the slice is
 *                     not wired yet). The state today, honestly labelled.
 *   'api'           — the slice's query answered and the rows on screen are
 *                     the server's.
 *   'seed-fallback' — the API was asked and failed (transport, server error,
 *                     or a contract drift caught by the Zod parse). The screen
 *                     degrades to the synthetic rows rather than to a blank —
 *                     METH_MODE §8's standing fallback — and a dev-only badge
 *                     names the failure so nobody mistakes fixtures for truth.
 *
 * Stage 6 wires `businesses` as the proof; Stages 7/11/12 point the remaining
 * slices' statuses at their own queries as each screen comes online.
 */

export type SliceSource = 'api' | 'seed' | 'seed-fallback';

export interface SliceStatus {
  source: SliceSource;
  loading: boolean;
  /** What failed, when source is 'seed-fallback'. */
  error: string | null;
}

/** Every slice the demo route reads. Names match the AppContext arrays. */
export type SliceName = 'documents' | 'chases' | 'proposals' | 'bankTransactions' | 'publishes' | 'businesses';

export type SliceStatuses = Record<SliceName, SliceStatus>;

/** A slice still on the generators — synthetic mode, or not wired yet. */
export const SEED_SLICE: SliceStatus = Object.freeze({ source: 'seed', loading: false, error: null });

/** The observable state every api-layer hook here already returns. */
export interface SliceQueryLike {
  isLoading: boolean;
  error: unknown;
  contractError: string | null;
}

export function sliceStatus(enabled: boolean, query: SliceQueryLike): SliceStatus {
  if (!enabled) return SEED_SLICE;
  const error =
    query.contractError ??
    (query.error instanceof Error ? query.error.message : query.error ? 'The request failed' : null);
  if (error) return { source: 'seed-fallback', loading: false, error };
  return { source: 'api', loading: query.isLoading, error: null };
}
