/**
 * Rejection vocabulary for the sanitisation pipeline.
 *
 * Nothing fails silently (SoT §4 Stage 1, module invariant): every rejection
 * carries a machine `kind`, a stable `NT-ING-*` code, and a plain-English
 * `message` a caller can show the submitter verbatim.
 *
 * The `NT-ING-*` codes are owned by `packages/contracts` (LAW, G7). They are
 * mirrored here so this pure library stays contract-free until the OpenAPI
 * spec freezes; the controller layer maps `Rejection` onto the wire error.
 * Keep this mapping in step with the contract when it lands.
 */

export type RejectionKind =
  | 'oversize' // over the per-channel size cap
  | 'type_not_allowed' // real type is not on the accepted allowlist
  | 'magic_byte_mismatch' // bytes contradict the declared extension/type
  | 'password_protected' // encrypted PDF / Office doc — cannot be processed
  | 'virus_detected' // the scan hook flagged it
  | 'zip_depth_exceeded' // nested-archive depth over cap
  | 'zip_total_size_exceeded' // decompressed-size explosion over cap
  | 'zip_file_count_exceeded' // entry-count over cap
  | 'malformed_archive'; // could not be parsed as a valid archive

/** The subset of ingestion error codes the sanitiser can produce (contract §NT-ING). */
export type IngestCode = 'NT-ING-001' | 'NT-ING-002' | 'NT-ING-004';

export interface Rejection {
  readonly kind: RejectionKind;
  readonly code: IngestCode;
  /** Plain English, ≤500 chars (contract cap), safe to show a submitter. */
  readonly message: string;
  /** Structured context for logs/audit — never assumed safe to display. */
  readonly detail?: Readonly<Record<string, string | number>>;
}

const CODE_BY_KIND: Readonly<Record<RejectionKind, IngestCode>> = {
  oversize: 'NT-ING-001',
  type_not_allowed: 'NT-ING-002',
  magic_byte_mismatch: 'NT-ING-004',
  password_protected: 'NT-ING-004',
  virus_detected: 'NT-ING-004',
  zip_depth_exceeded: 'NT-ING-004',
  zip_total_size_exceeded: 'NT-ING-004',
  zip_file_count_exceeded: 'NT-ING-004',
  malformed_archive: 'NT-ING-004',
};

export function reject(
  kind: RejectionKind,
  message: string,
  detail?: Record<string, string | number>,
): Rejection {
  if (message.length > 500) {
    throw new Error(`rejection message exceeds the 500-char contract cap: ${kind}`);
  }
  return detail ? { kind, code: CODE_BY_KIND[kind], message, detail } : { kind, code: CODE_BY_KIND[kind], message };
}
