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
  /**
   * **The same rows {@link emit} writes, per document, before any of it is a
   * file.**
   *
   * This exists so a human can be shown the bookkeeping entry they are
   * authorising *before* the release, rather than discovering it inside their
   * accounting software afterwards. The Review → Approve card is not allowed to
   * describe an effect it has re-derived — a second implementation of "what
   * goes in column G" would agree with the emitter until the day it did not —
   * so the contract on this method is stronger than "returns a preview":
   *
   * ⚠ **An implementation MUST build these rows with the same function `emit`
   * builds them with.** Not the same rules, the same *code*. If the two ever
   * become two functions, the preview becomes a lie, and a lie on a review card
   * is worse than showing nothing at all. `emitter.previewEntries` and
   * `emitter.emit` are checked against each other by test
   * (`vt-transaction-plus-emitter.test.ts`, which parses the emitted bytes back
   * and compares them cell by cell), which is the only guard that survives a
   * refactor.
   *
   * Warnings are partitioned per document rather than pooled, so the card can
   * say what will not travel *for this document* — an unprefixed analysis
   * account is worth knowing before the release, not after the import.
   */
  previewEntries(rows: readonly CanonicalRow[]): ExportEntryPreview;
}

/**
 * What one document will contribute to the export file — the contract's
 * `ExportEntryPreview`, structurally.
 *
 * The cells are **positional against {@link ExportEntryPreview.columns}**,
 * which is how the targets themselves read a file (VT's journal import is
 * positional and reads a header row as a transaction), and it is also what
 * keeps the payload a 500-document batch has to carry from multiplying the
 * column headings by the row count.
 */
export interface ExportEntryDocument {
  readonly documentId: string;
  /**
   * Which file inside the export the rows land in. VT writes one file per
   * (date, direction) because the journal import applies one date to a whole
   * file; a single-file target sends `''`.
   */
  readonly fileName: string;
  /** The import format the accountant picks for that file, in the target's own words. `''` when it has none. */
  readonly dataFormat: string;
  /** One per line the file will carry. A document split across two nominals is two rows. */
  readonly rows: readonly (readonly string[])[];
  /** The emitter's own warnings for THIS document. */
  readonly warnings: readonly ExportWarning[];
}

/** A document that cannot become a row at all, named rather than dropped. */
export interface ExportEntryRefusal {
  readonly documentId: string;
  readonly code: string;
  readonly message: string;
}

export interface ExportEntryPreview {
  readonly target: ExportTarget;
  /** The emitter's column names, in the order the file writes them. */
  readonly columns: readonly string[];
  readonly documents: readonly ExportEntryDocument[];
  /**
   * Filled by the CALLER, not by an emitter: a document that never became a
   * canonical row never reaches an emitter at all. It is on this shape because
   * the reviewer needs one list, not two.
   */
  readonly refusals?: readonly ExportEntryRefusal[];
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
