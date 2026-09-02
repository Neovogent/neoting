import { useRef, useState } from 'react';
import { UploadCloud, X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { ACCEPTED_EXTENSIONS } from '../../lib/ingest';
import { PORTAL_UPLOAD_LIMIT } from '../../lib/business';
import { Panel } from './Panel';
import type { BusinessAccount } from '../../lib/types';
import { PrivacyNoticeLink } from '../legal/PrivacyNoticeLink';

const m = defineMessages({
  title: { id: 'portal.businessUploadView.title', defaultMessage: 'Upload a document' },
  subtitle: {
    id: 'portal.businessUploadView.subtitle',
    defaultMessage:
      'Invoices, receipts, bills and statements — send them as they come. You do not need to sort them: we work out what each one is.',
  },
  dropHeading: {
    id: 'portal.businessUploadView.dropHeading',
    defaultMessage: 'Drop files here, or click to choose',
  },
  // A finger cannot drag and drop. The `pointer-coarse` variant swaps the
  // sentence, so this is a second string with its own id — not a shortening
  // of the first, and not the same message under a different id.
  dropHeadingTouch: {
    id: 'portal.businessUploadView.dropHeadingTouch',
    defaultMessage: 'Tap to choose files or take a photo',
  },
  dismissRejected: {
    id: 'portal.businessUploadView.dismissRejected',
    defaultMessage: 'Dismiss',
  },
  dropDetail: {
    id: 'portal.businessUploadView.dropDetail',
    defaultMessage:
      'PDF, JPG, PNG, HEIC, CSV or XLSX · up to {limit}MB each. A PDF with several documents in it is split automatically.',
  },
  noteLabel: {
    id: 'portal.businessUploadView.noteLabel',
    defaultMessage: 'Note for your accountant (optional)',
  },
  notePlaceholder: {
    id: 'portal.businessUploadView.notePlaceholder',
    defaultMessage: 'e.g. the Bidfood invoice for the July delivery',
  },
  rejectUnreadable: {
    id: 'portal.businessUploadView.rejectUnreadable',
    defaultMessage: "We can't read .{extension} files",
  },
  rejectTooBig: {
    id: 'portal.businessUploadView.rejectTooBig',
    defaultMessage: 'Over the {limit}MB limit — try splitting it',
  },
  rejectedHeading: {
    id: 'portal.businessUploadView.rejectedHeading',
    defaultMessage: '{count, plural, one {# file not sent} other {# files not sent}}',
  },
  justSentTitle: { id: 'portal.businessUploadView.justSentTitle', defaultMessage: 'Just sent' },
  justSentSubtitle: {
    id: 'portal.businessUploadView.justSentSubtitle',
    defaultMessage: 'Your accountant can see these already',
  },
  fileSize: { id: 'portal.businessUploadView.fileSize', defaultMessage: '{size}MB' },
  sentTitle: { id: 'portal.businessUploadView.sentTitle', defaultMessage: 'Sent from this portal' },
  sentSubtitle: {
    id: 'portal.businessUploadView.sentSubtitle',
    defaultMessage: "Live status from your accountant's system",
  },
  statusReading: { id: 'portal.businessUploadView.statusReading', defaultMessage: 'Reading it' },
  statusReview: { id: 'portal.businessUploadView.statusReview', defaultMessage: 'With your accountant' },
  statusAccepted: { id: 'portal.businessUploadView.statusAccepted', defaultMessage: 'Accepted' },
});

/**
 * Send a file to the accountant. Rejections are shown with a reason rather than
 * silently dropped — a business that thinks a receipt went through and hasn't is
 * exactly how paperwork goes missing.
 */
export function BusinessUploadView({ account }: { account: BusinessAccount }) {
  const { ingest, documents } = useAppContext();
  const intl = useIntl();
  const inputRef = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState('');
  const [accepted, setAccepted] = useState<{ name: string; size: number }[]>([]);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);

  const submit = (files: { name: string; size: number }[]) => {
    if (!files.length) return;

    const ok: { name: string; size: number }[] = [];
    const bad: { name: string; reason: string }[] = [];

    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        bad.push({ name: f.name, reason: intl.formatMessage(m.rejectUnreadable, { extension: ext }) });
      } else if (f.size > PORTAL_UPLOAD_LIMIT) {
        bad.push({
          name: f.name,
          reason: intl.formatMessage(m.rejectTooBig, { limit: Math.round(PORTAL_UPLOAD_LIMIT / 1024 / 1024) }),
        });
      } else {
        ok.push(f);
      }
    }

    if (ok.length) {
      ingest(ok, account.clientId, 'portal', {
        limit: PORTAL_UPLOAD_LIMIT,
        uploader: `${account.contactName} (business portal)`,
        // No kind: the business sends paperwork, it does not file it.
        // Extraction classifies money in vs money out.
        clientNote: note,
      });
      setAccepted((prev) => [...ok, ...prev].slice(0, 12));
      setNote('');
    }
    setRejected(bad);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    submit(Array.from(e.dataTransfer.files).map((f) => ({ name: f.name, size: f.size })));
  };

  const portalDocs = documents.filter((d) => d.clientId === account.clientId && d.source === 'portal').slice(0, 6);

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="font-sans text-2xl font-bold text-white tracking-tight">{intl.formatMessage(m.title)}</h1>
        <p className="text-[13px] text-zinc-500 mt-1">{intl.formatMessage(m.subtitle)}</p>
        {/* Above the upload control, not only in a footer: UK GDPR Art. 13
            requires the privacy notice at the point of collection, and this
            screen is where a client hands over documents (launch stage M4). */}
        <PrivacyNoticeLink className="mt-2" />
      </div>

      {/* The dropzone really is a button — activating it opens the file
          picker — so it carries the role, the tab stop and Enter/Space, not
          just the click. Not a <button> element: a drag-and-drop target with
          block children is not something button content models allow. Its
          accessible name is its own visible text below. */}
      <div
        role="button"
        tabIndex={0}
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
        onDrop={onDrop}
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
          <span className="pointer-coarse:hidden">{intl.formatMessage(m.dropHeading)}</span>
          <span className="hidden pointer-coarse:inline">{intl.formatMessage(m.dropHeadingTouch)}</span>
        </p>
        <p className="text-[12px] text-zinc-500 mt-1.5 max-w-sm leading-relaxed">
          {intl.formatMessage(m.dropDetail, { limit: Math.round(PORTAL_UPLOAD_LIMIT / 1024 / 1024) })}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            submit(Array.from(e.target.files ?? []).map((f) => ({ name: f.name, size: f.size })));
            e.target.value = '';
          }}
        />
      </div>

      <div>
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          {intl.formatMessage(m.noteLabel)}
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={intl.formatMessage(m.notePlaceholder)}
          className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
        />
      </div>

      <AnimatePresence>
        {rejected.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4"
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="flex items-center gap-2 text-[13px] font-bold text-red-400">
                <AlertTriangle size={15} />
                {intl.formatMessage(m.rejectedHeading, { count: rejected.length })}
              </span>
              <button
                onClick={() => setRejected([])}
                aria-label={intl.formatMessage(m.dismissRejected)}
                className="text-zinc-500 hover:text-white"
              >
                <X size={15} />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {rejected.map((r) => (
                <div key={r.name} className="text-[12px] text-zinc-400">
                  <span className="font-semibold text-white">{r.name}</span> — {r.reason}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {accepted.length > 0 && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
            <Panel
              title={intl.formatMessage(m.justSentTitle)}
              subtitle={intl.formatMessage(m.justSentSubtitle)}
            >
              <div className="flex flex-col gap-2">
                {accepted.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-4 p-3.5 rounded-2xl bg-ground/60 border border-white/5">
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

      {portalDocs.length > 0 && (
        <Panel title={intl.formatMessage(m.sentTitle)} subtitle={intl.formatMessage(m.sentSubtitle)}>
          <div className="flex flex-col gap-2">
            {portalDocs.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-4 p-3.5 rounded-2xl bg-ground/60 border border-white/5">
                <span className="text-[13px] font-semibold text-white truncate">{d.supplier}</span>
                <Pill tone={d.status === 'processing' ? 'blue' : d.status === 'review' ? 'amber' : 'green'}>
                  {d.status === 'processing'
                    ? intl.formatMessage(m.statusReading)
                    : d.status === 'review'
                      ? intl.formatMessage(m.statusReview)
                      : intl.formatMessage(m.statusAccepted)}
                </Pill>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
