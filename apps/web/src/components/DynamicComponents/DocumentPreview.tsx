import { Suspense, lazy, useState } from 'react';
import { Check, ExternalLink, FileText, Lock, PencilLine, X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { API_ENABLED } from '../../api/config';
import { isEditableLabel, parseCodingDraft, useDocumentDetail, type DraftProblem } from '../../api/document-detail';
import type { UpdateCodingPayload } from '@neoting/contracts/model';
import { currency } from '../../lib/resolver';
import { Pill } from './DataTable';
import type { Document, ExtractedField } from '../../lib/types';

/**
 * Lazy: the correction card (and its proposal wiring) loads at the moment of
 * the first edit, not with the screen — the document routes are measured
 * against the per-route bundle budget.
 */
const CodingProposalCard = lazy(() => import('./CodingProposalCard'));

const m = defineMessages({
  meta: { id: 'documents.documentPreview.meta', defaultMessage: '{client} • {date} • {total}' },
  via: { id: 'documents.documentPreview.via', defaultMessage: 'via {source}' },
  clientNoteHeading: { id: 'documents.documentPreview.clientNoteHeading', defaultMessage: 'Note from the client' },
  extractionRunning: {
    id: 'documents.documentPreview.extractionRunning',
    defaultMessage: 'Extraction running',
  },
  extractionBypass: {
    id: 'documents.documentPreview.extractionBypass',
    defaultMessage:
      'The pipeline is reading this document. Fields, confidence and coding suggestions appear here the moment it finishes — usually within seconds.',
  },
  noFields: { id: 'documents.documentPreview.noFields', defaultMessage: 'No fields extracted' },
  originalImmutable: { id: 'documents.documentPreview.originalImmutable', defaultMessage: 'Original — immutable' },
  extractedFields: { id: 'documents.documentPreview.extractedFields', defaultMessage: 'Extracted fields' },
  correctHint: { id: 'documents.documentPreview.correctHint', defaultMessage: 'click any value to correct' },
  confidence: { id: 'documents.documentPreview.confidence', defaultMessage: '{percent}% confident' },
  lineItemsHeading: {
    id: 'documents.documentPreview.lineItemsHeading',
    defaultMessage: 'Line items — standard, not an add-on',
  },
  lineItemAmount: { id: 'documents.documentPreview.lineItemAmount', defaultMessage: '{quantity} × {unit}' },
  uploadedBy: { id: 'documents.documentPreview.uploadedBy', defaultMessage: 'Uploaded by {uploader}' },
  originalAlt: { id: 'documents.documentPreview.originalAlt', defaultMessage: 'The original document as received' },
  openOriginal: { id: 'documents.documentPreview.openOriginal', defaultMessage: 'Open the original file' },
  loadingDetail: { id: 'documents.documentPreview.loadingDetail', defaultMessage: 'Loading the extraction…' },
  detailError: {
    id: 'documents.documentPreview.detailError',
    defaultMessage: 'The server answer did not match the contract — {error}',
  },
  processingLog: { id: 'documents.documentPreview.processingLog', defaultMessage: 'Processing log' },
  logDuration: { id: 'documents.documentPreview.logDuration', defaultMessage: '{ms, number} ms' },
  notEditable: {
    id: 'documents.documentPreview.notEditable',
    defaultMessage: 'This field has no correction path yet — it is shown exactly as extracted.',
  },
});

/** Why a typed correction was refused before it ever reached the network. */
const draftProblemMessages = defineMessages({
  empty: { id: 'documents.documentPreview.draftEmpty', defaultMessage: 'Type a value first — corrections carry values, never deletions.' },
  'not-money': { id: 'documents.documentPreview.draftNotMoney', defaultMessage: 'That is not an amount — try 1299.00.' },
  'not-date': { id: 'documents.documentPreview.draftNotDate', defaultMessage: 'That is not a date — try 2026-08-09 or 9 Aug 2026.' },
  'not-currency': { id: 'documents.documentPreview.draftNotCurrency', defaultMessage: 'Use a three-letter currency code, like GBP.' },
  'not-doc-type': { id: 'documents.documentPreview.draftNotDocType', defaultMessage: 'Use one of: invoice, receipt, credit note, statement, other.' },
  'not-editable': { id: 'documents.documentPreview.draftNotEditable', defaultMessage: 'This field has no correction path yet.' },
});

const statusMessages = defineMessages({
  ready: { id: 'documents.statusPill.ready', defaultMessage: 'Ready' },
  review: { id: 'documents.statusPill.review', defaultMessage: 'To Review — {note}' },
  reviewPlain: { id: 'documents.statusPill.reviewPlain', defaultMessage: 'To Review' },
  rejected: { id: 'documents.statusPill.rejected', defaultMessage: 'Rejected' },
  published: { id: 'documents.statusPill.published', defaultMessage: 'Published' },
  processing: { id: 'documents.statusPill.processing', defaultMessage: 'Processing' },
});

/** A staged correction, waiting in the Review → Approve card below the overlay. */
interface PendingCorrection {
  label: string;
  currentValue: string;
  nextValue: string;
  fields: UpdateCodingPayload['fields'];
}

/**
 * Document preview with the editable extraction overlay (PRD stages 2 & 8).
 * Every field carries confidence + provenance; every value is clickable and
 * correctable in place. The original image is immutable — corrections are
 * stored as metadata against the field.
 *
 * Live (`VITE_API_ENABLED=true`, METH S7) the same screen reads the real
 * record: the accepted extraction rows, the presigned original, the processing
 * log — and a correction stages a real `document.update-coding` proposal
 * instead of writing local state. Synthetic mode is byte-for-byte the old
 * behaviour; the fork is on data source, never on layout.
 */
export function DocumentPreview({ document: doc }: { document: Document }) {
  const { updateDocumentField } = useAppContext();
  const intl = useIntl();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCorrection | null>(null);
  const [draftProblem, setDraftProblem] = useState<DraftProblem | null>(null);

  const live = API_ENABLED;
  const isProcessing = doc.status === 'processing';
  const detail = useDocumentDetail({ documentId: doc.id, enabled: live, poll: live && isProcessing });

  const fields = live ? detail.fields : doc.fields;
  const lineItems = live ? detail.lineItems : doc.lineItems;
  // After approval, item details lock — the server refuses the proposal, so
  // the affordance goes rather than the refusal being discovered on approve.
  const canEdit = (label: string) => !live || (doc.status !== 'published' && isEditableLabel(label));

  const startEdit = (f: ExtractedField) => {
    setEditing(f.label);
    setDraftProblem(null);
    setDraft(f.value === '—' ? '' : f.value);
  };

  const commit = (label: string) => {
    if (!live) {
      updateDocumentField(doc.id, label, draft.trim() || '—');
      setEditing(null);
      return;
    }
    // Live: nothing changes here. The parsed correction is staged into the
    // Review → Approve card below — the only door a state change has.
    const parsed = parseCodingDraft(label, draft);
    if (!parsed.ok) {
      setDraftProblem(parsed.problem);
      return;
    }
    setDraftProblem(null);
    setPending({
      label,
      currentValue: fields.find((f) => f.label === label)?.value ?? '—',
      nextValue: parsed.display,
      fields: parsed.fields,
    });
    setEditing(null);
  };

  return (
    <div className="w-full max-w-3xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white shrink-0 border border-white/5 shadow-inner">
            <FileText size={22} />
          </div>
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{doc.supplier}</h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
              {intl.formatMessage(m.meta, {
                client: doc.clientName,
                date: doc.date,
                total: currency(doc.total),
              })}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <StatusPill doc={doc} />
          <span className="text-[11px] text-zinc-600 font-semibold uppercase tracking-wider">
            {intl.formatMessage(m.via, { source: doc.source })}
          </span>
        </div>
      </div>

      {doc.clientNote && (
        <div className="px-6 pt-5">
          <div className="rounded-2xl border border-white/5 bg-raised/40 p-4">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">
              {intl.formatMessage(m.clientNoteHeading)}
            </div>
            <p className="text-[13px] text-zinc-300 leading-relaxed">{doc.clientNote}</p>
          </div>
        </div>
      )}

      {isProcessing ? (
        <div className="p-6 flex flex-col gap-4">
          <div className="bg-raised/40 border border-white/5 rounded-2xl p-5 text-sm text-zinc-400">
            <p className="font-semibold text-white mb-1">{intl.formatMessage(m.extractionRunning)}</p>
            <p className="text-[13px] leading-relaxed">{intl.formatMessage(m.extractionBypass)}</p>
          </div>
          {/* The manual-entry bypass button lived here with no handler — a dead
              control on the golden path (METH S14 sweep). It returns when the
              bypass exists. */}
        </div>
      ) : live && detail.isLoading ? (
        // The loading state, per screen rule 5: skeleton rows, no spinner.
        <div className="p-6 flex flex-col gap-3" aria-label={intl.formatMessage(m.loadingDetail)}>
          <div className="h-3 w-2/5 rounded bg-white/10 animate-pulse" />
          <div className="h-3 w-3/5 rounded bg-white/[0.07] animate-pulse" />
          <div className="h-3 w-1/2 rounded bg-white/[0.07] animate-pulse" />
        </div>
      ) : fields.length === 0 ? (
        <div className="p-6 text-sm text-zinc-400">
          <p className="font-semibold text-white mb-1">{intl.formatMessage(m.noFields)}</p>
          <p className="text-[13px]">{doc.statusNote}</p>
          {live && detail.contractError && (
            <p className="text-[12px] text-red-400 mt-2">
              {intl.formatMessage(m.detailError, { error: detail.contractError })}
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1.25fr]">
          {/* Immutable original — the highlighted band shows the provenance of the hovered field. */}
          <div className="p-6 border-b md:border-b-0 md:border-r border-white/5 bg-ground/40">
            <div className="flex items-center gap-2 mb-4 text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
              <Lock size={11} /> {intl.formatMessage(m.originalImmutable)}
            </div>
            {live && detail.image && detail.image.mimeType.startsWith('image/') ? (
              // The real original off the presigned URL. No provenance band on
              // top of it: bounding boxes are not extracted yet, and painting
              // an invented position over a real photograph would be a lie the
              // synthetic placeholder below never told.
              <div className="relative aspect-[3/4] rounded-2xl bg-raised/60 border border-white/5 overflow-hidden shadow-inner">
                <img
                  src={detail.image.url}
                  alt={detail.image.filename ?? intl.formatMessage(m.originalAlt)}
                  className="w-full h-full object-contain"
                />
              </div>
            ) : live && detail.image ? (
              // A PDF or anything else a plain <img> cannot show: hand over the
              // short-lived link rather than pretending.
              <a
                href={detail.image.url}
                target="_blank"
                rel="noopener noreferrer"
                className="aspect-[3/4] rounded-2xl bg-raised/60 border border-white/5 shadow-inner flex flex-col items-center justify-center gap-3 text-zinc-400 hover:text-white hover:border-white/20 transition-colors"
              >
                <ExternalLink size={20} />
                <span className="text-[12px] font-bold">{intl.formatMessage(m.openOriginal)}</span>
              </a>
            ) : (
              <div className="relative aspect-[3/4] rounded-2xl bg-raised/60 border border-white/5 overflow-hidden shadow-inner p-5 flex flex-col gap-2.5">
                <div className="h-3 w-2/5 rounded bg-white/20" />
                <div className="h-2 w-3/5 rounded bg-white/10" />
                <div className="mt-4 h-2 w-full rounded bg-white/[0.07]" />
                <div className="h-2 w-11/12 rounded bg-white/[0.07]" />
                <div className="h-2 w-4/5 rounded bg-white/[0.07]" />
                <div className="mt-auto flex flex-col gap-2">
                  <div className="h-2 w-2/3 rounded bg-white/[0.07]" />
                  <div className="h-3 w-1/2 rounded bg-white/20" />
                </div>
                {hovered && (
                  <motion.div
                    layoutId="provenance-band"
                    className="absolute left-3 right-3 h-8 rounded-lg border-2 border-brand bg-brand/15 pointer-events-none"
                    style={{ top: `${18 + (hashPct(hovered) % 60)}%` }}
                  />
                )}
              </div>
            )}
            {hovered && (
              <p className="mt-3 text-[11px] text-brand font-semibold leading-relaxed">
                {fields.find((f) => f.label === hovered)?.provenance}
              </p>
            )}

            {/* The per-document processing log (SoT §13.3's "show the working"),
                straight off `GET /documents/{id}/events`. Live only — the
                synthetic dataset has no pipeline behind it to log. */}
            {live && detail.events.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
                  {intl.formatMessage(m.processingLog)}
                </div>
                <ol className="flex flex-col gap-1.5">
                  {detail.events.map((e) => (
                    <li key={e.id} className="flex items-center gap-2 text-[11px] font-semibold">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.outcome === 'failed' ? 'bg-red-400' : 'bg-emerald-400'}`} />
                      <span className="text-zinc-400">{e.stage}</span>
                      <span className="text-zinc-600 truncate">{e.outcome}</span>
                      {e.durationMs !== null && (
                        <span className="ml-auto text-zinc-600 tabular-nums shrink-0">
                          {intl.formatMessage(m.logDuration, { ms: e.durationMs })}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          {/* Editable overlay */}
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                {intl.formatMessage(m.extractedFields)}
              </span>
              <span className="text-[11px] font-semibold text-zinc-600">{intl.formatMessage(m.correctHint)}</span>
            </div>
            <div className="flex flex-col">
              {fields.map((f, i) => (
                <div
                  key={f.label}
                  onMouseEnter={() => setHovered(f.label)}
                  onMouseLeave={() => setHovered(null)}
                  className={`py-3 flex items-center justify-between gap-3 ${
                    i < fields.length - 1 ? 'border-b border-white/5' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-[13px] text-zinc-500 font-medium">{f.label}</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <ConfidenceDot value={f.confidence} />
                      <span className="text-[11px] text-zinc-600 font-semibold">
                        {intl.formatMessage(m.confidence, { percent: Math.round(f.confidence * 100) })}
                      </span>
                    </div>
                  </div>

                  {editing === f.label ? (
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <input
                          // This input mounts because the user just pressed Edit
                          // on this field: focus is following their action, not
                          // being stolen — the rule's concern — and Escape hands
                          // it back.
                          // eslint-disable-next-line jsx-a11y/no-autofocus
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commit(f.label);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          className="w-36 bg-ground border border-brand rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none"
                        />
                        <button
                          onClick={() => commit(f.label)}
                          className="p-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors"
                        >
                          <Check size={14} strokeWidth={3} />
                        </button>
                        <button
                          onClick={() => setEditing(null)}
                          className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
                        >
                          <X size={14} strokeWidth={3} />
                        </button>
                      </div>
                      {draftProblem && (
                        <p className="text-[11px] font-semibold text-amber-400 text-right max-w-52">
                          {intl.formatMessage(draftProblemMessages[draftProblem])}
                        </p>
                      )}
                    </div>
                  ) : canEdit(f.label) ? (
                    <button
                      onClick={() => startEdit(f)}
                      className={`shrink-0 group flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-bold transition-all border border-transparent hover:border-white/10 hover:bg-white/5 ${
                        f.confidence < 0.6 ? 'text-amber-400' : 'text-white'
                      }`}
                    >
                      {f.value}
                      <PencilLine size={13} className="text-zinc-600 group-hover:text-brand transition-colors" />
                    </button>
                  ) : (
                    <span
                      title={intl.formatMessage(m.notEditable)}
                      className={`shrink-0 px-3 py-1.5 text-sm font-bold ${f.confidence < 0.6 ? 'text-amber-400' : 'text-white'}`}
                    >
                      {f.value}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* The staged correction — a real proposal in live mode, through
                the same gate as everything else. Keyed so a new correction
                gets a fresh card rather than an already-approved one. */}
            {live && pending && (
              <Suspense fallback={null}>
                <div className="mt-6">
                  <CodingProposalCard
                    key={`${pending.label}:${pending.nextValue}`}
                    document={doc}
                    fieldLabel={pending.label}
                    currentValue={pending.currentValue}
                    nextValue={pending.nextValue}
                    fields={pending.fields}
                  />
                </div>
              </Suspense>
            )}

            {lineItems.length > 0 && (
              <div className="mt-6">
                <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
                  {intl.formatMessage(m.lineItemsHeading)}
                </div>
                <div className="bg-ground/40 border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner">
                  {lineItems.map((li, i) => (
                    <div key={i} className="px-4 py-3 flex items-center justify-between gap-3 text-[13px]">
                      <span className="text-zinc-400 truncate">{li.description}</span>
                      <span className="text-white font-bold shrink-0">
                        {intl.formatMessage(m.lineItemAmount, {
                          quantity: li.quantity,
                          unit: currency(li.total / li.quantity),
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 bg-raised/50 p-4 text-[12px] text-zinc-500 font-semibold">
        {intl.formatMessage(m.uploadedBy, { uploader: doc.uploader })}
      </div>
    </div>
  );
}

function StatusPill({ doc }: { doc: Document }) {
  const intl = useIntl();

  if (doc.status === 'ready') return <Pill tone="green">{intl.formatMessage(statusMessages.ready)}</Pill>;
  if (doc.status === 'review') {
    // API To-Review rows carry no note (the contract reserves failureMessage
    // for REJECTED/FAILED) — formatting {note} with undefined is a
    // console.error from react-intl and a garbled pill (METH S14 sweep).
    return (
      <Pill tone="amber">
        {doc.statusNote
          ? intl.formatMessage(statusMessages.review, { note: doc.statusNote })
          : intl.formatMessage(statusMessages.reviewPlain)}
      </Pill>
    );
  }
  if (doc.status === 'rejected') return <Pill tone="red">{intl.formatMessage(statusMessages.rejected)}</Pill>;
  if (doc.status === 'published') return <Pill tone="blue">{intl.formatMessage(statusMessages.published)}</Pill>;
  return <Pill tone="neutral">{intl.formatMessage(statusMessages.processing)}</Pill>;
}

function ConfidenceDot({ value }: { value: number }) {
  const color = value >= 0.9 ? 'bg-emerald-400' : value >= 0.6 ? 'bg-amber-400' : 'bg-red-400';
  return <span className={`w-1.5 h-1.5 rounded-full ${color}`} />;
}

function hashPct(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h;
}
