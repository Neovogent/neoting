import { defineMessages, type MessageDescriptor } from 'react-intl';

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
 *
 * The fragments below are `MessageDescriptor`s: this is module scope, where no
 * hook can run, so the sentence that embeds one formats it at the call site —
 * `intl.formatMessage(channelLabel('chase'))`.
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

const m = defineMessages({
  bySms: { id: 'pipeline.channels.bySms', defaultMessage: 'by SMS' },
  byEmail: { id: 'pipeline.channels.byEmail', defaultMessage: 'by email' },
  needsMobile: { id: 'pipeline.channels.needsMobile', defaultMessage: 'a mobile number' },
  needsEmail: { id: 'pipeline.channels.needsEmail', defaultMessage: 'an email address' },
});

/** "by SMS" / "by email", for sentences that name the channel. */
export const channelLabel = (what: Notification): MessageDescriptor =>
  channelFor(what) === 'sms' ? m.bySms : m.byEmail;

/** What we need on file before something can be sent at all. */
export const contactNeededFor = (what: Notification): MessageDescriptor =>
  channelFor(what) === 'sms' ? m.needsMobile : m.needsEmail;
