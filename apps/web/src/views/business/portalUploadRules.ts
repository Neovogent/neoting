import { PORTAL_UPLOAD_LIMIT } from '../../lib/business';
import { MIME_BY_EXTENSION, UPLOAD_ACCEPT, extensionOf, mimeTypeFor } from '../../lib/uploadMime';

/**
 * What the client portal may actually send, and why a file was refused.
 *
 * ## ⚠ THIS LIST IS THE SERVER'S, NOT A GUESS
 *
 * `POST /portal/uploads` checks the declared MIME against the sanitiser's
 * `ACCEPTED_FORMATS` (`apps/api/src/modules/ingestion-routing/lib/sanitisation/
 * formats.ts`) and answers `400` for anything else. This mirror has been
 * WRONG IN BOTH DIRECTIONS in its life: the picker once offered `.csv` and
 * `.xlsx` while the server refused them, and then — after the server gained
 * both on 28 Aug 2026 for D40's statement upload — this list was never
 * re-widened, so a client whose bank exports only CSV could not send it
 * (5 Sep 2026 review finding). When the two drift, the SERVER file is the
 * truth; fix this one.
 *
 * Screening here is a courtesy, never the enforcement: the server refuses
 * regardless, and this exists so the refusal arrives instantly, names the file,
 * and does not spend a client's mobile data first.
 *
 * ## The reason is a machine value
 *
 * Callers get one of three discriminants and turn it into a sentence
 * themselves. A refusal reason built as English in here would be a string this
 * module could not translate and a test could only assert by matching prose.
 */

/**
 * The server's allowlist mirror now lives in `lib/uploadMime.ts`, because the
 * accountant's own upload page needs the same answers and was getting different
 * ones -- the HEIC defect of 8 Sep 2026. Re-exported under the portal's original
 * names so this module's callers are unaffected.
 */
export const PORTAL_MIME_BY_EXTENSION = MIME_BY_EXTENSION;
export const PORTAL_ACCEPT = UPLOAD_ACCEPT;
export { extensionOf, mimeTypeFor };

export type RefusalReason = 'unsupported-type' | 'too-large' | 'empty';

export interface ScreenedFile {
  readonly name: string;
  readonly reason: RefusalReason;
  /** The extension it was refused for, for the `unsupported-type` sentence. */
  readonly extension: string;
}

/** Null when the file may be sent; otherwise the named refusal. */
export function screenPortalFile(file: { name: string; size: number; type: string }): ScreenedFile | null {
  const extension = extensionOf(file.name);
  const declared = mimeTypeFor(file);
  const known = Object.values(PORTAL_MIME_BY_EXTENSION).includes(declared);

  if (!known) return { name: file.name, reason: 'unsupported-type', extension };
  // A zero-byte file is a picker that failed, a file still syncing from iCloud,
  // or a directory. The contract's own `byteSize` minimum is 1, so it would be
  // refused anyway — this just says which file, before the network.
  if (file.size === 0) return { name: file.name, reason: 'empty', extension };
  if (file.size > PORTAL_UPLOAD_LIMIT) return { name: file.name, reason: 'too-large', extension };
  return null;
}

/** The whole picked set, split. Order is preserved in both halves. */
export function screenPortalFiles<T extends { name: string; size: number; type: string }>(
  files: readonly T[],
): { accepted: T[]; refused: ScreenedFile[] } {
  const accepted: T[] = [];
  const refused: ScreenedFile[] = [];
  for (const file of files) {
    const problem = screenPortalFile(file);
    if (problem === null) accepted.push(file);
    else refused.push(problem);
  }
  return { accepted, refused };
}

/** The cap, in whole megabytes, for the copy that states it. */
export const PORTAL_UPLOAD_LIMIT_MB = Math.round(PORTAL_UPLOAD_LIMIT / 1024 / 1024);
