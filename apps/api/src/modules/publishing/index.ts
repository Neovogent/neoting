/**
 * The public seam of publishing (Boundaries, apps/api/CLAUDE.md).
 *
 * What is exported here is the whole of what other modules' code may depend
 * on; everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`). Growing this list is a
 * boundary decision, not a convenience.
 *
 * Two consumers are in view, and the surface is cut to exactly what they need:
 *
 *  - The **`publish.batch` executor** (`validation-dedupe/proposals/`, METH
 *    Stage 10) — the export-destination vocabulary it resolves a release
 *    against, the preview + minimum-check functions it re-runs at execution
 *    time (the contract requires that re-validation), and the adapter
 *    interface, which is on the seam for the dormant v1 ledger lane rather
 *    than for the release path (D42 — see `export-destination.ts`).
 *  - The **`GET /v1/publishes` read surface** and the proposal-creation path —
 *    the same preview functions, so the number Read review renders and the
 *    number execution re-computes come from one implementation.
 *
 * `DemoXeroAdapter` is deliberately NOT here. Nothing outside this module
 * should name a demo implementation: `selectLedgerAdapter(env)` is how one is
 * obtained, which is what keeps the adapter choice in config where the real
 * Xero client will replace it without touching a call site.
 */
export {
  EXPORT_DESTINATION_KINDS,
  type ExportDestination,
  type ExportDestinationKind,
  isExportDestination,
} from './export-destination.js';
export {
  LEDGER_REJECTED,
  type LedgerAdapter,
  type LedgerAttachment,
  type LedgerFailure,
  type LedgerFailureCode,
  type LedgerPublishResult,
  type LedgerTarget,
  type PublishBillRequest,
} from './ledger-adapter.js';
export {
  checkPublishMinimum,
  computePublishPreview,
  previewPublishBatch,
  PUBLISH_MINIMUM_CODE,
  type PublishItemRefusal,
  type PublishPreview,
  type PublishPreviewItem,
  type PublishPreviewOutcome,
} from './publish-preview.js';
/**
 * The Nest module itself is on the seam because the `LEDGER_ADAPTER` token it
 * exports is useless without it: `approvals.module.ts` has to `imports:
 * [PublishingModule]` to inject the adapter into the executor registry, and
 * reaching for `publishing.module.js` directly would be reaching past this
 * file — the exact thing the boundary rule forbids. A module class IS a public
 * composition unit; naming it here is the honest way to say so.
 */
export { PublishingModule } from './publishing.module.js';
export { selectLedgerAdapter } from './select-ledger-adapter.js';
export { LEDGER_ADAPTER } from './tokens.js';
