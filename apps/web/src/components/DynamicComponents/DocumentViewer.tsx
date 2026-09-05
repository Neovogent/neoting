import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ChevronLeft, ChevronRight, Download, ExternalLink, FileText,
  Maximize2, PencilLine, RotateCcw, RotateCw, Trash2, ZoomIn, ZoomOut,
} from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { API_ENABLED } from '../../api/config';
import { useDocumentDetail } from '../../api/document-detail';
import { receivedViaHeading } from '../../lib/channelLabels';
import { currency } from '../../lib/resolver';
import { Modal } from './Modal';
import { Pill } from './DataTable';
import type { Document } from '../../lib/types';

/**
 * The correction path, unchanged and unmoved: `DocumentPreview` is the screen
 * that owns the editable extraction overlay, the coding ladder, the bank-match
 * section and the `document.update-coding` proposal. The viewer does not
 * reimplement any of it — it opens it, in a nested dialog, over itself.
 * `lib/useEscape` is a STACK precisely so that works: Escape closes the
 * correction dialog and leaves the viewer where it was.
 *
 * Lazy so that a viewer opened to LOOK at a photograph does not download the
 * correction machinery (`CodingProposalModal`, `ReviewGate`, the proposal
 * client) that only a typed edit needs.
 */
const DocumentPreview = lazy(() =>
  import('./DocumentPreview').then((mod) => ({ default: mod.DocumentPreview })),
);

/**
 * # The document viewer — the missing centre of the Documents screen
 *
 * The register listed documents and offered almost nothing you could DO with
 * one: clicking a row opened an overlay sized as a side panel, with no way to
 * enlarge a photograph, no way to turn a sideways one the right way up, no way
 * to reach the next document, and no way to take a copy of the original. This
 * is that surface.
 *
 * ## ⚠ Why this is BESIDE `DocumentPreview` and not composed out of it
 *
 * `DocumentPreview` already renders "the original beside its extracted
 * fields", and reusing it was the first thing tried. It does not fit, for one
 * concrete reason and one structural one:
 *
 * - **Zoom and rotate have to transform the `<img>` itself, and that `<img>`
 *   is welded to the provenance band.** `DocumentPreview` paints a hover band
 *   at each field's `boundingBox`, positioned by `scanBandFrame` — letterbox
 *   maths that assume an UNROTATED, UNSCALED `object-contain` image inside a
 *   fixed 3:4 frame. A transform applied from outside desynchronises the band
 *   from the value it claims to mark, which is not a layout bug: it is the
 *   screen pointing at the wrong part of a client's invoice and saying "this
 *   is where we read it". Making the band rotation-aware means editing that
 *   file, and that file is owned by another lane.
 * - **It is a side panel, not a stage.** `max-w-3xl`, a 3:4 frame, and a
 *   two-column grid tuned for ~300px of overlay. A viewer that fills the
 *   screen is a different frame around the same facts.
 *
 * So the viewer owns the STAGE (zoom, rotation, paging, download) and shows the
 * extracted fields read-only beside it, and `DocumentPreview` stays the one
 * place a correction is composed — reached from the viewer's [Correct a field]
 * button, one dialog up the Escape stack. Nothing about extraction, coding or
 * proposals is written twice.
 *
 * ## The `rel="noreferrer noopener"` rule
 *
 * ⚠ The original's URL is **presigned**: bearer authority over one of a
 * client's financial records, with no session behind it. A `Referer` header
 * would carry that URL to wherever the tab goes next. Every anchor and every
 * embed that touches it therefore carries `rel="noreferrer noopener"` (or
 * `referrerPolicy="no-referrer"` where it is a frame and not a link). The same
 * rule and the same reason as `ExportView`'s two download anchors. Pinned by
 * test.
 *
 * ## Synthetic mode
 *
 * There is no original on seed data — the demo cast has no bytes behind it —
 * so the stage renders an honest stand-in and says so. Paging, zoom, rotation
 * and the whole keyboard path still work, because the app has to walk end to
 * end with no API (METH_MODE §1).
 */

