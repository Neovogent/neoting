/**
 * The public seam of exports-public-api (Boundaries, ./CLAUDE.md).
 *
 * What is exported here is the whole of what other modules may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`) rather than conventional.
 *
 * The surface is four ideas wide:
 *
 * - **the canonical model**, which is what a producer of exportable rows
 *   (publishing, and A9's export surface) builds,
 * - **`selectEmitter`**, which is what turns those rows into one target's file,
 * - **the capability-URL lane** (A8, D43) — `DocumentLinkService` mints the
 *   link A9 puts on every row, and `CapabilityLinkModule` serves `GET /d/{code}`,
 * - **the source-document bundle** (D43 rung 4) — the manifest CSV zipped with
 *   the originals, each named by its code,
 * - **the export surface itself** (A9) — `ExportsApiModule`, which `app.module.ts`
 *   registers to serve `GET`+`POST /v1/exports`.
 *
 * `vtTransactionPlusEmitter` is not exported by name on purpose. A caller that
 * names the VT emitter directly is a caller that has to be changed when the
 * second client arrives on a different package, which is the scope capture §21
 * lists as a risk and §24.3 designs against. Ask for a target; get an emitter.
 *
 * `CapabilityLinkService` is likewise not exported. Resolving a code is an
 * UNAUTHENTICATED read of a client's financial document, and the one caller
 * that may do it is this module's own controller. A second door onto that would
 * be a second door onto the session wall's one gap.
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

export { ExportMoneyError, formatPenceDecimal } from './canonical/money.js';

export type { EmittedFile, ExportEmitter } from './emitters/export-emitter.js';
export { selectEmitter } from './emitters/select-emitter.js';

// ── The capability-URL lane (A8, D43) ───────────────────────────────────────
export {
  CAPABILITY_CODE_ALPHABET,
  CAPABILITY_CODE_ENTROPY_BITS,
  CAPABILITY_CODE_LENGTH,
  CapabilityCodeSchema,
  mintCapabilityCode,
  normaliseCapabilityCode,
} from './links/capability-code.js';
export {
  CAPABILITY_LINK_ORIGIN,
  CapabilityUrlError,
  assertCapabilityOrigin,
  capabilityLinkUrl,
} from './links/capability-url.js';
export { CapabilityLinkModule } from './links/capability-link.module.js';
export {
  DEFAULT_DOCUMENT_LINK_TTL_DAYS,
  DocumentLinkService,
  MAX_LINKS_PER_CALL,
} from './links/document-link.service.js';
export { DOCUMENT_LINK_SERVICE } from './links/tokens.js';

// ── The source-document bundle (D43 rung 4) ─────────────────────────────────
export {
  BUNDLE_DOCUMENTS_PREFIX,
  MANIFEST_COLUMNS,
  MANIFEST_FILENAME,
  type ManifestEntry,
  buildManifestCsv,
  bundleFileName,
} from './bundle/manifest.js';
export {
  type BundleDocument,
  type BundleWarning,
  type SourceDocumentBundle,
  type SourceDocumentBytes,
  buildSourceDocumentBundle,
} from './bundle/source-document-bundle.js';
export { ZipError, buildZipArchive, type ZipEntry } from './bundle/zip.js';

// ── The export surface (D42, stage A9) ──────────────────────────────────────
//
// Only the Nest module and the two constants a reader outside this directory
// could legitimately need. `ExportsService` is deliberately not exported: it is
// reachable through one controller and one contract operation, and a second
// in-process caller of "produce an export" would be a second way to write an
// `exports` row without the `Idempotency-Key` the contract makes mandatory.
export { ExportsApiModule } from './api/exports.module.js';
export { EXPORT_URL_TTL_SECONDS, MAX_EXPORT_DOCUMENTS } from './api/exports.service.js';
