import { useMemo, useRef, useState } from 'react';
import {
  Upload, Eye, Copy, CheckCircle, Send, Trash2, RefreshCw, MessageSquare, FileText, Image as ImageIcon,
  Link2, Sparkles, Download, PencilLine, UploadCloud,
} from 'lucide-react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { commonActions, commonLabels } from '../i18n/common';
import { useAppContext } from '../context/AppContext';
import { runWorkspaceDrop } from '../api/uploads';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { SubTabs } from '../components/DynamicComponents/SubTabs';
import { DuplicateModal } from '../components/DynamicComponents/DuplicateModal';
import { navigate, path, useQueryParam, useSegment } from '../lib/router';
import { failureOf, reasonText, retryMeaning } from '../lib/failures';
import { AnalysisModal } from '../components/DynamicComponents/AnalysisModal';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { blockedReason, partitionByReadiness, readinessOf } from '../lib/readiness';
import { currency } from '../lib/resolver';
import type { Client, DocKind, Document, DuplicatePair } from '../lib/types';
import { EXPORT_HINT } from '../lib/exportRules';

/**
 * Wireframe screen 8 — a client's Costs inbox. The Sales tab is the same
 * component over the opposite side of the ledger, because AI classification
 * routes documents to the right inbox and nothing else differs.
 *
 * Each status tab is a genuinely different job, so each gets the columns and
 * the actions that job needs rather than one table filtered five ways:
 *
 *   To Review       — ranked by uncertainty, least confident first
 *   Ready           — everything mandatory is present; the job is publishing
 *   Published       — done; the only actions left are getting the data out
 *   Processing      — waiting on extraction, nothing to decide yet
 *   Rejected/Failed — the 337-vote view: nothing ever vanishes silently
 *
 * Ordered the way an item moves through the accountant's hands: review it, it
 * becomes ready, it gets published. Processing sits after those because nobody
 * acts on it — extraction is running and the only thing to do is wait — and
 * Rejected / Failed is last because it is the exception, not a stage anything
 * passes through.
 */
const STATUSES = ['review', 'ready', 'published', 'processing', 'rejected', 'duplicates'] as const;
type Status = (typeof STATUSES)[number];

/**
 * The union above is identity — it is the URL segment and what `d.status ===`
 * compares against. These are the words on the sub-tabs. Descriptors, because a
 * hook cannot be called at module scope.
 */
const STATUS_LABEL: Record<Status, MessageDescriptor> = defineMessages({
  review: { id: 'analytics.inboxStatus.review', defaultMessage: 'To Review' },
  ready: { id: 'analytics.inboxStatus.ready', defaultMessage: 'Ready' },
  published: { id: 'analytics.inboxStatus.published', defaultMessage: 'Published' },
  processing: { id: 'analytics.inboxStatus.processing', defaultMessage: 'Processing' },
  rejected: { id: 'analytics.inboxStatus.rejected', defaultMessage: 'Rejected / Failed' },
  duplicates: { id: 'analytics.inboxStatus.duplicates', defaultMessage: 'Duplicates' },
});

const mSplit = defineMessages({
  autoLabel: { id: 'analytics.splitMode.autoLabel', defaultMessage: 'Auto-split' },
  autoHint: {
    id: 'analytics.splitMode.autoHint',
    defaultMessage: 'Standard — a multi-document PDF becomes one document per invoice',
  },
  perFileLabel: { id: 'analytics.splitMode.perFileLabel', defaultMessage: 'One per file' },
  perFileHint: {
    id: 'analytics.splitMode.perFileHint',
    defaultMessage: 'Every file is exactly one document',
  },
  perPageLabel: { id: 'analytics.splitMode.perPageLabel', defaultMessage: 'One per page' },
  perPageHint: { id: 'analytics.splitMode.perPageHint', defaultMessage: 'Every page is its own document' },
});

/** How the file was split on the way in — PRD stage 1, shown so it is auditable. */
const SPLIT_MODES = [
  { key: 'auto', label: mSplit.autoLabel, hint: mSplit.autoHint },
  { key: 'per-file', label: mSplit.perFileLabel, hint: mSplit.perFileHint },
  { key: 'per-page', label: mSplit.perPageLabel, hint: mSplit.perPageHint },
] as const;

