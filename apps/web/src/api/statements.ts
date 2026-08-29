import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { listStatements } from '@neoting/contracts/client';

import { API_ENABLED } from './config';
import { unwrapBody } from './envelope';
import type { Statement } from '../lib/types';

/**
 * The statements a client's bank data came from, and D41's verdict on each.
 *
 * ## Why this module exists
 *
 * ⚠ **A verdict nobody can see is not a gate.** The import lane has written
 * `assurance` since it shipped, and the Statements tab was seed data — so a
 * statement the product had *proven* incomplete looked exactly like one it had
 * proven whole. The first real statement through the pipeline imported 1,144
 * transactions and reported `incomplete`, correctly, and that reached nobody.
 *
 * D41 is a claim about what the product can demonstrate. This is the half that
 * demonstrates it.
 *
 * ## Pence in, pounds out
 *
 * The contract is integer pence; `Statement` in `lib/types.ts` is display-tier
 * pounds, like every other money field the seeded screens render. The division
 * happens HERE, at the boundary, and nowhere else.
 */

const findingShape = z.object({
  kind: z.string(),
  detail: z.string(),
  sourceLine: z.number().int().nullish(),
  amountPence: z.number().int().nullish(),
});

const statementShape = z.object({
  id: z.string(),
  businessId: z.string(),
  documentId: z.string().nullish(),
  fileName: z.string().nullish(),
  periodStart: z.string().nullish(),
  periodEnd: z.string().nullish(),
  openingBalancePence: z.number().int().nullish(),
  closingBalancePence: z.number().int().nullish(),
  rowCount: z.number().int().min(0),
  assurance: z.enum(['complete', 'reduced', 'incomplete']),
  provenBy: z.string().nullish(),
  findings: z.array(findingShape),
  createdAt: z.string(),
});

const listShape = z.object({ items: z.array(statementShape) });

/** `2026-07-01`/`2026-07-31` → `1 – 31 Jul 2026`, or the honest dash. */
function periodLabel(start: string | null | undefined, end: string | null | undefined): string {
  if (start == null || end == null) return '—';
  const fmt = (iso: string, withYear: boolean): string =>
    new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

export function toUiStatement(
  row: z.infer<typeof statementShape>,
  clientName: string,
): Statement {
  return {
    id: row.id,
    clientId: row.businessId,
    clientName,
    accountId: '',
    fileName: row.fileName ?? '—',
    period: periodLabel(row.periodStart, row.periodEnd),
    // ⚠ Pence → pounds, here and nowhere else. A statement with no balance
    // column reports 0 rather than a guess, and `assurance` is what tells the
    // reader the difference — never the zero.
    openingBalance: (row.openingBalancePence ?? 0) / 100,
    closingBalance: (row.closingBalancePence ?? 0) / 100,
    rows: row.rowCount,
    // The import either happened or the row would not exist, so the legacy
    // three-state `status` is always 'extracted' live. The thing worth reading
    // is `assurance`, which is its own column.
    status: 'extracted',
    uploadedAt: row.createdAt,
    assurance: row.assurance,
    findings: row.findings.map((f) => ({
      kind: f.kind,
      detail: f.detail,
      sourceLine: f.sourceLine ?? null,
      amountPence: f.amountPence ?? null,
    })),
    ...(row.documentId == null ? {} : { documentId: row.documentId }),
  };
}

export interface StatementsQuery {
  readonly statements: Statement[];
  readonly source: 'api' | 'seed' | 'error';
  readonly error: string | null;
  refetch(): void;
}

/**
 * Live statements, or a silent stand-down when the API is off.
 *
 * `enabled` is gated the same way every other live slice is: with no API the
 * query never runs and the caller keeps its seeded array, so the synthetic
 * walkthrough is untouched.
 */
export function useStatements(nameFor: (businessId: string) => string): StatementsQuery {
  const query = useQuery({
    queryKey: ['statements'],
    enabled: API_ENABLED,
    queryFn: async () => listShape.parse(unwrapBody(await listStatements())),
    // Statements arrive from a worker minutes after an upload, so the tab is
    // watched rather than loaded once — the same reason the inbox polls.
    refetchInterval: 10_000,
  });

  if (!API_ENABLED) {
    return { statements: [], source: 'seed', error: null, refetch: () => query.refetch() };
  }

  if (query.isError) {
    return {
      statements: [],
      source: 'error',
      error: query.error instanceof Error ? query.error.message : 'Statements could not be loaded.',
      refetch: () => query.refetch(),
    };
  }

  return {
    statements: (query.data?.items ?? []).map((row) => toUiStatement(row, nameFor(row.businessId))),
    source: 'api',
    error: null,
    refetch: () => query.refetch(),
  };
}
