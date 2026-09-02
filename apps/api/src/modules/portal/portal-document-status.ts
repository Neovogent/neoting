import type { DocumentState } from '@prisma/client';

import type { PortalDocumentStatus } from '@neoting/contracts/model';

/**
 * `DocumentState` → the five words a client is shown (D49, `PortalDocumentStatus`).
 *
 * ## Why this exists at all, and why it is on the server
 *
 * The pipeline has eight states and most of the distinctions between them are
 * the PRACTICE's working state: `RECEIVED` versus `PROCESSING` says how busy a
 * queue is, `REJECTED` versus `FAILED` names an internal reason, `ARCHIVED` is
 * the firm's own housekeeping. None of that is the client's to see — it is the
 * same line `PortalSummary` draws against `BusinessSummary`, one row down.
 *
 * The mapping is made **here** rather than in the browser because it is the one
 * place it can be made once. A client that mapped `DocumentState` itself would
 * be a second opinion about what a document's state means, and the two would
 * diverge the first time a state was added — with the client's version being
 * the one an actual person read.
 *
 * ## The map, and the two judgements in it
 *
 * ```
 * RECEIVED    PROCESSING  -> processing            we have it, we are reading it
 * TO_REVIEW               -> with_accountant       read, now on a human's desk
 * READY                   -> accepted              the accountant is happy with it
 * PUBLISHED               -> filed                 through, and released into the books
 * REJECTED    FAILED      -> needs_another_copy    we could not use it; send it again
 * ARCHIVED                -> with_accountant       (not reachable here — see below)
 * ```
 *
 * **`REJECTED` and `FAILED` collapse, deliberately.** They differ by *whose*
 * fault it was — a document the identity gate refused (D45) versus one the
 * pipeline could not read — and that distinction is internal. What the sender
 * can do about either is identical and is exactly one thing, so they are told
 * exactly that one thing. The internal reason (`failureCode`,
 * `failureMessage`) is deliberately NOT projected alongside it: a failure code
 * is the practice's diagnostic, and "Password-protected PDF" is a sentence
 * written for an accountant looking at a queue.
 *
 * **`ARCHIVED` is not served by this endpoint**, so this branch is unreachable
 * through `GET /portal/documents` (the query excludes it) and exists only
 * because a total function is the point of this file. Archiving is the
 * practice's own act — a duplicate set aside, a document superseded — and none
 * of the five words is *true* of one. `with_accountant` is the least false: it
 * is in the firm's hands and it is not the client's to act on. It is
 * emphatically NOT `filed`, which would claim the document reached their books.
 */
export function portalDocumentStatus(state: DocumentState): PortalDocumentStatus {
  switch (state) {
    case 'RECEIVED':
    case 'PROCESSING':
      return 'processing';
    case 'TO_REVIEW':
      return 'with_accountant';
    case 'READY':
      return 'accepted';
    case 'PUBLISHED':
      return 'filed';
    case 'REJECTED':
    case 'FAILED':
      return 'needs_another_copy';
    case 'ARCHIVED':
      return 'with_accountant';
  }
}

/**
 * The states this endpoint serves — every state except `ARCHIVED`.
 *
 * Exported so the service's `where` clause and the mapping above cannot drift:
 * the branch that says "not reachable" is only true while this list says so.
 */
export const PORTAL_HIDDEN_DOCUMENT_STATE = 'ARCHIVED' satisfies DocumentState;
