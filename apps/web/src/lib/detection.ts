import { defineMessages, type MessageDescriptor } from 'react-intl';
import type { MissingItem } from './types';

/**
 * How we know a document is missing.
 *
 * Five separate engines put items on the missing list, and they are not
 * interchangeable evidence. "There is a payment on the bank feed with nothing
 * against it" is a fact the client can check in seconds; "this supplier bills
 * you every month and this month is absent" is an inference that is sometimes
 * simply wrong. An accountant deciding whether to chase, cash-code or drop an
 * item is really deciding how much to trust the detection, so the row has to
 * say which one found it rather than presenting five different confidences as
 * one undifferentiated list.
 *
 * The table below is module scope, where no hook can run, so it holds
 * `MessageDescriptor`s and the screen showing a row formats them — the pattern
 * in `i18n/index.ts`.
 */

const m = defineMessages({
  // Where an accountant goes to check it. These are screen names, so they are
  // one shared vocabulary: two engines both point at Chases, and a second id
  // for the same destination is how the two drift apart in translation.
  whereBankUnmatched: { id: 'pipeline.detection.whereBankUnmatched', defaultMessage: 'Bank → Unmatched' },
  whereBankStatements: { id: 'pipeline.detection.whereBankStatements', defaultMessage: 'Bank → Statements' },
  whereSupplierStatements: {
    id: 'pipeline.detection.whereSupplierStatements',
    defaultMessage: 'Supplier Statements',
  },
  whereDocuments: { id: 'pipeline.detection.whereDocuments', defaultMessage: 'Documents' },
  whereChases: { id: 'pipeline.detection.whereChases', defaultMessage: 'Chases' },

  bankTransactionTag: { id: 'pipeline.detection.bankTransactionTag', defaultMessage: 'Bank line' },
  bankTransactionDetail: {
    id: 'pipeline.detection.bankTransactionDetail',
    defaultMessage:
      'Money left the account and no document explains it. The payment is on the feed, so this one is not in doubt — the paperwork simply has not arrived.',
  },

  supplierStatementTag: { id: 'pipeline.detection.supplierStatementTag', defaultMessage: 'Supplier statement' },
  supplierStatementDetail: {
    id: 'pipeline.detection.supplierStatementDetail',
    defaultMessage:
      'The supplier’s own statement lists this invoice and we do not hold it. Their records say it exists, which makes it worth chasing them as well as the client.',
  },

  statementGapTag: { id: 'pipeline.detection.statementGapTag', defaultMessage: 'Statement gap' },
  statementGapDetail: {
    id: 'pipeline.detection.statementGapDetail',
    defaultMessage:
      'A bank statement is missing for this period, so anything inside it is unverifiable. This is a gap in the evidence rather than one absent receipt.',
  },

  recurringTag: { id: 'pipeline.detection.recurringTag', defaultMessage: 'Expected, not arrived' },
  recurringDetail: {
    id: 'pipeline.detection.recurringDetail',
    defaultMessage:
      'This supplier bills on a regular cycle and this period is absent. It is an inference, not a certainty — the charge may genuinely have stopped.',
  },

  fallbackTag: { id: 'pipeline.detection.fallbackTag', defaultMessage: 'Flagged' },
  fallbackDetail: { id: 'pipeline.detection.fallbackDetail', defaultMessage: 'Flagged as missing.' },
});

export interface DetectionLabel {
  /** For a chip on a row. Two or three words. */
  tag: MessageDescriptor;
  /** What the engine actually saw, for the tooltip. */
  detail: MessageDescriptor;
  /** Where an accountant goes to check it themselves. */
  where: MessageDescriptor;
}

export const DETECTION: Record<MissingItem['detectedBy'], DetectionLabel> = {
  'bank-transaction': {
    tag: m.bankTransactionTag,
    detail: m.bankTransactionDetail,
    where: m.whereBankUnmatched,
  },
  'supplier-statement': {
    tag: m.supplierStatementTag,
    detail: m.supplierStatementDetail,
    where: m.whereSupplierStatements,
  },
  'statement-gap': {
    tag: m.statementGapTag,
    detail: m.statementGapDetail,
    where: m.whereBankStatements,
  },
  recurring: {
    tag: m.recurringTag,
    detail: m.recurringDetail,
    where: m.whereChases,
  },
};

/** The engine's label, with a safe fallback for anything unrecognised. */
export const detectionOf = (by: MissingItem['detectedBy']): DetectionLabel =>
  DETECTION[by] ?? { tag: m.fallbackTag, detail: m.fallbackDetail, where: m.whereChases };
