/**
 * The public seam of `banking-matching`.
 *
 * This module had none until 28 Aug 2026, and its own `CLAUDE.md` said why:
 * *"a module needs one when its first cross-module consumer arrives, and
 * nothing imports this module today"*. Statement import is that consumer — the
 * ingest job runs the statement step, and `ingestion-routing` may not reach
 * past this file to find it.
 *
 * ## What belongs here
 *
 * The statement step and the two things a composition root needs to build or
 * stub it. Nothing else: the parser, the completeness gate and the persistence
 * function are this module's own workings, and a caller that wanted them would
 * be re-implementing statement import outside the module that owns it.
 *
 * ⚠ The read surface (`BankTransactionsService`, its controller) is deliberately
 * NOT re-exported. It is reached through Nest providers, not imports, and
 * putting it on the seam would invite a second call path to the same data.
 */

export { selectTableReader } from './statement-ingest/select-table-reader.js';
export type { StatementTableReader, TableReadResult } from './statement-ingest/table-reader.js';

export {
  NO_STATEMENT_STEP,
  PrismaStatementStep,
  type StatementBytesSource,
  type StatementStep,
  type StatementStepInput,
  type StatementStepLogger,
} from './statement-ingest/statement-step.js';
