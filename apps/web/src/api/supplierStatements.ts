import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';

import { listSupplierStatements } from '@neoting/contracts/client';
import { listSupplierStatementsResponse } from '@neoting/contracts/zod';
import type { SupplierStatementLineOutcome } from '@neoting/contracts/model';

import { fromIsoDate, fromPence } from './documents';
import { unwrapBody } from './envelope';
import { errorLabel, SEED_SLICE, type SliceStatus } from './slices';

/**
 * A client's supplier statements, reconciled server-side (issue #318) —
 * `GET /supplier-statements`.
 *
 * ## Why this module exists
 *
 * The Supplier Statements tab used to compute its "on file / no document"
 * marks IN THE BROWSER, out of whatever documents happened to be loaded, and
 * added one invented missing line. Live, that was a reconciliation nobody did
 * presented as one that was. The server now computes every outcome with the
 * product's one matching rule (the chase lane's `chaseMatchesDocument`), and
 * this module reads the answer. Nothing here decides whether a line is
 * matched; it only renders the server's verdict.
 *
 * ## Pence in, pounds out
 *
 * The contract is integer pence; the screen shows pounds. The division
 * happens HERE, at the boundary, and nowhere else — the `statements.ts`
 * rule. Every row goes through the contract's own generated Zod first, so a
 * float on the wire or a missing field is a contract error with a retry, never
 * a wrong number on screen.
 *
 * Imported by the lazy Supplier Statements chunk only — the generated banking
 * client must stay off the bundle floor (the `chases.ts` placement rule).
 */

type ApiSupplierStatement = z.infer<typeof listSupplierStatementsResponse>['items'][number];

export interface LiveSupplierStatementLine {
  id: string;
  reference: string;
  /** UK display date, or an em dash when the statement printed none. */
  date: string;
  /** Signed pounds for display; null when the line carried no amount. */
  amount: number | null;
  outcome: SupplierStatementLineOutcome;
  matchedDocumentId: string | null;
}

export interface LiveSupplierStatementTotals {
  lineCount: number;
  matchedCount: number;
  missingCount: number;
  unreadableCount: number;
  statementTotal: number;
  matchedTotal: number;
  missingTotal: number;
}

export interface LiveSupplierStatement {
  id: string;
  businessId: string;
  supplier: string;
  documentId: string | null;
  fileName: string | null;
  /** The statement's end date as a UK display date, or an em dash. */
  statementEndDate: string;
  /** The supplier's own claim of what is still owed, in pounds; null when the statement printed none. */
  outstandingBalance: number | null;
  lines: LiveSupplierStatementLine[];
  totals: LiveSupplierStatementTotals;
  uploadedAt: string;
}

export function toLiveSupplierStatement(row: ApiSupplierStatement): LiveSupplierStatement {
  return {
    id: row.id,
    businessId: row.businessId,
    supplier: row.supplierName,
    documentId: row.documentId,
    fileName: row.fileName,
    statementEndDate: fromIsoDate(row.statementEndDate ?? null),
    outstandingBalance: row.outstandingBalancePence === null ? null : fromPence(row.outstandingBalancePence),
    lines: row.lines.map((line) => ({
      id: line.id,
      reference: line.reference ?? '—',
      date: fromIsoDate(line.lineDate ?? null),
      amount: line.amountPence === null ? null : fromPence(line.amountPence),
      outcome: line.outcome,
      matchedDocumentId: line.matchedDocumentId,
    })),
    totals: {
      lineCount: row.totals.lineCount,
      matchedCount: row.totals.matchedCount,
      missingCount: row.totals.missingCount,
      unreadableCount: row.totals.unreadableCount,
      statementTotal: fromPence(row.totals.statementTotalPence),
      matchedTotal: fromPence(row.totals.matchedTotalPence),
      missingTotal: fromPence(row.totals.missingTotalPence),
    },
    uploadedAt: fromIsoDate(row.createdAt),
  };
}

/** The one parse: unwrap the generated envelope, then the contract's own schema decides. */
export function parseSupplierStatements(body: unknown): LiveSupplierStatement[] {
  return listSupplierStatementsResponse.parse(unwrapBody(body)).items.map(toLiveSupplierStatement);
}

export interface SupplierStatementsQuery {
  readonly statements: LiveSupplierStatement[];
  readonly status: SliceStatus;
  refetch(): void;
}

/**
 * Live supplier statements for one client. `enabled: false` is the silent
 * stand-down every live slice has — the query never runs and the status says
 * `'seed'`, which is the truth ("the API was never asked").
 *
 * Polled, because a statement's lines change when a document ARRIVES — through
 * email, the portal or WhatsApp, none of which happen in this browser — and
 * the whole point of the tab is watching a missing invoice turn up.
 */
export function useSupplierStatements({ businessId, enabled }: { businessId: string; enabled: boolean }): SupplierStatementsQuery {
  const query = useQuery({
    queryKey: ['supplier-statements', businessId],
    enabled,
    queryFn: async () => parseSupplierStatements(await listSupplierStatements({ businessId })),
    refetchInterval: 10_000,
  });

  const refetch = (): void => {
    void query.refetch();
  };

  if (!enabled) return { statements: [], status: SEED_SLICE, refetch };

  if (query.isError) {
    return {
      statements: [],
      status: { source: 'error', loading: false, error: errorLabel(query.error) },
      refetch,
    };
  }

  return {
    statements: query.data ?? [],
    status: { source: 'api', loading: query.isLoading, error: null, loaded: query.data?.length ?? 0 },
    refetch,
  };
}
