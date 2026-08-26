import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createExport, listExports } from '@neoting/contracts/client';
import { createExportBodyDocumentIdsMax, listExportsResponse } from '@neoting/contracts/zod';
import type { Export, ExportRequest, ExportTarget } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * The export boundary (launch stage A9) — **the sole egress** (D42).
 *
 * ## ⚠ Nothing on this lane sends anything anywhere
 *
 * `POST /exports` returns bytes behind a short-lived link. There is no ledger,
 * no vendor, no transmission, and *Published* is an INTERNAL state meaning
 * approved and released for export. Every string this module or its view puts on
 * screen has to survive that reading: **"Export for VT"**, never "send to VT",
 * "publish to VT" or "sync". The contract states it on the operation itself and
 * calls a client string implying transmission a D42 defect rather than a copy
 * preference.
 *
 * ## This module must stay OFF the bundle floor
 *
 * Imported by the lazy `ExportView` chunk only, never by `AppContext` — the
 * shared floor has ~5.5 kB of headroom (apps/web/CLAUDE.md, *Bundle*). That is
 * also why the plain generated `listExports` / `createExport` functions are used
 * inside a hand-rolled `useQuery` rather than `useListExports` /
 * `getListExportsQueryKey`: the marginal cost is per-EXPORT touched from a
 * generated module, and the hook machinery is most of it (the measurement is on
 * `QUEUE_QUERY_KEY` in `proposals.ts`).
 */

export type { Export, ExportRequest, ExportTarget };

/**
 * ⚠ **The batch cap, and it is the contract's own number.**
 *
 * `ExportRequest.documentIds` is capped at 500 in `openapi.yaml`, the API's
 * `MAX_EXPORT_DOCUMENTS` is the same value, and so is A8's `MAX_LINKS_PER_CALL`.
 * Reading it off the generated constant rather than typing `500` here is what
 * stops the screen promising a ceiling the server does not have — if the
 * contract ever moves, this moves with it and the sentence on screen stays true.
 *
 * Generation is synchronous in ID (no queue, no worker, no progress polling), so
 * the cap is what pays for that. Over it the server answers `NT-EXP-003` naming
 * the number, never a truncated file.
 */
export const EXPORT_BATCH_CAP = createExportBodyDocumentIdsMax;

/** The item schema, reached off the list response — orval emits none for a 201. */
const exportSchema = listExportsResponse.shape.data.element;

function drift(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`)
    .join('; ');
}

export interface UseExportHistoryOptions {
  /** Off entirely when the app is running on seed data or has no session. */
  enabled: boolean;
  /** Narrow to one client. Omitted spans every workspace the caller can see. */
  businessId?: string | undefined;
}

/**
 * Export history, newest first — *"did we already export January for this
 * client?"*, whose wrong answer is a double-imported month in someone's books.
 *
 * **No polling.** Unlike the chases and proposals boards, nothing outside this
 * browser creates an export: it is created by the button on this screen, so a
 * timer would be a request every five seconds asking a question only this tab
 * can change the answer to.
 */
export function useExportHistory({ enabled, businessId }: UseExportHistoryOptions) {
  const query = useQuery({
    queryKey: ['exports', 'history', businessId ?? 'all'] as const,
    queryFn: () => listExports(businessId === undefined ? { limit: 50 } : { businessId, limit: 50 }),
    enabled,
  });

  const parsed = useMemo(() => {
    const empty = { exports: [] as Export[], invalid: null as string | null };
    if (!query.data) return empty;

    const result = listExportsResponse.safeParse(unwrapBody(query.data));
    if (!result.success) return { ...empty, invalid: drift(result.error.issues) };
    return { exports: result.data.data as Export[], invalid: null };
  }, [query.data]);

  return {
    exports: parsed.exports,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * **Export for VT.** One client, one target, one period — the import file plus
 * the D43 source-document bundle, generated in this request and handed back as
 * two short-lived URLs.
 *
 * A plain async function rather than a `useMutation`, which is the house pattern
 * for writes here (`openReview` in `proposals.ts`, `confirmMatchProposal` in
 * `bank.ts`): the component awaits it and then invalidates.
 *
 * `Idempotency-Key` is **not** set here. `ntFetch` attaches a fresh UUID to
 * every mutation, which is the point of the mutator — a caller cannot forget it,
 * because a caller never sets it.
 *
 * A contract drift **throws** rather than returning a half-parsed export. A
 * download panel built from a body we could not validate is a panel that might
 * offer a link to nothing.
 */
export async function requestExport(request: ExportRequest): Promise<Export> {
  const body = unwrapBody(await createExport(request));
  const result = exportSchema.safeParse(body);
  if (!result.success) throw new Error(`The export response did not match the contract — ${drift(result.error.issues)}`);
  return result.data as Export;
}

/**
 * The calendar month before `today`, as the two inclusive `YYYY-MM-DD` bounds
 * the contract wants.
 *
 * **Built out of integers, never out of a formatted `Date`.** A period is a
 * calendar range, not an instant; `toISOString()` on a local `Date` is the bug
 * that files 1 August as 31 July for anyone west of UTC, and `toLocaleDateString`
 * is the bug that files it as `8/1/2026` for anyone reading it as a date. Rule 8:
 * UK d/m/y is a rendering concern, and `YYYY-MM-DD` is what crosses the wire.
 *
 * Last month rather than this one because that is the month an accountant
 * actually exports: this month is still arriving.
 */
export function previousCalendarMonth(today: Date = new Date()): { periodStart: string; periodEnd: string } {
  const year = today.getFullYear();
  const month = today.getMonth(); // 0-based, so this IS last month's index in 1-based terms
  const start = month === 0 ? { y: year - 1, m: 12 } : { y: year, m: month };
  const lastDay = new Date(Date.UTC(start.y, start.m, 0)).getUTCDate();

  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    periodStart: `${start.y}-${pad(start.m)}-01`,
    periodEnd: `${start.y}-${pad(start.m)}-${pad(lastDay)}`,
  };
}
