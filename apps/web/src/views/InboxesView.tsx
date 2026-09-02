import { lazy, Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Search, AlertCircle, CheckCircle2, UploadCloud, Eye, PencilLine, X, Copy, Link2,
  ShieldAlert, Sparkles, Send, Trash2, RefreshCw, Download, ArrowRightLeft, Check, SlidersHorizontal,
  LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useQueryClient } from '@tanstack/react-query';
import { commonActions, commonLabels } from '../i18n/common';
import { useAppContext } from '../context/AppContext';
import { refreshDocuments, runWorkspaceDrop } from '../api/uploads';
import { useTourAction } from '../tour/bus';
import { useScrollActiveIntoView } from '../lib/useScrollActiveIntoView';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { Tooltip } from '../components/DynamicComponents/Tooltip';
import { blockedReason, describeMissing, partitionByReadiness, readinessOf } from '../lib/readiness';
import { currency } from '../lib/resolver';
import { missingMandatory, OPTIONAL_MANDATORY } from '../lib/selectors';
import { DuplicateModal } from '../components/DynamicComponents/DuplicateModal';
import { navigate, path, usePath, useQueryParam } from '../lib/router';
import { EXPORT_HINT, EXPORT_MIN_ROWS } from '../lib/exportRules';
import { failureOf, reasonText, retryMeaning } from '../lib/failures';
import { AnalysisModal } from '../components/DynamicComponents/AnalysisModal';
import { ProposalFlowModal } from '../components/DynamicComponents/ProposalFlowModal';
/**
 * The live publish door — see the header of `PublishBatchDialog.tsx`. `lazy()`
 * so the flow's copy stays off this route and shares one chunk with the copy
 * ClientInbox opens (the same dialog, the same refusal, the same wording).
 */
const PublishBatchDialog = lazy(() => import('../components/DynamicComponents/PublishBatchDialog'));
/**
 * `lazy()` for the same reason it is lazy on Bank and Client detail: eagerly it
 * put `DocumentPreview` and its `document-detail` client (~9.6 kB gzip) on this
 * route for a dialog most sessions never open, and this route was over budget.
 * The `Suspense` sits INSIDE the modal frame below, so the overlay, the card
 * shell and the close button paint at once and only the document waits.
 */
const DocumentPreview = lazy(() =>
  import('../components/DynamicComponents/DocumentPreview').then((mod) => ({ default: mod.DocumentPreview })),
);
import type { CreateActionProposalRequest } from '@neoting/contracts/model';
import type { DocKind, DocStatus, Document, DuplicatePair } from '../lib/types';

const STATUS_TABS = ['review', 'ready', 'processing', 'published', 'rejected'] as const;
const INBOXES = ['cost', 'sales'] as const;

type StatusTab = (typeof STATUS_TABS)[number];
type Inbox = (typeof INBOXES)[number] & DocKind;

