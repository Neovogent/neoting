/**
 * Sanitisation pipeline — public surface (Governance §11.4, SoT §4 Stage 1).
 *
 * A pure library: no controller, no Prisma, no network. The ingestion-routing
 * module's service layer calls `sanitise` before anything else touches an
 * upload, and maps a `Rejection` onto the NT-ING wire error at the boundary.
 */

export { sanitise, defaultDeps, type SanitisationDeps } from './pipeline.js';
export { CHANNEL_POLICY, type Channel, type ChannelPolicy } from './channels.js';
export { ACCEPTED_FORMATS, mimeForFormat, sniff, type AcceptedFormat, type SniffResult } from './formats.js';
export { reject, type IngestCode, type Rejection, type RejectionKind } from './reasons.js';
export type { AcceptedDocument, SanitisationInput, SanitisationResult } from './types.js';
export {
  EICAR_TEST_STRING,
  fixtureVirusScanner,
  type ScanVerdict,
  type VirusScanner,
} from './virus-scan.js';
export {
  bootstrapDocumentGuard,
  bootstrapImageNormaliser,
  type DocumentGuard,
  type DocumentGuardVerdict,
  type ImageNormaliser,
  type NormaliseResult,
} from './guards.js';
export { DEFAULT_ZIP_CAPS, inspectZip, type ZipCaps } from './zip-safety.js';

export { selectImageNormaliser, type ImageNormaliserMode } from './select-image-normaliser.js';
export { createSharpImageNormaliser, type SharpNormaliserOptions } from './sharp-image-normaliser.js';
