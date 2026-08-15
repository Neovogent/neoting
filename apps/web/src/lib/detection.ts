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
 */

export interface DetectionLabel {
  /** For a chip on a row. Two or three words. */
  tag: string;
  /** What the engine actually saw, for the tooltip. */
  detail: string;
  /** Where an accountant goes to check it themselves. */
  where: string;
}

export const DETECTION: Record<MissingItem['detectedBy'], DetectionLabel> = {
  'bank-transaction': {
    tag: 'Bank line',
    detail: 'Money left the account and no document explains it. The payment is on the feed, so this one is not in doubt — the paperwork simply has not arrived.',
    where: 'Bank → Unmatched',
  },
  'supplier-statement': {
    tag: 'Supplier statement',
    detail: 'The supplier’s own statement lists this invoice and we do not hold it. Their records say it exists, which makes it worth chasing them as well as the client.',
    where: 'Supplier Statements',
  },
  'statement-gap': {
    tag: 'Statement gap',
    detail: 'A bank statement is missing for this period, so anything inside it is unverifiable. This is a gap in the evidence rather than one absent receipt.',
    where: 'Bank → Statements',
  },
  'ledger-attachment': {
    tag: 'Posted, no attachment',
    detail: 'The entry is already in the ledger with nothing attached to support it. It will be the first thing an inspector asks for.',
    where: 'Documents',
  },
  recurring: {
    tag: 'Expected, not arrived',
    detail: 'This supplier bills on a regular cycle and this period is absent. It is an inference, not a certainty — the charge may genuinely have stopped.',
    where: 'Chases',
  },
};

/** The engine's label, with a safe fallback for anything unrecognised. */
export const detectionOf = (by: MissingItem['detectedBy']): DetectionLabel =>
  DETECTION[by] ?? { tag: 'Flagged', detail: 'Flagged as missing.', where: 'Chases' };