const m = defineMessages({
  uploadAudit: { id: 'inboxes.inboxesView.uploadAudit', defaultMessage: 'Uploaded documents' },
  uploadAuditScope: {
    id: 'inboxes.inboxesView.uploadAuditScope',
    defaultMessage: '{count} document(s) from {files} file(s)',
  },
  uploadNeedsClientTitle: {
    id: 'inboxes.inboxesView.uploadNeedsClientTitle',
    defaultMessage: 'Choose a client before uploading',
  },
  uploadNeedsClientDetail: {
    id: 'inboxes.inboxesView.uploadNeedsClientDetail',
    defaultMessage:
      'Every document is filed under a named client — pick one in the client filter, or upload from inside that client’s inbox. Guessing at upload time is how paperwork lands in the wrong books.',
  },
  // A practice with no clients cannot "pick one in the client filter" — the
  // filter is empty, and the instruction has to point at the real first step.
  uploadNeedsFirstClientDetail: {
    id: 'inboxes.inboxesView.uploadNeedsFirstClientDetail',
    defaultMessage:
      'Every document is filed under a named client, and this practice has none yet — add your first client under Clients, then upload into their inbox.',
  },
  publishAudit: { id: 'inboxes.inboxesView.publishAudit', defaultMessage: 'Published documents' },
  publishAuditScope: {
    id: 'inboxes.inboxesView.publishAuditScope',
    defaultMessage: '{count} item(s) · {amount} → {clients}',
  },
  retryReadTitle: { id: 'inboxes.inboxesView.retryReadTitle', defaultMessage: 'Read {supplier} again?' },
  retryPublishTitle: { id: 'inboxes.inboxesView.retryPublishTitle', defaultMessage: 'Publish {supplier} again?' },
  retryDetail: { id: 'inboxes.inboxesView.retryDetail', defaultMessage: '{reason}. {meaning}' },
  retryConsequence: {
    id: 'inboxes.inboxesView.retryConsequence',
    defaultMessage: 'This is unlikely to clear it on its own — {fix} is what changes the outcome.',
  },
  retryConfirm: { id: 'inboxes.inboxesView.retryConfirm', defaultMessage: 'Yes, retry' },
  replaceTitle: { id: 'inboxes.inboxesView.replaceTitle', defaultMessage: 'Replace {supplier} with {file}?' },
  replaceUnknownTitle: {
    id: 'inboxes.inboxesView.replaceUnknownTitle',
    defaultMessage: 'Replace this document with {file}?',
  },
  replaceDetail: {
    id: 'inboxes.inboxesView.replaceDetail',
    defaultMessage: 'The new file is read from scratch under the same client.',
  },
  replaceConsequence: {
    id: 'inboxes.inboxesView.replaceConsequence',
    defaultMessage: 'The unreadable original is removed, so the same spend is not on file twice.',
  },
  replaceConfirm: { id: 'inboxes.inboxesView.replaceConfirm', defaultMessage: 'Yes, replace it' },
  replaceAudit: { id: 'inboxes.inboxesView.replaceAudit', defaultMessage: 'Replaced an unreadable document' },
  replaceAuditScope: { id: 'inboxes.inboxesView.replaceAuditScope', defaultMessage: '{file} → {client}' },
  replaceAuditScopeWithNote: {
    id: 'inboxes.inboxesView.replaceAuditScopeWithNote',
    defaultMessage: '{file} → {client} — was: {note}',
  },
  notReadyTitle: { id: 'inboxes.inboxesView.notReadyTitle', defaultMessage: '{supplier} is not ready yet' },
  notReadyDetail: {
    id: 'inboxes.inboxesView.notReadyDetail',
    defaultMessage: '{missing}. Ready means every check has passed, so it cannot move until they are filled in.',
  },
  markReadyTitle: { id: 'inboxes.inboxesView.markReadyTitle', defaultMessage: 'Move {supplier} to Ready?' },
  markReadyDetail: {
    id: 'inboxes.inboxesView.markReadyDetail',
    defaultMessage: '{amount} · {category}. Ready means every check has passed and it is queued to publish.',
  },
  markReadyConfirm: { id: 'inboxes.inboxesView.markReadyConfirm', defaultMessage: 'Yes, mark it Ready' },
  markReviewedAudit: { id: 'inboxes.inboxesView.markReviewedAudit', defaultMessage: 'Marked document reviewed' },
  markReviewedAuditScope: {
    id: 'inboxes.inboxesView.markReviewedAuditScope',
    defaultMessage: '{supplier} · {amount} → Ready',
  },
  heading: { id: 'inboxes.inboxesView.heading', defaultMessage: 'Inboxes' },
  inboxCosts: { id: 'inboxes.inboxesView.inboxCosts', defaultMessage: 'Costs' },
  inboxSales: { id: 'inboxes.inboxesView.inboxSales', defaultMessage: 'Sales' },
  requiredFieldsTitle: {
    id: 'inboxes.inboxesView.requiredFieldsTitle',
    defaultMessage: 'Fields required before publishing',
  },
  requiredFieldsAction: { id: 'inboxes.inboxesView.requiredFieldsAction', defaultMessage: 'Required fields' },
  uploadAction: { id: 'inboxes.inboxesView.uploadAction', defaultMessage: 'Upload Documents' },
  documentsError: { id: 'inboxes.inboxesView.documentsError', defaultMessage: 'Could not load documents — {error}' },
  documentsLoading: {
    id: 'inboxes.inboxesView.documentsLoading',
    defaultMessage: 'Loading documents from the API…',
  },
  tabReview: { id: 'inboxes.inboxesView.tabReview', defaultMessage: 'To Review' },
  tabReady: { id: 'inboxes.inboxesView.tabReady', defaultMessage: 'Ready' },
  tabProcessing: { id: 'inboxes.inboxesView.tabProcessing', defaultMessage: 'Processing' },
  tabPublished: { id: 'inboxes.inboxesView.tabPublished', defaultMessage: 'Published' },
  tabRejected: { id: 'inboxes.inboxesView.tabRejected', defaultMessage: 'Failed' },
  searchPlaceholder: { id: 'inboxes.inboxesView.searchPlaceholder', defaultMessage: 'Search supplier, amount...' },
  filterAllClients: { id: 'inboxes.inboxesView.filterAllClients', defaultMessage: 'All clients' },
  filterAllChannels: { id: 'inboxes.inboxesView.filterAllChannels', defaultMessage: 'All channels' },
  channelEmail: { id: 'inboxes.inboxesView.channelEmail', defaultMessage: 'Email' },
  channelWeb: { id: 'inboxes.inboxesView.channelWeb', defaultMessage: 'Web upload' },
  channelWhatsapp: { id: 'inboxes.inboxesView.channelWhatsapp', defaultMessage: 'WhatsApp' },
  channelSmsLink: { id: 'inboxes.inboxesView.channelSmsLink', defaultMessage: 'Chase link' },
  channelCsv: { id: 'inboxes.inboxesView.channelCsv', defaultMessage: 'CSV / XLSX' },
  channelPortal: { id: 'inboxes.inboxesView.channelPortal', defaultMessage: 'Business portal' },
  rowCount: { id: 'inboxes.inboxesView.rowCount', defaultMessage: '{count} items' },
  publishItemsAction: { id: 'inboxes.inboxesView.publishItemsAction', defaultMessage: 'Publish {count} Items' },
  selectedCount: { id: 'inboxes.inboxesView.selectedCount', defaultMessage: '{count} selected' },
  markReviewedAction: { id: 'inboxes.inboxesView.markReviewedAction', defaultMessage: 'Mark reviewed' },
  markReviewedLiveHint: {
    id: 'inboxes.inboxesView.markReviewedLiveHint',
    defaultMessage: 'Open the document and correct or confirm a field — the change goes through Review → Approve.',
  },
  // ⚠ This used to be a DEAD-END tooltip on a disabled button, pointing at a
  // chat utterance. The button works now, so the hint says what pressing it
  // does — and it still says that nothing is Published without an approval,
  // because that is the part a person needs to know before pressing it.
  publishLiveHint: {
    id: 'inboxes.inboxesView.publishLiveHint',
    defaultMessage:
      'Releasing goes through Review → Approve: this stages the batch and shows the server’s own review. Nothing is Published until it is approved.',
  },
  bulkNoneReadyTitle: { id: 'inboxes.inboxesView.bulkNoneReadyTitle', defaultMessage: 'None of these can move yet' },
  bulkNoneReadyItem: { id: 'inboxes.inboxesView.bulkNoneReadyItem', defaultMessage: '{supplier} — {missing}' },
  bulkMarkReadyTitle: {
    id: 'inboxes.inboxesView.bulkMarkReadyTitle',
    defaultMessage: '{count, plural, one {Move # item to Ready?} other {Move # items to Ready?}}',
  },
  bulkMarkReadyDetail: {
    id: 'inboxes.inboxesView.bulkMarkReadyDetail',
    defaultMessage: 'Ready means every check has passed and they are queued to publish.',
  },
  bulkMarkReadyConsequence: {
    id: 'inboxes.inboxesView.bulkMarkReadyConsequence',
    defaultMessage: '{count} still missing required fields will be left alone: {suppliers}.',
  },
  bulkMarkReadyConfirm: { id: 'inboxes.inboxesView.bulkMarkReadyConfirm', defaultMessage: 'Yes, mark them Ready' },
  bulkMove: { id: 'inboxes.inboxesView.bulkMove', defaultMessage: 'Move to client' },
  moveMenuHeading: { id: 'inboxes.inboxesView.moveMenuHeading', defaultMessage: 'Move to' },
  // The Unrouted card is gone (SoT #158) and routing now happens here, so
  // the two things it said have to be said here or they are lost: which
  // inbox the document lands in, and that assigning one is a state change.
  routeMenuHeading: { id: 'inboxes.inboxesView.routeMenuHeading', defaultMessage: 'Route to client' },
  routeInbox: { id: 'inboxes.inboxesView.routeInbox', defaultMessage: 'Inbox: {inbox}' },
  routeProposalNote: {
    id: 'inboxes.inboxesView.routeProposalNote',
    defaultMessage:
      'Assigning one is a state change — it goes through Review \u2192 Approve like everything else.',
  },
  cardEmpty: {
    id: 'inboxes.inboxesView.cardEmpty',
    defaultMessage: 'Nothing in this view. Upload from the button above to ingest files.',
  },
  cardFieldMissing: {
    id: 'inboxes.inboxesView.cardFieldMissing',
    defaultMessage: 'Missing — required before publishing',
  },
  teachSenderLabel: { id: 'inboxes.inboxesView.teachSenderLabel', defaultMessage: 'Always route this sender here' },
  teachSenderFallback: {
    id: 'inboxes.inboxesView.teachSenderFallback',
    defaultMessage: 'the senders of these documents',
  },
  moveTitle: {
    id: 'inboxes.inboxesView.moveTitle',
    defaultMessage: '{count, plural, one {Move # document to {client}?} other {Move # documents to {client}?}}',
  },
  moveConsequence: {
    id: 'inboxes.inboxesView.moveConsequence',
    defaultMessage: 'Every future document from these senders will be filed under this client automatically.',
  },
  moveConfirm: { id: 'inboxes.inboxesView.moveConfirm', defaultMessage: 'Yes, move them' },
  moveAudit: { id: 'inboxes.inboxesView.moveAudit', defaultMessage: 'Moved documents between entities' },
  moveAuditScope: { id: 'inboxes.inboxesView.moveAuditScope', defaultMessage: '{count} item(s) → {client}' },
  moveAuditScopeTaught: {
    id: 'inboxes.inboxesView.moveAuditScopeTaught',
    defaultMessage: '{count} item(s) → {client} · sender taught',
  },
  addresseeMismatch: {
    id: 'inboxes.inboxesView.addresseeMismatch',
    defaultMessage: 'Addressee differs from the current workspace',
  },
  bulkAskAi: { id: 'inboxes.inboxesView.bulkAskAi', defaultMessage: 'Ask AI' },
  askAiPrompt: { id: 'inboxes.inboxesView.askAiPrompt', defaultMessage: 'Review the {supplier} document' },
  askAiReply: {
    id: 'inboxes.inboxesView.askAiReply',
    defaultMessage: 'Every field shows confidence and provenance — click any value to correct it.',
  },
  publishAction: { id: 'inboxes.inboxesView.publishAction', defaultMessage: 'Publish' },
  bulkRetryTitle: {
    id: 'inboxes.inboxesView.bulkRetryTitle',
    defaultMessage: '{count, plural, one {Retry # failed item?} other {Retry # failed items?}}',
  },
  bulkRetryDetail: {
    id: 'inboxes.inboxesView.bulkRetryDetail',
    defaultMessage:
      'Anything that failed to extract is read again; anything that failed to publish goes back to Ready to be pushed again. Whatever was already read off a document is kept.',
  },
  bulkDelete: { id: 'inboxes.inboxesView.bulkDelete', defaultMessage: 'Delete' },
  deleteTitle: {
    id: 'inboxes.inboxesView.deleteTitle',
    defaultMessage: '{count, plural, one {Delete # document?} other {Delete # documents?}}',
  },
  deleteDetailFallback: { id: 'inboxes.inboxesView.deleteDetailFallback', defaultMessage: 'The selected items.' },
  deleteConsequence: {
    id: 'inboxes.inboxesView.deleteConsequence',
    defaultMessage: 'The originals go with them, and a deleted document cannot be matched to a bank line later.',
  },
  deleteConfirm: { id: 'inboxes.inboxesView.deleteConfirm', defaultMessage: 'Yes, delete' },
  deleteAudit: { id: 'inboxes.inboxesView.deleteAudit', defaultMessage: 'Deleted documents' },
  deleteAuditScope: { id: 'inboxes.inboxesView.deleteAuditScope', defaultMessage: '{count} item(s)' },
  columnCustomer: { id: 'inboxes.inboxesView.columnCustomer', defaultMessage: 'Customer' },
  columnFlags: { id: 'inboxes.inboxesView.columnFlags', defaultMessage: 'Flags' },
  columnAction: { id: 'inboxes.inboxesView.columnAction', defaultMessage: 'Action' },
  emptyTable: {
    id: 'inboxes.inboxesView.emptyTable',
    defaultMessage: 'Nothing in this view. Drop files anywhere on this page to ingest them.',
  },
  fieldRequiredTitle: {
    id: 'inboxes.inboxesView.fieldRequiredTitle',
    defaultMessage: '{field} is required before this can be published',
  },
  fieldMissing: { id: 'inboxes.inboxesView.fieldMissing', defaultMessage: 'Missing' },
  flagDuplicate: { id: 'inboxes.inboxesView.flagDuplicate', defaultMessage: 'Suspected duplicate' },
  flagDuplicateDetail: {
    id: 'inboxes.inboxesView.flagDuplicateDetail',
    defaultMessage: 'Another document on file looks like the same spend. Open them side by side to compare.',
  },
  flagMatched: { id: 'inboxes.inboxesView.flagMatched', defaultMessage: 'Matched to a bank transaction' },
  flagMatchedDetail: {
    id: 'inboxes.inboxesView.flagMatchedDetail',
    defaultMessage: 'The payment for this is on the bank feed, so it is evidenced.',
  },
  cannotPublish: { id: 'inboxes.inboxesView.cannotPublish', defaultMessage: 'Cannot publish — missing {fields}' },
  flagBlockedDetail: {
    id: 'inboxes.inboxesView.flagBlockedDetail',
    defaultMessage: 'Your practice made these fields mandatory before anything is released for export.',
  },
  markReviewedTitle: {
    id: 'inboxes.inboxesView.markReviewedTitle',
    defaultMessage: 'Move to Ready — publish is the next step',
  },
  fixTitle: { id: 'inboxes.inboxesView.fixTitle', defaultMessage: '{reason} — open it to sort that out first.' },
  fixAction: { id: 'inboxes.inboxesView.fixAction', defaultMessage: 'Fix' },
  retryUnlikelyTitle: {
    id: 'inboxes.inboxesView.retryUnlikelyTitle',
    defaultMessage: 'Unlikely to help — {reason}. {meaning}',
  },
  retryChaseInstead: {
    id: 'inboxes.inboxesView.retryChaseInstead',
    defaultMessage:
      'Re-reading the same file is not built yet — re-request it from the client instead: the chase engine (Chases) asks for a fresh copy by email.',
  },
  publishRowTitle: { id: 'inboxes.inboxesView.publishRowTitle', defaultMessage: 'Publish this item' },
  viewTitle: {
    id: 'inboxes.inboxesView.viewTitle',
    defaultMessage: 'Open the document — the original with every extracted field',
  },
  viewAction: { id: 'inboxes.inboxesView.viewAction', defaultMessage: 'View' },
  dropHeading: { id: 'inboxes.inboxesView.dropHeading', defaultMessage: 'Drop to ingest' },
  dropDetail: {
    id: 'inboxes.inboxesView.dropDetail',
    defaultMessage: 'Multi-document PDFs are auto-split · 100MB per file',
  },
  confirmPublishTitle: {
    id: 'inboxes.inboxesView.confirmPublishTitle',
    defaultMessage: '{count, plural, one {Publish # item?} other {Publish # items?}}',
  },
  confirmPublishSubtitle: {
    id: 'inboxes.inboxesView.confirmPublishSubtitle',
    defaultMessage: 'This marks them Published — approved and released for export',
  },
  confirmRowItems: { id: 'inboxes.inboxesView.confirmRowItems', defaultMessage: 'Items' },
  confirmRowValue: { id: 'inboxes.inboxesView.confirmRowValue', defaultMessage: 'Total value' },
  confirmRowClient: { id: 'inboxes.inboxesView.confirmRowClient', defaultMessage: 'Client' },
  confirmRowClients: { id: 'inboxes.inboxesView.confirmRowClients', defaultMessage: 'Clients' },
  clientCount: { id: 'inboxes.inboxesView.clientCount', defaultMessage: '{count} clients' },
  heldBack: {
    id: 'inboxes.inboxesView.heldBack',
    defaultMessage:
      '{count, plural, one {<highlight># item</highlight>} other {<highlight># items</highlight>}} held back — missing required fields. Fix them in the review, or publish the remaining {remaining} now.',
  },
  confirmPublishAction: {
    id: 'inboxes.inboxesView.confirmPublishAction',
    defaultMessage: '{count, plural, one {Publish # item} other {Publish # items}}',
  },
  fieldsHeading: { id: 'inboxes.inboxesView.fieldsHeading', defaultMessage: 'Required before publish' },
  fieldsSubtitle: { id: 'inboxes.inboxesView.fieldsSubtitle', defaultMessage: 'Items missing these are held back' },
  fieldsIntro: {
    id: 'inboxes.inboxesView.fieldsIntro',
    defaultMessage:
      'Supplier, Total and Category are always required. Add more below — construction firms require a class, QBO users require a customer reference.',
  },
  doneAction: { id: 'inboxes.inboxesView.doneAction', defaultMessage: 'Done' },
});

