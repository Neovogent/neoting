import type { Document } from './types';

/**
 * Why a document failed, and what will actually fix it.
 *
 * "Failed" on its own is the least useful word in the app: it tells an
 * accountant something is wrong and nothing about what to do, so the only move
 * left is Retry — and Retry is frequently the one thing that cannot work. A
 * password-protected PDF read again is a password-protected PDF. A publish
 * rejected because the tax rate is not in the chart of accounts will be
 * rejected the same way in ten seconds' time.
 *
 * So a failure is classified into a cause, and the cause decides the button.
 * Retry stays available everywhere — sometimes an API really was just down —
 * but it stops being the only thing on offer, and where it is futile the row
 * says so rather than letting someone press it four times.
 */

export type FailureStage = 'extraction' | 'publish';

/** What the row should offer as the way out. */
export type FailureFix = 'retry' | 'replace-file' | 'open-document' | 'reconnect-ledger';

export interface Failure {
  stage: FailureStage;
  /** Short, for the tooltip heading. */
  title: string;
  /** The specific cause, in the accountant's terms. */
  reason: string;
  /** What it means and why the fix is the fix. One or two sentences. */
  detail: string;
  fix: FailureFix;
  /** The label for the reason's own button. */
  fixLabel: string;
  /**
   * Whether reading or publishing it again, unchanged, could plausibly work.
   * False means the input has to change first.
   */
  retryHelps: boolean;
}

/** Cause patterns, most specific first — the note is the extractor's own words. */
const CAUSES: {
  stage: FailureStage;
  match: RegExp;
  reason: string;
  detail: string;
  fix: FailureFix;
  fixLabel: string;
  retryHelps: boolean;
}[] = [
  {
    stage: 'extraction',
    match: /password|protected|encrypted|locked/i,
    reason: 'The file is password-protected',
    detail:
      'Nothing can be read out of it while it is locked, so reading it again gives the same result. Ask the sender for an unlocked copy and put that in its place.',
    fix: 'replace-file',
    fixLabel: 'Replace file',
    retryHelps: false,
  },
  {
    stage: 'extraction',
    match: /blank|blurred|blurry|illegible|too small|low resolution|unreadable|corrupt|damaged/i,
    reason: 'The image cannot be read',
    detail:
      'The page came through too poor to extract from. A second attempt reads the same pixels — a clearer scan or photo is what changes the outcome.',
    fix: 'replace-file',
    fixLabel: 'Replace file',
    retryHelps: false,
  },
  {
    stage: 'extraction',
    match: /unsupported|not a document|wrong file|format/i,
    reason: 'The file type is not supported',
    detail: 'Send it through as a PDF or an image and it will be read normally.',
    fix: 'replace-file',
    fixLabel: 'Replace file',
    retryHelps: false,
  },
  {
    stage: 'publish',
    match: /tax rate|chart of accounts|account code|nominal|unmapped|not found in/i,
    reason: 'The ledger has nothing to post this to',
    detail:
      'The tax rate or account on this document does not exist in the client’s chart of accounts, so the same publish will be refused again. Set the mapping on the document first, then publish.',
    fix: 'open-document',
    fixLabel: 'Fix mapping',
    retryHelps: false,
  },
  {
    stage: 'publish',
    match: /locked period|period is closed|closed period|filed/i,
    reason: 'That accounting period is closed',
    detail:
      'The ledger will not accept a posting into a filed period. Move the date into an open period, or have the period reopened, before publishing.',
    fix: 'open-document',
    fixLabel: 'Change the date',
    retryHelps: false,
  },
  {
    stage: 'publish',
    match: /disconnect|not connected|token|auth|unauthori[sz]ed|expired|reconnect/i,
    reason: 'The ledger connection has dropped',
    detail:
      'The client’s accounting software needs reconnecting before anything can be posted. Once it is back, this publishes as normal.',
    fix: 'reconnect-ledger',
    fixLabel: 'Reconnect ledger',
    retryHelps: false,
  },
  {
    stage: 'publish',
    match: /timeout|timed out|unavailable|5\d\d|rate limit|try again/i,
    reason: 'The ledger did not respond',
    detail: 'Nothing was wrong with the document — the other end was down or busy. Publishing again usually works.',
    fix: 'retry',
    fixLabel: 'Publish again',
    retryHelps: true,
  },
];

/**
 * A document's failure, or null if it has not failed.
 *
 * The stage is decided by evidence rather than wording: a document with no
 * extracted fields never got read, whatever the note says.
 */
export function failureOf(doc: Document): Failure | null {
  if (doc.status !== 'rejected' && !doc.publishFailed) return null;

  const note = doc.statusNote ?? '';
  const stage: FailureStage = doc.fields.length === 0 ? 'extraction' : 'publish';
  const cause = CAUSES.find((c) => c.stage === stage && c.match.test(note));

  if (cause) {
    return {
      stage,
      title: stage === 'extraction' ? 'Could not read this document' : 'The ledger refused this',
      reason: cause.reason,
      detail: cause.detail,
      fix: cause.fix,
      fixLabel: cause.fixLabel,
      retryHelps: cause.retryHelps,
    };
  }

  // Unrecognised note: say what we do know rather than inventing a cause, and
  // let Retry be the offer — it is the honest default when we cannot tell.
  return stage === 'extraction'
    ? {
        stage,
        title: 'Could not read this document',
        reason: note || 'Extraction did not finish',
        detail: 'Nothing was extracted from the file. Reading it again is worth one attempt before replacing it.',
        fix: 'retry',
        fixLabel: 'Read it again',
        retryHelps: true,
      }
    : {
        stage,
        title: 'The ledger refused this',
        reason: note || 'Publish was rejected',
        detail: 'Everything read off the document is still here. It goes back to Ready so it can be published again.',
        fix: 'retry',
        fixLabel: 'Publish again',
        retryHelps: true,
      };
}

/** What Retry will do, said plainly — the two stages behave differently. */
export function retryMeaning(failure: Failure): string {
  return failure.stage === 'extraction'
    ? 'Sends the file back through extraction. Anything already read off it is replaced.'
    : 'Puts it back to Ready with every figure intact, so it can be published again.';
}
