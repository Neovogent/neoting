/**
 * The per-slice hydration architecture (METH Stage 6, hardened by launch M2).
 *
 * The app migrates to the API surface by surface, and for a while some slices
 * are live while the rest run on the synthetic generators. This module is the
 * vocabulary for that: each slice declares where its data actually came from,
 * and a screen can say so instead of rendering rows that look like server
 * truth.
 *
 * The three sources:
 *
 *   'seed'  — the API was never asked (synthetic mode, or the slice is not
 *             wired yet). The state today, honestly labelled.
 *   'api'   — the slice's query answered and the rows on screen are the
 *             server's.
 *   'error' — the API was asked and failed (transport, server error, or a
 *             contract drift caught by the Zod parse). The screen says the
 *             data could not be loaded and offers a retry. It NEVER degrades
 *             to the synthetic rows: a paying accountant shown invented
 *             invoices has no way to know they are not real, which is the
 *             highest-trust-cost failure this product can have
 *             (docs/launch/MUBASSHIR.md, M2 — this replaced METH_MODE §8's
 *             'seed-fallback', which did exactly that).
 *
 * Stage 6 wired `businesses` as the proof; Stages 7/11/12 point the remaining
 * slices' statuses at their own queries as each screen comes online.
 */
import { NtProblemError } from '@neoting/contracts';

export type SliceSource = 'api' | 'seed' | 'error';

export interface SliceStatus {
  source: SliceSource;
  loading: boolean;
  /** What failed, when source is 'error'. */
  error: string | null;
}

/**
 * Every slice the demo route reads. Names match the AppContext arrays.
 *
 * `expenseClaims` is here because it IS one of those arrays, not because it is
 * wired: nothing asks the API for a claim and no contract operation exists to
 * ask. Naming it is what lets the tab report `'seed'` — "the API was never
 * asked" — instead of having no vocabulary for its own state and rendering an
 * empty list as though the server had answered with one.
 */
export type SliceName =
  | 'documents'
  | 'chases'
  | 'proposals'
  | 'bankTransactions'
  | 'publishes'
  | 'businesses'
  | 'expenseClaims';

export type SliceStatuses = Record<SliceName, SliceStatus>;

/** A slice still on the generators — synthetic mode, or not wired yet. */
export const SEED_SLICE: SliceStatus = Object.freeze({ source: 'seed', loading: false, error: null });

/** The observable state every api-layer hook here already returns. */
export interface SliceQueryLike {
  isLoading: boolean;
  error: unknown;
  contractError: string | null;
}

/**
 * The failure label every error surface renders. Problem+json failures
 * keep their `NT-` code in front of the words — the code is what a bug
 * report, a log line and the screen have in common, so a banner that drops
 * it strands whoever reads all three.
 */
export function errorLabel(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof NtProblemError) return `${error.code} — ${error.detail ?? error.title}`;
  return error instanceof Error ? error.message : 'The request failed';
}

export function sliceStatus(enabled: boolean, query: SliceQueryLike): SliceStatus {
  if (!enabled) return SEED_SLICE;
  const error = query.contractError ?? errorLabel(query.error);
  if (error) return { source: 'error', loading: false, error };
  return { source: 'api', loading: query.isLoading, error: null };
}
