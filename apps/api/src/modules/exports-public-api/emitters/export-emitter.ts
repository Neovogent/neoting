import type { ExportTarget, ExportWarning } from '@neoting/contracts/model';

import type { CanonicalRow } from '../canonical/canonical-row.js';

/**
 * The seam between the canonical model and one target's file format.
 *
 * **This interface is the point of A7.** SoT §24.3 opens *"the canonical model
 * comes first — one internal representation, one emitter per target. VT is an
 * emitter, not the architecture — otherwise the second client is a rebuild"*,
 * and §21 carries scope capture by the first client as a named risk. An
 * interface with one implementation is normally a smell; here it is the
 * mitigation, and it is cheap enough to be worth being wrong about.
 *
 * **Xero and Sage emitters are deliberately absent.** D42 puts every ledger
 * adapter out of this release, and the `ExportTarget` enum in both the contract
 * and Prisma carries two values for the same reason its own comment gives: *an
 * enum value with no emitter behind it is a 500 waiting for whoever passes it.*
 */
export interface ExportEmitter {
  readonly target: ExportTarget;
  /** File extension without the dot — A9 names the download from this. */
  readonly fileExtension: string;
  readonly contentType: string;
  /**
   * Canonical rows in, one file out.
   *
   * Implementations parse their input with Zod before touching it (rule 4). The
   * caller of an emitter is whatever assembled the canonical rows, and "we
   * built them ourselves so they must be valid" is precisely the assumption
   * that puts a wrong number in someone's books.
   */
  emit(rows: readonly CanonicalRow[]): EmittedFile;
}

export interface EmittedFile {
  /** The finished file. Bytes, not a string — the encoding decision is already made (`csv/encoding.ts`). */
  readonly bytes: Buffer;
  /**
   * Rows the emitter actually wrote, excluding any header.
   *
   * The accountant reconciles this against what VT's Universal Input Sheet
   * shows before pressing Post, which is the one moment a silently short file
   * is caught by a human. It differs from the input row count wherever a
   * document collapsed.
   */
  readonly rowCount: number;
  /**
   * **What did not travel.**
   *
   * §24.3.4 names silent flattening as the failure mode to design against, and
   * this array is the alternative to it. An emitter that drops something and
   * returns an empty `warnings` has lied by omission; the shape comes from the
   * contract so A9 can render it unchanged.
   */
  readonly warnings: readonly ExportWarning[];
}
