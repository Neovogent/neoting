import { useState } from 'react';
import { Check, FileText, Lock, PencilLine, X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { Pill } from './DataTable';
import type { Document, ExtractedField } from '../../lib/types';

const m = defineMessages({
  meta: { id: 'documents.documentPreview.meta', defaultMessage: '{client} • {date} • {total}' },
  via: { id: 'documents.documentPreview.via', defaultMessage: 'via {source}' },
  clientNoteHeading: { id: 'documents.documentPreview.clientNoteHeading', defaultMessage: 'Note from the client' },
  extractionRunning: {
    id: 'documents.documentPreview.extractionRunning',
    defaultMessage: 'Extraction running — ETA 2 minutes',
  },
  extractionBypass: {
    id: 'documents.documentPreview.extractionBypass',
    defaultMessage:
      "You don't have to wait. Use the manual-entry bypass to type the values now; OCR results merge in when they land and anything you typed wins.",
  },
  enterManually: { id: 'documents.documentPreview.enterManually', defaultMessage: 'Enter manually' },
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
});

const statusMessages = defineMessages({
  ready: { id: 'documents.statusPill.ready', defaultMessage: 'Ready' },
  review: { id: 'documents.statusPill.review', defaultMessage: 'To Review — {note}' },
  rejected: { id: 'documents.statusPill.rejected', defaultMessage: 'Rejected' },
  published: { id: 'documents.statusPill.published', defaultMessage: 'Published' },
  processing: { id: 'documents.statusPill.processing', defaultMessage: 'Processing' },
});

/**
 * Document preview with the editable extraction overlay (PRD stages 2 & 8).
 * Every field carries confidence + provenance; every value is clickable and
 * correctable in place. The original image is immutable — corrections are
 * stored as metadata against the field.
 */
export function DocumentPreview({ document: doc }: { document: Document }) {
  const { updateDocumentField } = useAppContext();
  const intl = useIntl();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);

  const startEdit = (f: ExtractedField) => {
    setEditing(f.label);
    setDraft(f.value === '—' ? '' : f.value);
  };

  const commit = (label: string) => {
    updateDocumentField(doc.id, label, draft.trim() || '—');
    setEditing(null);
  };

  const isProcessing = doc.status === 'processing';

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
          <button className="self-start flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-brand rounded-full hover:bg-brand-hover transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]">
            <PencilLine size={16} />
            {intl.formatMessage(m.enterManually)}
          </button>
        </div>
      ) : doc.fields.length === 0 ? (
        <div className="p-6 text-sm text-zinc-400">
          <p className="font-semibold text-white mb-1">{intl.formatMessage(m.noFields)}</p>
          <p className="text-[13px]">{doc.statusNote}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1.25fr]">
          {/* Immutable original — the highlighted band shows the provenance of the hovered field. */}
          <div className="p-6 border-b md:border-b-0 md:border-r border-white/5 bg-ground/40">
            <div className="flex items-center gap-2 mb-4 text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
              <Lock size={11} /> {intl.formatMessage(m.originalImmutable)}
            </div>
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
            {hovered && (
              <p className="mt-3 text-[11px] text-brand font-semibold leading-relaxed">
                {doc.fields.find((f) => f.label === hovered)?.provenance}
              </p>
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
              {doc.fields.map((f, i) => (
                <div
                  key={f.label}
                  onMouseEnter={() => setHovered(f.label)}
                  onMouseLeave={() => setHovered(null)}
                  className={`py-3 flex items-center justify-between gap-3 ${
                    i < doc.fields.length - 1 ? 'border-b border-white/5' : ''
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
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input
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
                  ) : (
                    <button
                      onClick={() => startEdit(f)}
                      className={`shrink-0 group flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-bold transition-all border border-transparent hover:border-white/10 hover:bg-white/5 ${
                        f.confidence < 0.6 ? 'text-amber-400' : 'text-white'
                      }`}
                    >
                      {f.value}
                      <PencilLine size={13} className="text-zinc-600 group-hover:text-brand transition-colors" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {doc.lineItems.length > 0 && (
              <div className="mt-6">
                <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
                  {intl.formatMessage(m.lineItemsHeading)}
                </div>
                <div className="bg-ground/40 border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner">
                  {doc.lineItems.map((li, i) => (
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
    return <Pill tone="amber">{intl.formatMessage(statusMessages.review, { note: doc.statusNote })}</Pill>;
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