export function InboxesView() {
  const {
    documents, clients, duplicates, transactions, ingest, sheetImports,
    mandatoryFields, setMandatoryFields, ingestRejections, updateDocumentStatus,
    documentsSource, documentsLoading, documentsError,
    moveDocuments, deleteDocuments, retryDocument, startConversation, logAudit, publishDocuments,
    isSameClient, serverClientIdFor,
  } = useAppContext();
  const intl = useIntl();
  const queryClient = useQueryClient();

  /**
   * /inboxes/:inbox/:status — both rows of tabs live in the address.
   *
   * A step is a place: Ready under Costs is where a person works for ten
   * minutes, sends the link to a colleague, and comes back to after opening a
   * document. Held in useState it survived none of that — Back left the screen
   * entirely and a refresh dropped them at To Review.
   */
  const segments = usePath();
  const inbox = (INBOXES.find((i) => i === segments[1]) ?? 'cost') as Inbox;
  const statusTab = (STATUS_TABS.find((st) => st === segments[2]) ?? 'review') as StatusTab;
  // Five status tabs do not fit a phone: the strip scrolls, so the active
  // one is scrolled back into view when a deep link picks a later tab.
  const tabStripRef = useScrollActiveIntoView<HTMLDivElement>(statusTab);

  /** Both tabs move together so a queued pair of calls cannot half-navigate. */
  const goTo = (next: { inbox?: Inbox; status?: StatusTab }) =>
    navigate(path('inboxes', next.inbox ?? inbox, next.status ?? statusTab));
  const setInbox = (next: Inbox) => goTo({ inbox: next });
  const setStatusTab = (next: StatusTab) => goTo({ status: next });
  const [query, setQuery] = useState('');
  const [clientFilter, setClientFilter] = useState<string>('all');
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Document | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [teachSender, setTeachSender] = useState(false);
  /** The upload being read on screen, so the result is shown rather than filed silently. */
  const [analysing, setAnalysing] = useState<{ docIds: string[]; importIds: string[] } | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const confirm = useConfirm();
  const [confirmPublish, setConfirmPublish] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * A live route (SoT #158): the bulk "Move to client" action is where the
   * retired Unrouted card's `document.route` proposal now lives. One proposal
   * per document, walked one at a time, because a proposal names one document
   * and routing is a state change like any other — Review → Approve, never a
   * local write. Held in state so the modal's `request` stays referentially
   * stable across renders.
   */
  const [routing, setRouting] = useState<
    { request: CreateActionProposalRequest; clientId: string; clientName: string; remaining: string[] } | null
  >(null);
  /** The failed document a replacement file is being chosen for, if any. */
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<Document | null>(null);
  /**
   * A live publish retry (METH Stage 12): a NEW `publish.batch` proposal over
   * the one failed document — Stage 10's retry path. Held in state so the
   * modal's request object stays referentially stable.
   */
  const [publishRetry, setPublishRetry] = useState<{ request: CreateActionProposalRequest; clientName: string } | null>(null);
  /**
   * A live release being staged over a selection (`PublishBatchDialog`). The
   * DOCUMENTS, not their ids: the dialog computes its own refusal and its own
   * per-client batching, and a practice-wide selection can legitimately span
   * several clients — one `publish.batch` names one business, so the dialog
   * walks them one at a time, the `document.route` idiom above.
   */
  const [publishing, setPublishing] = useState<Document[] | null>(null);

  const openPublishRetry = (doc: Document) => {
    setPublishRetry({
      request: {
        kind: 'publish.batch',
        businessId: doc.clientId,
        payload: {
          documentIds: [doc.id],
          integrationId: null,
          // The shape requires a preview; the SERVER recomputes and stores its
          // own at creation, and Read-review renders that one (METH S10).
          preview: { itemCount: 1, grossPence: 0, vatPence: 0 },
        },
      },
      clientName: doc.clientName,
    });
  };

  /**
   * The pair each flagged document belongs to, not just the fact that it is
   * flagged. A duplicate warning that cannot show you the other copy asks the
   * accountant to go and find it themselves, which is the whole job.
   */
  const pairFor = useMemo(() => {
    const map = new Map<string, DuplicatePair>();
    duplicates.forEach((p) => { map.set(p.left.id, p); map.set(p.right.id, p); });
    return map;
  }, [duplicates]);

  // In the URL, so a compare can be linked to and Back closes it.
  const [comparingId, setComparingId] = useQueryParam('compare');
  const comparing = comparingId ? duplicates.find((p) => p.id === comparingId) ?? null : null;
  const setComparing = (pair: DuplicatePair | null) => setComparingId(pair ? pair.id : null);

  const matchedIds = useMemo(
    () => new Set(transactions.filter((t) => t.matchedDocId).map((t) => t.matchedDocId!)),
    [transactions],
  );

  /**
   * Unrouted documents (METH Stage 12): the contract projects "no business
   * yet" as an empty `businessId`, which the mapper passes through as an
   * empty `clientId`. They used to be held back for a separate Unrouted card;
   * that card is gone (SoT #158), so they list here like any other document
   * and are routed through the bulk "Move to client" action — which in live
   * mode opens a `document.route` proposal. Holding them back now would leave
   * live mode with no way to route anything at all. In synthetic mode no
   * document carries an empty client id, so this reads the same as before.
   */
  // `clientId !== ''` is not redundant with the kind filter: a document the
  // routing ladder could not address has no client, and the inbox is a
  // per-client working queue. Dropping it (as the port briefly did) lists
  // unrouted documents with an empty client column in live mode. D45 removed
  // the Unrouted QUEUE; it did not make an unaddressed document a normal inbox
  // row. It is held back until a `document.route` proposal gives it a client.
  const inKind = useMemo(
    () => documents.filter((d) => d.kind === inbox && d.clientId !== ''),
    [documents, inbox],
  );

  /** Everything the filters allow, before the status tab narrows it further. */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inKind.filter((d) => {
      // Tolerant of both id worlds (METH S14 bridge): server rows carry
      // opaque business ids, the filter options still key by seed id.
      if (clientFilter !== 'all' && !isSameClient(d.clientId, clientFilter)) return false;
      if (channelFilter !== 'all' && d.source !== channelFilter) return false;
      if (q && !`${d.supplier} ${d.clientName} ${d.category} ${d.total}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [inKind, clientFilter, channelFilter, query, isSameClient]);

  const rows = useMemo(() => filtered.filter((d) => d.status === statusTab), [filtered, statusTab]);

  // The demo tour opens the first document and asks to publish; every step
  // change fires `tour:reset`, which closes whatever the tour opened.
  useTourAction('inboxes:open-preview', useCallback(() => { if (rows[0]) setPreview(rows[0]); }, [rows]));
  // ⚠ The live guard is on the BUTTONS (the row action, the header publish and
  // the bulk bar all carry a `documentsSource === 'api'` check), not inside
  // requestPublish — which needs none, because it is only reachable from them.
  // A tour action reaches setConfirmPublish without passing any of them, so the
  // guard has to be restated here or the tour can drive a publish on live data
  // that the product itself refuses. A demo surface must not be able to reach a
  // path the product gates.
  useTourAction('inboxes:request-publish', useCallback(() => {
    if (documentsSource === 'api') return;
    if (rows.length) setConfirmPublish(rows.map((d) => d.id));
  }, [rows, documentsSource]));
  useTourAction('tour:reset', useCallback(() => { setPreview(null); setConfirmPublish(null); setFieldsOpen(false); }, []));

  /**
   * One `document.route` proposal per document, walked one at a time. The
   * inbox is the one being looked at, so the routed document lands where the
   * person doing the routing is already standing.
   */
  const routeRequestFor = (documentId: string, clientId: string): CreateActionProposalRequest => ({
    kind: 'document.route',
    businessId: null,
    payload: {
      documentId,
      inbox: inbox === 'sales' ? 'SALES' : 'COSTS',
      toBusinessId: serverClientIdFor(clientId),
    },
  });

  const startRouting = (clientId: string, ids: string[]) => {
    const [head, ...remaining] = ids;
    const client = clients.find((c) => c.id === clientId);
    if (!head || !client) return;
    setRouting({ request: routeRequestFor(head, clientId), clientId, clientName: client.name, remaining });
  };

  /** Decided or dismissed — move to the next selected document, or finish. */
  const advanceRouting = () => {
    setRouting((prev) => {
      if (!prev) return null;
      const [head, ...remaining] = prev.remaining;
      if (!head) return null;
      return { ...prev, request: routeRequestFor(head, prev.clientId), remaining };
    });
  };

  // Tab counts track the active filters so they always agree with the table.
  const counts = (s: DocStatus) => filtered.filter((d) => d.status === s).length;

  const selectedDocs = documents.filter((d) => selected.includes(d.id));
  const allSelected = rows.length > 0 && rows.every((d) => selected.includes(d.id));

  /**
   * The real upload journey (METH S7): intent → presigned PUT → complete, one
   * document per file (`api/uploads.ts`), then the Processing tab watches the
   * pipeline move it.
   *
   * The API requires a named workspace per document (guessing at ingest time
   * is the misrouting this product exists to fix), so an upload with no client
   * filter chosen is refused with instructions, not routed somewhere hopeful.
   */
  const uploadLive = async (files: File[]) => {
    if (clientFilter === 'all') {
      await confirm({
        tone: 'red',
        title: intl.formatMessage(m.uploadNeedsClientTitle),
        detail: intl.formatMessage(clients.length === 0 ? m.uploadNeedsFirstClientDetail : m.uploadNeedsClientDetail),
        confirmLabel: intl.formatMessage(commonActions.close),
      });
      return;
    }
    goTo({ inbox: 'cost', status: 'processing' });

    const { sent } = await runWorkspaceDrop(intl, confirm, serverClientIdFor(clientFilter), files);
    void refreshDocuments(queryClient);

    logAudit({
      action: intl.formatMessage(m.uploadAudit),
      scope: intl.formatMessage(m.uploadAuditScope, { count: sent, files: files.length }),
      reviewOpened: true,
    });
  };

  const handleFiles = (files: FileList | null) => {
    if (!files?.length) return;
    if (documentsSource === 'api') {
      void uploadLive(Array.from(files));
      return;
    }
    const list = Array.from(files).map((f) => ({ name: f.name, size: f.size, raw: f }));
    const result = ingest(list, clientFilter === 'all' ? undefined : clientFilter, 'web');

    if (result.documents.length || result.imports.length) {
      setAnalysing({ docIds: result.documents.map((d) => d.id), importIds: result.imports.map((t) => t.id) });
    }

    logAudit({
      action: intl.formatMessage(m.uploadAudit),
      scope: intl.formatMessage(m.uploadAuditScope, { count: result.documents.length, files: list.length }),
      reviewOpened: true,
    });
    goTo({ inbox: 'cost', status: 'processing' });
  };

  /** Publishing is irreversible, so every entry point routes through the confirmation modal. */
  const requestPublish = (ids: string[]) => {
    if (ids.length) setConfirmPublish(ids);
  };

  /** Publishes right here in the dashboard — items missing required fields stay in Ready. */
  const publishConfirmed = () => {
    if (!confirmPublish?.length) return;
    const docs = documents.filter((d) => confirmPublish.includes(d.id));
    const publishable = docs.filter((d) => missingMandatory(d, mandatoryFields).length === 0);
    if (!publishable.length) return;
    publishDocuments(publishable.map((d) => d.id));
    const names = [...new Set(publishable.map((d) => d.clientName))];
    logAudit({
      action: intl.formatMessage(m.publishAudit),
      scope: intl.formatMessage(m.publishAuditScope, {
        count: publishable.length,
        amount: currency(publishable.reduce((s, d) => s + d.total, 0)),
        clients: names.join(', '),
      }),
      reviewOpened: true,
    });
    setConfirmPublish(null);
    setSelected([]);
    setStatusTab('published');
  };

  /**
   * Retry, with the confirmation saying what it will actually do — the two
   * stages behave differently and one of them overwrites what was read.
   */
  const askRetry = async (doc: Document) => {
    const failure = failureOf(doc);
    if (!failure) return;
    const ok = await confirm({
      title: intl.formatMessage(failure.stage === 'extraction' ? m.retryReadTitle : m.retryPublishTitle, {
        supplier: doc.supplier,
      }),
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
    if (!ok) return;
    retryDocument(doc.id);
  };

  /** The cause's own way out, which is a different thing in each case. */
  const runFix = (doc: Document) => {
    const failure = failureOf(doc);
    if (!failure) return;
    if (failure.fix === 'open-document') { setPreview(doc); return; }
    if (failure.fix === 'replace-file') { setReplacing(doc); replaceRef.current?.click(); }
  };

  /**
   * A replacement comes in under the same client and the unreadable original
   * goes — leaving both would put the same spend on file twice, which is the
   * problem the deduplicator exists to catch.
   */
  const handleReplacement = async (files: FileList | null) => {
    const doc = replacing;
    setReplacing(null);
    // Reading the file first says what the length check was really asserting:
    // a replacement is exactly one file, and there is nothing to do without it.
    const file = files?.[0];
    if (!doc || !file) return;
    const ok = await confirm({
      title:
        doc.supplier === 'Unknown'
          ? intl.formatMessage(m.replaceUnknownTitle, { file: file.name })
          : intl.formatMessage(m.replaceTitle, { supplier: doc.supplier, file: file.name }),
      detail: intl.formatMessage(m.replaceDetail),
      consequence: intl.formatMessage(m.replaceConsequence),
      confirmLabel: intl.formatMessage(m.replaceConfirm),
    });
    if (!ok) return;
    ingest([{ name: file.name, size: file.size }], doc.clientId, 'web');
    deleteDocuments([doc.id]);
    logAudit({
      action: intl.formatMessage(m.replaceAudit),
      scope: intl.formatMessage(doc.statusNote ? m.replaceAuditScopeWithNote : m.replaceAuditScope, {
        file: file.name,
        client: doc.clientName,
        note: doc.statusNote,
      }),
      reviewOpened: true,
    });
    goTo({ status: 'processing' });
  };

  // Selections don't carry across tabs — bulk actions must never touch rows the user can't see.
  const switchTab = (t: StatusTab) => {
    setStatusTab(t);
    setSelected([]);
  };

  const markReviewed = async (doc: Document) => {
    const { ready, missing } = readinessOf(doc, mandatoryFields);
    if (!ready) {
      await confirm({
        tone: 'red',
        title: intl.formatMessage(m.notReadyTitle, { supplier: doc.supplier }),
        detail: intl.formatMessage(m.notReadyDetail, { missing: describeMissing(missing) }),
        confirmLabel: intl.formatMessage(commonActions.close),
      });
      return;
    }
    const ok = await confirm({
      title: intl.formatMessage(m.markReadyTitle, { supplier: doc.supplier }),
      detail: intl.formatMessage(m.markReadyDetail, { amount: currency(doc.total, doc.currency), category: doc.category }),
      confirmLabel: intl.formatMessage(m.markReadyConfirm),
    });
    if (!ok) return;
    updateDocumentStatus(doc.id, 'ready');
    logAudit({
      action: intl.formatMessage(m.markReviewedAudit),
      scope: intl.formatMessage(m.markReviewedAuditScope, { supplier: doc.supplier, amount: currency(doc.total, doc.currency) }),
      reviewOpened: true,
    });
  };

  /** Selection is a toggle in three places now — card, checkbox, row. */
  const toggleSelected = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /**
   * The flags and the verbs, lifted out of the table cells so the phone cards
   * below render exactly the same ones. A phone offering fewer actions than a
   * desktop is how the Action column came to be off-screen in the first place.
   */
  const renderFlags = (doc: Document, blocked: string[]) => (
              <span className="flex items-center gap-1.5">
                {pairFor.has(doc.id) && (
                  <FlagIcon
                    icon={Copy}
                    tone="amber"
                    title={intl.formatMessage(m.flagDuplicate)}
                    detail={intl.formatMessage(m.flagDuplicateDetail)}
                    onClick={() => setComparing(pairFor.get(doc.id)!)}
                  />
                )}
                {matchedIds.has(doc.id) && (
                  <FlagIcon
                    icon={Link2}
                    tone="blue"
                    title={intl.formatMessage(m.flagMatched)}
                    detail={intl.formatMessage(m.flagMatchedDetail)}
                  />
                )}
                {doc.status === 'ready' && blocked.length > 0 && (
                  <FlagIcon
                    icon={ShieldAlert}
                    tone="red"
                    title={intl.formatMessage(m.cannotPublish, { fields: blocked.join(', ') })}
                    detail={intl.formatMessage(m.flagBlockedDetail)}
                  />
                )}
              </span>
  );

  const renderActions = (doc: Document, blocked: string[]) => (
              <div className="flex items-center justify-end gap-2">
                {/* A document with anything outstanding is offered
                    the fix, not the move — moving it on is what we
                    are trying to stop until it is sorted. */}
                {doc.status === 'review' && (() => {
                  const verdict = readinessOf(doc, mandatoryFields);
                  // Live, the review happens inside the document
                  // via a proposal — the local flip would revert
                  // under the poll. Disabled-with-tooltip, the
                  // house pattern (METH S14 sweep).
                  const live = documentsSource === 'api';
                  return verdict.ready ? (
                    <button
                      aria-disabled={live}
                      onClick={(e) => { e.stopPropagation(); if (live) return; markReviewed(doc); }}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
                        live
                          ? 'text-zinc-500 border border-white/10 cursor-not-allowed'
                          : 'bg-raised text-zinc-300 hover:bg-brand hover:text-brand-on'
                      }`}
                      title={intl.formatMessage(live ? m.markReviewedLiveHint : m.markReviewedTitle)}
                    >
                      <CheckCircle2 size={14} />
                      {intl.formatMessage(m.markReviewedAction)}
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setPreview(doc); }}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors"
                      title={intl.formatMessage(m.fixTitle, { reason: blockedReason(verdict, intl) })}
                    >
                      <PencilLine size={14} />
                      {intl.formatMessage(m.fixAction)}
                    </button>
                  );
                })()}
                {/* A failed row used to offer nothing but View.
                    It now offers whatever actually clears this
                    failure, with Retry beside it — and Retry says
                    so when it cannot help. */}
                {doc.status === 'rejected' && (() => {
                  const failure = failureOf(doc);
                  if (!failure) return null;
                  const live = documentsSource === 'api';
                  /**
                   * Live mode wires exactly what is real (METH
                   * S12): a publish failure retries through a NEW
                   * `publish.batch` proposal; an extraction
                   * failure has no reprocess executor yet, so its
                   * Retry explains that the chase engine — not a
                   * re-read — is what gets a fresh copy. The
                   * replace-file fix stays synthetic-only: its
                   * delete-and-reingest writes local state a poll
                   * would silently revert.
                   */
                  const liveExtraction = live && failure.stage === 'extraction';
                  return (
                    <>
                      {failure.fix !== 'retry' && !(live && failure.fix === 'replace-file') && (
                        <button
                          onClick={(e) => { e.stopPropagation(); runFix(doc); }}
                          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors"
                          title={intl.formatMessage(failure.detail)}
                        >
                          {failure.fix === 'replace-file' ? <UploadCloud size={14} /> : <PencilLine size={14} />}
                          {intl.formatMessage(failure.fixLabel)}
                        </button>
                      )}
                      <button
                        aria-disabled={liveExtraction}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (liveExtraction) return;
                          if (live) { openPublishRetry(doc); return; }
                          void askRetry(doc);
                        }}
                        className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
                          liveExtraction
                            ? 'text-zinc-500 border border-white/10 cursor-not-allowed'
                            : failure.retryHelps
                              ? 'bg-raised text-zinc-300 hover:bg-brand hover:text-brand-on'
                              : 'text-zinc-400 border border-white/10 hover:text-white'
                        }`}
                        title={
                          liveExtraction
                            ? intl.formatMessage(m.retryChaseInstead)
                            : failure.retryHelps
                              ? intl.formatMessage(retryMeaning(failure))
                              : intl.formatMessage(m.retryUnlikelyTitle, {
                                  reason: reasonText(failure, intl).toLowerCase(),
                                  meaning: intl.formatMessage(retryMeaning(failure)),
                                })
                        }
                      >
                        <RefreshCw size={13} />
                        {intl.formatMessage(commonActions.retry)}
                      </button>
                    </>
                  );
                })()}
                {doc.status === 'ready' && (
                  <button
                    // One document is a legitimate release. Live it stages a
                    // one-item `publish.batch` through the same dialog the bulk
                    // bar opens, so the row and the bar cannot disagree about
                    // what publishing means.
                    onClick={(e) => {
                      e.stopPropagation();
                      if (documentsSource === 'api') { setPublishing([doc]); return; }
                      requestPublish([doc.id]);
                    }}
                    disabled={blocked.length > 0}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold bg-brand text-brand-on hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title={
                      documentsSource === 'api'
                        ? intl.formatMessage(m.publishLiveHint)
                        : blocked.length
                          ? intl.formatMessage(m.cannotPublish, { fields: blocked.join(', ') })
                          : intl.formatMessage(m.publishRowTitle)
                    }
                  >
                    <Send size={13} />
                    {intl.formatMessage(m.publishAction)}
                  </button>
                )}
                {/* An eye, not an overflow menu: this opens the
                    document, it does not reveal more actions. It
                    also stays visible rather than appearing on
                    hover — a control you cannot see is one nobody
                    knows is there. */}
                <button
                  onClick={(e) => { e.stopPropagation(); setPreview(doc); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 border border-white/10 hover:text-white hover:border-white/20 transition-colors"
                  title={intl.formatMessage(m.viewTitle)}
                >
                  <Eye size={14} />
                  {intl.formatMessage(m.viewAction)}
                </button>
              </div>
  );

  return (
    <div
      className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-y-auto relative [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
    >
      <header className="px-4 md:px-10 py-4 md:py-8 shrink-0 flex flex-col items-center">
        <div className="flex items-center justify-between w-full mb-6 gap-4 flex-wrap">
          <div className="flex items-center gap-5">
            <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
            <div className="flex items-center gap-2">
              <InboxPill active={inbox === 'cost'} onClick={() => { setInbox('cost'); setSelected([]); }} label={intl.formatMessage(m.inboxCosts)} />
              <InboxPill active={inbox === 'sales'} onClick={() => { setInbox('sales'); setSelected([]); }} label={intl.formatMessage(m.inboxSales)} />
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              data-tour="inboxes-required-fields"
              onClick={() => setFieldsOpen(true)}
              className="flex items-center gap-2 px-5 py-3 text-sm font-bold text-zinc-300 bg-card border border-white/10 rounded-full hover:bg-white/5 shadow-lg transition-all"
              title={intl.formatMessage(m.requiredFieldsTitle)}
            >
              <SlidersHorizontal size={16} />
              {intl.formatMessage(m.requiredFieldsAction)}
              {mandatoryFields.length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-brand text-brand-on text-[11px]">{mandatoryFields.length}</span>
              )}
            </button>
            <button
              data-tour="inboxes-upload"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-6 py-3 text-sm font-bold text-white bg-card border border-white/10 rounded-full hover:bg-white/5 shadow-lg transition-all"
            >
              <UploadCloud size={18} />
              {intl.formatMessage(m.uploadAction)}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf,.zip,.csv,.xlsx"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
            />
            {/* Separate input: a replacement is one file for one document, not
                a bulk upload, and it must not fall into handleFiles. */}
            <input
              ref={replaceRef}
              type="file"
              className="hidden"
              accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf"
              onChange={(e) => { handleReplacement(e.target.files); e.target.value = ''; }}
            />
          </div>
        </div>

        {/* Where these rows came from. Silent on seed data — it is only worth
            saying when the answer is the API, because then "empty inbox" and
            "the request failed" look identical and are not. */}
        {documentsSource === 'api' && (documentsLoading || documentsError) && (
          <div
            className={`w-full mb-4 flex items-center gap-3 px-5 py-3 rounded-2xl border text-[13px] ${
              documentsError
                ? 'bg-red-500/10 border-red-500/20 text-red-300'
                : 'bg-white/[0.03] border-white/10 text-zinc-400'
            }`}
          >
            {documentsError ? <AlertCircle size={15} /> : <RefreshCw size={15} className="animate-spin" />}
            <span className="min-w-0">
              {documentsError
                ? intl.formatMessage(m.documentsError, { error: documentsError })
                : intl.formatMessage(m.documentsLoading)}
            </span>
          </div>
        )}

        {ingestRejections.length > 0 && (
          <div className="w-full mb-4 flex flex-col gap-2">
            {ingestRejections.slice(0, 3).map((r, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-[13px] text-red-300">
                <ShieldAlert size={16} className="shrink-0" />
                <span className="font-bold">{r.fileName}</span>
                <span className="text-red-300/70">{r.reason}</span>
                <span className="ml-auto text-red-300/50 text-[11px] font-semibold">{r.at}</span>
              </div>
            ))}
          </div>
        )}

        {(
          <div ref={tabStripRef} data-tour="inboxes-tabs" className="flex items-center gap-2 bg-card p-1.5 rounded-full border border-white/5 shadow-2xl relative z-10 md:-mb-16 max-w-full scroll-x [&>button]:shrink-0">
            <TabButton active={statusTab === 'review'} onClick={() => switchTab('review')} label={intl.formatMessage(m.tabReview)} count={counts('review')} />
            <TabButton active={statusTab === 'ready'} onClick={() => switchTab('ready')} label={intl.formatMessage(m.tabReady)} count={counts('ready')} />
            <TabButton active={statusTab === 'processing'} onClick={() => switchTab('processing')} label={intl.formatMessage(m.tabProcessing)} count={counts('processing')} />
            <TabButton active={statusTab === 'published'} onClick={() => switchTab('published')} label={intl.formatMessage(m.tabPublished)} count={counts('published')} />
            <TabButton active={statusTab === 'rejected'} onClick={() => switchTab('rejected')} label={intl.formatMessage(m.tabRejected)} count={counts('rejected')} />
          </div>
        )}
      </header>

      {/* ⚠ This one element owned the whole bug. It was a hardcoded white
          surface, which is the same colour in BOTH themes, so in dark mode the
          shell went dark and the entire middle of the screen stayed light —
          and every control inside it had been coloured for that light ground
          (zinc-100 fills, zinc-200 hairlines, zinc-900 ink). `bg-card` follows
          the theme, which is what the rest of this file now assumes. Nothing
          under here may reintroduce a fixed light surface. */}
      <div className="flex-1 bg-card rounded-t-[28px] md:rounded-t-[40px] m-2 md:m-4 mt-4 md:mt-8 pt-6 md:pt-16 p-3 md:p-8 shadow-2xl flex flex-col overflow-hidden border border-white/10">
        {(
          <>
            <div className="flex items-center justify-between shrink-0 mb-6 px-2 gap-4 flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="relative w-full sm:w-auto">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={intl.formatMessage(m.searchPlaceholder)}
                    className="w-full sm:w-64 bg-raised border-none rounded-full py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-brand transition-all placeholder:text-zinc-500 font-medium"
                  />
                </div>
                <LightSelect value={clientFilter} onChange={setClientFilter} options={[{ value: 'all', label: intl.formatMessage(m.filterAllClients) }, ...clients.map((c) => ({ value: c.id, label: c.name }))]} />
                <LightSelect
                  value={channelFilter}
                  onChange={setChannelFilter}
                  options={[
                    { value: 'all', label: intl.formatMessage(m.filterAllChannels) },
                    { value: 'email', label: intl.formatMessage(m.channelEmail) },
                    { value: 'web', label: intl.formatMessage(m.channelWeb) },
                    { value: 'whatsapp', label: intl.formatMessage(m.channelWhatsapp) },
                    { value: 'sms-link', label: intl.formatMessage(m.channelSmsLink) },
                    { value: 'csv', label: intl.formatMessage(m.channelCsv) },
                    { value: 'portal', label: intl.formatMessage(m.channelPortal) },
                  ]}
                />
              </div>

              <div className="flex items-center gap-3">
                <span className="text-[13px] font-bold text-zinc-400">{intl.formatMessage(m.rowCount, { count: rows.length })}</span>
                {/* Live publishing is a `publish.batch` proposal (METH S10),
                    which is now a door rather than a tooltip: the S14 sweep was
                    right that the LOCAL publish fakes a success the next poll
                    reverts, but disabling it left no way to reach Published —
                    and Published is what `ExportView` exports. Live it opens
                    `PublishBatchDialog` (stage → Read review → Approve);
                    synthetic keeps `requestPublish` unchanged. */}
                <button
                  onClick={() =>
                    documentsSource === 'api'
                      ? setPublishing(selected.length ? selectedDocs : rows)
                      : requestPublish(selected.length ? selected : rows.map((d) => d.id))
                  }
                  disabled={statusTab !== 'ready' || rows.length === 0}
                  title={documentsSource === 'api' ? intl.formatMessage(m.publishLiveHint) : undefined}
                  className="px-6 py-2.5 text-sm font-bold text-brand-on bg-brand hover:bg-brand-hover rounded-full transition-all shadow-md disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {intl.formatMessage(m.publishItemsAction, { count: selected.length ? selected.length : rows.length })}
                </button>
              </div>
            </div>

            <AnimatePresence>
              {selected.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -8, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: 'auto' }}
                  exit={{ opacity: 0, y: -8, height: 0 }}
                  className="shrink-0 mb-5 mx-2 overflow-visible"
                >
                  <div className="flex items-center gap-2 flex-wrap bg-raised/50 rounded-2xl px-4 py-3">
                    <span className="text-[13px] font-bold text-zinc-300 mr-2">{intl.formatMessage(m.selectedCount, { count: selected.length })}</span>
                    {/* Live review happens inside the document via a
                        `document.update-coding` proposal; a bulk local flip
                        would revert under the poll (METH S14 sweep). */}
                    {statusTab === 'review' && documentsSource !== 'api' && (
                      <BulkBtn
                        icon={CheckCircle2}
                        label={intl.formatMessage(m.markReviewedAction)}
                        onClick={async () => {
                          const { ready, blocked } = partitionByReadiness(selectedDocs, mandatoryFields, intl);
                          if (ready.length === 0) {
                            await confirm({
                              tone: 'red',
                              title: intl.formatMessage(m.bulkNoneReadyTitle),
                              detail: blocked
                                .map(({ doc, missing }) =>
                                  intl.formatMessage(m.bulkNoneReadyItem, {
                                    supplier: doc.supplier,
                                    missing: describeMissing(missing).toLowerCase(),
                                  }),
                                )
                                .slice(0, 4)
                                .join('. '),
                              confirmLabel: intl.formatMessage(commonActions.close),
                            });
                            return;
                          }
                          const ok = await confirm({
                            title: intl.formatMessage(m.bulkMarkReadyTitle, { count: ready.length }),
                            detail: intl.formatMessage(m.bulkMarkReadyDetail),
                            ...(blocked.length
                              ? {
                                  consequence: intl.formatMessage(m.bulkMarkReadyConsequence, {
                                    count: blocked.length,
                                    suppliers: blocked.map((b) => b.doc.supplier).join(', '),
                                  }),
                                }
                              : {}),
                            confirmLabel: intl.formatMessage(m.bulkMarkReadyConfirm),
                          });
                          if (!ok) return;
                          ready.forEach((d) => updateDocumentStatus(d.id, 'ready'));
                          setSelected([]);
                        }}
                      />
                    )}
                    {/* Routing lives here now that the Unrouted card is gone
                        (SoT #158). On seed data this is the local move it has
                        always been; against the API it opens a
                        `document.route` proposal per document, which lands
                        through Review → Approve like everything else — never a
                        local write that the next poll would revert. */}
                    <div className="relative">
                      <BulkBtn icon={ArrowRightLeft} label={intl.formatMessage(m.bulkMove)} onClick={() => setMoveOpen((o) => !o)} />
                      <AnimatePresence>
                        {moveOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: -6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6 }}
                            className="absolute top-full left-0 mt-2 w-72 bg-card border border-white/10 rounded-2xl shadow-2xl z-50 p-2"
                          >
                            <div className="px-3 py-2 text-[11px] font-bold text-zinc-400 uppercase tracking-widest">
                              {intl.formatMessage(documentsSource === 'api' ? m.routeMenuHeading : m.moveMenuHeading)}
                            </div>
                            {documentsSource === 'api' && (
                              <div className="px-3 pb-2 flex flex-col gap-1">
                                <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-widest">
                                  {intl.formatMessage(m.routeInbox, {
                                    inbox: intl.formatMessage(inbox === 'sales' ? m.inboxSales : m.inboxCosts),
                                  })}
                                </span>
                                <span className="text-[11px] font-medium text-zinc-500 leading-snug">
                                  {intl.formatMessage(m.routeProposalNote)}
                                </span>
                              </div>
                            )}
                            {/* The taught-sender tick from the old unrouted
                                card, kept where the routing decision now
                                happens: correcting an addressee once should
                                mean never correcting it again.

                                ⚠ SYNTHETIC MODE ONLY, and the gate is the whole
                                point. The live branch below resets teachSender
                                and calls startRouting() without it — there is no
                                sender-rule endpoint in the contract yet, so the
                                intent has nowhere to go. Rendering the tick in
                                api mode told an accountant a rule had been
                                taught when nothing was written and nothing was
                                audited; the next email from that sender arrives
                                misrouted again. Ungating this needs a
                                contract-change issue for the rule, not a UI
                                edit. On origin/main the whole menu was gated,
                                which is why this never shipped before. */}
                            {documentsSource !== 'api' && (
                            <label className="flex items-start gap-2 px-3 py-2 mb-1 rounded-xl cursor-pointer hover:bg-white/5">
                              <input
                                type="checkbox"
                                checked={teachSender}
                                onChange={(e) => setTeachSender(e.target.checked)}
                                className="mt-0.5 accent-brand"
                              />
                              <span className="text-[12px] font-semibold text-zinc-300 leading-snug">
                                {intl.formatMessage(m.teachSenderLabel)}
                                <span className="block text-[11px] font-medium text-zinc-400">
                                  {[...new Set(selectedDocs.map((d) => d.uploader))].slice(0, 2).join(', ') || intl.formatMessage(m.teachSenderFallback)}
                                </span>
                              </span>
                            </label>
                            )}
                            {clients.map((c) => {
                              const mismatch = selectedDocs.some((d) => d.clientName !== c.name);
                              return (
                                <button
                                  key={c.id}
                                  onClick={async () => {
                                    if (documentsSource === 'api') {
                                      // Review → Approve is the confirmation;
                                      // a second local dialog in front of it
                                      // would only be theatre.
                                      const ids = [...selected];
                                      setMoveOpen(false);
                                      setTeachSender(false);
                                      setSelected([]);
                                      startRouting(c.id, ids);
                                      return;
                                    }
                                    const ok = await confirm({
                                      title: intl.formatMessage(m.moveTitle, { count: selected.length, client: c.name }),
                                      detail: selectedDocs.map((d) => d.supplier).slice(0, 4).join(' · '),
                                      ...(teachSender
                                        ? { consequence: intl.formatMessage(m.moveConsequence) }
                                        : {}),
                                      confirmLabel: intl.formatMessage(m.moveConfirm),
                                    });
                                    if (!ok) return;
                                    moveDocuments(selected, c.id, teachSender);
                                    logAudit({
                                      action: intl.formatMessage(m.moveAudit),
                                      scope: intl.formatMessage(teachSender ? m.moveAuditScopeTaught : m.moveAuditScope, {
                                        count: selected.length,
                                        client: c.name,
                                      }),
                                      reviewOpened: true,
                                    });
                                    setMoveOpen(false);
                                    setTeachSender(false);
                                    setSelected([]);
                                  }}
                                  className="w-full px-3 py-2.5 rounded-xl text-left text-[13px] font-semibold text-zinc-300 hover:bg-white/5 transition-colors"
                                >
                                  {c.name}
                                  {mismatch && (
                                    <span className="block text-[11px] font-medium text-amber-600 mt-0.5">
                                      {intl.formatMessage(m.addresseeMismatch)}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <BulkBtn icon={Sparkles} label={intl.formatMessage(m.bulkAskAi)} onClick={() => {
                      // The bar only renders with a selection, but the rows it
                      // names can go under it — a delete elsewhere leaves ids
                      // selected with no document behind them, and there is
                      // nothing to open in the workspace then.
                      const first = selectedDocs[0];
                      if (!first) return;
                      const names = [...new Set(selectedDocs.map((d) => d.clientName))];
                      const ids = clients.filter((c) => names.includes(c.name)).map((c) => c.id);
                      startConversation(ids, [
                        { id: `${Date.now()}-u`, role: 'user', content: intl.formatMessage(m.askAiPrompt, { supplier: first.supplier }) },
                        { id: `${Date.now()}-a`, role: 'assistant', content: intl.formatMessage(m.askAiReply), intent: 'REVIEW_DOCUMENT', payload: { documentId: first.id, clientIds: ids, clientNames: names } },
                      ]);
                    }} />
                    {/* Same route as the header publish: live it stages a
                        `publish.batch` proposal, synthetic it is the local
                        confirm-then-flip. Never hidden live any more — the bar
                        without it was the reported break. */}
                    {statusTab === 'ready' && (
                      <BulkBtn
                        icon={Send}
                        label={intl.formatMessage(m.publishAction)}
                        onClick={() =>
                          documentsSource === 'api' ? setPublishing(selectedDocs) : requestPublish(selected)
                        }
                      />
                    )}
                    {/* Bulk retry stays synthetic-only: live retries are one
                        proposal per failed publish (METH S12), and a bulk
                        card is Stage 10's post-demo shape. */}
                    {statusTab === 'rejected' && documentsSource !== 'api' && (
                      <BulkBtn
                        icon={RefreshCw}
                        label={intl.formatMessage(commonActions.retry)}
                        onClick={async () => {
                          const ok = await confirm({
                            title: intl.formatMessage(m.bulkRetryTitle, { count: selected.length }),
                            detail: intl.formatMessage(m.bulkRetryDetail),
                            confirmLabel: intl.formatMessage(m.retryConfirm),
                          });
                          if (!ok) return;
                          selected.forEach((id) => retryDocument(id));
                          setSelected([]);
                        }}
                      />
                    )}
                    <BulkBtn
                      icon={Download}
                      label={intl.formatMessage(commonActions.exportCsv)}
                      minSelected={EXPORT_MIN_ROWS}
                      selectedCount={selected.length}
                      disabledHint={intl.formatMessage(EXPORT_HINT)}
                      onClick={() => exportDocs(selectedDocs)}
                    />
                    {/* Was a click-twice-within-4s pattern, which is easy to
                        trip by accident and says nothing about what goes.
                        Hidden live: no delete endpoint exists, so the row
                        would only come back with the next poll (METH S14). */}
                    {documentsSource !== 'api' && (
                    <BulkBtn
                      icon={Trash2}
                      label={intl.formatMessage(m.bulkDelete)}
                      danger
                      onClick={async () => {
                        const ok = await confirm({
                          tone: 'red',
                          title: intl.formatMessage(m.deleteTitle, { count: selected.length }),
                          detail: selectedDocs.map((d) => d.supplier).slice(0, 4).join(' · ') || intl.formatMessage(m.deleteDetailFallback),
                          consequence: intl.formatMessage(m.deleteConsequence),
                          confirmLabel: intl.formatMessage(m.deleteConfirm),
                        });
                        if (!ok) return;
                        deleteDocuments(selected);
                        logAudit({
                          action: intl.formatMessage(m.deleteAudit),
                          scope: intl.formatMessage(m.deleteAuditScope, { count: selected.length }),
                          reviewOpened: true,
                        });
                        setSelected([]);
                      }}
                    />
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Phones: a card per document. Same selection, same flags, same
                verbs; just stacked so the Action column is never off-screen. */}
            <div className="flex-1 overflow-y-auto md:hidden -mx-1 divide-y divide-white/5 pb-safe">
              {rows.length === 0 && (
                <div className="px-4 py-12 text-center text-zinc-400 font-medium">
                  {intl.formatMessage(m.cardEmpty)}
                </div>
              )}
              {rows.map((doc) => {
                const isSel = selected.includes(doc.id);
                const blocked = missingMandatory(doc, mandatoryFields);
                return (
                  <div
                    key={doc.id}
                    // The whole card selects, the way the whole row does on a
                    // desktop. It cannot be a <button> — the verbs below are
                    // buttons and buttons do not nest — so it carries the
                    // keyboard activation by hand, and only when the key
                    // landed on the card rather than on one of those verbs.
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSel}
                    onClick={() => toggleSelected(doc.id)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      toggleSelected(doc.id);
                    }}
                    className={`px-3 py-4 flex gap-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${isSel ? 'bg-brand/10' : ''}`}
                  >
                    <div className="pt-0.5 shrink-0">
                      <LightCheckbox checked={isSel} onChange={() => toggleSelected(doc.id)} />
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col gap-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-bold text-white text-[15px] leading-tight break-words">{doc.supplier}</div>
                          {doc.splitFrom && <div className="text-[11px] font-medium text-zinc-400">{doc.splitFrom}</div>}
                          <div className="text-[12px] text-zinc-500 font-medium mt-0.5">{doc.clientName} · {doc.date}</div>
                        </div>
                        <div className="font-bold text-white text-[15px] tabular-nums shrink-0">{currency(doc.total, doc.currency)}</div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-bold tracking-wide uppercase ${doc.category === '—' ? 'bg-amber-100 text-amber-700' : 'bg-raised text-zinc-300'}`}>
                          {doc.category}
                        </span>
                        <StatusBadge doc={doc} blocked={blocked} />
                        {renderFlags(doc, blocked)}
                      </div>
                      {mandatoryFields.length > 0 && (
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                          {mandatoryFields.map((label) => {
                            const value = doc.fields.find((f) => f.label.toLowerCase() === label.toLowerCase())?.value;
                            const filled = value && value !== '—';
                            return (
                              <div key={label} className="min-w-0">
                                <dt className="text-[10px] uppercase tracking-widest font-bold text-zinc-400">{label}</dt>
                                <dd className={`text-[13px] font-semibold break-words ${filled ? 'text-zinc-300' : 'text-amber-600'}`}>
                                  {filled ? value : intl.formatMessage(m.cardFieldMissing)}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      )}
                      <div className="[&>div]:justify-start [&>div]:flex-wrap">{renderActions(doc, blocked)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden md:block flex-1 overflow-auto px-2">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="text-[11px] uppercase tracking-widest font-bold text-zinc-400 border-b border-white/5">
                  <tr>
                    <th className="px-4 py-4 w-12">
                      <LightCheckbox
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? [] : rows.map((d) => d.id))}
                      />
                    </th>
                    <th className="px-4 py-4">{intl.formatMessage(commonLabels.client)}</th>
                    <th className="px-4 py-4">{intl.formatMessage(inbox === 'sales' ? m.columnCustomer : commonLabels.supplier)}</th>
                    <th className="px-4 py-4">{intl.formatMessage(commonLabels.date)}</th>
                    <th className="px-4 py-4 text-right">{intl.formatMessage(commonLabels.total)}</th>
                    <th className="px-4 py-4">{intl.formatMessage(commonLabels.category)}</th>
                    {/* A field the practice made mandatory is a field they
                        need to see: making it required and then hiding it
                        leaves people opening documents one by one to find out
                        which are missing it. */}
                    {mandatoryFields.map((f) => (
                      <th key={f} className="px-4 py-4">{f}</th>
                    ))}
                    <th className="px-4 py-4">{intl.formatMessage(m.columnFlags)}</th>
                    <th className="px-4 py-4 text-right">{intl.formatMessage(commonLabels.status)}</th>
                    <th className="px-4 py-4 text-right">{intl.formatMessage(m.columnAction)}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={9 + mandatoryFields.length} className="px-4 py-16 text-center text-zinc-400 font-medium">
                        {intl.formatMessage(m.emptyTable)}
                      </td>
                    </tr>
                  )}
                  {rows.map((doc) => {
                    const isSel = selected.includes(doc.id);
                    const blocked = missingMandatory(doc, mandatoryFields);
                    return (
                      <tr
                        key={doc.id}
                        onClick={() => setSelected((p) => (p.includes(doc.id) ? p.filter((x) => x !== doc.id) : [...p, doc.id]))}
                        className={`transition-colors group cursor-pointer ${isSel ? 'bg-brand/10' : 'hover:bg-white/[0.02]'}`}
                      >
                        <td className="px-4 py-5">
                          <LightCheckbox checked={isSel} onChange={() => setSelected((p) => (p.includes(doc.id) ? p.filter((x) => x !== doc.id) : [...p, doc.id]))} />
                        </td>
                        <td className="px-4 py-5 text-white font-bold">{doc.clientName}</td>
                        <td className="px-4 py-5 font-semibold text-zinc-300">
                          {doc.supplier}
                          {doc.splitFrom && <span className="block text-[11px] font-medium text-zinc-400">{doc.splitFrom}</span>}
                        </td>
                        <td className="px-4 py-5 text-zinc-500 font-medium">{doc.date}</td>
                        <td className="px-4 py-5 text-right font-bold text-white text-[15px]">{currency(doc.total, doc.currency)}</td>
                        <td className="px-4 py-5">
                          <span className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-bold tracking-wide uppercase ${doc.category === '—' ? 'bg-amber-100 text-amber-700' : 'bg-raised text-zinc-300'}`}>
                            {doc.category}
                          </span>
                        </td>
                        {mandatoryFields.map((label) => {
                          const value = doc.fields.find((f) => f.label.toLowerCase() === label.toLowerCase())?.value;
                          const filled = value && value !== '—';
                          return (
                            <td key={label} className="px-4 py-5">
                              <span
                                className={`text-[13px] font-semibold ${filled ? 'text-zinc-300' : 'text-amber-600'}`}
                                title={filled ? undefined : intl.formatMessage(m.fieldRequiredTitle, { field: label })}
                              >
                                {filled ? value : intl.formatMessage(m.fieldMissing)}
                              </span>
                            </td>
                          );
                        })}
                        <td className="px-4 py-5">
                          {renderFlags(doc, blocked)}
                        </td>
                        <td className="px-4 py-5 text-right">
                          <StatusBadge doc={doc} blocked={blocked} />
                        </td>
                        <td className="px-4 py-5 text-right">
                          {renderActions(doc, blocked)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Drop overlay */}
      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-brand/20 backdrop-blur-sm border-4 border-dashed border-brand flex items-center justify-center pointer-events-none"
          >
            <div className="bg-card border border-white/10 rounded-[32px] px-4 md:px-10 py-8 text-center shadow-2xl">
              <UploadCloud size={40} className="text-brand mx-auto mb-4" />
              <p className="text-xl font-bold text-white">{intl.formatMessage(m.dropHeading)}</p>
              <p className="text-[13px] text-zinc-500 mt-1">{intl.formatMessage(m.dropDetail)}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A live route — one Review → Approve card per selected document. */}
      <AnimatePresence>
        {routing && (
          <ProposalFlowModal
            request={routing.request}
            clientName={routing.clientName}
            onExecuted={() => void refreshDocuments(queryClient)}
            onClose={advanceRouting}
          />
        )}
      </AnimatePresence>

      {/* The live release: stage a `publish.batch` per client and walk the
          server's Review → Approve card. `refreshDocuments` on settle so an
          approved batch moves to Published here rather than on the next poll. */}
      <AnimatePresence>
        {publishing && (
          <Suspense fallback={null}>
            <PublishBatchDialog
              selection={publishing}
              onSettled={() => {
                setSelected([]);
                void refreshDocuments(queryClient);
              }}
              onClose={() => setPublishing(null)}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* A live publish retry — the Review → Approve card over a fresh proposal. */}
      <AnimatePresence>
        {publishRetry && (
          <ProposalFlowModal
            request={publishRetry.request}
            clientName={publishRetry.clientName}
            onExecuted={() => void refreshDocuments(queryClient)}
            onClose={() => setPublishRetry(null)}
          />
        )}
      </AnimatePresence>

      {/* Document detail */}
      <AnimatePresence>
        {preview && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setPreview(null)}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4 md:p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.97 }}
              onClick={(e) => e.stopPropagation()}
              data-tour="document-preview"
              className="relative w-full max-w-3xl"
            >
              <button onClick={() => setPreview(null)} className="absolute -top-3 -right-3 z-10 p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg">
                <X size={18} />
              </button>
              {/* Suspense INSIDE the frame: the modal itself paints at once and
                  only the document card waits on its chunk. */}
              <Suspense fallback={null}>
                <DocumentPreview document={documents.find((d) => d.id === preview.id) ?? preview} />
              </Suspense>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Extraction on screen, then its figures, then the calls it made —
          all before the document is filed anywhere. */}
      {analysing && (
        <AnalysisModal
          docIds={analysing.docIds}
          importIds={analysing.importIds}
          onClose={(settled) => {
            const importIds = analysing.importIds;
            setAnalysing(null);
            // Land where the rows actually went, so the result of the upload is
            // the thing on screen rather than something to go and find.
            const first = settled[0];
            if (first) {
              goTo({ inbox: first.kind as Inbox, status: first.status === 'ready' ? 'ready' : 'review' });
              return;
            }
            const imported = sheetImports.filter((t) => importIds.includes(t.id));
            const sales = imported.reduce((n, t) => n + t.counts.sales, 0);
            const costs = imported.reduce((n, t) => n + t.counts.cost, 0);
            if (sales || costs) goTo({ inbox: sales > costs ? 'sales' : 'cost', status: 'review' });
          }}
        />
      )}

      {/* The two suspected copies, side by side, with keep-one / keep-both */}
      {comparing && <DuplicateModal pair={comparing} onClose={() => setComparing(null)} />}

      {/* Publish confirmation — releasing is a state change, so it always asks first */}
      <AnimatePresence>
        {confirmPublish && (() => {
          const docs = documents.filter((d) => confirmPublish.includes(d.id));
          const held = docs.filter((d) => missingMandatory(d, mandatoryFields).length > 0);
          const publishable = docs.length - held.length;
          const totalValue = docs.reduce((s, d) => s + d.total, 0);
          const clientNames = [...new Set(docs.map((d) => d.clientName))];
          // One client is named; more than one is counted. Naming the single
          // case keeps that the only thing clientNames[0] is read under.
          const onlyClient = clientNames.length === 1 ? clientNames[0] : undefined;
          return (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setConfirmPublish(null)}
              className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 md:p-10"
            >
              <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.97 }}
                onClick={(e) => e.stopPropagation()}
                data-tour="publish-confirm"
                className="w-full max-w-md border border-white/5 rounded-t-[28px] sm:rounded-[32px] bg-card shadow-2xl overflow-hidden pb-safe sm:pb-0"
              >
                <div className="p-6 border-b border-white/5">
                  <h3 className="font-sans font-bold text-xl text-white tracking-tight">
                    {intl.formatMessage(m.confirmPublishTitle, { count: docs.length })}
                  </h3>
                  <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                    {intl.formatMessage(m.confirmPublishSubtitle)}
                  </p>
                </div>
                <div className="p-6 flex flex-col gap-3">
                  <ConfirmRow label={intl.formatMessage(m.confirmRowItems)} value={String(docs.length)} />
                  <ConfirmRow label={intl.formatMessage(m.confirmRowValue)} value={currency(totalValue)} />
                  <ConfirmRow
                    label={intl.formatMessage(clientNames.length === 1 ? m.confirmRowClient : m.confirmRowClients)}
                    value={onlyClient ?? intl.formatMessage(m.clientCount, { count: clientNames.length })}
                  />
                  {held.length > 0 && (
                    <div className="flex items-start gap-2.5 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-[13px] text-amber-300 leading-relaxed">
                      <ShieldAlert size={16} className="shrink-0 mt-0.5" />
                      <span>
                        {intl.formatMessage(m.heldBack, {
                          count: held.length,
                          remaining: publishable,
                          // Keyed because formatMessage hands the parts back as an
                          // array and React counts this element as a list child.
                          highlight: (chunks: ReactNode[]) => <span key="held" className="font-bold">{chunks}</span>,
                        })}
                      </span>
                    </div>
                  )}
                </div>
                <div className="p-4 bg-raised/50 flex justify-end gap-3">
                  <button
                    onClick={() => setConfirmPublish(null)}
                    className="px-6 py-2.5 text-sm font-bold text-zinc-300 bg-white/5 hover:bg-white/10 rounded-full transition-all"
                  >
                    {intl.formatMessage(commonActions.cancel)}
                  </button>
                  <button
                    onClick={publishConfirmed}
                    disabled={publishable === 0}
                    className="px-6 py-2.5 text-sm font-bold text-brand-on bg-brand hover:bg-brand-hover rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {intl.formatMessage(m.confirmPublishAction, { count: publishable })}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Mandatory fields config */}
      <AnimatePresence>
        {fieldsOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setFieldsOpen(false)}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 md:p-10"
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.97 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md border border-white/5 rounded-t-[28px] sm:rounded-[32px] bg-card shadow-2xl overflow-hidden pb-safe sm:pb-0"
            >
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(m.fieldsHeading)}</h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">{intl.formatMessage(m.fieldsSubtitle)}</p>
              </div>
              <div className="p-6 flex flex-col gap-3">
                <div className="text-[13px] text-zinc-500 leading-relaxed">
                  {intl.formatMessage(m.fieldsIntro)}
                </div>
                {OPTIONAL_MANDATORY.map((f) => (
                  <button
                    key={f}
                    onClick={() => setMandatoryFields(mandatoryFields.includes(f) ? mandatoryFields.filter((x) => x !== f) : [...mandatoryFields, f])}
                    className="flex items-center justify-between gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 hover:border-white/15 transition-colors text-left"
                  >
                    <span className="text-sm font-bold text-white">{f}</span>
                    <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${mandatoryFields.includes(f) ? 'bg-brand' : 'bg-white/10'}`}>
                      <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${mandatoryFields.includes(f) ? 'left-6' : 'left-1'}`} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="p-4 bg-raised/50 flex justify-end">
                <button onClick={() => setFieldsOpen(false)} className="px-6 py-2.5 text-sm font-bold text-brand-on bg-brand hover:bg-brand-hover rounded-full transition-all">
                  {intl.formatMessage(m.doneAction)}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}


const mStatus = defineMessages({
  processing: { id: 'inboxes.statusBadge.processing', defaultMessage: 'Processing' },
  failedReason: { id: 'inboxes.statusBadge.failedReason', defaultMessage: 'Failed' },
  failed: { id: 'inboxes.statusBadge.failed', defaultMessage: 'Failed' },
  toReview: { id: 'inboxes.statusBadge.toReview', defaultMessage: 'To review' },
  published: { id: 'inboxes.statusBadge.published', defaultMessage: 'Published' },
  missingTitle: { id: 'inboxes.statusBadge.missingTitle', defaultMessage: 'Missing {fields}' },
  readyPublishFailed: { id: 'inboxes.statusBadge.readyPublishFailed', defaultMessage: 'Ready — publish failed' },
  readyBlocked: { id: 'inboxes.statusBadge.readyBlocked', defaultMessage: 'Ready — blocked' },
  ready: { id: 'inboxes.statusBadge.ready', defaultMessage: 'Ready' },
});

function StatusBadge({ doc, blocked }: { doc: Document; blocked: string[] }) {
  const intl = useIntl();

  if (doc.status === 'processing') {
    return (
      <span className="inline-flex items-center gap-1.5 text-zinc-300 text-xs font-bold bg-raised px-3 py-1 rounded-full">
        <span className="w-2 h-2 rounded-full bg-zinc-400 animate-pulse" />
        {intl.formatMessage(mStatus.processing)}
      </span>
    );
  }
  if (doc.status === 'rejected') {
    // "Failed" alone tells an accountant nothing they can act on, so the
    // cause and the way out are one hover away rather than nowhere.
    const failure = failureOf(doc);
    return (
      <Tooltip
        label={failure ? reasonText(failure, intl) : intl.formatMessage(mStatus.failedReason)}
        {...(failure ? { detail: intl.formatMessage(failure.detail) } : {})}
      >
        <span className="inline-flex items-center gap-1.5 text-white text-xs font-bold bg-red-500 px-3 py-1 rounded-full cursor-help">
          <AlertCircle size={14} />
          {intl.formatMessage(mStatus.failed)}
        </span>
      </Tooltip>
    );
  }
  if (doc.status === 'review') {
    return (
      <span className="inline-flex items-center gap-1.5 text-zinc-900 text-xs font-bold bg-amber-200 px-3 py-1 rounded-full">
        <AlertCircle size={14} />
        {doc.statusNote ?? intl.formatMessage(mStatus.toReview)}
      </span>
    );
  }
  if (doc.status === 'published') {
    return (
      <span className="inline-flex items-center gap-1.5 text-white text-xs font-bold bg-emerald-500 px-3 py-1 rounded-full">
        <CheckCircle2 size={14} />
        {intl.formatMessage(mStatus.published)}
      </span>
    );
  }
  // Ready: green when clean, yellow when a previous publish failed or fields are missing.
  const yellow = doc.publishFailed || blocked.length > 0;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1 rounded-full ${
        yellow ? 'bg-amber-200 text-zinc-900' : 'bg-brand text-brand-on'
      }`}
      title={doc.publishFailed ? doc.statusNote : blocked.length ? intl.formatMessage(mStatus.missingTitle, { fields: blocked.join(', ') }) : undefined}
    >
      <CheckCircle2 size={14} />
      {doc.publishFailed
        ? intl.formatMessage(mStatus.readyPublishFailed)
        : blocked.length
          ? intl.formatMessage(mStatus.readyBlocked)
          : intl.formatMessage(mStatus.ready)}
    </span>
  );
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60">
      <span className="text-[12px] font-bold text-zinc-500 uppercase tracking-widest">{label}</span>
      <span className="text-sm font-bold text-white">{value}</span>
    </div>
  );
}

