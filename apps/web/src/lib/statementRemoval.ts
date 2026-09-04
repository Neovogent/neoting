import type { Statement } from './types';

/**
 * What a statement removal will actually destroy, computed from the rows the
 * accountant selected — the numbers the confirmation dialog is REQUIRED to
 * state. A generic "Are you sure?" over a thousand-row import is the failure
 * this module exists to prevent: the dialog must say how many transactions go,
 * and which files they came from.
 *
 * Display-tier only. The authoritative blast radius is the server's, computed
 * at proposal creation and rendered at [Read review] once the
 * `bank.remove-statement` kind lands (see
 * `apps/api/src/modules/banking-matching/CLAUDE.md`, the removal design note);
 * this is the honest local summary shown before anything is staged.
 */
export interface RemovalSummary {
  /** How many statements are being removed. */
  count: number;
  /** Every transaction those statements imported, summed off their row counts. */
  totalRows: number;
  /** Up to three file names, so the dialog names what it destroys. */
  namedFiles: string[];
  /** How many further files there are beyond the named three. */
  moreCount: number;
}

const NAMED_FILE_LIMIT = 3;

export function summariseRemoval(statements: readonly Statement[]): RemovalSummary {
  const files = statements.map((s) => s.fileName);
  return {
    count: statements.length,
    totalRows: statements.reduce((sum, s) => sum + s.rows, 0),
    namedFiles: files.slice(0, NAMED_FILE_LIMIT),
    moreCount: Math.max(0, files.length - NAMED_FILE_LIMIT),
  };
}
