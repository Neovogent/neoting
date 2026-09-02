import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, UploadCloud, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';

import type { PortalSentPage } from '../../api/onboarding';
import { PrivacyNoticeLink } from '../legal/PrivacyNoticeLink';
import { LapsedSubscriptionNotice } from './LapsedSubscriptionNotice';
import { Empty, Panel } from './LivePortalHome';
import { PortalStatusPill } from './PortalStatusPill';
import {
  PORTAL_ACCEPT,
  PORTAL_UPLOAD_LIMIT_MB,
  screenPortalFiles,
  type RefusalReason,
  type ScreenedFile,
} from './portalUploadRules';
import { PortalSendFaultNotice } from './PortalSendFaultNotice';
import type { PortalSendFault } from './portalSendFault';
import type { PortalSendOutcome } from './useBusinessPortalSession';

/**
 * Send a file to the accountant.
 *
 * Two rules govern this screen and both were learned the hard way:
 *
 * - **D48 first.** The lapsed-subscription state is shown ABOVE the dropzone,
 *   never as a refusal after the client has photographed a receipt. An upload
 *   without a live subscription is refused server-side (`402 NT-BIL-001`), so
 *   the honest thing is to say so before any effort is spent.
 * - **A refusal is named, never silent.** Every file that will not be sent is
 *   listed with its own reason. A business that thinks a receipt went through
 *   and has not is exactly how paperwork goes missing.
 *
 * ⚠ **There is deliberately no "note for your accountant" field**, which the
 * prototype has. `PortalUploadRequest` carries `filename`, `mimeType`,
 * `byteSize` and `transactionId` and nothing else, so a note would be typed
 * into a box, dropped on the floor, and believed. This repo's rule is absolute:
 * a control whose write goes nowhere is worse than no control. It comes back
 * the day the contract carries it.
 */

const m = defineMessages({
  title: { id: 'portal.livePortalUpload.title', defaultMessage: 'Upload a document' },
  subtitle: {
    id: 'portal.livePortalUpload.subtitle',
    defaultMessage:
      'Invoices, receipts, bills and statements — send them as they come. You do not need to sort them: your accountant works out what each one is.',
  },
  dropHeading: {
    id: 'portal.livePortalUpload.dropHeading',
    defaultMessage: 'Drop files here, or click to choose',
  },
  // A finger cannot drag and drop. The `pointer-coarse` variant swaps the
  // sentence, so this is a second string with its own id — not a shortening of
  // the first, and not the same message under a different id.
  dropHeadingTouch: {
    id: 'portal.livePortalUpload.dropHeadingTouch',
    defaultMessage: 'Tap to choose files or take a photo',
  },
  dropDetail: {
    id: 'portal.livePortalUpload.dropDetail',
    defaultMessage: 'PDF, JPG, PNG, HEIC or a Word document · up to {limit}MB each.',
  },
  sending: { id: 'portal.livePortalUpload.sending', defaultMessage: 'Sending…' },

  refusedHeading: {
    id: 'portal.livePortalUpload.refusedHeading',
    defaultMessage: '{count, plural, one {# file not sent} other {# files not sent}}',
  },
  dismissRefused: { id: 'portal.livePortalUpload.dismissRefused', defaultMessage: 'Dismiss' },
  refusalUnsupported: {
    id: 'portal.livePortalUpload.refusalUnsupported',
    defaultMessage: 'We cannot read .{extension} files here',
  },
  refusalUnsupportedNoExtension: {
    id: 'portal.livePortalUpload.refusalUnsupportedNoExtension',
    defaultMessage: 'We could not tell what kind of file this is',
  },
  refusalTooBig: {
    id: 'portal.livePortalUpload.refusalTooBig',
    defaultMessage: 'Over the {limit}MB limit — try splitting it',
  },
  refusalEmpty: {
    id: 'portal.livePortalUpload.refusalEmpty',
    defaultMessage: 'This file is empty — it may still be downloading to your phone',
  },
  // ⚠ This replaced `refusalFault` ("Did not send. Try it again."), which stood
  // in front of a storage outage, a lapsed subscription, an expired session and
  // a refused file alike. The headline says what is true of all of them; the
  // reason and its `NT-` code come from `PortalSendFaultNotice`.
  sendFaultHeading: {
    id: 'portal.livePortalUpload.sendFaultHeading',
    defaultMessage: '{count, plural, one {# file did not send} other {# files did not send}}',
  },

  justSentTitle: { id: 'portal.livePortalUpload.justSentTitle', defaultMessage: 'Just sent' },
  justSentSubtitle: {
    id: 'portal.livePortalUpload.justSentSubtitle',
    defaultMessage: 'Your accountant has these already',
  },
  fileSize: { id: 'portal.livePortalUpload.fileSize', defaultMessage: '{size}MB' },

  sentTitle: { id: 'portal.livePortalUpload.sentTitle', defaultMessage: 'Sent from this portal' },
  sentSubtitle: {
    id: 'portal.livePortalUpload.sentSubtitle',
    defaultMessage: 'The status changes as your accountant works through them',
  },
  sentEmpty: {
    id: 'portal.livePortalUpload.sentEmpty',
    defaultMessage: 'Nothing sent from this portal yet.',
  },
  sentLoading: { id: 'portal.livePortalUpload.sentLoading', defaultMessage: 'Loading what you have sent…' },
  sentUnnamed: { id: 'portal.livePortalUpload.sentUnnamed', defaultMessage: 'Not read yet' },
});

