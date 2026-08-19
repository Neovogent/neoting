import { defineMessages, type IntlShape, type MessageDescriptor } from 'react-intl';
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
 *
 * ## Why this module holds descriptors rather than text
 *
 * It is not a component, so it cannot call `useIntl`. Every string below is a
 * `MessageDescriptor` and the screen showing it formats it — the pattern in
 * `i18n/index.ts`. The one exception is `reason`, which is sometimes the
 * extractor's own note: see `reasonText`.
 */

const m = defineMessages({
  // The two headings, decided by the stage rather than the cause.
  extractionTitle: { id: 'pipeline.failures.extractionTitle', defaultMessage: 'Could not read this document' },
  publishTitle: { id: 'pipeline.failures.publishTitle', defaultMessage: 'The ledger refused this' },

  // The way out. Shared across causes where the words are the same word —
  // three different ids for "Replace file" would hand a translator one phrase
  // three times with no way to see they must agree.
  fixReplaceFile: { id: 'pipeline.failures.fixReplaceFile', defaultMessage: 'Replace file' },
  fixMapping: { id: 'pipeline.failures.fixMapping', defaultMessage: 'Fix mapping' },
  fixChangeDate: { id: 'pipeline.failures.fixChangeDate', defaultMessage: 'Change the date' },
  fixReconnectLedger: { id: 'pipeline.failures.fixReconnectLedger', defaultMessage: 'Reconnect ledger' },
  fixPublishAgain: { id: 'pipeline.failures.fixPublishAgain', defaultMessage: 'Publish again' },
  fixReadAgain: { id: 'pipeline.failures.fixReadAgain', defaultMessage: 'Read it again' },

  passwordReason: { id: 'pipeline.failures.passwordReason', defaultMessage: 'The file is password-protected' },
  passwordDetail: {
    id: 'pipeline.failures.passwordDetail',
    defaultMessage:
      'Nothing can be read out of it while it is locked, so reading it again gives the same result. Ask the sender for an unlocked copy and put that in its place.',
  },

  unreadableReason: { id: 'pipeline.failures.unreadableReason', defaultMessage: 'The image cannot be read' },
  unreadableDetail: {
    id: 'pipeline.failures.unreadableDetail',
    defaultMessage:
      'The page came through too poor to extract from. A second attempt reads the same pixels — a clearer scan or photo is what changes the outcome.',
  },

  unsupportedReason: { id: 'pipeline.failures.unsupportedReason', defaultMessage: 'The file type is not supported' },
  unsupportedDetail: {
    id: 'pipeline.failures.unsupportedDetail',
    defaultMessage: 'Send it through as a PDF or an image and it will be read normally.',
  },

  unmappedReason: {
    id: 'pipeline.failures.unmappedReason',
    defaultMessage: 'The ledger has nothing to post this to',
  },
  unmappedDetail: {
    id: 'pipeline.failures.unmappedDetail',
    defaultMessage:
      'The tax rate or account on this document does not exist in the client’s chart of accounts, so the same publish will be refused again. Set the mapping on the document first, then publish.',
  },

  closedPeriodReason: {
    id: 'pipeline.failures.closedPeriodReason',
    defaultMessage: 'That accounting period is closed',
  },
  closedPeriodDetail: {
    id: 'pipeline.failures.closedPeriodDetail',
    defaultMessage:
      'The ledger will not accept a posting into a filed period. Move the date into an open period, or have the period reopened, before publishing.',
  },

  disconnectedReason: {
    id: 'pipeline.failures.disconnectedReason',
    defaultMessage: 'The ledger connection has dropped',
  },
  disconnectedDetail: {
    id: 'pipeline.failures.disconnectedDetail',
    defaultMessage:
      'The client’s accounting software needs reconnecting before anything can be posted. Once it is back, this publishes as normal.',
  },

  ledgerSilentReason: { id: 'pipeline.failures.ledgerSilentReason', defaultMessage: 'The ledger did not respond' },
  ledgerSilentDetail: {
    id: 'pipeline.failures.ledgerSilentDetail',
    defaultMessage:
      'Nothing was wrong with the document — the other end was down or busy. Publishing again usually works.',
  },

  // The two unrecognised-note fallbacks.
  extractionStalledReason: {
    id: 'pipeline.failures.extractionStalledReason',
    defaultMessage: 'Extraction did not finish',
  },
  extractionStalledDetail: {
    id: 'pipeline.failures.extractionStalledDetail',
    defaultMessage:
      'Nothing was extracted from the file. Reading it again is worth one attempt before replacing it.',
  },
  publishRejectedReason: { id: 'pipeline.failures.publishRejectedReason', defaultMessage: 'Publish was rejected' },
  publishRejectedDetail: {
    id: 'pipeline.failures.publishRejectedDetail',
    defaultMessage:
      'Everything read off the document is still here. It goes back to Ready so it can be published again.',
  },

  retryMeaningExtraction: {
    id: 'pipeline.failures.retryMeaningExtraction',
    defaultMessage: 'Sends the file back through extraction. Anything already read off it is replaced.',
  },
  retryMeaningPublish: {
    id: 'pipeline.failures.retryMeaningPublish',
    defaultMessage: 'Puts it back to Ready with every figure intact, so it can be published again.',
  },
});

