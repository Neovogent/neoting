import type { Document as DocumentRow, DocumentState, Prisma } from '@prisma/client';

import type { ScopedClient } from '../../common/db/scoped-db.js';

/**
 * The document state machine — issue #80, SoT §4 Stage 5.
 *
 * ONE transition function. The sink creates documents in RECEIVED (creation is
 * not a transition); everything that moves a document after that goes through
 * {@link transitionDocument} — the proposal executors (#81), the pipeline
 * stages, and every future caller. An illegal move THROWS rather than silently
 * writing, and every legal move writes a `DocumentEvent` in the same
 * transaction, because the processing log is the audit surface for the
 * pipeline and it must not have gaps.
 */

/**
 * The legal moves. Read a row as "from → may become".
 *
 * The shape of the map is the point: it is a total record over
 * `DocumentState`, so adding an enum value without deciding its transitions is
 * a compile error here, not a runtime surprise in a queue worker.
 *
 * - RECEIVED/PROCESSING cannot be archived: a document mid-pipeline has not
 *   been seen by anyone yet, and archiving it would be losing it politely.
 * - PROCESSING is the reprocess target from everywhere retryable — that is
 *   what `document.reprocess` (#81) drives, and why REJECTED/FAILED point
 *   there and nowhere else except the archive.
 * - PUBLISHED only archives. Un-publishing is a publishing-module concern
 *   with external side effects; it is not a state edge anyone may take here.
 * - ARCHIVED restores to the states archiving is reachable from — which one is
 *   the UNARCHIVE decision recorded on #81: publishing data kept → PUBLISHED,
 *   cleared or absent → READY/TO_REVIEW by readiness, failure code present →
 *   the failed surface.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<DocumentState, readonly DocumentState[]>> = {
  RECEIVED: ['PROCESSING', 'REJECTED', 'FAILED'],
  PROCESSING: ['TO_REVIEW', 'READY', 'REJECTED', 'FAILED'],
  TO_REVIEW: ['READY', 'PROCESSING', 'REJECTED', 'ARCHIVED'],
  READY: ['TO_REVIEW', 'PUBLISHED', 'PROCESSING', 'REJECTED', 'ARCHIVED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: ['PUBLISHED', 'READY', 'TO_REVIEW', 'REJECTED', 'FAILED'],
  REJECTED: ['PROCESSING', 'ARCHIVED'],
  FAILED: ['PROCESSING', 'ARCHIVED'],
};

export type DocumentFailureState = Extract<DocumentState, 'REJECTED' | 'FAILED'>;
export type DocumentNonFailureState = Exclude<DocumentState, DocumentFailureState>;

/** Why a document was rejected or failed — surfaced verbatim in the Rejected/Failed view. */
export interface DocumentFailure {
  /** A stable NT- machine code (§13.4). */
  readonly code: string;
  /** Plain English a client can act on. A rejection without a reason is not a rejection. */
  readonly message: string;
}

/**
 * The transition request. A discriminated union so that REJECTED and FAILED
 * are unreachable without a code and a message **in the type system** — the
 * schema's "never null when state is REJECTED/FAILED" made mechanical rather
 * than left as a comment. The `failure?: never` on the other branch is what
 * stops a caller attaching a failure to a state that must not carry one.
 */
export type DocumentTransition =
  | {
      readonly to: DocumentNonFailureState;
      readonly failure?: never;
      readonly traceId: string;
      /** Small, safe, storable context for the event log. Never untrusted content. */
      readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
    }
  | {
      readonly to: DocumentFailureState;
      readonly failure: DocumentFailure;
      readonly traceId: string;
      readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
    };

export class IllegalDocumentTransition extends Error {
  constructor(
    readonly documentId: string,
    readonly from: DocumentState,
    readonly to: DocumentState,
  ) {
    super(`illegal document transition ${from} → ${to} on ${documentId} (issue #80 — see LEGAL_TRANSITIONS)`);
    this.name = 'IllegalDocumentTransition';
  }
}

/**
 * Thrown when the row moved between the caller reading it and the transition
 * writing it. The write is guarded on the expected `from` state, so a race
 * loses loudly instead of silently overwriting a concurrent transition.
 */
export class StaleDocumentState extends Error {
  constructor(
    readonly documentId: string,
    readonly expectedFrom: DocumentState,
  ) {
    super(`document ${documentId} is no longer in ${expectedFrom} — concurrent transition won; re-read and decide again`);
    this.name = 'StaleDocumentState';
  }
}

/** Pure legality check, exported for callers that need to ask before acting. */
export function isLegalTransition(from: DocumentState, to: DocumentState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Move a document to a new state, inside the CALLER's open `scopedDb`
 * transaction — the executor pattern (#81): one effect, one transaction, and
 * this function cannot open a second one because `ScopedClient` has no
 * `$transaction`.
 *
 * What one call does, atomically with the caller's other writes:
 * - refuses an illegal move ({@link IllegalDocumentTransition});
 * - refuses a stale one — the UPDATE is guarded on the expected `from` state,
 *   so a lost race throws {@link StaleDocumentState} rather than clobbering;
 * - writes `failureCode`/`failureMessage` on the failure branch, and CLEARS
 *   them on reprocess (REJECTED/FAILED → PROCESSING) so a healthy document
 *   never carries a stale reason — the archive keeps them, because an archived
 *   rejection restores as a rejection and needs its reason back;
 * - stamps `archivedAt` on the way into ARCHIVED and clears it on the way out;
 * - writes the `DocumentEvent` (stage `state`, outcome = the new state, the
 *   caller's traceId, detail carrying from/to and the failure if any).
 */
export async function transitionDocument(
  db: ScopedClient,
  document: Pick<DocumentRow, 'id' | 'state'>,
  transition: DocumentTransition,
): Promise<void> {
  const from = document.state;
  const { to, traceId } = transition;

  if (!isLegalTransition(from, to)) throw new IllegalDocumentTransition(document.id, from, to);

  // The type system already forbids these; the runtime guard is for the caller
  // that arrived through a cast. Fails towards refusing, like every gate here.
  if ((to === 'REJECTED' || to === 'FAILED') && transition.failure === undefined) {
    throw new IllegalDocumentTransition(document.id, from, to);
  }

  const failure = transition.failure;
  const data: Prisma.DocumentUpdateManyMutationInput = {
    state: to,
    ...(failure !== undefined ? { failureCode: failure.code, failureMessage: failure.message } : {}),
    // Reprocess wipes the reason; anything else leaving a failure state (only
    // the archive) keeps it, so an unarchived rejection still says why.
    ...((from === 'REJECTED' || from === 'FAILED') && to === 'PROCESSING'
      ? { failureCode: null, failureMessage: null }
      : {}),
    ...(to === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
    ...(from === 'ARCHIVED' ? { archivedAt: null } : {}),
  };

  // updateMany, not update: the guarded `state: from` makes the write
  // compare-and-swap shaped, and a zero rowcount is the race detector.
  const updated = await db.document.updateMany({ where: { id: document.id, state: from }, data });
  if (updated.count === 0) throw new StaleDocumentState(document.id, from);

  await db.documentEvent.create({
    data: {
      documentId: document.id,
      stage: 'state',
      outcome: to,
      traceId,
      detail: {
        from,
        to,
        ...(failure !== undefined ? { failureCode: failure.code, failureMessage: failure.message } : {}),
        ...transition.detail,
      },
    },
  });
}
