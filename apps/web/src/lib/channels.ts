/**
 * Which channel each thing we send goes out on.
 *
 * SMS is reserved. It reaches someone who has installed nothing and may not
 * read email that day, and every use of it costs a little of the client's
 * patience — so it carries only the four things that are genuinely urgent or
 * that must work with no account at all:
 *
 *   · a chase for a missing document
 *   · a reminder on one
 *   · an approval that is waiting on a person
 *   · the very first registration of a client company
 *
 * Everything else — inviting a colleague at the business, telling someone a
 * claim was reimbursed, weekly summaries, receipts of what arrived — goes by
 * email, where it can be longer, kept, and searched later.
 *
 * Keeping the rule here rather than in prose means the copy on every screen
 * can be generated from it, so a screen cannot quietly claim the wrong one.
 */
export type Channel = 'sms' | 'email';

export type Notification =
  | 'chase'
  | 'chase-reminder'
  | 'approval-request'
  | 'client-registration'
  | 'user-invite'
  | 'user-approval-request'
  | 'claim-update'
  | 'weekly-summary'
  | 'upload-receipt';

const SMS_ONLY: Notification[] = [
  'chase',
  'chase-reminder',
  'approval-request',
  'client-registration',
];

export const channelFor = (what: Notification): Channel => (SMS_ONLY.includes(what) ? 'sms' : 'email');

/** "by SMS" / "by email", for sentences that name the channel. */
export const channelLabel = (what: Notification) => (channelFor(what) === 'sms' ? 'by SMS' : 'by email');

/** What we need on file before something can be sent at all. */
export const contactNeededFor = (what: Notification) =>
  channelFor(what) === 'sms' ? 'a mobile number' : 'an email address';
