/**
 * The public seam of exports-public-api (Boundaries, ./CLAUDE.md).
 *
 * What is exported here is the whole of what other modules may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`) rather than conventional.
 *
 * The surface is deliberately two ideas wide:
 *
 * - **the canonical model**, which is what a producer of exportable rows
 *   (publishing, and A9's export surface) builds, and
 * - **`selectEmitter`**, which is what turns those rows into one target's file.
 *
 * `vtTransactionPlusEmitter` is not exported by name on purpose. A caller that
 * names the VT emitter directly is a caller that has to be changed when the
 * second client arrives on a different package, which is the scope capture §21
 * lists as a risk and §24.3 designs against. Ask for a target; get an emitter.
 */
export {
  CalendarDateSchema,
  CanonicalAnalysisLineSchema,
  CanonicalBankStatementLineSchema,
  CanonicalRowSchema,
  CanonicalRowsSchema,
  CanonicalSourceLinkSchema,
  CanonicalTransactionDocumentSchema,
  type CalendarDate,
  type CanonicalAnalysisLine,
  type CanonicalBankStatementLine,
  type CanonicalRow,
  type CanonicalSourceLink,
  type CanonicalTransactionDocument,
} from './canonical/canonical-row.js';

export type { EmittedFile, ExportEmitter } from './emitters/export-emitter.js';
export { selectEmitter } from './emitters/select-emitter.js';