/** Keyed by the machine reason, so only the sentence is copy. */
const REFUSAL: Record<RefusalReason, MessageDescriptor> = {
  'unsupported-type': m.refusalUnsupported,
  'too-large': m.refusalTooBig,
  empty: m.refusalEmpty,
};

/** Portal uploads are the `SMS_PORTAL` channel, fixed server-side. */
const PORTAL_CHANNEL = 'SMS_PORTAL';

export function LivePortalUpload({
  subscriptionActive,
  documents,
  documentsFault,
  busy,
  onUpload,
  onSubscribe,
}: {
  readonly subscriptionActive: boolean;
  readonly documents: PortalSentPage | null;
  readonly documentsFault: string | null;
  readonly busy: boolean;
  readonly onUpload: (file: File) => Promise<PortalSendOutcome>;
  readonly onSubscribe: () => void;
}) {
  const intl = useIntl();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [sent, setSent] = useState<{ name: string; size: number }[]>([]);
  const [refused, setRefused] = useState<ScreenedFile[]>([]);
  // ⚠ Kept APART from `refused`, which is the pre-flight screen (type, size,
  // empty) and knows the filename. A send failure is a different fact with a
  // different remedy — it used to be pushed into that list as a fabricated
  // `unsupported-type` row with `fault: true` to suppress the wrong sentence,
  // which told the client nothing and told the next reader something false.
  const [sendFaults, setSendFaults] = useState<readonly PortalSendFault[]>([]);

  const submit = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const { accepted, refused: screened } = screenPortalFiles(files);
    setRefused(screened);
    setSendFaults([]);

    for (const file of accepted) {
      // One at a time, on purpose: a phone on mobile data with four receipts in
      // flight at once is four requests competing for the same handful of
      // kilobits, and the first failure would be indistinguishable from the
      // rest.
      const outcome = await onUpload(file);
      if (outcome.ok) {
        setSent((prev) => [{ name: file.name, size: file.size }, ...prev].slice(0, 12));
      } else {
        const fault = outcome.fault;
        if (fault !== null) setSendFaults((prev) => [...prev, fault]);
      }
    }
  };

  const portalDocs = (documents?.rows ?? []).filter((d) => d.channel === PORTAL_CHANNEL);

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto flex flex-col gap-6 pb-safe-6">
      <div>
        <h1 className="font-sans text-2xl font-bold text-white tracking-tight">{intl.formatMessage(m.title)}</h1>
        <p className="text-[13px] text-zinc-500 mt-1">{intl.formatMessage(m.subtitle)}</p>
        {/* Above the upload control, not only in a footer: UK GDPR Art. 13
            requires the privacy notice at the point of collection, and this
            screen is where a client hands over documents. */}
        <PrivacyNoticeLink className="mt-2" />
      </div>

      {/* ⚠ D48 — BEFORE the dropzone, never after the photograph. */}
      {!subscriptionActive && <LapsedSubscriptionNotice onSubscribe={onSubscribe} busy={busy} />}

      {subscriptionActive && (
        <>
          {/* The dropzone really is a button — activating it opens the file
              picker — so it carries the role, the tab stop and Enter/Space, not
              just the click. Not a <button> element: a drag-and-drop target
              with block children is not something button content models allow.
              Its accessible name is its own visible text below. */}
          <div
            role="button"
            tabIndex={0}
            aria-busy={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); // Space must not scroll the page
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void submit(Array.from(e.dataTransfer.files));
            }}
            onClick={() => inputRef.current?.click()}
            data-tour="portal-upload"
            className={`rounded-[28px] border-2 border-dashed p-6 sm:p-12 flex flex-col items-center justify-center text-center cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${
              dragging ? 'border-brand bg-brand/5' : 'border-white/10 bg-card hover:border-white/20'
            }`}
          >
            <div className="w-14 h-14 rounded-2xl bg-raised border border-white/5 flex items-center justify-center text-zinc-300">
              <UploadCloud size={24} />
            </div>
            <p className="text-sm font-bold text-white mt-4">
              {busy ? (
                intl.formatMessage(m.sending)
              ) : (
                <>
                  <span className="pointer-coarse:hidden">{intl.formatMessage(m.dropHeading)}</span>
                  <span className="hidden pointer-coarse:inline">{intl.formatMessage(m.dropHeadingTouch)}</span>
                </>
              )}
            </p>
            <p className="text-[12px] text-zinc-500 mt-1.5 max-w-sm leading-relaxed">
              {intl.formatMessage(m.dropDetail, { limit: PORTAL_UPLOAD_LIMIT_MB })}
            </p>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={PORTAL_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = '';
                void submit(picked);
              }}
            />
          </div>
        </>
      )}

      <AnimatePresence>
        {refused.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            role="alert"
            className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4"
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="flex items-center gap-2 text-[13px] font-bold text-red-400">
                <AlertTriangle size={15} />
                {intl.formatMessage(m.refusedHeading, { count: refused.length })}
              </span>
              <button
                onClick={() => setRefused([])}
                aria-label={intl.formatMessage(m.dismissRefused)}
                className="text-zinc-500 hover:text-white"
              >
                <X size={15} />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {refused.map((r, index) => (
                <div key={`${r.name}-${index}`} className="text-[12px] text-zinc-400">
                  <span className="font-semibold text-white">{r.name}</span>
                  {' — '}
                  {r.reason === 'unsupported-type' && r.extension === ''
                    ? intl.formatMessage(m.refusalUnsupportedNoExtension)
                    : intl.formatMessage(REFUSAL[r.reason], {
                        extension: r.extension,
                        limit: PORTAL_UPLOAD_LIMIT_MB,
                      })}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The bytes left the device and did not arrive — a different fact from
          the pre-flight screen above, with a different remedy, so it gets its
          own notice rather than a fabricated row in that list. */}
      <PortalSendFaultNotice
        failures={sendFaults}
        headline={m.sendFaultHeading}
        onSubscribe={onSubscribe}
        busy={busy}
      />

      <AnimatePresence>
        {sent.length > 0 && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
            <Panel title={intl.formatMessage(m.justSentTitle)} subtitle={intl.formatMessage(m.justSentSubtitle)}>
              <div className="flex flex-col gap-2">
                {sent.map((f, i) => (
                  <div
                    key={`${f.name}-${i}`}
                    className="flex items-center justify-between gap-4 p-3.5 rounded-2xl bg-ground/60 border border-white/5"
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                      <span className="text-[13px] font-semibold text-white truncate">{f.name}</span>
                    </span>
                    <span className="text-[11px] text-zinc-500 font-semibold shrink-0">
                      {intl.formatMessage(m.fileSize, { size: (f.size / 1024 / 1024).toFixed(1) })}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>

      <Panel title={intl.formatMessage(m.sentTitle)} subtitle={intl.formatMessage(m.sentSubtitle)}>
        {documentsFault !== null ? (
          <p role="alert" className="text-[13px] text-red-400 leading-relaxed py-2">
            {documentsFault}
          </p>
        ) : documents === null ? (
          <div className="flex flex-col gap-2" role="status" aria-busy="true">
            <span className="sr-only">{intl.formatMessage(m.sentLoading)}</span>
            <div className="h-14 rounded-2xl bg-white/[0.04] animate-pulse" />
            <div className="h-14 rounded-2xl bg-white/[0.04] animate-pulse" />
          </div>
        ) : portalDocs.length === 0 ? (
          <Empty icon={UploadCloud} message={intl.formatMessage(m.sentEmpty)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {portalDocs.slice(0, 10).map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-ground/60 border border-white/5"
              >
                {/* Untrusted content — extracted text, rendered as text. */}
                <span className="text-[13px] font-semibold text-white truncate">
                  {doc.supplier ?? intl.formatMessage(m.sentUnnamed)}
                </span>
                <PortalStatusPill status={doc.status} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