const m = defineMessages({
  dialogLabel: { id: 'documents.documentViewer.dialogLabel', defaultMessage: 'Document viewer' },
  position: { id: 'documents.documentViewer.position', defaultMessage: '{position} of {total}' },
  previous: { id: 'documents.documentViewer.previous', defaultMessage: 'Previous document' },
  next: { id: 'documents.documentViewer.next', defaultMessage: 'Next document' },
  // The keyboard path, said out loud. An accountant walking a stack should not
  // have to discover the arrow keys by accident.
  keyboardHint: {
    id: 'documents.documentViewer.keyboardHint',
    defaultMessage: 'Arrow keys or J / K move through the stack · R rotates · + and − zoom · 0 resets · Esc closes',
  },

  zoomIn: { id: 'documents.documentViewer.zoomIn', defaultMessage: 'Zoom in' },
  zoomOut: { id: 'documents.documentViewer.zoomOut', defaultMessage: 'Zoom out' },
  zoomLevel: { id: 'documents.documentViewer.zoomLevel', defaultMessage: '{percent}%' },
  resetView: { id: 'documents.documentViewer.resetView', defaultMessage: 'Reset zoom and rotation' },
  rotateLeft: { id: 'documents.documentViewer.rotateLeft', defaultMessage: 'Rotate left' },
  rotateRight: { id: 'documents.documentViewer.rotateRight', defaultMessage: 'Rotate right' },
  download: { id: 'documents.documentViewer.download', defaultMessage: 'Download the original' },
  openOriginal: { id: 'documents.documentViewer.openOriginal', defaultMessage: 'Open the original file' },
  deleteAction: { id: 'documents.documentViewer.deleteAction', defaultMessage: 'Delete' },
  restoreAction: { id: 'documents.documentViewer.restoreAction', defaultMessage: 'Restore' },
  correctAction: { id: 'documents.documentViewer.correctAction', defaultMessage: 'Correct a field' },
  correctLabel: { id: 'documents.documentViewer.correctLabel', defaultMessage: 'Extraction and corrections' },

  originalAlt: { id: 'documents.documentViewer.originalAlt', defaultMessage: 'The original document as received' },
  pdfTitle: { id: 'documents.documentViewer.pdfTitle', defaultMessage: 'The original document, as a PDF' },

  loadingOriginal: { id: 'documents.documentViewer.loadingOriginal', defaultMessage: 'Loading the original…' },
  errorHeading: { id: 'documents.documentViewer.errorHeading', defaultMessage: 'This document could not be read' },
  errorDetail: {
    id: 'documents.documentViewer.errorDetail',
    defaultMessage: 'The server answer did not match the contract — {error}',
  },
  noOriginalHeading: { id: 'documents.documentViewer.noOriginalHeading', defaultMessage: 'No original to show' },
  noOriginalDetail: {
    id: 'documents.documentViewer.noOriginalDetail',
    defaultMessage:
      'The file this record was made from is not available to this screen. The extracted fields beside it are still what was read from it.',
  },
  demoHeading: { id: 'documents.documentViewer.demoHeading', defaultMessage: 'Demonstration document' },
  demoDetail: {
    id: 'documents.documentViewer.demoDetail',
    defaultMessage: 'There is no scanned original behind a demonstration document — the panel beside it is the extraction.',
  },

  fieldsHeading: { id: 'documents.documentViewer.fieldsHeading', defaultMessage: 'Extracted fields' },
  fieldsEmpty: {
    id: 'documents.documentViewer.fieldsEmpty',
    defaultMessage: 'Nothing has been extracted from this document yet. Fields appear here the moment the pipeline finishes reading it.',
  },
  meta: { id: 'documents.documentViewer.meta', defaultMessage: '{client} · {date} · {total}' },
  via: { id: 'documents.documentViewer.via', defaultMessage: 'via {source}' },
  confidence: { id: 'documents.documentViewer.confidence', defaultMessage: '{percent}% confident' },
  lineItemsHeading: { id: 'documents.documentViewer.lineItemsHeading', defaultMessage: 'Line items' },
});

