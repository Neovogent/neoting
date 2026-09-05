import { defineMessages, type IntlShape, type MessageDescriptor } from 'react-intl';
import type { Document, SourceChannel } from './types';

/**
 * The words a document row uses for HOW IT ARRIVED (review items 21/43/62).
 *
 * One catalogue for one surface role — the "Received via" cell / pill and the
 * preview's "via …" line — because that role rendering the raw slug
 * (`sms-link`) on one screen and different words on another was the reported
 * defect. Chart legends (AnalyticsView, ClientDetailView's channel mix) keep
 * their per-view ids per `i18n/common.ts`'s rule; the WORDS should still agree
 * with these.
 *
 * The honesty rules these words carry:
 *  - ID sends no SMS (launch M8), so `sms-link` reads "Chase link" — the link
 *    arrives by email — never anything with SMS in it.
 *  - A signed-in client's direct upload is "Client portal", never a chase.
 */
export const channelLabels: Record<SourceChannel, MessageDescriptor> = defineMessages({
  email: { id: 'pipeline.channelLabels.email', defaultMessage: 'Email' },
  web: { id: 'pipeline.channelLabels.web', defaultMessage: 'Web upload' },
  whatsapp: { id: 'pipeline.channelLabels.whatsapp', defaultMessage: 'WhatsApp' },
  'sms-link': { id: 'pipeline.channelLabels.smsLink', defaultMessage: 'Chase link' },
  csv: { id: 'pipeline.channelLabels.csv', defaultMessage: 'CSV / XLSX' },
  chat: { id: 'pipeline.channelLabels.chat', defaultMessage: 'Chat upload' },
  portal: { id: 'pipeline.channelLabels.portal', defaultMessage: 'Client portal' },
});

/**
 * The server's machine slugs on `submitterLabel` — provenance markers, not
 * words for a human. Anything else on that field IS display words ("Uploaded
 * by Priya Shah"), composed server-side from facts the server held.
 */
const PROVENANCE_SLUGS = new Set([
  'uploaded-by-delegated-session', // pre-5 Sep 2026 rows, both portal kinds
  'uploaded-via-chase-link',
  'uploaded-via-client-portal',
]);

/** The human words for who sent this document, or null when there are none. */
export function submitterDisplay(doc: Pick<Document, 'submitterLabel'>): string | null {
  const label = doc.submitterLabel;
  if (label === undefined || label === '' || PROVENANCE_SLUGS.has(label)) return null;
  return label;
}

/**
 * What the "Received via" cell says. Client channels name the CHANNEL
 * ("Client portal", "Chase link", "Email" — who sent it belongs to the
 * preview's provenance line); the practice's own manual door names the PERSON
 * ("Uploaded by Priya Shah", item 62) because there the accountant IS the
 * provenance, distinct from every client channel.
 */
export function receivedViaText(intl: IntlShape, doc: Pick<Document, 'source' | 'submitterLabel'>): string {
  if (doc.source === 'web') {
    const who = submitterDisplay(doc);
    if (who !== null) return who;
  }
  return intl.formatMessage(channelLabels[doc.source]);
}

/**
 * The preview/viewer header line. Channels compose into the caller's own
 * "via {source}" message ("VIA CLIENT PORTAL"); a manual upload's label stands
 * alone — "UPLOADED BY PRIYA SHAH", never "VIA UPLOADED BY…".
 */
export function receivedViaHeading(
  intl: IntlShape,
  doc: Pick<Document, 'source' | 'submitterLabel'>,
  via: MessageDescriptor,
): string {
  if (doc.source === 'web') {
    const who = submitterDisplay(doc);
    if (who !== null) return who;
  }
  return intl.formatMessage(via, { source: intl.formatMessage(channelLabels[doc.source]) });
}
