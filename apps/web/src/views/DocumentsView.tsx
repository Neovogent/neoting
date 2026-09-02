import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import {
  Search, FileText, FolderTree, AlertTriangle, UploadCloud, Trash2, ArrowRightLeft,
  Eye, Download, ChevronRight, ChevronDown, Archive, Lock, Building2, User,
  MoreHorizontal, X, RotateCcw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { useQueryClient } from '@tanstack/react-query';
import { useAppContext } from '../context/AppContext';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
/**
 * ⚠ **The canonical `Modal`, not the re-export from `ApprovalsView`.**
 *
 * `ApprovalsView` re-exports `Modal` "so existing importers keep working", and
 * this screen was one of them. It costs far more than a tidier import path:
 * Rollup cannot shake a whole view module down to one re-exported component, so
 * the built `DocumentsView` chunk carried a bare side-effect
 * `import"./ApprovalsView-*.js"` — and with it the **ApprovalsView chunk
 * (15.9 kB gz)**, plus `DocumentPreview`, `LiveProposalCard`, `ReviewGate` and
 * `Tooltip`, all statically fetched before this route could render. Measured:
 * roughly **32 kB gzip on a route that renders a table.**
 *
 * It also silently defeated the `lazy()` below — moving `DocumentPreview`
 * behind the viewer chunk reclaimed nothing while this line pulled it back in
 * through the side door.
 */
import { Modal } from '../components/DynamicComponents/Modal';
import {
  applyToEach, refreshTrash, restoreDocument, softDeleteDocument, useDeletedDocuments, useDocumentCounts,
} from '../api/document-lifecycle';
import { errorLabel, sliceStatus } from '../api/slices';
import { useScrollActiveIntoView } from '../lib/useScrollActiveIntoView';
import { currency } from '../lib/resolver';
import type { CreateActionProposalRequest } from '@neoting/contracts/model';
import type { DocStatus, Document, VaultDocument } from '../lib/types';
import { EXPORT_HINT } from '../lib/exportRules';
import { commonActions, commonLabels } from '../i18n/common';
import { DataSourceBadge } from '../components/DataSourceBadge';

// The Review → Approve card behind a live Move to client. Lazy, the
// BankFilterPanel pattern: it drags LiveProposalCard + ReviewGate with it, and
// none of that belongs on the route's opening download — it loads on the first
// live move, which is the only moment it can render.
const ProposalFlowModal = lazy(() =>
  import('../components/DynamicComponents/ProposalFlowModal').then((mod) => ({ default: mod.ProposalFlowModal })),
);

/**
 * ⚠ **The viewer is lazy, and that is a budget rule.** It carries the stage,
 * the toolbar, the extraction read (`api/document-detail.ts`, heavy with the
 * strict extraction Zod) and — behind a second `lazy()` inside it —
 * `DocumentPreview` and the whole correction machinery. This screen used to
 * import `DocumentPreview` at module scope, which put all of it on the
 * Documents route's opening download whether or not anybody opened a document.
 * Now the route downloads a list, and the viewer arrives on the first click.
 */
const DocumentViewer = lazy(() => import('../components/DynamicComponents/DocumentViewer'));

/** Permanent delete's Review → Approve card. Loads on the first purge, which is the only moment it can render. */
const PurgeDocumentsDialog = lazy(() => import('../components/DynamicComponents/PurgeDocumentsDialog'));

// 'All' is the register — every document the practice holds, in every state,
// from every channel. It is first and it is the default because the other two
// are subsets (the archive is what has been published, the vault is what is
// not a transaction), and a practice whose paperwork has only just started
// arriving would otherwise open this screen onto an empty shelf while the
// documents it is asking about sit one filter away.
const TABS = ['All', 'Archive', 'Vault', 'Trash'] as const;
type Tab = (typeof TABS)[number];

// The tab value is the shelf being looked at and is compared against, so it
// stays English. Only the word on the button is translated — descriptors here,
// formatted where the button renders, because no hook reaches module scope.
const TAB_LABEL: Record<Tab, MessageDescriptor> = defineMessages({
  All: { id: 'documents.documentsView.tabAll', defaultMessage: 'All documents' },
  Archive: { id: 'documents.documentsView.tabArchive', defaultMessage: 'Archive' },
  Vault: { id: 'documents.documentsView.tabVault', defaultMessage: 'Vault' },
  Trash: { id: 'documents.documentsView.tabTrash', defaultMessage: 'Trash' },
});

/** Pipeline order, which is the order the status filter offers. */
const STATUS_ORDER: DocStatus[] = ['processing', 'review', 'ready', 'published', 'rejected'];

/**
 * What "expiring soon" means on this screen — the vault filter's window and,
 * since the counts moved server-side, the `expiringWithinDays` the header asks
 * for. It is one constant because a header that counted a different window from
 * the filter beneath it would be two answers to one question.
 */
const EXPIRY_SOON_DAYS = 14;

/** The same vocabulary the Inboxes tabs use, so a document reads the same on both screens. */
const STATUS_LABEL: Record<DocStatus, MessageDescriptor> = defineMessages({
  processing: { id: 'documents.documentsView.statusProcessing', defaultMessage: 'Processing' },
  review: { id: 'documents.documentsView.statusReview', defaultMessage: 'To review' },
  ready: { id: 'documents.documentsView.statusReady', defaultMessage: 'Ready' },
  published: { id: 'documents.documentsView.statusPublished', defaultMessage: 'Published' },
  rejected: { id: 'documents.documentsView.statusFailed', defaultMessage: 'Failed' },
});

/** Colour is supplementary — the pill always carries the word. */
const STATUS_TONE: Record<DocStatus, 'neutral' | 'blue' | 'red' | 'green' | 'amber'> = {
  processing: 'neutral',
  review: 'amber',
  ready: 'blue',
  published: 'green',
  rejected: 'red',
};

const VAULT_CATEGORIES: VaultDocument['category'][] = [
  'Contracts', 'Leases', 'Insurance', 'Tax filings', 'Engagement letters', 'Payroll', 'Certificates',
];

/** What each vault shelf is called on screen. The union value itself is data. */
const VAULT_CATEGORY_LABEL: Record<VaultDocument['category'], MessageDescriptor> = defineMessages({
  Contracts: { id: 'documents.documentsView.categoryContracts', defaultMessage: 'Contracts' },
  Leases: { id: 'documents.documentsView.categoryLeases', defaultMessage: 'Leases' },
  Insurance: { id: 'documents.documentsView.categoryInsurance', defaultMessage: 'Insurance' },
  'Tax filings': { id: 'documents.documentsView.categoryTaxFilings', defaultMessage: 'Tax filings' },
  'Engagement letters': {
    id: 'documents.documentsView.categoryEngagementLetters',
    defaultMessage: 'Engagement letters',
  },
  Payroll: { id: 'documents.documentsView.categoryPayroll', defaultMessage: 'Payroll' },
  Certificates: { id: 'documents.documentsView.categoryCertificates', defaultMessage: 'Certificates' },
});

const m = defineMessages({
  heading: { id: 'documents.documentsView.heading', defaultMessage: 'Documents' },
  documentsLoading: { id: 'documents.documentsView.loading', defaultMessage: 'Loading documents…' },
  documentsError: { id: 'documents.documentsView.loadError', defaultMessage: 'Could not load documents — {error}' },
  summary: {
    id: 'documents.documentsView.summary',
    defaultMessage: '{total} documents · {archived} archived · {vault} in vault · {expiring} expiring',
  },
  /**
   * The same line with the Trash count on it — a WHOLE second sentence rather
   * than the first one plus a fragment, per the i18n note in `apps/web/
   * CLAUDE.md`: a translator handed "· {n} in Trash" to bolt onto the end has
   * no way to reorder it, and several languages need to.
   *
   * The short form is what shows while the Trash count is not KNOWN — the live
   * listing has not answered, or answered with a failure. A zero printed for a
   * count nobody has is the kind of quiet wrong figure this file has been
   * caught on before (the register that showed "0 archived" over a full inbox).
   */
  summaryWithTrash: {
    id: 'documents.documentsView.summaryWithTrash',
    defaultMessage: '{total} documents · {archived} archived · {vault} in vault · {expiring} expiring · {trash} in Trash',
  },
  searchAll: { id: 'documents.documentsView.searchAll', defaultMessage: 'Search every document…' },
  searchArchive: {
    id: 'documents.documentsView.searchArchive',
    defaultMessage: 'Full-text search — try "avocado"',
  },
  searchVault: { id: 'documents.documentsView.searchVault', defaultMessage: 'Search vault...' },
  addToVault: { id: 'documents.documentsView.addToVault', defaultMessage: 'Add to vault' },
  addToVaultAudit: { id: 'documents.documentsView.addToVaultAudit', defaultMessage: 'Added vault document' },

  columnSource: { id: 'documents.documentsView.columnSource', defaultMessage: 'Source' },
  columnUploader: { id: 'documents.documentsView.columnUploader', defaultMessage: 'Uploader' },

  unarchiveAction: { id: 'documents.documentsView.unarchiveAction', defaultMessage: 'Unarchive' },
  unarchiveTitle: {
    id: 'documents.documentsView.unarchiveTitle',
    defaultMessage: '{count, plural, one {Unarchive # document?} other {Unarchive # documents?}}',
  },
  unarchiveDetail: {
    id: 'documents.documentsView.unarchiveDetail',
    defaultMessage: 'They return to Ready and leave the archive.',
  },
  unarchiveConsequence: {
    id: 'documents.documentsView.unarchiveConsequence',
    defaultMessage: 'Their release history is cleared — an import file you already downloaded is unaffected.',
  },
  unarchiveConfirm: { id: 'documents.documentsView.unarchiveConfirm', defaultMessage: 'Yes, unarchive' },
  unarchiveAudit: { id: 'documents.documentsView.unarchiveAudit', defaultMessage: 'Unarchived documents' },
  unarchiveAuditScope: {
    id: 'documents.documentsView.unarchiveAuditScope',
    defaultMessage: '{count} item(s) — publishing data cleared',
  },
  moveToClientAction: { id: 'documents.documentsView.moveToClientAction', defaultMessage: 'Move to client' },

  filterAllClients: { id: 'documents.documentsView.filterAllClients', defaultMessage: 'All clients' },
  filterAllCategories: { id: 'documents.documentsView.filterAllCategories', defaultMessage: 'All categories' },
  filterAllChannels: { id: 'documents.documentsView.filterAllChannels', defaultMessage: 'All channels' },
  filterAllStatuses: { id: 'documents.documentsView.filterAllStatuses', defaultMessage: 'All statuses' },
  groupByClient: { id: 'documents.documentsView.groupByClient', defaultMessage: 'Group by client' },
  filterAllYears: { id: 'documents.documentsView.filterAllYears', defaultMessage: 'All years' },
  filterAnyOwner: { id: 'documents.documentsView.filterAnyOwner', defaultMessage: 'Any owner' },
  filterFirmOwned: { id: 'documents.documentsView.filterFirmOwned', defaultMessage: 'Firm-owned — {practice}' },
  filterOwnedBy: { id: 'documents.documentsView.filterOwnedBy', defaultMessage: 'Owned by {owner}' },
  filterAnyExpiry: { id: 'documents.documentsView.filterAnyExpiry', defaultMessage: 'Any expiry' },
  filterExpiringSoon: { id: 'documents.documentsView.filterExpiringSoon', defaultMessage: 'Expiring soon ({count})' },
  filterExpired: { id: 'documents.documentsView.filterExpired', defaultMessage: 'Expired ({count})' },
  filterNoExpiry: { id: 'documents.documentsView.filterNoExpiry', defaultMessage: 'No expiry date' },
  filterAnyVisibility: { id: 'documents.documentsView.filterAnyVisibility', defaultMessage: 'Any visibility' },
  filterPracticeOnly: { id: 'documents.documentsView.filterPracticeOnly', defaultMessage: 'Practice only' },
  filterClientVisible: { id: 'documents.documentsView.filterClientVisible', defaultMessage: 'Client visible' },
  filterAnyTag: { id: 'documents.documentsView.filterAnyTag', defaultMessage: 'Any tag' },
  filterTag: { id: 'documents.documentsView.filterTag', defaultMessage: '#{tag}' },
  clearFilters: { id: 'documents.documentsView.clearFilters', defaultMessage: 'Clear' },

  allEmpty: {
    id: 'documents.documentsView.allEmpty',
    defaultMessage:
      'No documents yet. Everything received — by email, WhatsApp, the client portal, chat or upload — lands here the moment it arrives. Upload the first one from the Inboxes screen.',
  },
  allEmptySearch: {
    id: 'documents.documentsView.allEmptySearch',
    defaultMessage: 'No documents match that phrase.',
  },
  allEmptyFiltered: {
    id: 'documents.documentsView.allEmptyFiltered',
    defaultMessage: 'No documents match those filters.',
  },
  allFooter: {
    id: 'documents.documentsView.allFooter',
    defaultMessage: '{count, plural, one {# document} other {# documents}} — every state, every channel',
  },
  archiveEmptySearch: {
    id: 'documents.documentsView.archiveEmptySearch',
    defaultMessage: 'Nothing in the archive matches that phrase.',
  },
  archiveEmpty: {
    id: 'documents.documentsView.archiveEmpty',
    defaultMessage: 'Nothing archived yet — items land here once published.',
  },
  archiveEmptyFiltered: {
    id: 'documents.documentsView.archiveEmptyFiltered',
    defaultMessage: 'Nothing in the archive matches those filters.',
  },
  archiveEmptyForClient: {
    id: 'documents.documentsView.archiveEmptyForClient',
    defaultMessage: 'Nothing archived for this client.',
  },
  archiveFooter: {
    id: 'documents.documentsView.archiveFooter',
    defaultMessage: '{count} archived • searches every extracted field and line item',
  },
  unassignedClient: { id: 'documents.documentsView.unassignedClient', defaultMessage: 'Unassigned' },
  groupCount: { id: 'documents.documentsView.groupCount', defaultMessage: '{count} documents' },

  vaultTree: {
    id: 'documents.documentsView.vaultTree',
    defaultMessage: 'Firm → Client → Financial year → Category',
  },
  vaultEmptyFiltered: {
    id: 'documents.documentsView.vaultEmptyFiltered',
    defaultMessage: 'Nothing in the vault matches those filters.',
  },
  vaultEmpty: {
    id: 'documents.documentsView.vaultEmpty',
    defaultMessage: 'Nothing in the vault yet — the company documents you file for a client land here.',
  },

  moveHeading: { id: 'documents.documentsView.moveHeading', defaultMessage: 'Move to another entity' },
  moveCount: {
    id: 'documents.documentsView.moveCount',
    defaultMessage: '{count, plural, one {# item} other {# items}}',
  },
  moveWarning: {
    id: 'documents.documentsView.moveWarning',
    defaultMessage: 'Check the addressee matches before moving',
  },
  // The sentence InboxesView's route menu carries, said here too now that the
  // same real path (a `document.route` proposal per document) opens from this
  // screen's Move to client in live mode.
  routeProposalNote: {
    id: 'documents.documentsView.routeProposalNote',
    defaultMessage: 'Moving one is a state change — each document goes through Review → Approve.',
  },
  deleteDocsAction: { id: 'documents.documentsView.deleteDocsAction', defaultMessage: 'Delete' },
  deleteDocsTitle: {
    id: 'documents.documentsView.deleteDocsTitle',
    defaultMessage: '{count, plural, one {Delete # document?} other {Delete # documents?}}',
  },
  deleteDocsFallback: { id: 'documents.documentsView.deleteDocsFallback', defaultMessage: 'The selected items.' },
  deleteDocsConsequence: {
    id: 'documents.documentsView.deleteDocsConsequence',
    defaultMessage: 'The originals go with them, and a deleted document cannot be matched to a bank line later.',
  },
  deleteDocsConfirm: { id: 'documents.documentsView.deleteDocsConfirm', defaultMessage: 'Yes, delete' },
  deleteDocsAudit: { id: 'documents.documentsView.deleteDocsAudit', defaultMessage: 'Deleted documents' },
  deleteDocsAuditScope: { id: 'documents.documentsView.deleteDocsAuditScope', defaultMessage: '{count} item(s)' },
  moveAudit: { id: 'documents.documentsView.moveAudit', defaultMessage: 'Moved between entities' },
  moveAuditScope: { id: 'documents.documentsView.moveAuditScope', defaultMessage: '{count} item(s) → {client}' },

  ownerAudit: { id: 'documents.documentsView.ownerAudit', defaultMessage: 'Changed vault file owner' },
  ownerAuditScope: { id: 'documents.documentsView.ownerAuditScope', defaultMessage: '{name} → {owner}' },

  deleteTitle: { id: 'documents.documentsView.deleteTitle', defaultMessage: 'Delete "{name}"?' },
  deleteDetail: { id: 'documents.documentsView.deleteDetail', defaultMessage: '{category} · owned by {owner}.' },
  deleteConsequenceProtected: {
    id: 'documents.documentsView.deleteConsequenceProtected',
    defaultMessage:
      'This is a permanent or statutory record — it should normally be kept for the life of the company.',
  },
  deleteConsequence: {
    id: 'documents.documentsView.deleteConsequence',
    defaultMessage: 'The file goes for good; the vault holds no second copy.',
  },
  deleteConfirm: { id: 'documents.documentsView.deleteConfirm', defaultMessage: 'Yes, delete it' },
  deleteAudit: { id: 'documents.documentsView.deleteAudit', defaultMessage: 'Deleted vault document' },

  /* ── Trash: delete, restore, purge ───────────────────────────────────────
     ⚠ The whole point of the wording below is the difference between the two
     acts. Moving a document to Trash is REVERSIBLE and the confirmation says
     so plainly, in the brand tone, with a button that says where it goes —
     never a red "this cannot be undone" over an act that can. Dressing a
     reversible act as an irreversible one is how people learn to click through
     the warning that matters, which is the purge one further down. */
  columnActions: { id: 'documents.documentsView.columnActions', defaultMessage: 'Actions' },

  trashAction: { id: 'documents.documentsView.trashAction', defaultMessage: 'Delete' },
  trashRowLabel: { id: 'documents.documentsView.trashRowLabel', defaultMessage: 'Delete {supplier}' },
  trashTitle: {
    id: 'documents.documentsView.trashTitle',
    defaultMessage: '{count, plural, one {Move # document to Trash?} other {Move # documents to Trash?}}',
  },
  trashConsequence: {
    id: 'documents.documentsView.trashConsequence',
    defaultMessage:
      'They move to the Trash tab and leave the register. Nothing is lost — you can restore any of them from there. Deleting for good is a separate, approved step.',
  },
  trashConfirm: { id: 'documents.documentsView.trashConfirm', defaultMessage: 'Move to Trash' },
  trashAudit: { id: 'documents.documentsView.trashAudit', defaultMessage: 'Moved documents to Trash' },
  trashAuditScope: { id: 'documents.documentsView.trashAuditScope', defaultMessage: '{count} item(s)' },

  restoreAction: { id: 'documents.documentsView.restoreAction', defaultMessage: 'Restore' },
  restoreRowLabel: { id: 'documents.documentsView.restoreRowLabel', defaultMessage: 'Restore {supplier}' },
  restoreAudit: { id: 'documents.documentsView.restoreAudit', defaultMessage: 'Restored documents from Trash' },

  purgeAction: { id: 'documents.documentsView.purgeAction', defaultMessage: 'Delete permanently' },
  purgeTitle: {
    id: 'documents.documentsView.purgeTitle',
    defaultMessage: '{count, plural, one {Delete # document for good?} other {Delete # documents for good?}}',
  },
  purgeConsequence: {
    id: 'documents.documentsView.purgeConsequence',
    defaultMessage: 'The record and the original file go, and neither can be restored.',
  },
  purgeConfirm: { id: 'documents.documentsView.purgeConfirm', defaultMessage: 'Yes, delete for good' },
  purgeAudit: { id: 'documents.documentsView.purgeAudit', defaultMessage: 'Deleted documents permanently' },

  trashLoading: { id: 'documents.documentsView.trashLoading', defaultMessage: 'Loading the Trash…' },
  trashLoadError: {
    id: 'documents.documentsView.trashLoadError',
    defaultMessage: 'The Trash could not be loaded — {error}',
  },
  trashEmpty: {
    id: 'documents.documentsView.trashEmpty',
    defaultMessage:
      'The Trash is empty. A document you delete from the register lands here, keeps its extraction, and can be restored until somebody deletes it for good.',
  },
  trashFooter: {
    id: 'documents.documentsView.trashFooter',
    defaultMessage: '{count, plural, one {# document in Trash} other {# documents in Trash}} — restorable until deleted for good',
  },
  /**
   * A refusal from `POST …/deletion` or `…/restoration` — the SERVER's sentence
   * and the SERVER's `NT-` code, through `errorLabel`, which keeps the code in
   * front of the words. Nothing here restates what the server said, and no
   * client-side rule pre-empts it.
   */
  lifecycleFailed: {
    id: 'documents.documentsView.lifecycleFailed',
    defaultMessage: 'Stopped at “{supplier}” — {error}. Anything before it went through.',
  },
  lifecycleWorking: { id: 'documents.documentsView.lifecycleWorking', defaultMessage: 'Working…' },
});

type ExpiryFilter = 'all' | 'expiring' | 'expired' | 'none';

export function DocumentsView() {
  const {
    documents, vault, clients, updateDocumentStatus, moveDocuments, deleteDocuments, addVaultDocument,
    updateVaultDocument, deleteVaultDocument, moveVaultDocument, logAudit,
    documentsSource, documentsLoading, documentsError, refetchDocuments, slices, settings,
    isSameClient, serverClientIdFor, clientNameFor,
  } = useAppContext();

  const [tab, setTab] = useState<Tab>('All');
  const tabStripRef = useScrollActiveIntoView<HTMLDivElement>(tab);
  const confirm = useConfirm();
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [clientFilter, setClientFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | DocStatus>('all');
  const [yearFilter, setYearFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [accessFilter, setAccessFilter] = useState('all');
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [groupByClient, setGroupByClient] = useState(true);

  /** Which document the viewer is on, by id — never by index, because the 5 s
   *  poll reorders the list under it and an index would silently walk to a
   *  different document while somebody was reading one. */
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [vaultPreview, setVaultPreview] = useState<VaultDocument | null>(null);
  /** The purge dialog's selection — live only; synthetic purges through `confirm`. */
  const [purging, setPurging] = useState<Document[] | null>(null);
  /**
   * Synthetic Trash. It is deliberately LOCAL and not a new AppContext field:
   * the context is ~90 kB of source that wraps every route and can never be
   * split out, so a demo-only array there is bytes on the shared floor for
   * every screen in the product. Live, the Trash is the server's
   * (`GET /documents?deleted=true`) and this array is never read.
   */
  const [trashedIds, setTrashedIds] = useState<string[]>([]);
  /** A refusal from the delete/restore calls — the server's own words and code. */
  const [lifecycleError, setLifecycleError] = useState<{ supplier: string; error: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([clients[0]?.id ?? '']);
  const [moveTarget, setMoveTarget] = useState<{ ids: string[]; kind: 'doc' | 'vault' } | null>(null);
  /**
   * A live move is a `document.route` proposal per selected document, walked
   * one at a time through the same Review → Approve card InboxesView uses —
   * never the local `moveDocuments` flip, which the next poll would revert.
   */
  const [routing, setRouting] = useState<
    { request: CreateActionProposalRequest; clientId: string; clientName: string; remaining: string[] } | null
  >(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const live = documentsSource === 'api';

  /**
   * The Trash listing (`GET /documents?deleted=true`).
   *
   * Enabled for the whole screen and not only for its own tab, because the
   * header count is one of the four figures the summary line makes — a Trash
   * count that only becomes true once you open the Trash is the same defect as
   * a register that only counted published documents.
   *
   * It does not poll: nothing outside this browser moves a document INTO the
   * Trash, so a five-second round trip would buy nothing. Every delete and
   * every restore invalidates it by hand instead.
   */
  const trash = useDeletedDocuments({ enabled: live, clientNameFor });
  const trashError = live ? (trash.contractError ?? errorLabel(trash.error)) : null;

  /**
   * ⚠ **The header's counts are the SERVER's now** (`GET /documents/counts`),
   * and that endpoint exists because they were not true before it.
   * `PageInfo` carries no total — keyset pagination has none to carry, and
   * Governance §3 forbids offsets — so `total` could only ever be produced here
   * by walking every page, while `archived`, `inVault` and `expiring` were
   * derived client-side from data that had not been fetched. A decorative
   * number on a screen an accountant reconciles against is worse than no
   * number.
   *
   * The local derivations stay as the fallback for the moment before the
   * endpoint answers, and as the whole answer in synthetic mode — there the
   * seeded arrays genuinely ARE every document. `deleted` is the one count with
   * no honest local derivation live, so it is null until the server says.
   */
  const counts = useDocumentCounts({ enabled: live, expiringWithinDays: EXPIRY_SOON_DAYS });
  const serverCounts = live ? counts.counts : null;
  const trashCount = live ? (serverCounts?.deleted ?? null) : trashedIds.length;

  /**
   * Live, the server already withholds deleted rows from the register — the
   * filter is `deleted=true` and its absence means the opposite. Synthetic,
   * that is this array's job.
   */
  const visible = useMemo(
    () => (live ? documents : documents.filter((d) => !trashedIds.includes(d.id))),
    [live, documents, trashedIds],
  );

  const trashRows = useMemo(
    () => (live ? trash.documents : documents.filter((d) => trashedIds.includes(d.id))),
    [live, trash.documents, documents, trashedIds],
  );

  /** The Trash answers the same filters the register does — a Trash you cannot search is a bin. */
  const trashFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return trashRows.filter((d) => {
      if (clientFilter !== 'all' && !isSameClient(d.clientId, clientFilter)) return false;
      if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
      if (sourceFilter !== 'all' && d.source !== sourceFilter) return false;
      if (statusFilter !== 'all' && d.status !== statusFilter) return false;
      if (!q) return true;
      return [d.supplier, d.clientName, d.category, d.uploader, d.source, String(d.total)]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [trashRows, query, clientFilter, categoryFilter, sourceFilter, statusFilter, isSameClient]);

  /** Archive = processed historical evidence. Full-text, not just supplier search. */
  const archived = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visible.filter((d) => {
      if (d.status !== 'published') return false;
      if (clientFilter !== 'all' && d.clientId !== clientFilter) return false;
      if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
      if (sourceFilter !== 'all' && d.source !== sourceFilter) return false;
      if (!q) return true;
      const haystack = [
        d.supplier, d.clientName, d.category, d.uploader, d.source, String(d.total),
        ...d.fields.map((f) => `${f.label} ${f.value}`),
        ...d.lineItems.map((l) => l.description),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [visible, query, clientFilter, categoryFilter, sourceFilter]);

  /**
   * The register: EVERY document the practice holds, whatever its state —
   * still processing, waiting on review, ready, published or failed. This is
   * the scope the screen opens on, because a document that arrived by email,
   * WhatsApp, the portal or upload exists here long before it is published,
   * and a view that shows only the published ones reads as "nothing arrived".
   * The client compare is the tolerant one (METH S14 bridge): live rows carry
   * opaque business ids while the filter may still key by seed id.
   */
  const allDocs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visible.filter((d) => {
      if (clientFilter !== 'all' && !isSameClient(d.clientId, clientFilter)) return false;
      if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
      if (sourceFilter !== 'all' && d.source !== sourceFilter) return false;
      if (statusFilter !== 'all' && d.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [
        d.supplier, d.clientName, d.category, d.uploader, d.source, String(d.total),
        ...d.fields.map((f) => `${f.label} ${f.value}`),
        ...d.lineItems.map((l) => l.description),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [visible, query, clientFilter, categoryFilter, sourceFilter, statusFilter, isSameClient]);

  /**
   * ⚠ The viewer pages through the rows CURRENTLY ON SCREEN, in the tab's own
   * order — not through every document the practice holds. An accountant who
   * has filtered to one client and one month is walking that stack; sending
   * them into somebody else's paperwork on the next arrow press would be the
   * screen quietly widening the scope they set.
   */
  const viewerRows = tab === 'Trash' ? trashFiltered : tab === 'Archive' ? archived : allDocs;
  const viewerIndex = viewerId === null ? -1 : viewerRows.findIndex((d) => d.id === viewerId);

  const vaultDocs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vault.filter((v) => {
      if (clientFilter !== 'all' && v.clientId !== clientFilter) return false;
      if (categoryFilter !== 'all' && v.category !== categoryFilter) return false;
      if (yearFilter !== 'all' && v.financialYear !== yearFilter) return false;
      if (accessFilter !== 'all' && v.access !== accessFilter) return false;
      if (tagFilter !== 'all' && !v.tags.includes(tagFilter)) return false;
      if (ownerFilter === 'firm' && v.ownerKind !== 'firm') return false;
      if (ownerFilter !== 'all' && ownerFilter !== 'firm' && v.ownerName !== ownerFilter) return false;
      if (expiryFilter === 'none' && v.daysToExpiry !== undefined) return false;
      if (expiryFilter === 'expired' && !(v.daysToExpiry !== undefined && v.daysToExpiry <= 0)) return false;
      if (expiryFilter === 'expiring' && !(v.daysToExpiry !== undefined && v.daysToExpiry > 0 && v.daysToExpiry <= 14)) return false;
      if (!q) return true;
      return `${v.name} ${v.summary} ${v.tags.join(' ')} ${v.category} ${v.clientName} ${v.ownerName}`.toLowerCase().includes(q);
    });
  }, [vault, query, clientFilter, categoryFilter, yearFilter, accessFilter, tagFilter, ownerFilter, expiryFilter]);

  const expiringCount = vault.filter((v) => v.daysToExpiry !== undefined && v.daysToExpiry <= EXPIRY_SOON_DAYS).length;

  // Filter option lists, derived so they only ever offer what exists.
  const archiveCategories = useMemo(
    () => [...new Set(documents.filter((d) => d.status === 'published').map((d) => d.category))].filter(Boolean).sort(),
    [documents],
  );
  const archiveSources = useMemo(
    () => [...new Set(documents.filter((d) => d.status === 'published').map((d) => d.source))].sort(),
    [documents],
  );
  // The register's option lists come off every document, not just the
  // published ones — same idiom as above: only ever offer what exists.
  // '—' is the mapper's "not extracted yet" placeholder, not a category.
  const allCategories = useMemo(
    () => [...new Set(documents.map((d) => d.category))].filter((c) => Boolean(c) && c !== '—').sort(),
    [documents],
  );
  const allSources = useMemo(() => [...new Set(documents.map((d) => d.source))].sort(), [documents]);
  const allStatuses = useMemo(
    () => STATUS_ORDER.filter((s) => documents.some((d) => d.status === s)),
    [documents],
  );
  const vaultYears = useMemo(() => [...new Set(vault.map((v) => v.financialYear))].sort(), [vault]);
  const vaultTags = useMemo(() => [...new Set(vault.flatMap((v) => v.tags))].sort(), [vault]);
  const vaultOwners = useMemo(
    () => [...new Set(vault.filter((v) => v.ownerKind === 'accountant').map((v) => v.ownerName))].sort(),
    [vault],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, VaultDocument[]>>();
    vaultDocs.forEach((v) => {
      if (!map.has(v.clientId)) map.set(v.clientId, new Map());
      const years = map.get(v.clientId)!;
      const key = v.financialYear;
      if (!years.has(key)) years.set(key, []);
      years.get(key)!.push(v);
    });
    return map;
  }, [vaultDocs]);

  /** Archive rows filed under their client, which is how a practice thinks. */
  const archiveByClient = useMemo(() => {
    const map = new Map<string, Document[]>();
    archived.forEach((d) => {
      if (!map.has(d.clientId)) map.set(d.clientId, []);
      map.get(d.clientId)!.push(d);
    });
    return map;
  }, [archived]);

  const filtersActive =
    clientFilter !== 'all' || categoryFilter !== 'all' || sourceFilter !== 'all' || statusFilter !== 'all' ||
    yearFilter !== 'all' ||
    ownerFilter !== 'all' || accessFilter !== 'all' || expiryFilter !== 'all' || tagFilter !== 'all' || query !== '';

  /**
   * While a filter is on, every group holding a match is open. Leaving them
   * collapsed makes a working filter look like it found nothing.
   */
  const isOpen = (clientId: string) => filtersActive || expanded.includes(clientId);

  const resetFilters = () => {
    setQuery(''); setClientFilter('all'); setCategoryFilter('all'); setSourceFilter('all'); setStatusFilter('all');
    setYearFilter('all'); setOwnerFilter('all'); setAccessFilter('all'); setExpiryFilter('all'); setTagFilter('all');
  };

  /**
   * One `document.route` proposal per document, walked one at a time — the
   * exact shape InboxesView uses. The inbox in the payload is the document's
   * own kind, because unlike the Inboxes screen this register mixes both.
   */
  const routeRequestFor = (documentId: string, clientId: string): CreateActionProposalRequest => ({
    kind: 'document.route',
    businessId: null,
    payload: {
      documentId,
      inbox: documents.find((d) => d.id === documentId)?.kind === 'sales' ? 'SALES' : 'COSTS',
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

  /* ── delete, Trash and restore ─────────────────────────────────────────────
     ⚠ Two acts, two shapes, and the difference is the whole design.

     Soft-delete and restore are ORDINARY CALLS (`POST …/deletion`,
     `POST …/restoration`) because they are reversible in both directions: the
     server keeps the row and the original either way, so there is nothing for a
     Review → Approve to protect and a proposal in front of them would be
     ceremony that teaches nothing. Permanent deletion is not reversible, and it
     goes through the one door — `PurgeDocumentsDialog`, below.

     A refusal is the SERVER's: `errorLabel` puts the `NT-` code in front of the
     server's own sentence and this screen adds nothing to it. No rule here
     decides what may be deleted. */

  /** Walk a batch through one of the two calls, then re-read both lists. */
  const runLifecycle = async (docs: Document[], op: (id: string) => Promise<void>) => {
    setWorking(true);
    setLifecycleError(null);
    const result = await applyToEach(docs.map((d) => d.id), op);
    if (result.failedId !== null) {
      const failed = docs.find((d) => d.id === result.failedId);
      setLifecycleError({
        supplier: failed?.supplier ?? result.failedId,
        error: errorLabel(result.error) ?? '',
      });
    }
    refetchDocuments();
    await refreshTrash(queryClient);
    setWorking(false);
    return result.done.length;
  };

  const trashDocuments = async (sel: Document[]) => {
    if (sel.length === 0) return;
    const ok = await confirm({
      // ⚠ NOT `red`. This act is reversible and the confirmation says so; a
      // scary warning over a reversible act is how people learn to click
      // through the one that is not.
      tone: 'brand',
      title: intl.formatMessage(m.trashTitle, { count: sel.length }),
      detail: sel.map((d) => d.supplier).slice(0, 4).join(' · ') || intl.formatMessage(m.deleteDocsFallback),
      consequence: intl.formatMessage(m.trashConsequence),
      confirmLabel: intl.formatMessage(m.trashConfirm),
    });
    if (!ok) return;

    if (!live) {
      setTrashedIds((prev) => [...prev, ...sel.map((d) => d.id).filter((id) => !prev.includes(id))]);
    } else if ((await runLifecycle(sel, softDeleteDocument)) === 0) {
      return;
    }
    setViewerId(null);
    logAudit({
      action: intl.formatMessage(m.trashAudit),
      scope: intl.formatMessage(m.trashAuditScope, { count: sel.length }),
      reviewOpened: true,
    });
  };

  /** Restore needs no confirmation: it undoes something, and it is itself undoable. */
  const restoreDocuments = async (sel: Document[]) => {
    if (sel.length === 0) return;
    if (!live) setTrashedIds((prev) => prev.filter((id) => !sel.some((d) => d.id === id)));
    else if ((await runLifecycle(sel, restoreDocument)) === 0) return;
    setViewerId(null);
    logAudit({
      action: intl.formatMessage(m.restoreAudit),
      scope: intl.formatMessage(m.trashAuditScope, { count: sel.length }),
      reviewOpened: true,
    });
  };

  /**
   * Permanent deletion. Live it is a `document.purge` proposal and NOTHING
   * else — create → Read review → Approve, in the dialog. Synthetic there is
   * no server to propose to, so the local `deleteDocuments` really is the
   * source of truth and a red confirm is the honest gate in front of it.
   */
  const purgeDocuments = async (sel: Document[]) => {
    if (sel.length === 0) return;
    if (live) {
      setPurging(sel);
      return;
    }
    const ok = await confirm({
      tone: 'red',
      title: intl.formatMessage(m.purgeTitle, { count: sel.length }),
      detail: sel.map((d) => d.supplier).slice(0, 4).join(' · ') || intl.formatMessage(m.deleteDocsFallback),
      consequence: intl.formatMessage(m.purgeConsequence),
      confirmLabel: intl.formatMessage(m.purgeConfirm),
    });
    if (!ok) return;
    const ids = sel.map((d) => d.id);
    deleteDocuments(ids);
    setTrashedIds((prev) => prev.filter((id) => !ids.includes(id)));
    setViewerId(null);
    logAudit({
      action: intl.formatMessage(m.purgeAudit),
      scope: intl.formatMessage(m.trashAuditScope, { count: sel.length }),
      reviewOpened: true,
    });
  };

  /** The per-row door onto the same two acts, so a single document needs no selection at all. */
  const rowActionsColumn = (kind: 'register' | 'trash'): Column<Document> => ({
    key: 'actions',
    label: intl.formatMessage(m.columnActions),
    card: 'actions',
    render: (d) => (
      <div className="flex items-center justify-end gap-1.5">
        {kind === 'trash' ? (
          <RowIconButton
            label={intl.formatMessage(m.restoreRowLabel, { supplier: d.supplier })}
            onClick={() => void restoreDocuments([d])}
            icon={RotateCcw}
          />
        ) : (
          <RowIconButton
            label={intl.formatMessage(m.trashRowLabel, { supplier: d.supplier })}
            onClick={() => void trashDocuments([d])}
            icon={Trash2}
          />
        )}
      </div>
    ),
  });

  const archiveColumns: Column<Document>[] = [
    { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
    ...(groupByClient ? [] : [{ key: 'clientName', label: intl.formatMessage(commonLabels.client), sortValue: (d: Document) => d.clientName }]),
    { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (d) => d.date },
    { key: 'category', label: intl.formatMessage(commonLabels.category), sortValue: (d) => d.category },
    { key: 'source', label: intl.formatMessage(m.columnSource), sortValue: (d) => d.source, render: (d) => <Pill>{d.source}</Pill> },
    { key: 'uploader', label: intl.formatMessage(m.columnUploader), sortValue: (d) => d.uploader },
    { key: 'total', label: intl.formatMessage(commonLabels.total), align: 'right', sortValue: (d) => d.total, render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total, d.currency)}</span> },
  ];

  /**
   * Unarchive and move are local flips the live poll reverts — off live rows
   * (METH S14 sweep); a published document is locked server-side anyway. The
   * client-side export is real either way.
   */
  const syntheticArchiveActions = [
    {
      label: intl.formatMessage(m.unarchiveAction),
      icon: Archive,
      onClick: async (sel: Document[]) => {
        const ok = await confirm({
          tone: 'red',
          title: intl.formatMessage(m.unarchiveTitle, { count: sel.length }),
          detail: intl.formatMessage(m.unarchiveDetail),
          consequence: intl.formatMessage(m.unarchiveConsequence),
          confirmLabel: intl.formatMessage(m.unarchiveConfirm),
        });
        if (!ok) return;
        sel.forEach((d) => updateDocumentStatus(d.id, 'ready'));
        logAudit({
          action: intl.formatMessage(m.unarchiveAudit),
          scope: intl.formatMessage(m.unarchiveAuditScope, { count: sel.length }),
          reviewOpened: true,
        });
      },
    },
    { label: intl.formatMessage(m.moveToClientAction), icon: ArrowRightLeft, onClick: (sel: Document[]) => setMoveTarget({ ids: sel.map((d) => d.id), kind: 'doc' as const }) },
  ];

  /**
   * ⚠ **Two export doors, one rule, and the rule is the filename.**
   *
   * Both tabs offer the same client-side CSV of the rows you are looking at,
   * and **neither is the D42/D43 export** — that is `ExportView`, which serves
   * only Published documents and produces the VT import file plus resolvable
   * links to the sources. What was wrong here was not the offer but the label
   * on the tin: the register's export wrote **`archive.csv`**, so selecting
   * `processing`, `review` or `rejected` rows produced a file whose name says
   * they had been published and released. The archive tab's rows really are all
   * `published` (`:297`), so there the name is true; on the register it was a
   * claim about state made by a filename nobody re-reads.
   *
   * So: the file is named after the table it came from, and the register's
   * carries a **Status** column — a dump that omits the one column that
   * distinguishes these rows is what let them pass as archived evidence.
   * Gating the register to Published instead was the other option and is worse:
   * the whole point of this tab is every state, and an accountant who wants the
   * published subset can say so in the filter above and export that.
   */
  const archiveExportAction = {
    label: intl.formatMessage(commonActions.exportCsv), icon: Download, primary: true, minSelected: 2,
    disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel: Document[]) => exportDocs(sel, 'archive.csv'),
  };

  const registerExportAction = {
    label: intl.formatMessage(commonActions.exportCsv), icon: Download, minSelected: 2,
    disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel: Document[]) => exportDocs(sel, 'documents.csv'),
  };

  /**
   * ⚠ **Delete is offered in BOTH modes now, and that is the point of this
   * change.** It used to be synthetic-only, and the comment said why: "no
   * delete endpoint exists, so live the row would only come back with the next
   * poll (METH S14)". The endpoint exists — `POST …/deletion` soft-deletes into
   * Trash — so the S14 rule is satisfied by giving the button a real path
   * rather than by hiding it. The poll no longer reverts anything: the server
   * stops listing the row, and the Trash tab starts.
   */
  const trashAction = {
    label: intl.formatMessage(m.trashAction),
    icon: Trash2,
    onClick: (sel: Document[]) => void trashDocuments(sel),
  };

  const archiveActions = documentsSource === 'api'
    ? [trashAction, archiveExportAction]
    : [...syntheticArchiveActions, trashAction, archiveExportAction];

  /** The Trash tab's own two, and nothing else — no export of deleted rows. */
  const trashActions = [
    {
      label: intl.formatMessage(m.restoreAction),
      icon: RotateCcw,
      primary: true,
      onClick: (sel: Document[]) => void restoreDocuments(sel),
    },
    {
      label: intl.formatMessage(m.purgeAction),
      icon: Trash2,
      onClick: (sel: Document[]) => void purgeDocuments(sel),
    },
  ];

  /**
   * The register's columns: the archive's, plus the client always (a mixed
   * list is meaningless without it) and the state the document is actually in.
   * A row with no client is honest about it — that is the row Move to client
   * exists for.
   */
  const allColumns: Column<Document>[] = [
    { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
    {
      key: 'clientName',
      label: intl.formatMessage(commonLabels.client),
      sortValue: (d: Document) => d.clientName,
      render: (d) => (d.clientName ? <span>{d.clientName}</span> : <Pill tone="amber">{intl.formatMessage(m.unassignedClient)}</Pill>),
    },
    { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (d) => d.date },
    { key: 'category', label: intl.formatMessage(commonLabels.category), sortValue: (d) => d.category },
    {
      key: 'status',
      label: intl.formatMessage(commonLabels.status),
      sortValue: (d) => STATUS_ORDER.indexOf(d.status),
      render: (d) => (
        <Pill tone={STATUS_TONE[d.status]} {...(d.statusNote === undefined ? {} : { title: d.statusNote })}>
          {intl.formatMessage(STATUS_LABEL[d.status])}
        </Pill>
      ),
    },
    { key: 'source', label: intl.formatMessage(m.columnSource), sortValue: (d) => d.source, render: (d) => <Pill>{d.source}</Pill> },
    { key: 'uploader', label: intl.formatMessage(m.columnUploader), sortValue: (d) => d.uploader },
    { key: 'total', label: intl.formatMessage(commonLabels.total), align: 'right', sortValue: (d) => d.total, render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total, d.currency)}</span> },
    rowActionsColumn('register'),
  ];

  /** The Trash's columns: the register's, minus the actions, plus its own. */
  const trashColumns: Column<Document>[] = [
    ...allColumns.slice(0, -1),
    rowActionsColumn('trash'),
  ];

  /**
   * Move to client is offered live AND synthetic, because both paths are real:
   * the picker modal branches — synthetic it is the local `moveDocuments`,
   * live it opens a `document.route` proposal per document (Review → Approve
   * is the confirmation, exactly as InboxesView's bulk move).
   *
   * ⚠ **Neither of these two was ever gated by live mode, and the report that
   * they "are both greyed out" had a different cause.** `DataTable` disables a
   * bulk action while the selection is smaller than the action needs — one row
   * for Move to client, two for Export CSV (a CSV of one row is a worse way to
   * read a document that has its own viewer) — so on an untouched screen every
   * action is off because NOTHING IS SELECTED. The only explanation offered was
   * a hover `title`, invisible on a phone and unfindable on a desktop unless
   * you already knew the answer. `DataTable` now says it under the bar, and
   * names the shift-click range while it is there.
   */
  const moveAllAction = {
    label: intl.formatMessage(m.moveToClientAction),
    icon: ArrowRightLeft,
    onClick: (sel: Document[]) => setMoveTarget({ ids: sel.map((d) => d.id), kind: 'doc' as const }),
  };

  const allActions = [moveAllAction, trashAction, registerExportAction];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header className="px-4 md:px-10 pt-4 md:pt-8 pb-4 md:pb-5 shrink-0">
        {/* Loading and failure said out loud (METH S14 sweep, hardened by
            launch M2): a failed load shows what is really known — nothing —
            with a retry, never seed rows impersonating the archive. */}
        {documentsSource === 'api' && (documentsLoading || documentsError) && (
          <div
            className={`mb-4 flex items-center gap-3 px-5 py-3 rounded-2xl border text-[13px] font-semibold ${
              documentsError
                ? 'bg-red-500/10 border-red-500/20 text-red-300'
                : 'bg-white/[0.03] border-white/10 text-zinc-400'
            }`}
          >
            <AlertTriangle size={15} className="shrink-0" />
            <span className="min-w-0">
              {documentsError
                ? intl.formatMessage(m.documentsError, { error: documentsError })
                : intl.formatMessage(m.documentsLoading)}
            </span>
            <DataSourceBadge slice="documents" status={slices.documents} onRetry={refetchDocuments} />
          </div>
        )}

        {/* A batch in flight. `aria-live` because the only other signal is
            rows disappearing, which a screen reader does not announce. */}
        {working && (
          <p aria-live="polite" className="mb-4 text-[13px] font-semibold text-zinc-400">
            {intl.formatMessage(m.lifecycleWorking)}
          </p>
        )}

        {/* A delete or a restore the server refused. `errorLabel` keeps the
            `NT-` code in front of the server's own sentence, and the batch
            says where it stopped — the documents before it really did move. */}
        {lifecycleError !== null && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-3 px-5 py-3 rounded-2xl border text-[13px] font-semibold bg-red-500/10 border-red-500/20 text-red-300"
          >
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span className="min-w-0">
              {intl.formatMessage(m.lifecycleFailed, {
                supplier: lifecycleError.supplier,
                error: lifecycleError.error,
              })}
            </span>
            <button
              onClick={() => setLifecycleError(null)}
              aria-label={intl.formatMessage(commonActions.close)}
              className="ml-auto shrink-0 text-red-300 hover:text-white transition-colors"
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
              <FileText size={22} />
            </div>
            <div>
              <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {/* The counts are over the WHOLE register, not a page of it —
                    `api/paged.ts` follows the cursor to the end, so `documents`
                    really is every document. Trash joins them the moment the
                    server answers for it, and is left off entirely until then
                    rather than printed as a zero nobody measured. */}
                {trashCount === null
                  ? intl.formatMessage(m.summary, {
                      total: serverCounts?.total ?? visible.length,
                      archived: serverCounts?.archived ?? archived.length,
                      vault: serverCounts?.inVault ?? vault.length,
                      expiring: serverCounts?.expiring ?? expiringCount,
                    })
                  : intl.formatMessage(m.summaryWithTrash, {
                      total: serverCounts?.total ?? visible.length,
                      archived: serverCounts?.archived ?? archived.length,
                      vault: serverCounts?.inVault ?? vault.length,
                      expiring: serverCounts?.expiring ?? expiringCount,
                      trash: trashCount,
                    })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative w-full sm:w-auto">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={intl.formatMessage(tab === 'All' ? m.searchAll : tab === 'Archive' ? m.searchArchive : m.searchVault)}
                className="w-full sm:w-72 bg-card border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-brand placeholder:text-zinc-600 text-white font-medium shadow-inner"
              />
            </div>
            {tab === 'Vault' && (
              <>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
                >
                  <UploadCloud size={16} />
                  {intl.formatMessage(m.addToVault)}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    const target = clientFilter === 'all' ? clients[0]?.id : clientFilter;
                    if (f && target) {
                      addVaultDocument(target, 'Contracts', f.name, Math.round(f.size / 1024));
                      logAudit({ action: intl.formatMessage(m.addToVaultAudit), scope: f.name, reviewOpened: true });
                    }
                    e.target.value = '';
                  }}
                />
              </>
            )}
          </div>
        </div>
      </header>

      <div ref={tabStripRef} data-tour="documents-tabs" className="px-4 md:px-10 pb-4 flex items-center gap-2 shrink-0 scroll-x [&>button]:shrink-0 [&>button]:whitespace-nowrap">
        {TABS.map((t) => (
          <button
            key={t}
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border ${
              tab === t
                ? 'bg-brand text-white border-brand shadow-glow-pill'
                : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {intl.formatMessage(TAB_LABEL[t])}
          </button>
        ))}
      </div>

      {/* Filters. Every file is filed under a client, so that one is always
          offered; the rest follow whichever shelf you are looking at. */}
      <div className="px-4 md:px-10 pb-5 flex items-center gap-2 flex-wrap shrink-0">
        <FilterSelect
          value={clientFilter}
          onChange={setClientFilter}
          options={[{ value: 'all', label: intl.formatMessage(m.filterAllClients) }, ...clients.map((c) => ({ value: c.id, label: c.name }))]}
        />
        <FilterSelect
          value={categoryFilter}
          onChange={setCategoryFilter}
          options={[
            { value: 'all', label: intl.formatMessage(m.filterAllCategories) },
            // Document categories come off the documents themselves, so they
            // are data; the vault's shelves are a fixed list, so they are copy.
            ...(tab === 'Vault'
              ? VAULT_CATEGORIES.map((c) => ({ value: c, label: intl.formatMessage(VAULT_CATEGORY_LABEL[c]) }))
              : (tab === 'All' ? allCategories : archiveCategories).map((c) => ({ value: c, label: c }))),
          ]}
        />

        {tab !== 'Vault' ? (
          <>
            <FilterSelect
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAllChannels) },
                ...(tab === 'All' ? allSources : archiveSources).map((s) => ({ value: s, label: s })),
              ]}
            />
            {tab === 'All' && (
              <FilterSelect
                value={statusFilter}
                onChange={(v) => setStatusFilter(v as 'all' | DocStatus)}
                options={[
                  { value: 'all', label: intl.formatMessage(m.filterAllStatuses) },
                  ...allStatuses.map((s) => ({ value: s, label: intl.formatMessage(STATUS_LABEL[s]) })),
                ]}
              />
            )}
            {tab === 'Archive' && (
              <button
                onClick={() => setGroupByClient((g) => !g)}
                className={`px-4 py-2 rounded-full text-[13px] font-bold border transition-all ${
                  groupByClient ? 'bg-brand/10 text-brand border-brand/30' : 'bg-card text-zinc-400 border-white/5 hover:text-white'
                }`}
              >
                {intl.formatMessage(m.groupByClient)}
              </button>
            )}
          </>
        ) : (
          <>
            <FilterSelect
              value={yearFilter}
              onChange={setYearFilter}
              options={[{ value: 'all', label: intl.formatMessage(m.filterAllYears) }, ...vaultYears.map((y) => ({ value: y, label: y }))]}
            />
            <FilterSelect
              value={ownerFilter}
              onChange={setOwnerFilter}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAnyOwner) },
                { value: 'firm', label: intl.formatMessage(m.filterFirmOwned, { practice: settings.practiceName || '—' }) },
                ...vaultOwners.map((o) => ({ value: o, label: intl.formatMessage(m.filterOwnedBy, { owner: o }) })),
              ]}
            />
            <FilterSelect
              value={expiryFilter}
              onChange={(v) => setExpiryFilter(v as ExpiryFilter)}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAnyExpiry) },
                {
                  value: 'expiring',
                  label: intl.formatMessage(m.filterExpiringSoon, {
                    count: vault.filter((v) => v.daysToExpiry !== undefined && v.daysToExpiry > 0 && v.daysToExpiry <= 14).length,
                  }),
                },
                {
                  value: 'expired',
                  label: intl.formatMessage(m.filterExpired, {
                    count: vault.filter((v) => v.daysToExpiry !== undefined && v.daysToExpiry <= 0).length,
                  }),
                },
                { value: 'none', label: intl.formatMessage(m.filterNoExpiry) },
              ]}
            />
            <FilterSelect
              value={accessFilter}
              onChange={setAccessFilter}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAnyVisibility) },
                { value: 'practice', label: intl.formatMessage(m.filterPracticeOnly) },
                { value: 'client-visible', label: intl.formatMessage(m.filterClientVisible) },
              ]}
            />
            <FilterSelect
              value={tagFilter}
              onChange={setTagFilter}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAnyTag) },
                ...vaultTags.map((t) => ({ value: t, label: intl.formatMessage(m.filterTag, { tag: t }) })),
              ]}
            />
          </>
        )}

        {filtersActive && (
          <button
            onClick={resetFilters}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
          >
            <RotateCcw size={13} />
            {intl.formatMessage(m.clearFilters)}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'All' && (
            <DataTable<Document>
              className="max-w-none"
              columns={allColumns}
              rows={allDocs}
              rowId={(d) => d.id}
              selectable
              onRowClick={(d) => setViewerId(d.id)}
              emptyMessage={intl.formatMessage(
                query ? m.allEmptySearch : filtersActive ? m.allEmptyFiltered : m.allEmpty,
              )}
              bulkActions={allActions}
              footer={intl.formatMessage(m.allFooter, { count: allDocs.length })}
            />
          )}

          {tab === 'Archive' && !groupByClient && (
            <DataTable<Document>
              className="max-w-none"
              columns={archiveColumns}
              rows={archived}
              rowId={(d) => d.id}
              selectable
              onRowClick={(d) => setViewerId(d.id)}
              emptyMessage={intl.formatMessage(query ? m.archiveEmptySearch : m.archiveEmpty)}
              bulkActions={archiveActions}
              footer={intl.formatMessage(m.archiveFooter, { count: archived.length })}
            />
          )}

          {tab === 'Archive' && groupByClient && (
            <div className="flex flex-col gap-4">
              {[...archiveByClient.entries()].map(([clientId, docs]) => {
                const client = clients.find((c) => c.id === clientId);
                const open = isOpen(clientId);
                return (
                  <div key={clientId} className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
                    <button
                      onClick={() => setExpanded((p) => (p.includes(clientId) ? p.filter((x) => x !== clientId) : [...p, clientId]))}
                      className="w-full p-5 flex items-center gap-4 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      {open ? <ChevronDown size={18} className="text-zinc-500" /> : <ChevronRight size={18} className="text-zinc-500" />}
                      <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center font-bold text-white shrink-0 overflow-hidden">
                        {client?.logoDataUrl ? <img src={client.logoDataUrl} alt="" className="w-full h-full object-cover" /> : client?.name.charAt(0)}
                      </div>
                      <span className="font-sans font-bold text-lg text-white tracking-tight">
                        {client?.name ?? intl.formatMessage(m.unassignedClient)}
                      </span>
                      <span className="ml-auto text-[12px] text-zinc-600 font-semibold">
                        {intl.formatMessage(m.groupCount, { count: docs.length })}
                      </span>
                    </button>
                    {open && (
                      <div className="border-t border-white/5 p-4">
                        <DataTable<Document>
                          className="max-w-none"
                          columns={archiveColumns}
                          rows={docs}
                          rowId={(d) => d.id}
                          selectable
                          onRowClick={(d) => setViewerId(d.id)}
                          emptyMessage={intl.formatMessage(m.archiveEmptyForClient)}
                          bulkActions={archiveActions}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              {archiveByClient.size === 0 && (
                <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center text-zinc-500">
                  {intl.formatMessage(query || filtersActive ? m.archiveEmptyFiltered : m.archiveEmpty)}
                </div>
              )}
            </div>
          )}

          {tab === 'Vault' && (
            <div className="flex flex-col gap-4">
              <div className="text-[12px] text-zinc-500 font-semibold flex items-center gap-2">
                <FolderTree size={14} />
                {intl.formatMessage(m.vaultTree)}
              </div>

              {[...grouped.entries()].map(([clientId, years]) => {
                const client = clients.find((c) => c.id === clientId);
                const open = isOpen(clientId);
                const count = [...years.values()].reduce((n, list) => n + list.length, 0);
                return (
                  <div key={clientId} className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
                    <button
                      onClick={() => setExpanded((p) => (p.includes(clientId) ? p.filter((x) => x !== clientId) : [...p, clientId]))}
                      className="w-full p-5 flex items-center gap-4 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      {open ? <ChevronDown size={18} className="text-zinc-500" /> : <ChevronRight size={18} className="text-zinc-500" />}
                      <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center font-bold text-white shrink-0 overflow-hidden">
                        {client?.logoDataUrl ? <img src={client.logoDataUrl} alt="" className="w-full h-full object-cover" /> : client?.name.charAt(0)}
                      </div>
                      <span className="font-sans font-bold text-lg text-white tracking-tight">{client?.name}</span>
                      <span className="ml-auto text-[12px] text-zinc-600 font-semibold">
                        {intl.formatMessage(m.groupCount, { count })}
                      </span>
                    </button>

                    {open && (
                      <div className="border-t border-white/5">
                        {[...years.entries()].map(([year, docs]) => (
                          <div key={year} className="px-5 py-4 border-b border-white/5 last:border-0">
                            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{year}</div>
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                              {VAULT_CATEGORIES.filter((cat) => docs.some((d) => d.category === cat)).map((cat) => (
                                <div key={cat} className="rounded-2xl bg-ground/60 border border-white/5 p-4">
                                  <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">
                                    {intl.formatMessage(VAULT_CATEGORY_LABEL[cat])}
                                  </div>
                                  <div className="flex flex-col gap-2.5">
                                    {docs.filter((d) => d.category === cat).map((d) => (
                                      <VaultFileRow key={d.id} doc={d} onPreview={() => setVaultPreview(d)} />
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {grouped.size === 0 && (
                <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center text-zinc-500">
                  {intl.formatMessage(query || filtersActive ? m.vaultEmptyFiltered : m.vaultEmpty)}
                </div>
              )}
            </div>
          )}

          {/* ── Trash: all four states ─────────────────────────────────────
              loading is skeleton rows (rule 5, no spinner on a primary
              surface); a failure says so in plain English WITH the `NT-` code
              and offers a retry; empty teaches what the Trash is for and that
              a document in it is restorable; success is the table. */}
          {tab === 'Trash' && (
            <div className="flex flex-col gap-4">
              {live && (trash.isLoading || trashError !== null) && (
                <div
                  {...(trashError === null ? {} : { role: 'alert' as const })}
                  className={`flex items-center gap-3 px-5 py-3 rounded-2xl border text-[13px] font-semibold ${
                    trashError !== null
                      ? 'bg-red-500/10 border-red-500/20 text-red-300'
                      : 'bg-white/[0.03] border-white/10 text-zinc-400'
                  }`}
                >
                  <AlertTriangle size={15} className="shrink-0" />
                  <span className="min-w-0">
                    {trashError !== null
                      ? intl.formatMessage(m.trashLoadError, { error: trashError })
                      : intl.formatMessage(m.trashLoading)}
                  </span>
                  <DataSourceBadge
                    slice="trash"
                    status={sliceStatus(live, trash)}
                    onRetry={() => void trash.refetch()}
                  />
                </div>
              )}

              {live && trash.isLoading ? (
                <div
                  aria-label={intl.formatMessage(m.trashLoading)}
                  className="border border-white/5 rounded-[32px] bg-card p-6 flex flex-col gap-3"
                >
                  <div className="h-3 w-2/5 rounded bg-white/10 animate-pulse" />
                  <div className="h-3 w-3/5 rounded bg-white/[0.07] animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-white/[0.07] animate-pulse" />
                </div>
              ) : (
                <DataTable<Document>
                  className="max-w-none"
                  columns={trashColumns}
                  rows={trashFiltered}
                  rowId={(d) => d.id}
                  selectable
                  onRowClick={(d) => setViewerId(d.id)}
                  emptyMessage={intl.formatMessage(
                    query ? m.allEmptySearch : filtersActive ? m.allEmptyFiltered : m.trashEmpty,
                  )}
                  bulkActions={trashActions}
                  footer={intl.formatMessage(m.trashFooter, { count: trashFiltered.length })}
                />
              )}
            </div>
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {vaultPreview && (
          <Modal onClose={() => setVaultPreview(null)}>
            <VaultPreview
              doc={vault.find((v) => v.id === vaultPreview.id) ?? vaultPreview}
              onMove={() => setMoveTarget({ ids: [vaultPreview.id], kind: 'vault' })}
              onSetOwner={(kind, name) => {
                // The firm's name is resolved here, from settings, rather than
                // imported from the seed — the seeded practice name must never
                // be written onto a real firm's record (launch M8).
                const ownerName = kind === 'firm' ? settings.practiceName || 'Firm' : name;
                updateVaultDocument(vaultPreview.id, { ownerKind: kind, ownerName });
                logAudit({
                  action: intl.formatMessage(m.ownerAudit),
                  scope: intl.formatMessage(m.ownerAuditScope, { name: vaultPreview.name, owner: ownerName }),
                  reviewOpened: true,
                });
              }}
              onDelete={async () => {
                const ok = await confirm({
                  tone: 'red',
                  title: intl.formatMessage(m.deleteTitle, { name: vaultPreview.name }),
                  detail: intl.formatMessage(m.deleteDetail, {
                    category: intl.formatMessage(VAULT_CATEGORY_LABEL[vaultPreview.category]),
                    owner: vaultPreview.ownerName,
                  }),
                  consequence: intl.formatMessage(
                    vaultPreview.tags.includes('permanent') || vaultPreview.tags.includes('statutory')
                      ? m.deleteConsequenceProtected
                      : m.deleteConsequence,
                  ),
                  confirmLabel: intl.formatMessage(m.deleteConfirm),
                });
                if (!ok) return;
                deleteVaultDocument(vaultPreview.id);
                logAudit({ action: intl.formatMessage(m.deleteAudit), scope: vaultPreview.name, reviewOpened: true });
                setVaultPreview(null);
              }}
            />
          </Modal>
        )}

        {moveTarget && (
          <Modal onClose={() => setMoveTarget(null)}>
            <div className="w-full max-w-md border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(m.moveHeading)}</h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  {intl.formatMessage(m.moveCount, { count: moveTarget.ids.length })}
                </p>
                {moveTarget.kind === 'doc' && documentsSource === 'api' && (
                  <p className="text-[12px] text-zinc-500 mt-2 leading-snug">
                    {intl.formatMessage(m.routeProposalNote)}
                  </p>
                )}
              </div>
              <div className="p-4 flex flex-col gap-1">
                {clients.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      if (moveTarget.kind === 'doc' && documentsSource === 'api') {
                        // Review → Approve is the confirmation; the audit trail
                        // is the proposal's own. Same shape as InboxesView.
                        const ids = [...moveTarget.ids];
                        setMoveTarget(null);
                        startRouting(c.id, ids);
                        return;
                      }
                      if (moveTarget.kind === 'doc') moveDocuments(moveTarget.ids, c.id);
                      else moveTarget.ids.forEach((id) => moveVaultDocument(id, c.id));
                      logAudit({
                        action: intl.formatMessage(m.moveAudit),
                        scope: intl.formatMessage(m.moveAuditScope, { count: moveTarget.ids.length, client: c.name }),
                        reviewOpened: true,
                      });
                      setMoveTarget(null);
                      setVaultPreview(null);
                    }}
                    className="px-4 py-3 rounded-2xl text-left hover:bg-white/5 transition-colors"
                  >
                    <div className="text-sm font-bold text-white">{c.name}</div>
                    <div className="text-[12px] text-amber-400 mt-0.5">{intl.formatMessage(m.moveWarning)}</div>
                  </button>
                ))}
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      {/* A live move — one Review → Approve card per selected document. The
          refetch nudge is dynamically imported for the same reason the modal
          is lazy: the uploads client has no business on this route's opening
          download when its one caller here runs after an approve. */}
      <AnimatePresence>
        {routing && (
          <Suspense fallback={null}>
            <ProposalFlowModal
              request={routing.request}
              clientName={routing.clientName}
              onExecuted={() => {
                void import('../api/uploads').then(({ refreshDocuments }) => refreshDocuments(queryClient));
              }}
              onClose={advanceRouting}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* The viewer. `viewerIndex === -1` means the document it was on has left
          the list under it — deleted, restored, or filtered away — so the
          surface closes rather than paging to whatever happens to be first. */}
      <AnimatePresence>
        {viewerIndex !== -1 && (
          <Suspense fallback={null}>
            <DocumentViewer
              documents={viewerRows}
              index={viewerIndex}
              onIndex={(i) => setViewerId(viewerRows[i]?.id ?? null)}
              onClose={() => setViewerId(null)}
              {...(tab === 'Trash'
                ? { onRestore: (d: Document) => void restoreDocuments([d]) }
                : { onDelete: (d: Document) => void trashDocuments([d]) })}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* Permanent deletion — the `document.purge` proposal, and the only path
          to one. Approve is not in the DOM until the server's review returns. */}
      <AnimatePresence>
        {purging !== null && (
          <Suspense fallback={null}>
            <PurgeDocumentsDialog
              selection={purging}
              onClose={() => setPurging(null)}
              onSettled={() => {
                refetchDocuments();
                void refreshTrash(queryClient);
              }}
            />
          </Suspense>
        )}
      </AnimatePresence>
    </div>
  );
}

const rowMessages = defineMessages({
  ownedByPractice: { id: 'documents.vaultFileRow.ownedByPractice', defaultMessage: 'Owned by the practice' },
  ownedBy: { id: 'documents.vaultFileRow.ownedBy', defaultMessage: 'Owned by {owner}' },
  firm: { id: 'documents.vaultFileRow.firm', defaultMessage: 'Firm' },
  expired: { id: 'documents.vaultFileRow.expired', defaultMessage: 'Expired' },
  daysLeft: { id: 'documents.vaultFileRow.daysLeft', defaultMessage: '{days}d' },
  tag: { id: 'documents.vaultFileRow.tag', defaultMessage: '#{tag}' },
  previewLabel: { id: 'documents.vaultFileRow.previewLabel', defaultMessage: 'Preview {name}' },
  preview: { id: 'documents.vaultFileRow.preview', defaultMessage: 'Preview' },
});

/** One file in the vault, with the same explicit preview the archive offers. */
function VaultFileRow({ doc, onPreview }: { doc: VaultDocument; onPreview: () => void }) {
  const intl = useIntl();

  return (
    <div className="group/item flex items-start gap-2">
      <button onClick={onPreview} className="text-left min-w-0 flex-1" title={doc.summary}>
        <div className="text-[13px] font-bold text-white group-hover/item:text-brand transition-colors truncate">
          {doc.name.replace(` — ${doc.clientName}`, '')}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${
              doc.ownerKind === 'firm'
                ? 'text-zinc-400 border-white/10 bg-white/[0.03]'
                : 'text-brand border-brand/25 bg-brand/10'
            }`}
            title={
              doc.ownerKind === 'firm'
                ? intl.formatMessage(rowMessages.ownedByPractice)
                : intl.formatMessage(rowMessages.ownedBy, { owner: doc.ownerName })
            }
          >
            {doc.ownerKind === 'firm' ? <Building2 size={9} /> : <User size={9} />}
            {doc.ownerKind === 'firm' ? intl.formatMessage(rowMessages.firm) : doc.ownerName}
          </span>
          {doc.daysToExpiry !== undefined && (
            <span className={`text-[10px] font-bold ${doc.daysToExpiry <= 0 ? 'text-red-400' : doc.daysToExpiry <= 14 ? 'text-amber-400' : 'text-zinc-600'}`}>
              {doc.daysToExpiry <= 0
                ? intl.formatMessage(rowMessages.expired)
                : intl.formatMessage(rowMessages.daysLeft, { days: doc.daysToExpiry })}
            </span>
          )}
          {doc.access === 'practice' && <Lock size={10} className="text-zinc-600" />}
          {doc.tags.slice(0, 2).map((t) => (
            <span key={t} className="text-[10px] text-zinc-600 font-semibold">
              {intl.formatMessage(rowMessages.tag, { tag: t })}
            </span>
          ))}
        </div>
      </button>
      <button
        onClick={onPreview}
        aria-label={intl.formatMessage(rowMessages.previewLabel, { name: doc.name })}
        title={intl.formatMessage(rowMessages.preview)}
        className="shrink-0 w-7 h-7 rounded-lg border border-white/5 text-zinc-500 hover:text-white hover:border-white/20 flex items-center justify-center transition-colors"
      >
        <Eye size={13} />
      </button>
    </div>
  );
}

const previewMessages = defineMessages({
  meta: { id: 'documents.vaultPreview.meta', defaultMessage: '{client} · {category} · {year} · {size}KB' },
  tag: { id: 'documents.vaultPreview.tag', defaultMessage: '#{tag}' },
  practiceOnly: { id: 'documents.vaultPreview.practiceOnly', defaultMessage: 'Practice only' },
  clientVisible: { id: 'documents.vaultPreview.clientVisible', defaultMessage: 'Client visible' },
  ownedBy: { id: 'documents.vaultPreview.ownedBy', defaultMessage: 'Owned by' },
  theFirm: { id: 'documents.vaultPreview.theFirm', defaultMessage: 'The firm' },
  ownershipNote: {
    id: 'documents.vaultPreview.ownershipNote',
    defaultMessage:
      'Firm-owned files stay with the practice. A file owned by one accountant follows their engagement.',
  },
  rowOwner: { id: 'documents.vaultPreview.rowOwner', defaultMessage: 'Owner' },
  rowUploader: { id: 'documents.vaultPreview.rowUploader', defaultMessage: 'Uploader' },
  rowSource: { id: 'documents.vaultPreview.rowSource', defaultMessage: 'Source' },
  rowUploaded: { id: 'documents.vaultPreview.rowUploaded', defaultMessage: 'Uploaded' },
  rowKeyDate: { id: 'documents.vaultPreview.rowKeyDate', defaultMessage: 'Key date' },
  expiredNote: {
    id: 'documents.vaultPreview.expiredNote',
    defaultMessage: 'This document has expired. A reminder was raised when the key date passed.',
  },
  expiringNote: {
    id: 'documents.vaultPreview.expiringNote',
    defaultMessage: 'Expires in {days} days — reminder already set from the extracted key date.',
  },
  confirmDelete: {
    id: 'documents.vaultPreview.confirmDelete',
    defaultMessage: 'Delete “{name}” permanently? This cannot be undone.',
  },
  deletePermanently: { id: 'documents.vaultPreview.deletePermanently', defaultMessage: 'Delete permanently' },
  moreActions: { id: 'documents.vaultPreview.moreActions', defaultMessage: 'More actions' },
  deleteFile: { id: 'documents.vaultPreview.deleteFile', defaultMessage: 'Delete file…' },
  moveToClient: { id: 'documents.vaultPreview.moveToClient', defaultMessage: 'Move to client' },
});

/**
 * Vault file detail. Deleting is deliberately two steps behind a menu — an
 * engagement letter removed by a stray click is not recoverable.
 */
function VaultPreview({
  doc,
  onMove,
  onSetOwner,
  onDelete,
}: {
  doc: VaultDocument;
  onMove: () => void;
  onSetOwner: (kind: VaultDocument['ownerKind'], name: string) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const intl = useIntl();

  return (
    <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 border-b border-white/5">
        <h3 className="font-sans font-bold text-xl text-white tracking-tight">{doc.name}</h3>
        <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
          {intl.formatMessage(previewMessages.meta, {
            client: doc.clientName,
            category: intl.formatMessage(VAULT_CATEGORY_LABEL[doc.category]),
            year: doc.financialYear,
            size: doc.sizeKb,
          })}
        </p>
      </div>

      <div className="p-6 flex flex-col gap-4">
        <p className="text-[13px] text-zinc-400 leading-relaxed">{doc.summary}</p>

        <div className="flex flex-wrap gap-2">
          {doc.tags.map((t) => <Pill key={t}>{intl.formatMessage(previewMessages.tag, { tag: t })}</Pill>)}
          {doc.access === 'practice'
            ? <Pill tone="amber">{intl.formatMessage(previewMessages.practiceOnly)}</Pill>
            : <Pill tone="blue">{intl.formatMessage(previewMessages.clientVisible)}</Pill>}
        </div>

        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            {intl.formatMessage(previewMessages.ownedBy)}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onSetOwner('firm', '')}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold border transition-all ${
                doc.ownerKind === 'firm'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
              }`}
            >
              <Building2 size={13} />
              {intl.formatMessage(previewMessages.theFirm)}
            </button>
            <button
              onClick={() => onSetOwner('accountant', doc.uploader)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold border transition-all ${
                doc.ownerKind === 'accountant'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
              }`}
            >
              <User size={13} />
              {doc.uploader}
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
            {intl.formatMessage(previewMessages.ownershipNote)}
          </p>
        </div>

        <div className="flex flex-col gap-2.5 text-[13px]">
          <Row label={intl.formatMessage(previewMessages.rowOwner)} value={doc.ownerName} />
          <Row label={intl.formatMessage(previewMessages.rowUploader)} value={doc.uploader} />
          <Row label={intl.formatMessage(previewMessages.rowSource)} value={doc.source} />
          <Row label={intl.formatMessage(previewMessages.rowUploaded)} value={doc.uploadedAt} />
          {doc.expiresOn && <Row label={intl.formatMessage(previewMessages.rowKeyDate)} value={doc.expiresOn} />}
        </div>

        {doc.daysToExpiry !== undefined && doc.daysToExpiry <= 14 && (
          <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-[13px] text-amber-200/90">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            {doc.daysToExpiry <= 0
              ? intl.formatMessage(previewMessages.expiredNote)
              : intl.formatMessage(previewMessages.expiringNote, { days: doc.daysToExpiry })}
          </div>
        )}
      </div>

      {confirming ? (
        <div className="p-4 bg-red-500/5 border-t border-red-500/20 flex items-center gap-3 justify-between flex-wrap">
          <p className="text-[12px] text-red-300 font-semibold min-w-0">
            {intl.formatMessage(previewMessages.confirmDelete, { name: doc.name })}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setConfirming(false)}
              className="px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
            >
              {intl.formatMessage(commonActions.cancel)}
            </button>
            <button
              onClick={onDelete}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-red-500 hover:bg-red-600 transition-colors"
            >
              <Trash2 size={14} />
              {intl.formatMessage(previewMessages.deletePermanently)}
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 bg-raised/50 flex items-center gap-2 sm:gap-3 justify-end flex-wrap [&>button]:flex-1 [&>button]:basis-[8rem] sm:[&>button]:flex-none sm:[&>button]:basis-auto [&>button]:justify-center">
          <div className="relative mr-auto">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={intl.formatMessage(previewMessages.moreActions)}
              className="w-9 h-9 rounded-full border border-white/5 text-zinc-500 hover:text-white hover:border-white/20 flex items-center justify-center transition-colors"
            >
              {menuOpen ? <X size={15} /> : <MoreHorizontal size={16} />}
            </button>
            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  className="absolute bottom-full left-0 mb-2 w-52 rounded-2xl border border-white/5 bg-card shadow-2xl p-1.5 z-10"
                >
                  <button
                    onClick={() => { setMenuOpen(false); setConfirming(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-[13px] font-semibold text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors text-left"
                  >
                    <Trash2 size={14} />
                    {intl.formatMessage(previewMessages.deleteFile)}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button
            onClick={onMove}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
          >
            <ArrowRightLeft size={15} />
            {intl.formatMessage(previewMessages.moveToClient)}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A row-level action. `stopPropagation` because the row itself opens the
 * viewer, and a delete that also opened what it had just deleted would be a
 * bad joke. The label names the document, so a screen reader hears which row's
 * button it is on rather than eleven identical "Delete"s.
 */
function RowIconButton({
  label,
  onClick,
  icon: Icon,
}: {
  label: string;
  onClick: () => void;
  icon: typeof Trash2;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      title={label}
      className="hit-area shrink-0 w-8 h-8 rounded-lg border border-white/5 text-zinc-500 hover:text-white hover:border-white/25 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
    >
      <Icon size={14} />
    </button>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const active = value !== 'all';
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`bg-card border rounded-full py-2 px-4 text-[13px] font-bold focus:outline-none focus:border-brand shadow-inner transition-colors ${
        active ? 'text-brand border-brand/30' : 'text-zinc-400 border-white/5'
      }`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-card text-white">
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center gap-4">
      <span className="text-zinc-500 font-medium">{label}</span>
      <span className="text-white font-bold text-right">{value}</span>
    </div>
  );
}

/**
 * The selected rows as a CSV, named by the caller — see the note on the two
 * export actions for why the name is the honest part.
 *
 * Two columns beyond what this wrote before, both because the file outlives the
 * screen it came off:
 *
 * - **Status**, so a row's state travels with it. Without it a `processing`
 *   receipt and a `published` one are the same line of text.
 * - **Currency**, for the reason `currency()` in `lib/resolver.ts` carries at
 *   length: a USD invoice in a bare Total column is read as sterling, and a
 *   spreadsheet has no amber pill to hint otherwise.
 *
 * Every field goes through `esc` — the previous version wrapped values in bare
 * quotes, so a supplier named `Bob "Bobby" Ltd` produced a file that parses
 * into the wrong number of columns. `ClientInbox` already had this.
 */
function exportDocs(rows: Document[], filename: string) {
  if (rows.length === 0) return;
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = 'Client,Supplier,Date,Category,Status,Source,Uploader,Currency,Total\n';
  const body = rows
    .map((d) =>
      [esc(d.clientName), esc(d.supplier), esc(d.date), esc(d.category), esc(d.status), esc(d.source), esc(d.uploader), esc(d.currency), d.total].join(','),
    )
    .join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