const m = defineMessages({
  // Why a document stopped, in the words of whatever stopped it.
  flagDuplicate: { id: 'analytics.clientInbox.flagDuplicate', defaultMessage: 'Duplicate — {percent}% match' },
  flagLowConfidence: {
    id: 'analytics.clientInbox.flagLowConfidence',
    defaultMessage: 'Low confidence on {field}',
  },
  flagMissing: { id: 'analytics.clientInbox.flagMissing', defaultMessage: 'Missing {fields}' },

  publishPromptOne: {
    id: 'analytics.clientInbox.publishPromptOne',
    defaultMessage: 'Publish {supplier} for {client}',
  },
  publishPromptMany: {
    id: 'analytics.clientInbox.publishPromptMany',
    defaultMessage: 'Publish {count} ready items for {client}',
  },
  publishReply: {
    id: 'analytics.clientInbox.publishReply',
    defaultMessage: 'Read the review — counts and gross/VAT totals — before approving the push.',
  },
  reviewPrompt: { id: 'analytics.clientInbox.reviewPrompt', defaultMessage: 'Review the {supplier} document' },
  reviewReply: {
    id: 'analytics.clientInbox.reviewReply',
    defaultMessage: 'Every field shows confidence and provenance — click any value to correct it.',
  },

  columnDoc: { id: 'analytics.clientInbox.columnDoc', defaultMessage: 'Doc' },
  docReceipt: { id: 'analytics.clientInbox.docReceipt', defaultMessage: 'Receipt' },
  docInvoice: { id: 'analytics.clientInbox.docInvoice', defaultMessage: 'Invoice' },
  columnCustomer: { id: 'analytics.clientInbox.columnCustomer', defaultMessage: 'Customer' },
  columnChannel: { id: 'analytics.clientInbox.columnChannel', defaultMessage: 'Received via' },
  columnWhyFlagged: { id: 'analytics.clientInbox.columnWhyFlagged', defaultMessage: 'Why flagged' },
  columnVat: { id: 'analytics.clientInbox.columnVat', defaultMessage: 'VAT' },
  columnPublishTo: { id: 'analytics.clientInbox.columnPublishTo', defaultMessage: 'Publish to' },
  columnInTheLedger: { id: 'analytics.clientInbox.columnInTheLedger', defaultMessage: 'In the ledger' },
  columnWhatFailed: { id: 'analytics.clientInbox.columnWhatFailed', defaultMessage: 'What failed' },
  columnReason: { id: 'analytics.clientInbox.columnReason', defaultMessage: 'Reason' },

  percent: { id: 'analytics.clientInbox.percent', defaultMessage: '{percent}%' },
  categoryMissing: { id: 'analytics.clientInbox.categoryMissing', defaultMessage: 'Missing' },
  categoryConfidence: {
    id: 'analytics.clientInbox.categoryConfidence',
    defaultMessage: 'AI · {percent}% confident',
  },
  duplicateTitle: {
    id: 'analytics.clientInbox.duplicateTitle',
    defaultMessage: '{percent}% match — {signals}',
  },
  duplicateBadge: { id: 'analytics.clientInbox.duplicateBadge', defaultMessage: 'Duplicate {percent}%' },

  retryReadTitle: { id: 'analytics.clientInbox.retryReadTitle', defaultMessage: 'Read {supplier} again?' },
  retryPublishTitle: {
    id: 'analytics.clientInbox.retryPublishTitle',
    defaultMessage: 'Publish {supplier} again?',
  },
  retryDetail: { id: 'analytics.clientInbox.retryDetail', defaultMessage: '{reason}. {meaning}' },
  retryConsequence: {
    id: 'analytics.clientInbox.retryConsequence',
    defaultMessage: 'This is unlikely to clear it on its own — {fix} is what changes the outcome.',
  },
  retryConfirm: { id: 'analytics.clientInbox.retryConfirm', defaultMessage: 'Yes, retry' },

  replaceTitle: {
    id: 'analytics.clientInbox.replaceTitle',
    defaultMessage: 'Replace {supplier} with {file}?',
  },
  replaceTitleUnknown: {
    id: 'analytics.clientInbox.replaceTitleUnknown',
    defaultMessage: 'Replace this document with {file}?',
  },
  replaceDetail: {
    id: 'analytics.clientInbox.replaceDetail',
    defaultMessage: 'The new file is read from scratch under this client.',
  },
  replaceConsequence: {
    id: 'analytics.clientInbox.replaceConsequence',
    defaultMessage: 'The unreadable original is removed, so the same spend is not on file twice.',
  },
  replaceConfirm: { id: 'analytics.clientInbox.replaceConfirm', defaultMessage: 'Yes, replace it' },

  stepFix: { id: 'analytics.clientInbox.stepFix', defaultMessage: 'Fix' },
  stepMoveToReady: { id: 'analytics.clientInbox.stepMoveToReady', defaultMessage: 'Move to Ready' },
  stepPublish: { id: 'analytics.clientInbox.stepPublish', defaultMessage: 'Publish' },
  readyTitle: { id: 'analytics.clientInbox.readyTitle', defaultMessage: 'Move {supplier} to Ready?' },
  readyDetail: {
    id: 'analytics.clientInbox.readyDetail',
    defaultMessage:
      '{amount} · {category}. Ready means every check has passed and it is queued to publish.',
  },
  readyConsequence: {
    id: 'analytics.clientInbox.readyConsequence',
    defaultMessage: 'This item is flagged: {flag}.',
  },
  readyConfirm: { id: 'analytics.clientInbox.readyConfirm', defaultMessage: 'Yes, mark it Ready' },

  rowOpen: {
    id: 'analytics.clientInbox.rowOpen',
    defaultMessage: 'Open — the original with every extracted field',
  },
  rowCompare: {
    id: 'analytics.clientInbox.rowCompare',
    defaultMessage: 'Compare the two copies side by side',
  },
  rowOpenInChat: {
    id: 'analytics.clientInbox.rowOpenInChat',
    defaultMessage:
      'Open in the AI workspace — every field with its confidence, click any value to correct it',
  },
  stepBlocked: {
    id: 'analytics.clientInbox.stepBlocked',
    defaultMessage: '{reason} — open it to sort that out first.',
  },
  rowRetryHelps: { id: 'analytics.clientInbox.rowRetryHelps', defaultMessage: 'Retry — {meaning}' },
  rowRetryUnlikely: {
    id: 'analytics.clientInbox.rowRetryUnlikely',
    defaultMessage: 'Retry — unlikely to help while {reason}',
  },

  mandatoryMissing: { id: 'analytics.clientInbox.mandatoryMissing', defaultMessage: 'Missing' },
  mandatoryRequired: {
    id: 'analytics.clientInbox.mandatoryRequired',
    defaultMessage: '{field} is required before this can be published',
  },
  extractionRunning: {
    id: 'analytics.clientInbox.extractionRunning',
    defaultMessage: 'Extraction running',
  },
  targetXeroBills: { id: 'analytics.clientInbox.targetXeroBills', defaultMessage: 'Xero — Bills' },
  targetXeroInvoices: { id: 'analytics.clientInbox.targetXeroInvoices', defaultMessage: 'Xero — Invoices' },
  targetNoLedger: { id: 'analytics.clientInbox.targetNoLedger', defaultMessage: 'No ledger connected' },
  targetExported: { id: 'analytics.clientInbox.targetExported', defaultMessage: 'Exported' },
  failedPublish: { id: 'analytics.clientInbox.failedPublish', defaultMessage: 'Publish' },
  failedExtraction: { id: 'analytics.clientInbox.failedExtraction', defaultMessage: 'Extraction' },
  noReasonRecorded: { id: 'analytics.clientInbox.noReasonRecorded', defaultMessage: 'No reason recorded' },

  bulkApprove: { id: 'analytics.clientInbox.bulkApprove', defaultMessage: 'Approve suggestions' },
  approveNoneTitle: {
    id: 'analytics.clientInbox.approveNoneTitle',
    defaultMessage: 'None of these can move yet',
  },
  approveNoneItem: { id: 'analytics.clientInbox.approveNoneItem', defaultMessage: '{supplier} — {reason}' },
  approveTitle: {
    id: 'analytics.clientInbox.approveTitle',
    defaultMessage: "Accept the AI's coding on {count, plural, one {# item} other {# items}}?",
  },
  approveDetail: {
    id: 'analytics.clientInbox.approveDetail',
    defaultMessage: '{suppliers} move to Ready with the categories as suggested.',
  },
  approveDetailMore: {
    id: 'analytics.clientInbox.approveDetailMore',
    defaultMessage: '{suppliers} and {more} more move to Ready with the categories as suggested.',
  },
  approveConsequenceBlocked: {
    id: 'analytics.clientInbox.approveConsequenceBlocked',
    defaultMessage: '{count} of the selected cannot move yet and will be left alone: {suppliers}.',
  },
  approveConsequence: {
    id: 'analytics.clientInbox.approveConsequence',
    defaultMessage: 'Anything the extractor got wrong goes through unchallenged.',
  },
  approveConfirm: { id: 'analytics.clientInbox.approveConfirm', defaultMessage: 'Yes, accept them' },

  bulkDelete: { id: 'analytics.clientInbox.bulkDelete', defaultMessage: 'Delete' },
  deleteTitle: {
    id: 'analytics.clientInbox.deleteTitle',
    defaultMessage: 'Delete {count, plural, one {# document} other {# documents}}?',
  },
  deleteItem: { id: 'analytics.clientInbox.deleteItem', defaultMessage: '{supplier} {amount}' },
  deleteConsequence: {
    id: 'analytics.clientInbox.deleteConsequence',
    defaultMessage:
      'The originals go with them, and a deleted document cannot be matched to a bank line later.',
  },
  deleteConfirm: { id: 'analytics.clientInbox.deleteConfirm', defaultMessage: 'Yes, delete' },

  bulkBackToReview: { id: 'analytics.clientInbox.bulkBackToReview', defaultMessage: 'Back to review' },
  backToReviewTitle: {
    id: 'analytics.clientInbox.backToReviewTitle',
    defaultMessage: 'Send {count, plural, one {# item} other {# items}} back to review?',
  },
  backToReviewDetail: {
    id: 'analytics.clientInbox.backToReviewDetail',
    defaultMessage: 'They leave the publish queue until someone passes them again.',
  },
  backToReviewConfirm: {
    id: 'analytics.clientInbox.backToReviewConfirm',
    defaultMessage: 'Yes, send them back',
  },
  bulkPublish: { id: 'analytics.clientInbox.bulkPublish', defaultMessage: 'Publish selected' },

  bulkUnpublish: { id: 'analytics.clientInbox.bulkUnpublish', defaultMessage: 'Unpublish' },
  unpublishTitle: {
    id: 'analytics.clientInbox.unpublishTitle',
    defaultMessage: 'Unpublish {count, plural, one {# item} other {# items}}?',
  },
  unpublishDetail: {
    id: 'analytics.clientInbox.unpublishDetail',
    defaultMessage: 'They come back to Ready here.',
  },
  unpublishConsequence: {
    id: 'analytics.clientInbox.unpublishConsequence',
    defaultMessage:
      'This does not remove them from the accounting software — that has to be undone in the ledger itself.',
  },
  unpublishConfirm: { id: 'analytics.clientInbox.unpublishConfirm', defaultMessage: 'Yes, unpublish' },

  bulkRetryTitle: {
    id: 'analytics.clientInbox.bulkRetryTitle',
    defaultMessage: 'Retry {count, plural, one {# failed item} other {# failed items}}?',
  },
  bulkRetryDetail: {
    id: 'analytics.clientInbox.bulkRetryDetail',
    defaultMessage:
      'Anything that failed to extract is read again; anything that failed to publish goes back to Ready to be pushed again. Whatever was already read off a document is kept.',
  },
  bulkRetryConfirm: { id: 'analytics.clientInbox.bulkRetryConfirm', defaultMessage: 'Yes, retry' },
  bulkEnterManually: { id: 'analytics.clientInbox.bulkEnterManually', defaultMessage: 'Enter manually' },

  duplicatesEmpty: {
    id: 'analytics.clientInbox.duplicatesEmpty',
    defaultMessage:
      'Nothing flagged. Every document is checked against the others on file the moment it is read — same total, supplier, dates within a few days, matching text, file and image hashes — so an invoice and its photographed twin are caught even when they came from different people.',
  },
  duplicatePair: { id: 'analytics.clientInbox.duplicatePair', defaultMessage: '{left} ↔ {right}' },
  duplicateCrossType: { id: 'analytics.clientInbox.duplicateCrossType', defaultMessage: 'Cross-type' },
  duplicateDifferentUploaders: {
    id: 'analytics.clientInbox.duplicateDifferentUploaders',
    defaultMessage: 'Different uploaders',
  },

  uploadAction: { id: 'analytics.clientInbox.uploadAction', defaultMessage: 'Upload' },

  emptyProcessing: {
    id: 'analytics.clientInbox.emptyProcessing',
    defaultMessage: 'Nothing extracting right now.',
  },
  emptyReview: {
    id: 'analytics.clientInbox.emptyReview',
    defaultMessage: 'Nothing to review — the inbox is clear.',
  },
  emptyReady: { id: 'analytics.clientInbox.emptyReady', defaultMessage: 'Nothing ready to publish.' },
  emptyPublished: {
    id: 'analytics.clientInbox.emptyPublished',
    defaultMessage: 'Nothing published yet for this client.',
  },
  emptyRejected: {
    id: 'analytics.clientInbox.emptyRejected',
    defaultMessage: 'Nothing has failed. Anything that does lands here with its reason.',
  },

  footerReview: {
    id: 'analytics.clientInbox.footerReview',
    defaultMessage: 'Ranked by uncertainty — least confident first',
  },
  footerReady: {
    id: 'analytics.clientInbox.footerReady',
    defaultMessage: 'Needs supplier, total and category before publishing',
  },
  footerReadyPlus: {
    id: 'analytics.clientInbox.footerReadyPlus',
    defaultMessage: 'Needs supplier, total and category, plus {fields} before publishing',
  },
  footerPublished: {
    id: 'analytics.clientInbox.footerPublished',
    defaultMessage:
      'Already in the accounting software — unpublishing here does not remove it from the ledger',
  },
  footerRejected: {
    id: 'analytics.clientInbox.footerRejected',
    defaultMessage: 'Nothing ever disappears silently — every failure keeps its reason',
  },
  footerProcessing: {
    id: 'analytics.clientInbox.footerProcessing',
    defaultMessage: '{count} extracting · ETA shown per item',
  },
  documentsLoading: { id: 'analytics.clientInbox.documentsLoading', defaultMessage: 'Loading documents…' },
  documentsError: { id: 'analytics.clientInbox.documentsError', defaultMessage: 'Could not load documents — {error}' },
});

