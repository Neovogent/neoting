import { createHash } from 'node:crypto';

import type { CanonicalSourceLink } from '../canonical/canonical-row.js';

import { MANIFEST_FILENAME, type ManifestEntry, buildManifestCsv, bundleFileName } from './manifest.js';
import { buildZipArchive, type ZipEntry } from './zip.js';

/**
 * D43 rung 4 assembled: **a manifest CSV zipped with the original documents,
 * each named by its capability code.**
 *
 * This is the rung that works when the other three do not — when VT renders the
 * URL as inert text, when the accountant is offline, when the link has been
 * revoked and the file is all that is left. It ships alongside every export
 * rather than instead of one, because SoT §24.3.2 ships **all four rungs at
 * once**: *"together they cost almost nothing"*.
 *
 * ## Reading bytes is a seam, not an import
 *
 * `readBytes` is a structural port rather than an injected `DocumentStore`,
 * following the `DedupeDetection` precedent (validation-dedupe/CLAUDE.md): this
 * file needs "give me the bytes at this key" and nothing else, so it asks for
 * exactly that and stays unit-testable with a `Map`. The caller — A9's export
 * surface — hands it the config-selected store.
 *
 * ## What a missing or altered document does
 *
 * **It is reported, never silently dropped.** A bundle that quietly omitted a
 * document would be a bundle whose manifest lies, and §24.3.4 names silent
 * flattening as the failure mode this whole surface is designed against. A
 * document whose bytes cannot be read is left out of BOTH the archive and the
 * manifest, and named in `warnings` — so the accountant is told which row has
 * no paperwork behind it rather than discovering it at year-end.
 *
 * A document whose bytes no longer hash to its recorded `byte_hash` is a
 * different and worse thing: the file in storage is not the file that was
 * approved. That one is refused for that document specifically, with its own
 * warning code, rather than exported under a checksum that does not describe
 * it.
 */

/** "Give me the bytes at this key." The whole of what this file needs from storage. */
export interface SourceDocumentBytes {
  read(key: string): Promise<Buffer>;
}

/** One document, as A9 reads it out of the database, plus the link A8 minted for it. */
export interface BundleDocument {
  readonly documentId: string;
  readonly link: CanonicalSourceLink;
  /** The object key. Never shown to anyone — it is storage's business, not the accountant's. */
  readonly s3Key: string;
  /** The STORED mime type: magic-byte authoritative after sanitisation. */
  readonly mimeType: string;
  /** `documents.byte_hash`, hex sha256. Verified against the bytes before they are archived. */
  readonly byteHash: string;
  readonly supplierName: string;
  /** `YYYY-MM-DD`, or empty when unknown. */
  readonly documentDate: string;
  readonly reference: string;
  /** Gross, signed integer pence. */
  readonly totalPence: number;
}

export interface BundleWarning {
  readonly documentId: string;
  readonly code: 'source-document-unreadable' | 'source-document-hash-mismatch';
  readonly message: string;
}

export interface SourceDocumentBundle {
  /** The whole archive. `manifest.csv` first, then `documents/<CODE>.<ext>`. */
  readonly bytes: Buffer;
  /** How many documents actually made it in — the number to reconcile against the import file's row count. */
  readonly documentCount: number;
  readonly warnings: readonly BundleWarning[];
}

export async function buildSourceDocumentBundle(input: {
  readonly documents: readonly BundleDocument[];
  readonly readBytes: SourceDocumentBytes;
}): Promise<SourceDocumentBundle> {
  const warnings: BundleWarning[] = [];
  const manifest: ManifestEntry[] = [];
  const files: ZipEntry[] = [];

  for (const document of input.documents) {
    let bytes: Buffer;
    try {
      bytes = await input.readBytes.read(document.s3Key);
    } catch {
      // The row exists and the object does not — a document persisted before
      // its upload landed, or an object lifecycle rule that ran. Real, and it
      // must not take the whole export down with it.
      warnings.push({
        documentId: document.documentId,
        code: 'source-document-unreadable',
        message: `The original file for ${document.link.code} could not be read, so it is not in the bundle. The row is still in the import file and the link still resolves.`,
      });
      continue;
    }

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== document.byteHash) {
      warnings.push({
        documentId: document.documentId,
        code: 'source-document-hash-mismatch',
        message: `The stored file for ${document.link.code} no longer matches the checksum recorded when it was approved, so it is not in the bundle. Investigate before relying on this export.`,
      });
      continue;
    }

    const fileName = bundleFileName(document.link.code, document.mimeType);
    files.push({ name: fileName, bytes });
    manifest.push({
      code: document.link.code,
      fileName,
      byteHashSha256: document.byteHash,
      reference: document.reference,
      documentDate: document.documentDate,
      supplierName: document.supplierName,
      totalPence: document.totalPence,
      url: document.link.url,
    });
  }

  // The manifest is written LAST and placed FIRST: it can only be built once
  // every document's fate is known, and it must be entry zero so a
  // double-click lands on the index rather than on somebody's invoice.
  return {
    bytes: buildZipArchive([{ name: MANIFEST_FILENAME, bytes: buildManifestCsv(manifest) }, ...files]),
    documentCount: files.length,
    warnings,
  };
}
