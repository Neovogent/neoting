import { defineMessages, type MessageDescriptor } from 'react-intl';

/**
 * Which channel each thing we send goes out on.
 *
 * Initial Delivery has exactly one: email (launch S2/A13 — SMS was cut, and
 * nothing in the product sends one). Chases, reminders, approval requests,
 * client registration, colleague invites, claim updates, summaries and
 * receipts all go by email, where a message can be longer, kept, and
 * searched later.
 *
 * Keeping the rule here rather than in prose means the copy on every screen
 * can be generated from it, so a screen cannot quietly claim the wrong one —
 * and when a second channel returns, this list is where it comes back.
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

/** Empty for Initial Delivery: there is no SMS. Kept so the seam — and every
 *  sentence generated from it — survives the channel's return unchanged. */
const SMS_ONLY: Notification[] = [];

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