export function ClientInbox({ client, kind, onPreview }: {
  client: Client;
  kind: DocKind;
  onPreview: (doc: Document) => void;
}) {
  const {
    documents, duplicates, mandatoryFields, ingest, sheetImports, updateDocumentStatus, retryDocument,
    deleteDocuments, startConversation, statsFor, documentsSource, documentsLoading, documentsError,
    isSameClient, serverClientIdFor,
  } = useAppContext();

  const confirm = useConfirm();
  const intl = useIntl();

  // /clients/:id/costs/:status — the sub-tab is the fourth segment.
  const [statusSlug, setStatusSlug] = useSegment(3);
  const status: Status = (STATUSES.find((st) => st === statusSlug) as Status) ?? 'review';
  const setStatus = (next: Status) => setStatusSlug(next);

  // ?compare=<pairId> — the side-by-side modal is linkable like any other.
  const [comparingId, setComparingId] = useQueryParam('compare');
  const comparing = comparingId ? duplicates.find((p) => p.id === comparingId) ?? null : null;
  const setComparing = (pair: DuplicatePair | null) => setComparingId(pair ? pair.id : null);
  const [splitMode, setSplitMode] = useState<(typeof SPLIT_MODES)[number]['key']>('auto');
  const fileRef = useRef<HTMLInputElement>(null);
  /** A replacement is one file for one unreadable document, kept off the bulk path. */
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<Document | null>(null);
  /** The upload being read on screen. */
  const [analysing, setAnalysing] = useState<{ docIds: string[]; importIds: string[] } | null>(null);

  // Tolerant of both id worlds (METH S14 bridge): server rows carry opaque
  // business ids, the opened client still keys by seed id.
  const mine = documents.filter((d) => isSameClient(d.clientId, client.id) && d.kind === kind);
  const counts = Object.fromEntries(
    STATUSES.map((st) => [st, mine.filter((d) => d.status === st).length]),
  ) as Record<Status, number>;

  /**
   * Pairs where at least one side is in this inbox, and the lookup from a
   * document to the pair it belongs to — the row needs the pair, not just the
   * knowledge that one exists.
   */
  const pairFor = useMemo(() => {
    const ids = new Set(mine.map((d) => d.id));
    const map = new Map<string, DuplicatePair>();
    duplicates
      .filter((p) => ids.has(p.left.id) || ids.has(p.right.id))
      .forEach((p) => {
        if (!map.has(p.left.id)) map.set(p.left.id, p);
        if (!map.has(p.right.id)) map.set(p.right.id, p);
      });
    return map;
  }, [duplicates, mine]);

  /** The pairs themselves, for the Duplicates tab. */
  const clientPairs = useMemo(() => {
    const ids = new Set(mine.map((d) => d.id));
    return duplicates.filter((p) => ids.has(p.left.id) || ids.has(p.right.id));
  }, [duplicates, mine]);

  /**
   * The least confident thing the extractor said about a document. Ranking on
   * it puts the documents most likely to be wrong at the top, which is the
   * whole point of a review queue — not date order.
   */
  const uncertainty = (d: Document) =>
    d.fields.length === 0 ? 0 : Math.min(...d.fields.map((f) => f.confidence));

  /** Why this document stopped, in the words of whatever stopped it. */
  const whyFlagged = (d: Document): { text: string; tone: 'amber' | 'red' | 'neutral' } => {
    if (pairFor.has(d.id)) {
      return { text: intl.formatMessage(m.flagDuplicate, { percent: Math.round(pairFor.get(d.id)!.similarity * 100) }), tone: 'amber' };
    }
    if (d.statusNote) return { text: d.statusNote, tone: d.status === 'rejected' ? 'red' : 'amber' };
    const weakest = d.fields.length ? d.fields.reduce((a, b) => (a.confidence < b.confidence ? a : b)) : undefined;
    if (weakest && weakest.confidence < 0.6) {
      return { text: intl.formatMessage(m.flagLowConfidence, { field: weakest.label.toLowerCase() }), tone: 'amber' };
    }
    const missing = mandatoryFields.filter((f) => !d.fields.some((x) => x.label === f && x.value !== '—'));
    if (missing.length) return { text: intl.formatMessage(m.flagMissing, { fields: missing.join(', ') }), tone: 'amber' };
    return { text: '—', tone: 'neutral' };
  };

  const rows = useMemo(() => {
    const list = mine.filter((d) => d.status === status);
    // Only the review queue is uncertainty-ranked; the others read better in
    // the order they arrived.
    return status === 'review' ? [...list].sort((a, b) => uncertainty(a) - uncertainty(b)) : list;
  }, [mine, status]);

  /**
   * Which tab you happened to be on is not evidence about the document.
   * `kind` is deliberately not passed: extraction reads the bill-to block and
   * decides, and the analysis panel shows that call with a control to change
   * it — so a receipt dropped on the Sales tab still files as a cost.
   */
  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    if (documentsSource === 'api') {
      // The real journey (METH S7): intent → presigned PUT → complete, per
      // file (`api/uploads.ts`), into THIS client — the one place an upload's
      // workspace is never ambiguous. The Processing tab then watches the
      // pipeline move it (the live documents query polls); the analysis is the
      // server's and arrives as extraction rows, not a synthetic panel.
      setStatus('processing');
      void runWorkspaceDrop(intl, confirm, serverClientIdFor(client.id), Array.from(files));
      return;
    }
    const result = ingest(
      Array.from(files).map((f) => ({ name: f.name, size: f.size, raw: f })),
      client.id,
      'web',
      { uploader: 'You (web upload)' },
    );
    if (result.documents.length || result.imports.length) {
      setAnalysing({ docIds: result.documents.map((d) => d.id), importIds: result.imports.map((t) => t.id) });
    }
  };

  /** Publishing always goes through the review gate — one path for row and bulk. */
  const publish = (docs: Document[]) => {
    // Naming the single document keeps the "length === 1" invariant — the only
    // thing that makes docs[0] present — visible at the point it is relied on.
    const single = docs.length === 1 ? docs[0] : undefined;
    return startConversation([client.id], [
      {
        id: `${Date.now()}-u`,
        role: 'user',
        content: single
          ? intl.formatMessage(m.publishPromptOne, { supplier: single.supplier, client: client.name })
          : intl.formatMessage(m.publishPromptMany, { count: docs.length, client: client.name }),
      },
      {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: intl.formatMessage(m.publishReply),
        intent: 'PUBLISH',
        payload: { clientIds: [client.id], clientNames: [client.name], documentIds: docs.map((d) => d.id) },
      },
    ]);
  };

  const openInChat = (doc: Document) =>
    startConversation([client.id], [
      { id: `${Date.now()}-u`, role: 'user', content: intl.formatMessage(m.reviewPrompt, { supplier: doc.supplier }) },
      {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: intl.formatMessage(m.reviewReply),
        intent: 'REVIEW_DOCUMENT',
        payload: { documentId: doc.id, clientIds: [client.id], clientNames: [client.name] },
      },
    ]);


  /* ── columns, per status ────────────────────────────────────────────────── */

  const docCell: Column<Document> = {
    key: 'doc',
    label: intl.formatMessage(m.columnDoc),
    sortValue: (d) => d.splitFrom ?? d.id,
    render: (d) => {
      const isImage = /receipt|photo|jpg|png|heic/i.test(`${d.source} ${d.splitFrom ?? ''}`) || d.source === 'whatsapp';
      return (
        <span className="flex items-center gap-2.5">
          <span className="w-8 h-9 rounded-lg bg-raised border border-white/5 flex items-center justify-center text-zinc-500 shrink-0">
            {isImage ? <ImageIcon size={14} /> : <FileText size={14} />}
          </span>
          <span className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
            {intl.formatMessage(isImage ? m.docReceipt : m.docInvoice)}
          </span>
        </span>
      );
    },
  };

  const supplierCell: Column<Document> = {
    key: 'supplier',
    label: intl.formatMessage(kind === 'cost' ? commonLabels.supplier : m.columnCustomer),
    sortValue: (d) => d.supplier,
    render: (d) => {
      const field = d.fields.find((f) => f.label === 'Supplier' || f.label === 'Customer');
      const low = field !== undefined && field.confidence < 0.75;
      return (
        <span className="flex items-center gap-2">
          <span className="text-white font-semibold">{d.supplier}</span>
          {/* Confidence is shown where it changes what you do, not everywhere. */}
          {low && <Pill tone="amber">{intl.formatMessage(m.percent, { percent: Math.round(field!.confidence * 100) })}</Pill>}
        </span>
      );
    },
  };

  const categoryCell: Column<Document> = {
    key: 'category',
    label: intl.formatMessage(commonLabels.category),
    sortValue: (d) => d.category,
    render: (d) => {
      const field = d.fields.find((f) => f.label === 'Category');
      if (d.category === '—') return <Pill tone="amber">{intl.formatMessage(m.categoryMissing)}</Pill>;
      const byRule = field?.provenance?.includes('rule');
      return (
        <span className="flex items-center gap-2">
          <span className="text-zinc-300">{d.category}</span>
          {byRule ? (
            <span title={field?.provenance} className="text-brand shrink-0"><Link2 size={12} /></span>
          ) : field ? (
            <span title={intl.formatMessage(m.categoryConfidence, { percent: Math.round(field.confidence * 100) })} className="text-zinc-500 shrink-0 flex items-center gap-1">
              <Sparkles size={12} />
              <span className="text-[11px] font-semibold">{intl.formatMessage(m.percent, { percent: Math.round(field.confidence * 100) })}</span>
            </span>
          ) : null}
        </span>
      );
    },
  };

  const totalCell: Column<Document> = {
    key: 'total',
    label: intl.formatMessage(commonLabels.total),
    align: 'right',
    sortValue: (d) => d.total,
    render: (d) => (
      <span className="flex items-center justify-end gap-2">
        {d.currency !== 'GBP' && <Pill tone="amber">{d.currency}</Pill>}
        <span className="text-white font-bold tabular-nums">{currency(d.total)}</span>
      </span>
    ),
  };

  // Kept at the user's request: which channel a document arrived on is how you
  // tell a chased upload from a supplier emailing us directly.
  const channelCell: Column<Document> = {
    key: 'source',
    label: intl.formatMessage(m.columnChannel),
    sortValue: (d) => d.source,
    render: (d) => <Pill>{d.source}</Pill>,
  };

  const dateCell: Column<Document> = { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (d) => d.date };

  /**
   * A duplicate flag has to be visible wherever the document is, not only on
   * the tab that happens to explain why an item stopped.
   */
  const flagCell: Column<Document> = {
    key: 'flags',
    label: '',
    render: (d) => {
      const pair = pairFor.get(d.id);
      if (!pair) return null;
      return (
        <button
          onClick={(e) => { e.stopPropagation(); setComparing(pair); }}
          title={intl.formatMessage(m.duplicateTitle, {
            percent: Math.round(pair.similarity * 100),
            signals: pair.signals.slice(0, 3).join(', '),
          })}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/25 hover:bg-amber-400/20 transition-colors whitespace-nowrap"
        >
          <Copy size={11} />
          {intl.formatMessage(m.duplicateBadge, { percent: Math.round(pair.similarity * 100) })}
        </button>
      );
    },
  };

  const whyCell: Column<Document> = {
    key: 'why',
    label: intl.formatMessage(m.columnWhyFlagged),
    sortValue: (d) => whyFlagged(d).text,
    render: (d) => {
      const { text, tone } = whyFlagged(d);
      if (text === '—') return <span className="text-zinc-700">—</span>;
      return <Pill tone={tone}>{text}</Pill>;
    },
  };

  /**
   * The one move that takes this document forward, named for where it goes.
   * A document waiting on extraction has no move — nobody can hurry it — and a
   * published one is finished, so neither gets a button rather than getting a
   * disabled one that invites a click.
   */
  /** Retry, saying what it will actually do — and whether it can help at all. */
  const askRetry = async (d: Document) => {
    const failure = failureOf(d);
    if (!failure) return;
    const ok = await confirm({
      title: intl.formatMessage(failure.stage === 'extraction' ? m.retryReadTitle : m.retryPublishTitle, { supplier: d.supplier }),
      detail: intl.formatMessage(m.retryDetail, {
        reason: reasonText(failure, intl),
        meaning: intl.formatMessage(retryMeaning(failure)),
      }),
      ...(failure.retryHelps
        ? {}
        : {
            consequence: intl.formatMessage(m.retryConsequence, {
              fix: intl.formatMessage(failure.fixLabel).toLowerCase(),
            }),
          }),
      confirmLabel: intl.formatMessage(m.retryConfirm),
    });
    if (ok) retryDocument(d.id);
  };

  /** The replacement is read from scratch and the unreadable original goes. */
  const handleReplacement = async (files: FileList | null) => {
    const doc = replacing;
    setReplacing(null);
    // Reading the file first says what the length check was really asserting:
    // a replacement is exactly one file, and there is nothing to do without it.
    const file = files?.[0];
    if (!doc || !file) return;
    const ok = await confirm({
      title: doc.supplier === 'Unknown'
        ? intl.formatMessage(m.replaceTitleUnknown, { file: file.name })
        : intl.formatMessage(m.replaceTitle, { supplier: doc.supplier, file: file.name }),
      detail: intl.formatMessage(m.replaceDetail),
      consequence: intl.formatMessage(m.replaceConsequence),
      confirmLabel: intl.formatMessage(m.replaceConfirm),
    });
    if (!ok) return;
    ingest([{ name: file.name, size: file.size, raw: file }], client.id, 'web');
    deleteDocuments([doc.id]);
    setStatus('processing');
  };

  const nextStep = (
    d: Document,
  ): { label: string; icon: typeof CheckCircle; run: () => void; blocked?: string } | null => {
    // Live, the only universal next step is opening the document — every
    // local flip below reverts under the poll; corrections go through a
    // Review → Approve proposal and publishing through the workspace
    // (METH S14 sweep).
    if (documentsSource === 'api') {
      if (d.status === 'review') {
        return { label: intl.formatMessage(m.stepFix), icon: PencilLine, run: () => onPreview(d) };
      }
      return null;
    }
    if (d.status === 'review') {
      // Ready claims every check has passed. A document that cannot make that
      // claim is not offered the move at all — it is offered the fix, because
      // that is the only thing that gets it moving.
      const verdict = readinessOf(d, mandatoryFields);
      if (!verdict.ready) {
        return {
          label: intl.formatMessage(m.stepFix),
          icon: PencilLine,
          blocked: blockedReason(verdict, intl),
          run: () => onPreview(d),
        };
      }
      return {
        label: intl.formatMessage(m.stepMoveToReady),
        icon: CheckCircle,
        run: async () => {
          const flag = whyFlagged(d).text;
          const ok = await confirm({
            title: intl.formatMessage(m.readyTitle, { supplier: d.supplier }),
            detail: intl.formatMessage(m.readyDetail, { amount: currency(d.total), category: d.category }),
            ...(flag === '—' ? {} : { consequence: intl.formatMessage(m.readyConsequence, { flag }) }),
            confirmLabel: intl.formatMessage(m.readyConfirm),
          });
          if (ok) updateDocumentStatus(d.id, 'ready');
        },
      };
    }
    if (d.status === 'ready') return { label: intl.formatMessage(m.stepPublish), icon: Send, run: () => publish([d]) };
    if (d.status === 'rejected') {
      // "Fix & retry" was one button doing one thing — retrying — whatever the
      // cause. A locked PDF read again is still a locked PDF, so the cause
      // decides the verb, and Retry sits beside it in the action cell.
      const failure = failureOf(d);
      if (!failure) return null;
      if (failure.fix === 'replace-file') {
        return { label: intl.formatMessage(failure.fixLabel), icon: UploadCloud, blocked: reasonText(failure, intl), run: () => { setReplacing(d); replaceRef.current?.click(); } };
      }
      if (failure.fix === 'open-document') {
        return { label: intl.formatMessage(failure.fixLabel), icon: PencilLine, blocked: reasonText(failure, intl), run: () => onPreview(d) };
      }
      return { label: intl.formatMessage(failure.fixLabel), icon: RefreshCw, run: () => askRetry(d) };
    }
    return null;
  };

  /** The wireframe's per-row verb, in this site's icon-button language. */
  const actionCell: Column<Document> = {
    key: 'actions',
    label: '',
    align: 'right',
    render: (d) => {
      const step = nextStep(d);
      return (
        <span className="flex items-center justify-end gap-1.5">
          <RowButton icon={Eye} title={intl.formatMessage(m.rowOpen)} onClick={() => onPreview(d)} />
          {pairFor.has(d.id) && (
            <RowButton
              icon={Copy}
              title={intl.formatMessage(m.rowCompare)}
              tone="amber"
              onClick={() => setComparing(pairFor.get(d.id)!)}
            />
          )}
          {d.status === 'review' && (
            // Not a pencil: this leaves the table for the AI workspace rather
            // than editing in place, and an icon promising inline editing
            // makes the jump feel like a misfire.
            <RowButton
              icon={MessageSquare}
              title={intl.formatMessage(m.rowOpenInChat)}
              onClick={() => openInChat(d)}
            />
          )}
          {step && (
            // Blocked rows get an amber Fix that opens the document, not a
            // dead grey button — there is always something to do about it.
            <button
              onClick={(e) => { e.stopPropagation(); step.run(); }}
              title={step.blocked ? intl.formatMessage(m.stepBlocked, { reason: step.blocked }) : undefined}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold border transition-colors whitespace-nowrap ${
                step.blocked
                  ? 'text-amber-400 bg-amber-400/10 border-amber-400/25 hover:bg-amber-400/20'
                  : 'text-brand bg-brand/10 border-brand/25 hover:bg-brand/20'
              }`}
            >
              <step.icon size={12} strokeWidth={2.5} />
              {step.label}
            </button>
          )}
          {/* Retry sits beside the cause's own fix rather than replacing it,
              and says plainly when it is not the thing that will help. */}
          {d.status === 'rejected' && failureOf(d)?.fix !== 'retry' && (() => {
            const failure = failureOf(d)!;
            return (
              <RowButton
                icon={RefreshCw}
                title={failure.retryHelps
                  ? intl.formatMessage(m.rowRetryHelps, { meaning: intl.formatMessage(retryMeaning(failure)) })
                  : intl.formatMessage(m.rowRetryUnlikely, { reason: reasonText(failure, intl).toLowerCase() })}
                onClick={() => askRetry(d)}
              />
            );
          })()}
        </span>
      );
    },
  };

  /**
   * A column for each field the practice made mandatory.
   *
   * Requiring a field and then not showing it means opening documents one at a
   * time to find out which are short of it — the toggle in "Required before
   * publish" now puts the answer in the table.
   */
  const mandatoryCols: Column<Document>[] = mandatoryFields.map((label) => ({
    key: `req-${label}`,
    label,
    render: (d: Document) => {
      const value = d.fields.find((f) => f.label.toLowerCase() === label.toLowerCase())?.value;
      return value && value !== '—' ? (
        <span className="text-zinc-300">{value}</span>
      ) : (
        <span className="text-amber-400" title={intl.formatMessage(m.mandatoryRequired, { field: label })}>{intl.formatMessage(m.mandatoryMissing)}</span>
      );
    },
  }));

  const columns: Column<Document>[] =
    status === 'processing'
      ? [docCell, supplierCell, dateCell, channelCell,
         { key: 'eta', label: intl.formatMessage(commonLabels.status), render: (d) => <Pill>{d.statusNote ?? intl.formatMessage(m.extractionRunning)}</Pill> },
         flagCell, actionCell]
      : status === 'ready'
      ? [docCell, supplierCell, totalCell, categoryCell,
         {
           key: 'vat', label: intl.formatMessage(m.columnVat), align: 'right',
           render: (d) => {
             const tax = d.fields.find((f) => f.label.toLowerCase().includes('tax'));
             return <span className="tabular-nums text-zinc-400">{tax?.value ?? '—'}</span>;
           },
         },
         channelCell,
         ...mandatoryCols,
         flagCell,
         {
           key: 'target', label: intl.formatMessage(m.columnPublishTo),
           render: () => (
             <span className="text-zinc-400">
               {intl.formatMessage(client.xeroConnected ? (kind === 'cost' ? m.targetXeroBills : m.targetXeroInvoices) : m.targetNoLedger)}
             </span>
           ),
         },
         actionCell]
      : status === 'published'
      ? [docCell, supplierCell, dateCell, totalCell, categoryCell,
         {
           key: 'vat', label: intl.formatMessage(m.columnVat), align: 'right',
           render: (d) => {
             const tax = d.fields.find((f) => f.label.toLowerCase().includes('tax'));
             return <span className="tabular-nums text-zinc-400">{tax?.value ?? '—'}</span>;
           },
         },
         channelCell,
         flagCell,
         {
           key: 'where', label: intl.formatMessage(m.columnInTheLedger),
           render: () => (
             <Pill tone="blue">{intl.formatMessage(client.xeroConnected ? (kind === 'cost' ? m.targetXeroBills : m.targetXeroInvoices) : m.targetExported)}</Pill>
           ),
         },
         actionCell]
      : status === 'rejected'
      ? [docCell, supplierCell,
         {
           key: 'failed', label: intl.formatMessage(m.columnWhatFailed),
           render: (d) => <Pill tone="red">{intl.formatMessage(failureOf(d)?.stage === 'publish' ? m.failedPublish : m.failedExtraction)}</Pill>,
         },
         {
           key: 'reason', label: intl.formatMessage(m.columnReason),
           render: (d) => {
             const failure = failureOf(d);
             return (
               <span className="text-zinc-400" {...(failure ? { title: intl.formatMessage(failure.detail) } : {})}>
                 {failure ? reasonText(failure, intl) : d.statusNote ?? intl.formatMessage(m.noReasonRecorded)}
               </span>
             );
           },
         },
         channelCell,
         flagCell, actionCell]
      : [docCell, supplierCell, dateCell, totalCell, categoryCell, whyCell, channelCell, ...mandatoryCols, flagCell, actionCell];

  /* ── bulk actions, per status ───────────────────────────────────────────── */

  /**
   * Every writer below is a local flip the live poll reverts — off live rows
   * (METH S14 sweep). The client-side CSV export is real either way and is
   * the one bulk action a live Published tab keeps.
   */
  const syntheticBulkActions =
    status === 'review'
      ? [
          {
            label: intl.formatMessage(m.bulkApprove), icon: CheckCircle,
            onClick: async (sel: Document[]) => {
              const { ready, blocked } = partitionByReadiness(sel, mandatoryFields, intl);
              if (ready.length === 0) {
                await confirm({
                  tone: 'red',
                  title: intl.formatMessage(m.approveNoneTitle),
                  detail: blocked
                    .map(({ doc, reason }) => intl.formatMessage(m.approveNoneItem, { supplier: doc.supplier, reason: reason.toLowerCase() }))
                    .slice(0, 4)
                    .join('. '),
                  confirmLabel: intl.formatMessage(commonActions.close),
                });
                return;
              }
              const suppliers = ready.map((d) => d.supplier).slice(0, 3).join(', ');
              const ok = await confirm({
                title: intl.formatMessage(m.approveTitle, { count: ready.length }),
                detail: ready.length > 3
                  ? intl.formatMessage(m.approveDetailMore, { suppliers, more: ready.length - 3 })
                  : intl.formatMessage(m.approveDetail, { suppliers }),
                consequence: blocked.length
                  ? intl.formatMessage(m.approveConsequenceBlocked, {
                      count: blocked.length,
                      suppliers: blocked.map((b) => b.doc.supplier).join(', '),
                    })
                  : intl.formatMessage(m.approveConsequence),
                confirmLabel: intl.formatMessage(m.approveConfirm),
              });
              if (ok) ready.forEach((d) => updateDocumentStatus(d.id, 'ready'));
            },
          },
          {
            label: intl.formatMessage(m.bulkDelete), icon: Trash2,
            onClick: async (sel: Document[]) => {
              const ok = await confirm({
                tone: 'red',
                title: intl.formatMessage(m.deleteTitle, { count: sel.length }),
                detail: sel.map((d) => intl.formatMessage(m.deleteItem, { supplier: d.supplier, amount: currency(d.total) })).slice(0, 4).join(' · '),
                consequence: intl.formatMessage(m.deleteConsequence),
                confirmLabel: intl.formatMessage(m.deleteConfirm),
              });
              if (ok) deleteDocuments(sel.map((d) => d.id));
            },
          },
        ]
      : status === 'ready'
      ? [
          {
            label: intl.formatMessage(m.bulkBackToReview), icon: RefreshCw,
            onClick: async (sel: Document[]) => {
              const ok = await confirm({
                title: intl.formatMessage(m.backToReviewTitle, { count: sel.length }),
                detail: intl.formatMessage(m.backToReviewDetail),
                confirmLabel: intl.formatMessage(m.backToReviewConfirm),
              });
              if (ok) sel.forEach((d) => updateDocumentStatus(d.id, 'review'));
            },
          },
          { label: intl.formatMessage(m.bulkPublish), icon: Send, primary: true, onClick: publish },
        ]
      : status === 'published'
      ? [
          // Published is the end of the line, so the only actions are getting
          // the data back out — never a silent edit of what the ledger holds.
          { label: intl.formatMessage(commonActions.exportCsv), icon: Download, minSelected: 2, disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel: Document[]) => exportDocuments(sel, client.name) },
          {
            label: intl.formatMessage(m.bulkUnpublish), icon: RefreshCw,
            onClick: async (sel: Document[]) => {
              const ok = await confirm({
                tone: 'red',
                title: intl.formatMessage(m.unpublishTitle, { count: sel.length }),
                detail: intl.formatMessage(m.unpublishDetail),
                consequence: intl.formatMessage(m.unpublishConsequence),
                confirmLabel: intl.formatMessage(m.unpublishConfirm),
              });
              if (ok) sel.forEach((d) => updateDocumentStatus(d.id, 'ready'));
            },
          },
        ]
      : status === 'rejected'
      ? [
          {
            label: intl.formatMessage(commonActions.retry), icon: RefreshCw, primary: true,
            onClick: async (sel: Document[]) => {
              const ok = await confirm({
                title: intl.formatMessage(m.bulkRetryTitle, { count: sel.length }),
                detail: intl.formatMessage(m.bulkRetryDetail),
                confirmLabel: intl.formatMessage(m.bulkRetryConfirm),
              });
              if (ok) sel.forEach((d) => retryDocument(d.id));
            },
          },
          { label: intl.formatMessage(m.bulkEnterManually), icon: MessageSquare, onClick: (sel: Document[]) => sel[0] && openInChat(sel[0]) },
        ]
      : [];

  const bulkActions =
    documentsSource === 'api'
      ? status === 'published'
        ? [{ label: intl.formatMessage(commonActions.exportCsv), icon: Download, minSelected: 2, disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel: Document[]) => exportDocuments(sel, client.name) }]
        : []
      : syntheticBulkActions;

  const s = statsFor(client.id);

  return (
    <div className="flex flex-col gap-5">
      {/* Loading and failure said out loud, like InboxesView (METH S14 sweep):
          seed rows may render underneath — the standing fallback — but never
          silently impersonating the server. */}
      {documentsSource === 'api' && (documentsLoading || documentsError) && (
        <div
          className={`flex items-center gap-3 px-5 py-3 rounded-2xl border text-[13px] font-semibold ${
            documentsError
              ? 'bg-red-500/10 border-red-500/20 text-red-300'
              : 'bg-white/[0.03] border-white/10 text-zinc-400'
          }`}
        >
          <RefreshCw size={15} className={documentsError ? '' : 'animate-spin'} />
          <span className="min-w-0">
            {documentsError
              ? intl.formatMessage(m.documentsError, { error: documentsError })
              : intl.formatMessage(m.documentsLoading)}
          </span>
        </div>
      )}
      {/* Status tabs carry their own counts. Rendered as a recessed segmented
          control so they never read as a second row of client tabs. */}
      <SubTabs
        tabs={STATUSES.map((st) => ({
          key: st,
          label: intl.formatMessage(STATUS_LABEL[st]),
          count: st === 'duplicates' ? clientPairs.length : counts[st],
          alert: (st === 'rejected' && counts.rejected > 0) || (st === 'duplicates' && clientPairs.length > 0),
        }))}
        active={status}
        onChange={(k) => setStatus(k as Status)}
      />

      {status === 'duplicates' ? (
        <div className="flex flex-col gap-3">
          {clientPairs.length === 0 ? (
            <div className="border border-white/5 rounded-[32px] bg-card p-10 text-center shadow-2xl">
              <p className="text-[13px] text-zinc-500 leading-relaxed max-w-md mx-auto">
                {intl.formatMessage(m.duplicatesEmpty)}
              </p>
            </div>
          ) : (
            clientPairs.map((pair) => (
              <button
                key={pair.id}
                onClick={() => setComparing(pair)}
                className="w-full text-left border border-amber-400/20 rounded-[24px] bg-amber-400/[0.05] p-5 hover:border-amber-400/40 transition-colors flex items-center gap-4 flex-wrap"
              >
                <span className="w-10 h-10 rounded-xl bg-amber-400/10 border border-amber-400/25 flex items-center justify-center text-amber-400 shrink-0">
                  <Copy size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-white truncate">
                    {intl.formatMessage(m.duplicatePair, { left: pair.left.label, right: pair.right.label })}
                  </span>
                  <span className="block text-[12px] text-zinc-500 mt-0.5 truncate">
                    {pair.signals.slice(0, 4).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 flex items-center gap-2">
                  {pair.crossType && <Pill tone="blue">{intl.formatMessage(m.duplicateCrossType)}</Pill>}
                  {pair.left.uploader !== pair.right.uploader && <Pill>{intl.formatMessage(m.duplicateDifferentUploaders)}</Pill>}
                  <Pill tone="amber">{intl.formatMessage(m.percent, { percent: Math.round(pair.similarity * 100) })}</Pill>
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
      <DataTable<Document>
        className="max-w-none"
        columns={columns}
        rows={rows}
        rowId={(d) => d.id}
        selectable={status !== 'processing'}
        bulkActions={bulkActions}
        actionsOnTop
        onRowClick={(d) => onPreview(d)}
        toolbar={
          <>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn-soft"
            >
              <Upload size={16} strokeWidth={2.5} />
              {intl.formatMessage(m.uploadAction)}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => { upload(e.target.files); e.target.value = ''; }}
            />
            <input
              ref={replaceRef}
              type="file"
              className="hidden"
              accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf"
              onChange={(e) => { handleReplacement(e.target.files); e.target.value = ''; }}
            />
            <div className="flex items-center gap-1 bg-ground border border-white/5 rounded-full p-1 shadow-inner">
              {SPLIT_MODES.map((mode) => (
                <button
                  key={mode.key}
                  onClick={() => setSplitMode(mode.key)}
                  title={intl.formatMessage(mode.hint)}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
                    splitMode === mode.key ? 'bg-raised text-white' : 'text-zinc-500 hover:text-white'
                  }`}
                >
                  {intl.formatMessage(mode.label)}
                </button>
              ))}
            </div>
          </>
        }
        emptyMessage={intl.formatMessage(
          status === 'processing' ? m.emptyProcessing
            : status === 'review' ? m.emptyReview
            : status === 'ready' ? m.emptyReady
            : status === 'published' ? m.emptyPublished
            : m.emptyRejected,
        )}
        footer={
          status === 'review'
            ? intl.formatMessage(m.footerReview)
            : status === 'ready'
            ? mandatoryFields.length
              ? intl.formatMessage(m.footerReadyPlus, { fields: mandatoryFields.join(', ') })
              : intl.formatMessage(m.footerReady)
            : status === 'published'
            ? intl.formatMessage(m.footerPublished)
            : status === 'rejected'
            ? intl.formatMessage(m.footerRejected)
            : intl.formatMessage(m.footerProcessing, { count: s.processing })
        }
      />
      )}

      {analysing && (
        <AnalysisModal
          docIds={analysing.docIds}
          importIds={analysing.importIds}
          lockedClientId={client.id}
          onClose={(settled) => {
            const importIds = analysing.importIds;
            setAnalysing(null);
            const first = settled[0];
            if (!first) {
              // A spreadsheet lands as rows, not as one document — go to
              // whichever side of the ledger most of them belong to.
              const imported = sheetImports.filter((t) => importIds.includes(t.id));
              const sales = imported.reduce((n, t) => n + t.counts.sales, 0);
              const costs = imported.reduce((n, t) => n + t.counts.cost, 0);
              if (!sales && !costs) return;
              const landedKind = sales > costs ? 'sales' : 'cost';
              if (landedKind !== kind) navigate(path('clients', client.id, landedKind === 'sales' ? 'sales' : 'costs', 'review'));
              else setStatus('review');
              return;
            }
            const landed: Status = first.status === 'ready' ? 'ready' : 'review';
            // The AI may have filed it as the other kind, in which case it is
            // not on this tab at all — go to where it actually is.
            if (first.kind !== kind) {
              navigate(path('clients', client.id, first.kind === 'sales' ? 'sales' : 'costs', landed));
              return;
            }
            setStatus(landed);
          }}
        />
      )}

      {comparing && <DuplicateModal pair={comparing} onClose={() => setComparing(null)} />}
    </div>
  );
}

/** CSV of the selected documents, flattened so the file is useful on its own. */
function exportDocuments(rows: Document[], clientName: string) {
  if (rows.length === 0) return;
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = 'Supplier,Date,Category,Status,Channel,Uploader,Currency,Total\n';
  const body = rows
    .map((d) => [esc(d.supplier), esc(d.date), esc(d.category), esc(d.status), esc(d.source), esc(d.uploader), esc(d.currency), d.total].join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([header + body], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-published.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function RowButton({ icon: Icon, title, onClick, tone = 'plain' }: {
  icon: typeof Eye;
  title: string;
  onClick: () => void;
  tone?: 'plain' | 'amber';
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      aria-label={title}
      className={`p-2 rounded-lg border transition-colors ${
        tone === 'amber'
          ? 'text-amber-400 border-amber-400/20 bg-amber-400/10 hover:bg-amber-400/20'
          : 'text-zinc-400 border-white/5 hover:text-white hover:border-white/20 hover:bg-white/5'
      }`}
    >
      <Icon size={14} />
    </button>
  );
}