/**
 * An icon in the Flags column. The icon carries the whole meaning, so it gets
 * a real tooltip rather than a native `title` that waits a second and cannot
 * say a second sentence.
 */
/**
 * A flag, and where it leads.
 *
 * Where there is something to look at behind the flag it is a real button —
 * pointer cursor, hover state, keyboard-reachable — because "suspected
 * duplicate" is only useful next to the other copy. Where there is nothing to
 * open it stays a hint and keeps the help cursor, so the two do not look alike.
 */
const mFlag = defineMessages({
  compareLabel: { id: 'inboxes.flagIcon.compareLabel', defaultMessage: '{title} — compare' },
  detailClickable: { id: 'inboxes.flagIcon.detailClickable', defaultMessage: '{detail} Click to open.' },
});

function FlagIcon({ icon: Icon, tone, title, detail, onClick }: {
  icon: LucideIcon;
  tone: 'amber' | 'blue' | 'red';
  title: string;
  detail?: string;
  onClick?: () => void;
}) {
  const intl = useIntl();
  const tones = {
    amber: 'bg-amber-100 text-amber-700 hover:bg-amber-200',
    blue: 'bg-brand/20 text-brand hover:bg-brand/35',
    red: 'bg-red-100 text-red-600 hover:bg-red-200',
  };
  const shape = `w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${tones[tone]}`;

  return (
    <Tooltip label={title} {...(detail ? { detail: onClick ? intl.formatMessage(mFlag.detailClickable, { detail }) : detail } : {})}>
      {onClick ? (
        <button
          type="button"
          aria-label={intl.formatMessage(mFlag.compareLabel, { title })}
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          className={`${shape} cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60`}
        >
          <Icon size={13} />
        </button>
      ) : (
        // A tooltip trigger has to be focusable or keyboard users never see
        // the tooltip, and the ARIA tooltip pattern wants a real interactive
        // element for that — not a span with a bare tabIndex, which is what
        // `no-noninteractive-tabindex` rejects. So: a button that deliberately
        // does nothing on click, exactly like the clickable branch above minus
        // the handler.
        <button type="button" aria-label={title} className={`${shape} cursor-help focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60`}>
          <Icon size={13} />
        </button>
      )}
    </Tooltip>
  );
}