export type FailureStage = 'extraction' | 'publish';

/** What the row should offer as the way out. */
export type FailureFix = 'retry' | 'replace-file' | 'open-document' | 'reconnect-ledger';

export interface Failure {
  stage: FailureStage;
  /** Short, for the tooltip heading. */
  title: MessageDescriptor;
  /**
   * The specific cause, in the accountant's terms.
   *
   * A message when we recognised the cause; the extractor's own note, verbatim,
   * when we did not. That note is data — it arrives from the pipeline and is
   * never in the catalogue — so this is genuinely a union rather than a type
   * that has not been finished. `reasonText` resolves either to a string.
   */
  reason: MessageDescriptor | string;
  /** What it means and why the fix is the fix. One or two sentences. */
  detail: MessageDescriptor;
  fix: FailureFix;
  /** The label for the reason's own button. */
  fixLabel: MessageDescriptor;
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
  reason: MessageDescriptor;
  detail: MessageDescriptor;
  fix: FailureFix;
  fixLabel: MessageDescriptor;
  retryHelps: boolean;
}[] = [
  {
    stage: 'extraction',
    match: /password|protected|encrypted|locked/i,
    reason: m.passwordReason,
    detail: m.passwordDetail,
    fix: 'replace-file',
    fixLabel: m.fixReplaceFile,
    retryHelps: false,
  },
  {
    stage: 'extraction',
    match: /blank|blurred|blurry|illegible|too small|low resolution|unreadable|corrupt|damaged/i,
    reason: m.unreadableReason,
    detail: m.unreadableDetail,
    fix: 'replace-file',
    fixLabel: m.fixReplaceFile,
    retryHelps: false,
  },
  {
    stage: 'extraction',
    match: /unsupported|not a document|wrong file|format/i,
    reason: m.unsupportedReason,
    detail: m.unsupportedDetail,
    fix: 'replace-file',
    fixLabel: m.fixReplaceFile,
    retryHelps: false,
  },
  {
    stage: 'publish',
    match: /tax rate|chart of accounts|account code|nominal|unmapped|not found in/i,
    reason: m.unmappedReason,
    detail: m.unmappedDetail,
    fix: 'open-document',
    fixLabel: m.fixMapping,
    retryHelps: false,
  },
  {
    stage: 'publish',
    match: /locked period|period is closed|closed period|filed/i,
    reason: m.closedPeriodReason,
    detail: m.closedPeriodDetail,
    fix: 'open-document',
    fixLabel: m.fixChangeDate,
    retryHelps: false,
  },
  {
    stage: 'publish',
    match: /disconnect|not connected|token|auth|unauthori[sz]ed|expired|reconnect/i,
    reason: m.disconnectedReason,
    detail: m.disconnectedDetail,
    fix: 'reconnect-ledger',
    fixLabel: m.fixReconnectLedger,
    retryHelps: false,
  },
  {
    stage: 'publish',
    match: /timeout|timed out|unavailable|5\d\d|rate limit|try again/i,
    reason: m.ledgerSilentReason,
    detail: m.ledgerSilentDetail,
    fix: 'retry',
    fixLabel: m.fixPublishAgain,
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
  // A live row names its stage in the stable code (NT-PUB-* is the publish
  // follow-up's; everything else failed before the ledger). The field-count
  // heuristic stays for synthetic rows — an API row always has `fields: []`,
  // which read as "never extracted" and called every publish failure an
  // extraction failure (METH S12).
  const stage: FailureStage = doc.failureCode
    ? doc.failureCode.startsWith('NT-PUB')
      ? 'publish'
      : 'extraction'
    : doc.fields.length === 0
      ? 'extraction'
      : 'publish';
  const cause = CAUSES.find((c) => c.stage === stage && c.match.test(note));

  if (cause) {
    return {
      stage,
      title: stage === 'extraction' ? m.extractionTitle : m.publishTitle,
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
        title: m.extractionTitle,
        reason: note || m.extractionStalledReason,
        detail: m.extractionStalledDetail,
        fix: 'retry',
        fixLabel: m.fixReadAgain,
        retryHelps: true,
      }
    : {
        stage,
        title: m.publishTitle,
        reason: note || m.publishRejectedReason,
        detail: m.publishRejectedDetail,
        fix: 'retry',
        fixLabel: m.fixPublishAgain,
        retryHelps: true,
      };
}

/**
 * The reason as text.
 *
 * `intl` is a parameter, not a hook: this is reached from render bodies, table
 * cell renderers and confirm handlers alike, and a hook would only work in the
 * first of those.
 */
export const reasonText = (failure: Failure, intl: IntlShape): string =>
  typeof failure.reason === 'string' ? failure.reason : intl.formatMessage(failure.reason);

/** What Retry will do, said plainly — the two stages behave differently. */
export function retryMeaning(failure: Failure): MessageDescriptor {
  return failure.stage === 'extraction' ? m.retryMeaningExtraction : m.retryMeaningPublish;
}
