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
  /**
   * ⚠ The slice reached its page cap and the server had MORE.
   *
   * A fourth state, and it is not a failure — the rows on screen are real and
   * the server's. What is not true is that they are ALL of them, and a screen
   * showing part of a client's financial records must say which part.
   *
   * It exists because the opposite shipped: `AppContext` asked for
   * `{ limit: 100 }`, nothing read `pageInfo`, and a client with 2,288 bank
   * transactions saw 100 of them with no message of any kind. Truncation is now
   * followed to the end (`api/paged.ts`) and this reports the one case that
   * cannot be — silently truncating a client's records is not acceptable; a
   * VISIBLE limit is.
   */
  truncated?: boolean;
  /** How many rows are actually in hand, so the badge can name the number. */
  loaded?: number;
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
  /** Optional so a hook that reads a bounded list need not claim either way. */
  truncated?: boolean;
  loaded?: number;
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
  return {
    source: 'api',
    loading: query.isLoading,
    error: null,
    // Carried on the SUCCESS status, deliberately: a truncated read is not a
    // failed one. The rows are the server's; there are simply more of them.
    truncated: query.truncated === true,
    loaded: query.loaded ?? 0,
  };
}
