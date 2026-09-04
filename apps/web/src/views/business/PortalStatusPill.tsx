import type { ReactNode } from 'react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';

import type { PortalDocumentStatus } from '@neoting/contracts/model';

/**
 * The five words a client may be told about their own document — and the only
 * five (D49).
 *
 * ## ⚠ THE STATE IS THE SERVER'S; ONLY THE WORDING IS OURS
 *
 * `PortalDocumentStatus` is deliberately not `DocumentState`. The pipeline has
 * eight states and most of the distinctions between them are the practice's
 * working state, which is not the client's to see — whether a document is
 * `RECEIVED` or `PROCESSING` says how busy a queue is; whether it is `REJECTED`
 * or `FAILED` names an internal reason. The mapping down to five is made
 * server-side so it cannot fork between clients.
 *
 * What is done HERE, and must stay here, is the wording: the enum arrives as a
 * machine value and goes through the catalogue, so a translator can move these
 * five sentences without the server shipping prose. Rendering a server-supplied
 * English string verbatim would put five untranslatable phrases on the one
 * surface a non-English-speaking client is most likely to be using.
 *
 * ⚠ **Never render a raw `DocumentState` here**, and never derive one of these
 * five from one. A `status` the enum does not admit is refused at the parse in
 * `api/onboarding.ts` rather than falling through to a blank pill.
 */

const m = defineMessages({
  processing: { id: 'portal.documentStatus.processing', defaultMessage: 'Processing' },
  withAccountant: { id: 'portal.documentStatus.withAccountant', defaultMessage: 'With your accountant' },
  accepted: { id: 'portal.documentStatus.accepted', defaultMessage: 'Accepted' },
  filed: { id: 'portal.documentStatus.filed', defaultMessage: 'Filed' },
  needsAnotherCopy: { id: 'portal.documentStatus.needsAnotherCopy', defaultMessage: 'Needs another copy' },
});

type Tone = 'blue' | 'amber' | 'green' | 'red' | 'neutral';

/** Keyed by the contract's enum — machine values, so only `label` is copy. */
const STATUS: Record<PortalDocumentStatus, { label: MessageDescriptor; tone: Tone }> = {
  processing: { label: m.processing, tone: 'blue' },
  with_accountant: { label: m.withAccountant, tone: 'amber' },
  accepted: { label: m.accepted, tone: 'green' },
  // ⚠ "Filed" is the client's word for their own paperwork having been dealt
  // with. It is NOT a claim that anything reached accounting software: in this
  // release nothing does (D42), and no label on this surface may suggest it.
  filed: { label: m.filed, tone: 'green' },
  needs_another_copy: { label: m.needsAnotherCopy, tone: 'red' },
};

const TONES: Record<Tone, string> = {
  blue: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
  green: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  red: 'bg-red-500/10 text-red-300 border-red-500/20',
  neutral: 'bg-white/5 text-zinc-400 border-white/10',
};

/**
 * A small pill, written out here rather than imported from `DataTable`.
 *
 * The portal is the lightest route in the product and nothing it imports may
 * become shared with a practice screen — pulling the practice's table module
 * onto this chunk for one span is exactly the kind of drift that ends with a
 * client's phone downloading a bulk-action bar.
 */
export function PortalPill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center shrink-0 px-2.5 py-1 rounded-full border text-[11px] font-bold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function PortalStatusPill({ status }: { status: PortalDocumentStatus }) {
  const intl = useIntl();
  const entry = STATUS[status];
  return <PortalPill tone={entry.tone}>{intl.formatMessage(entry.label)}</PortalPill>;
}
