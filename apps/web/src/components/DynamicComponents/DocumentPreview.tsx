import { Suspense, lazy, useState } from 'react';
import { Check, ExternalLink, FileText, Lock, PencilLine, X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { API_ENABLED } from '../../api/config';
import { isEditableLabel, parseCodingDraft, useDocumentDetail, type DraftProblem } from '../../api/document-detail';
import type { UpdateCodingPayload } from '@neoting/contracts/model';
import { currency } from '../../lib/resolver';
import { BASE_MANDATORY } from '../../lib/selectors';
import { Pill } from './DataTable';
import type { Document, ExtractedField, FieldBoundingBox } from '../../lib/types';

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
  // The same instruction for a finger. A second id rather than a reuse: the
  // verb is the difference, and "click" is wrong on the device where most of
  // these arrive.
  correctHintTouch: { id: 'documents.documentPreview.correctHintTouch', defaultMessage: 'tap any value to correct' },
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
  // The honest hover caption when the extraction recorded no source note AND
  // no position band is painted — the one thing this caption may not do is
  // invent where on the page the value came from.
  provenanceFallback: {
    id: 'documents.documentPreview.provenanceFallback',
    defaultMessage: 'Read from the document by extraction — its position on the page was not captured.',
  },
  // Its twin for a field whose band IS painted at a real position: the old
  // sentence would deny the highlight sitting right above it.
  provenancePositioned: {
    id: 'documents.documentPreview.provenancePositioned',
    defaultMessage: 'Read from the document by extraction — highlighted where it was read.',
  },
  readyHeading: { id: 'documents.documentPreview.readyHeading', defaultMessage: 'Path to Ready' },
  readyMissing: {
    id: 'documents.documentPreview.readyMissing',
    defaultMessage:
      'Ready needs a value for {fields}. Add {count, plural, one {it} other {each one}} below — a correction stages a Review → Approve proposal, and approving the correction that completes the set makes this document Ready.',
  },
  readyAddField: { id: 'documents.documentPreview.readyAddField', defaultMessage: 'Add {field}' },
  readyComplete: {
    id: 'documents.documentPreview.readyComplete',
    defaultMessage:
      'Every field Ready requires ({fields}) is present. Confirming the coding without changing a value has no proposal path yet — correcting any value re-checks readiness through Review → Approve.',
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

/** The original frame's CSS aspect (`aspect-[3/4]`) — the letterbox maths below depend on it. */
const PREVIEW_ASPECT = 3 / 4;
/** The page whose image the preview shows today. A box on any other page cannot be painted honestly. */
const PREVIEW_PAGE = 1;

/**
 * The scan band's absolute-% frame over the live original.
 *
 * The box is normalised 0–1 relative to the PAGE, but the `<img>` sits
 * `object-contain` inside a fixed 3:4 frame, so a page whose aspect differs is
 * letterboxed and container-percentages would miss the value they claim to
 * mark. The image's real aspect (from `naturalWidth/Height` once it loads)
 * maps page coordinates onto the rendered image's slice of the frame; until
 * the aspect is known the caller paints the whole-frame fallback rather than
 * a band that might sit on the letterbox bar.
 */
export function scanBandFrame(
  box: FieldBoundingBox,
  imageAspect: number,
): { top: string; left: string; width: string; height: string } {
  const wider = imageAspect >= PREVIEW_ASPECT;
  const renderedW = wider ? 1 : imageAspect / PREVIEW_ASPECT;
  const renderedH = wider ? PREVIEW_ASPECT / imageAspect : 1;
  const offsetX = (1 - renderedW) / 2;
  const offsetY = (1 - renderedH) / 2;
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  return {
    left: pct(offsetX + box.x * renderedW),
    top: pct(offsetY + box.y * renderedH),
    width: pct(box.width * renderedW),
    height: pct(box.height * renderedH),
  };
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
  /** The live original's real aspect (naturalWidth/Height) — null until it loads. */
  const [imageAspect, setImageAspect] = useState<number | null>(null);

  const live = API_ENABLED;
  const isProcessing = doc.status === 'processing';
  const detail = useDocumentDetail({ documentId: doc.id, enabled: live, poll: live && isProcessing });

  const fields = live ? detail.fields : doc.fields;
  const lineItems = live ? detail.lineItems : doc.lineItems;
  const metaText = intl.formatMessage(m.meta, { client: doc.clientName, date: doc.date, total: currency(doc.total) });

  /**
   * The honest path from To Review to Ready (live only): the server's own
   * readiness rule is Total + Supplier + Category (`resolveProcessedState`),
   * and the `document.update-coding` executor drives TO_REVIEW → READY when an
   * approved correction completes that set. So the offer here is exactly that
   * — fill what is missing, through the same Review → Approve card every
   * correction uses. There is deliberately NO "confirm as-is" button: a
   * payload whose values all equal the stored ones collapses to zero changes
   * server-side and returns before the readiness edge, so such a button's
   * write would do nothing — reported as a contract gap rather than bent.
   */
  const readyPanelOn = live && detail.state === 'TO_REVIEW';
  const missingForReady = readyPanelOn
    ? BASE_MANDATORY.filter((label) => {
        const field = fields.find((f) => f.label === label);
        return field === undefined || field.value === '—';
      })
    : [];
  // After approval, item details lock — the server refuses the proposal, so
  // the affordance goes rather than the refusal being discovered on approve.
  const canEdit = (label: string) => !live || (doc.status !== 'published' && isEditableLabel(label));

  const hoveredField = hovered === null ? undefined : fields.find((f) => f.label === hovered);
  // The positioned band: only where extraction PLACED the value, only on the
  // page the preview is actually showing, and only once the image's real
  // aspect is known — anything less falls back to framing the whole original,
  // which is the honest claim "this document is the source".
  const hoveredBox = hoveredField?.boundingBox;
  const bandFrame =
    hoveredBox !== undefined && hoveredBox.page === PREVIEW_PAGE && imageAspect !== null
      ? scanBandFrame(hoveredBox, imageAspect)
      : null;

  /** Remember the loaded original's aspect; a cached image may never fire onLoad. */
  const readImageAspect = (img: HTMLImageElement | null) => {
    if (img !== null && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setImageAspect(img.naturalWidth / img.naturalHeight);
    }
  };

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
            {/* Truncated values always carry the full text as a title, so a
                clipped name is one hover away rather than lost. */}
            <h3 title={doc.supplier} className="font-sans font-bold text-xl text-white tracking-tight truncate">
              {doc.supplier}
            </h3>
            <p title={metaText} className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
              {metaText}
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
        // ⚠ minmax(0, …) is load-bearing: a bare `1fr` track floors at its
        // content's min-content size, and live content carries unbreakable
        // runs (a presigned <img> at natural width, nowrap truncate spans over
        // 80-character line-item descriptions) that pushed the grid past the
        // card, whose overflow-hidden then clipped every right-aligned value.
        // Seed data never showed it because the synthetic values are short.
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          {/* Immutable original — the highlighted band shows the provenance of the hovered field. */}
          <div className="min-w-0 p-6 border-b md:border-b-0 md:border-r border-white/5 bg-ground/40">
            <div className="flex items-center gap-2 mb-4 text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
              <Lock size={11} /> {intl.formatMessage(m.originalImmutable)}
            </div>
            {live && detail.image && detail.image.mimeType.startsWith('image/') ? (
              // The real original off the presigned URL. The hover band paints
              // AT the hovered field's boundingBox when extraction placed the
              // value on the displayed page — that is the contract's editable
              // OCR overlay, live. A field with no box (or a box on a page the
              // preview is not showing) falls back to framing the WHOLE image:
              // the frame says "this document is the source" and never invents
              // a position. The caption underneath carries the provenance.
              <div className="relative aspect-[3/4] rounded-2xl bg-raised/60 border border-white/5 overflow-hidden shadow-inner">
                <img
                  ref={readImageAspect}
                  src={detail.image.url}
                  alt={detail.image.filename ?? intl.formatMessage(m.originalAlt)}
                  className="w-full h-full object-contain"
                  onLoad={(e) => readImageAspect(e.currentTarget)}
                />
                {hovered && (
                  <motion.div
                    layoutId="provenance-band"
                    data-testid="provenance-band"
                    className={
                      bandFrame !== null
                        ? 'absolute rounded-lg border-2 border-brand bg-brand/15 pointer-events-none'
                        : 'absolute inset-0 rounded-2xl border-2 border-brand bg-brand/15 pointer-events-none'
                    }
                    {...(bandFrame === null ? {} : { style: bandFrame })}
                  />
                )}
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
                    data-testid="provenance-band"
                    className="absolute left-3 right-3 h-8 rounded-lg border-2 border-brand bg-brand/15 pointer-events-none"
                    style={{ top: `${18 + (hashPct(hovered) % 60)}%` }}
                  />
                )}
              </div>
            )}
            {hovered && (
              <p className="mt-3 text-[11px] text-brand font-semibold leading-relaxed">
                {/* A field with no recorded source note still gets an honest
                    sentence — an empty caption reads as a broken feature, and
                    which sentence depends on whether a position is painted. */}
                {(hoveredField?.provenance ?? '').trim() ||
                  intl.formatMessage(bandFrame !== null ? m.provenancePositioned : m.provenanceFallback)}
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
                      <span className="min-w-0 text-zinc-600 truncate">{e.outcome}</span>
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
          <div className="min-w-0 p-6">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                {intl.formatMessage(m.extractedFields)}
              </span>
              <span className="text-[11px] font-semibold text-zinc-600">
                <span className="pointer-coarse:hidden">{intl.formatMessage(m.correctHint)}</span>
                <span className="hidden pointer-coarse:inline">{intl.formatMessage(m.correctHintTouch)}</span>
              </span>
            </div>
            <div className="flex flex-col">
              {fields.map((f, i) => (
                <div
                  key={f.label}
                  onMouseEnter={() => setHovered(f.label)}
                  onMouseLeave={() => setHovered(null)}
                  className={`py-3 flex items-center justify-between gap-3 flex-wrap ${
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
                      title={f.value}
                      className={`shrink-0 max-w-full group flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-bold transition-all border border-transparent hover:border-white/10 hover:bg-white/5 ${
                        f.confidence < 0.6 ? 'text-amber-400' : 'text-white'
                      }`}
                    >
                      <span className="min-w-0 truncate">{f.value}</span>
                      <PencilLine size={13} className="text-zinc-600 group-hover:text-brand transition-colors" />
                    </button>
                  ) : (
                    <span
                      title={intl.formatMessage(m.notEditable)}
                      className={`min-w-0 max-w-full break-words px-3 py-1.5 text-sm font-bold ${f.confidence < 0.6 ? 'text-amber-400' : 'text-white'}`}
                    >
                      {f.value}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* The path from To Review to Ready — see the note on
                `missingForReady` above. Approval happens in the staged card
                below, never here: Review → Approve is the only door. */}
            {readyPanelOn && (
              <div className="mt-6 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4">
                <div className="text-[11px] font-bold text-amber-400 uppercase tracking-widest mb-2">
                  {intl.formatMessage(m.readyHeading)}
                </div>
                {missingForReady.length > 0 ? (
                  <>
                    <p className="text-[13px] text-zinc-300 leading-relaxed">
                      {intl.formatMessage(m.readyMissing, {
                        fields: intl.formatList(missingForReady, { type: 'conjunction' }),
                        count: missingForReady.length,
                      })}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {missingForReady.map((label) => {
                        const field = fields.find((f) => f.label === label);
                        if (field === undefined || !canEdit(label)) return null;
                        return (
                          <button
                            key={label}
                            onClick={() => startEdit(field)}
                            className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-raised hover:bg-white/10 border border-white/5 transition-colors shadow-inner"
                          >
                            <PencilLine size={13} className="text-brand" />
                            {intl.formatMessage(m.readyAddField, { field: label })}
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : (
                  <p className="text-[13px] text-zinc-300 leading-relaxed">
                    {intl.formatMessage(m.readyComplete, {
                      fields: intl.formatList(BASE_MANDATORY, { type: 'conjunction' }),
                    })}
                  </p>
                )}
              </div>
            )}

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
                      {/* min-w-0 is load-bearing: a truncate span is nowrap, and
                          without it a real 80-character description sets the
                          row's — and the grid column's — minimum width. */}
                      <span title={li.description} className="min-w-0 text-zinc-400 truncate">
                        {li.description}
                      </span>
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