function InboxPill({ active, onClick, label, count, alert }: { active: boolean; onClick: () => void; label: string; count?: number; alert?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border flex items-center gap-2 ${
        active
          ? 'bg-brand text-brand-on border-brand shadow-glow-pill'
          : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${active ? 'bg-black/30' : alert ? 'bg-amber-500/20 text-amber-400' : 'bg-raised'}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-2 px-4 md:px-5 py-2.5 rounded-full text-sm transition-all duration-300 whitespace-nowrap ${
        active
          ? 'bg-brand text-brand-on font-bold shadow-glow-tab'
          : 'text-zinc-400 font-semibold hover:text-white hover:bg-white/5'
      }`}
    >
      {label}
      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${active ? 'bg-black text-brand' : 'bg-raised text-zinc-500'}`}>
        {count}
      </span>
    </button>
  );
}

function BulkBtn({ icon: Icon, label, onClick, danger, minSelected, selectedCount, disabledHint }: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** How many rows this action needs to mean anything. Defaults to 1. */
  minSelected?: number;
  selectedCount?: number;
  disabledHint?: string;
}) {
  const short = minSelected !== undefined && (selectedCount ?? 0) < minSelected;
  return (
    <button
      disabled={short}
      title={short ? disabledHint : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${
        danger ? 'text-red-500 hover:bg-red-500/10' : 'text-zinc-300 hover:bg-white/5'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

function LightSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-raised border-none rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-300 focus:outline-none focus:ring-2 focus:ring-brand transition-all"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function LightCheckbox({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
        checked ? 'bg-brand border-brand' : 'border-white/20 hover:border-white/40'
      }`}
    >
      {checked && <Check size={12} strokeWidth={4} className="text-white" />}
    </button>
  );
}

function exportDocs(rows: Document[]) {
  const header = 'Client,Supplier,Date,Total,Category,Status,Channel,Inbox\n';
  const body = rows
    .map((d) => `"${d.clientName}","${d.supplier}","${d.date}",${d.total},"${d.category}","${d.status}","${d.source}","${d.kind}"`)
    .join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'inbox.csv';
  a.click();
  URL.revokeObjectURL(url);
}
