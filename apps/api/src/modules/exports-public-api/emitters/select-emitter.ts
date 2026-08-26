import type { ExportTarget } from '@neoting/contracts/model';

import { genericCsvEmitter } from './generic-csv/generic-csv-emitter.js';
import type { ExportEmitter } from './export-emitter.js';
import { vtTransactionPlusEmitter } from './vt/vt-transaction-plus-emitter.js';

/**
 * Target → emitter. The registry, and the reason nothing above it mentions VT.
 *
 * Typed as `Record<ExportTarget, …>`, so adding a value to the contract's
 * `ExportTarget` enum without adding an emitter is a **compile error** rather
 * than a 500 in front of a paying accountant — which is what the enum's own
 * comment in `prisma/schema.prisma` asks for in words.
 */
const EMITTERS: Record<ExportTarget, ExportEmitter> = {
  VT_TRANSACTION_PLUS: vtTransactionPlusEmitter,
  GENERIC_CSV: genericCsvEmitter,
};

export function selectEmitter(target: ExportTarget): ExportEmitter {
  return EMITTERS[target];
}