const statusMessages = defineMessages({
  processing: { id: 'documents.documentViewer.statusProcessing', defaultMessage: 'Processing' },
  review: { id: 'documents.documentViewer.statusReview', defaultMessage: 'To review' },
  ready: { id: 'documents.documentViewer.statusReady', defaultMessage: 'Ready' },
  published: { id: 'documents.documentViewer.statusPublished', defaultMessage: 'Published' },
  rejected: { id: 'documents.documentViewer.statusFailed', defaultMessage: 'Failed' },
});

const STATUS_TONE = {
  processing: 'neutral',
  review: 'amber',
  ready: 'blue',
  published: 'green',
  rejected: 'red',
} as const;

/** Zoom stops, so + and − land on round numbers rather than compounding drift. */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
const DEFAULT_ZOOM_INDEX = 2;

export interface DocumentViewerProps {
  /** The rows exactly as they appear on screen — paging follows this order. */
  documents: Document[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Omitted where the surface has no delete (the Trash tab passes restore instead). */
  onDelete?: (document: Document) => void;
  onRestore?: (document: Document) => void;
}

export default function DocumentViewer({
  documents,
  index,
  onIndex,
  onClose,
  onDelete,
  onRestore,
}: DocumentViewerProps) {
  const intl = useIntl();
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [rotation, setRotation] = useState(0);
  const [correcting, setCorrecting] = useState(false);

  const doc = documents[index];
  const live = API_ENABLED;

  /* A new document is a new view: a photograph turned upright is not a claim
     about the next one, and a zoom left at 400% would open the next document
     into the middle of nowhere. */
  const resetView = useCallback(() => {
    setZoomIndex(DEFAULT_ZOOM_INDEX);
    setRotation(0);
  }, []);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= documents.length) return;
      resetView();
      setCorrecting(false);
      onIndex(next);
    },
    [index, documents.length, onIndex, resetView],
  );

  const rotate = useCallback((delta: number) => setRotation((r) => (r + delta + 360) % 360), []);
  const zoom = useCallback(
    (delta: number) => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + delta))),
    [],
  );

  /**
   * The keyboard path. Escape is deliberately NOT handled here — it belongs to
   * `useEscape`'s stack inside `Modal`, so the correction dialog opened over
   * this one owns the key while it is up. Anything typed into a field is left
   * alone: the correction dialog has inputs, and a viewer that ate "r" while
   * somebody was typing a supplier name would be worse than no shortcut.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (correcting) return;

      // `j`/`k` beside the arrows: the paging convention every review queue in
      // this category uses, so a reviewer's hands never leave the home row.
      if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); go(-1); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom(-1); }
      else if (e.key === '0') { e.preventDefault(); resetView(); }
      else if (e.key === 'r') { e.preventDefault(); rotate(90); }
      else if (e.key === 'R') { e.preventDefault(); rotate(-90); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, zoom, rotate, resetView, correcting]);

  const detail = useDocumentDetail({
    documentId: doc?.id ?? '',
    enabled: live && doc !== undefined,
    poll: live && doc?.status === 'processing',
  });

  const fields = live ? detail.fields : (doc?.fields ?? []);
  const lineItems = live ? detail.lineItems : (doc?.lineItems ?? []);

  const scale = ZOOM_STEPS[zoomIndex] ?? 1;
  const stageStyle = useMemo(
    () => ({ transform: `rotate(${rotation}deg) scale(${scale})`, transformOrigin: 'center center' }),
    [rotation, scale],
  );

  if (!doc) return null;

  const image = live ? detail.image : null;
  const isImage = image !== null && image.mimeType.startsWith('image/');
  const isPdf = image !== null && image.mimeType === 'application/pdf';
  const metaText = intl.formatMessage(m.meta, {
    client: doc.clientName,
    date: doc.date,
    total: currency(doc.total, doc.currency),
  });

  return (
    <Modal onClose={onClose} width="max-w-6xl" label={intl.formatMessage(m.dialogLabel)}>
      <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        {/* ── header: which document, where in the stack, and how to move ── */}
        <div className="p-5 md:p-6 flex items-start justify-between gap-4 border-b border-white/5 flex-wrap">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white shrink-0 border border-white/5 shadow-inner">
              <FileText size={22} />
            </div>
            <div className="min-w-0">
              {/* The generated channel-based name for an unextracted supplier —
                  never the literal "Unknown" (item 43). */}
              <h3 title={doc.displayTitle ?? doc.supplier} className="font-sans font-bold text-xl text-white tracking-tight truncate">
                {doc.displayTitle ?? doc.supplier}
              </h3>
              <p title={metaText} className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
                {metaText}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0 flex-wrap">
            <Pill tone={STATUS_TONE[doc.status]}>{intl.formatMessage(statusMessages[doc.status])}</Pill>
            {/* Honest channel words, never the raw slug (item 21). */}
            <span className="text-[11px] text-zinc-600 font-semibold uppercase tracking-wider">
              {receivedViaHeading(intl, doc, m.via)}
            </span>
            <div className="flex items-center gap-1.5">
              <IconButton
                label={intl.formatMessage(m.previous)}
                onClick={() => go(-1)}
                disabled={index === 0}
                icon={ChevronLeft}
              />
              <span aria-live="polite" className="text-[12px] font-bold text-zinc-400 tabular-nums px-1 min-w-14 text-center">
                {intl.formatMessage(m.position, { position: index + 1, total: documents.length })}
              </span>
              <IconButton
                label={intl.formatMessage(m.next)}
                onClick={() => go(1)}
                disabled={index >= documents.length - 1}
                icon={ChevronRight}
              />
            </div>
          </div>
        </div>

        {/* ── the toolbar ─────────────────────────────────────────────────── */}
        <div className="px-5 md:px-6 py-3 border-b border-white/5 bg-raised/30 flex items-center gap-2 flex-wrap">
          <IconButton label={intl.formatMessage(m.zoomOut)} onClick={() => zoom(-1)} disabled={zoomIndex === 0} icon={ZoomOut} />
          <span className="text-[12px] font-bold text-zinc-400 tabular-nums min-w-14 text-center">
            {intl.formatMessage(m.zoomLevel, { percent: Math.round(scale * 100) })}
          </span>
          <IconButton
            label={intl.formatMessage(m.zoomIn)}
            onClick={() => zoom(1)}
            disabled={zoomIndex === ZOOM_STEPS.length - 1}
            icon={ZoomIn}
          />
          <span className="w-px h-6 bg-white/10 mx-1" />
          {/* The sideways phone photograph, which is a constant rather than an
              edge case: two taps, either way round, and it never touches the
              stored file. */}
          <IconButton label={intl.formatMessage(m.rotateLeft)} onClick={() => rotate(-90)} icon={RotateCcw} />
          <IconButton label={intl.formatMessage(m.rotateRight)} onClick={() => rotate(90)} icon={RotateCw} />
          <IconButton label={intl.formatMessage(m.resetView)} onClick={resetView} icon={Maximize2} />

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {image !== null && (
              <a
                href={image.url}
                download={image.filename ?? undefined}
                target="_blank"
                // ⚠ Not decoration. See the header of this file: the URL is
                // bearer authority over a client's financial record, and a
                // Referer would carry it wherever this tab goes next.
                rel="noreferrer noopener"
                className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-300 hover:text-white border border-white/10 hover:border-white/25 transition-colors"
              >
                <Download size={14} />
                {intl.formatMessage(m.download)}
              </a>
            )}
            {live && (
              <button
                onClick={() => setCorrecting(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-300 hover:text-white border border-white/10 hover:border-white/25 transition-colors"
              >
                <PencilLine size={14} />
                {intl.formatMessage(m.correctAction)}
              </button>
            )}
            {onRestore && (
              <button
                onClick={() => onRestore(doc)}
                className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors"
              >
                <RotateCcw size={14} />
                {intl.formatMessage(m.restoreAction)}
              </button>
            )}
            {onDelete && (
              <button
                onClick={() => onDelete(doc)}
                className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-red-300 hover:text-white border border-red-500/25 hover:bg-red-500/20 transition-colors"
              >
                <Trash2 size={14} />
                {intl.formatMessage(m.deleteAction)}
              </button>
            )}
          </div>
        </div>

        {/* ── stage + fields ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 border-b lg:border-b-0 lg:border-r border-white/5 bg-ground/40 overflow-auto p-4 md:p-6 flex items-center justify-center min-h-80">
            {live && detail.isLoading ? (
              <div className="w-full max-w-md flex flex-col gap-3" aria-label={intl.formatMessage(m.loadingOriginal)}>
                <div className="h-64 rounded-2xl bg-white/[0.07] animate-pulse" />
                <div className="h-3 w-2/5 rounded bg-white/10 animate-pulse" />
                <div className="h-3 w-3/5 rounded bg-white/[0.07] animate-pulse" />
              </div>
            ) : live && detail.contractError !== null ? (
              <StageNotice
                tone="error"
                heading={intl.formatMessage(m.errorHeading)}
                detail={intl.formatMessage(m.errorDetail, { error: detail.contractError })}
              />
            ) : isImage ? (
              <img
                src={image.url}
                alt={image.filename ?? intl.formatMessage(m.originalAlt)}
                style={stageStyle}
                className="max-w-full max-h-[60vh] object-contain rounded-xl shadow-2xl transition-transform duration-200"
              />
            ) : isPdf ? (
              <iframe
                title={intl.formatMessage(m.pdfTitle)}
                src={image.url}
                // The frame equivalent of `rel="noreferrer"` — see the header.
                referrerPolicy="no-referrer"
                style={stageStyle}
                className="w-full h-[60vh] rounded-xl border border-white/10 bg-raised transition-transform duration-200"
              />
            ) : image !== null ? (
              <a
                href={image.url}
                target="_blank"
                rel="noreferrer noopener"
                className="w-full max-w-sm aspect-[3/4] rounded-2xl bg-raised/60 border border-white/5 shadow-inner flex flex-col items-center justify-center gap-3 text-zinc-400 hover:text-white hover:border-white/20 transition-colors"
              >
                <ExternalLink size={22} />
                <span className="text-[13px] font-bold">{intl.formatMessage(m.openOriginal)}</span>
              </a>
            ) : live ? (
              <StageNotice
                tone="quiet"
                heading={intl.formatMessage(m.noOriginalHeading)}
                detail={intl.formatMessage(m.noOriginalDetail)}
              />
            ) : (
              // Synthetic mode: the stand-in, still zoomable and rotatable so
              // the whole keyboard path is walkable with no API (METH_MODE §1).
              <div style={stageStyle} className="w-full max-w-sm transition-transform duration-200">
                <div className="aspect-[3/4] rounded-2xl bg-raised/60 border border-white/5 overflow-hidden shadow-inner p-5 flex flex-col gap-2.5">
                  <div className="h-3 w-2/5 rounded bg-white/20" />
                  <div className="h-2 w-3/5 rounded bg-white/10" />
                  <div className="mt-4 h-2 w-full rounded bg-white/[0.07]" />
                  <div className="h-2 w-11/12 rounded bg-white/[0.07]" />
                  <div className="h-2 w-4/5 rounded bg-white/[0.07]" />
                  <div className="mt-auto flex flex-col gap-2">
                    <div className="h-2 w-2/3 rounded bg-white/[0.07]" />
                    <div className="h-3 w-1/2 rounded bg-white/20" />
                  </div>
                </div>
                <p className="mt-3 text-[12px] font-bold text-zinc-400">{intl.formatMessage(m.demoHeading)}</p>
                <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.demoDetail)}</p>
              </div>
            )}
          </div>

          <div className="min-w-0 overflow-y-auto p-5 md:p-6">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
              {intl.formatMessage(m.fieldsHeading)}
            </div>

            {fields.length === 0 ? (
              <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.fieldsEmpty)}</p>
            ) : (
              <dl className="flex flex-col">
                {fields.map((f, i) => (
                  <div
                    key={f.label}
                    className={`py-2.5 flex items-start justify-between gap-3 ${
                      i < fields.length - 1 ? 'border-b border-white/5' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <dt className="text-[13px] text-zinc-500 font-medium">{f.label}</dt>
                      <dd className="mt-0.5 text-[11px] text-zinc-600 font-semibold">
                        {intl.formatMessage(m.confidence, { percent: Math.round(f.confidence * 100) })}
                      </dd>
                    </div>
                    <span
                      title={f.value}
                      className={`min-w-0 max-w-[55%] break-words text-right text-sm font-bold ${
                        f.confidence < 0.6 ? 'text-amber-400' : 'text-white'
                      }`}
                    >
                      {f.value}
                    </span>
                  </div>
                ))}
              </dl>
            )}

            {lineItems.length > 0 && (
              <div className="mt-6">
                <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
                  {intl.formatMessage(m.lineItemsHeading)}
                </div>
                <div className="bg-ground/40 border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner">
                  {lineItems.map((li, i) => (
                    <div key={i} className="px-4 py-2.5 flex items-center justify-between gap-3 text-[13px]">
                      <span title={li.description} className="min-w-0 text-zinc-400 truncate">
                        {li.description}
                      </span>
                      <span className="text-white font-bold shrink-0 tabular-nums">
                        {currency(li.total, doc.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <p className="px-5 md:px-6 py-3 bg-raised/50 text-[11.5px] text-zinc-500 font-semibold">
          {intl.formatMessage(m.keyboardHint)}
        </p>
      </div>

      {/* The correction path, one dialog up the Escape stack. */}
      <AnimatePresence>
        {correcting && (
          <Suspense fallback={null}>
            <Modal onClose={() => setCorrecting(false)} width="max-w-3xl" label={intl.formatMessage(m.correctLabel)}>
              <DocumentPreview document={doc} />
            </Modal>
          </Suspense>
        )}
      </AnimatePresence>
    </Modal>
  );
}

function IconButton({
  label,
  onClick,
  icon: Icon,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  icon: typeof ZoomIn;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="w-9 h-9 rounded-full border border-white/10 text-zinc-400 hover:text-white hover:border-white/30 flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
    >
      <Icon size={15} />
    </button>
  );
}

/** The stage's error and quiet states, which share everything but their colour. */
function StageNotice({ tone, heading, detail }: { tone: 'error' | 'quiet'; heading: string; detail: string }) {
  return (
    <div
      {...(tone === 'error' ? { role: 'alert' as const } : {})}
      className={`w-full max-w-sm rounded-2xl border p-5 flex items-start gap-3 ${
        tone === 'error' ? 'border-red-500/20 bg-red-500/10' : 'border-white/10 bg-raised/40'
      }`}
    >
      <AlertTriangle size={16} className={`shrink-0 mt-0.5 ${tone === 'error' ? 'text-red-400' : 'text-zinc-500'}`} />
      <div className="min-w-0">
        <p className={`text-[13px] font-bold ${tone === 'error' ? 'text-red-300' : 'text-white'}`}>{heading}</p>
        <p className="text-[12.5px] text-zinc-400 mt-1 leading-relaxed">{detail}</p>
      </div>
    </div>
  );
}
