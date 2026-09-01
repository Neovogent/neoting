import { Download, RefreshCw, Send, CheckCircle, Eye } from 'lucide-react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { useConfirm } from './ConfirmProvider';
import { describeMissing, partitionByReadiness } from '../../lib/readiness';
import { currency } from '../../lib/resolver';
import { DataTable, Pill } from './DataTable';
import type { ApprovalItem, AuditEntry, DocStatus, Document, MissingItem } from '../../lib/types';
import { EXPORT_HINT } from '../../lib/exportRules';
import { commonActions, commonLabels } from '../../i18n/common';

/**
 * Column headings are one shared vocabulary under `shell.tables.column*` rather
 * than five private copies of "Supplier". These five tables are one surface with
 * one set of nouns; giving each its own id would hand a translator the same word
 * five times with no way to see they must agree.
 *
 * Everything a single table says about itself — its title, its empty state, its
 * actions — stays under that table's own component id.
 */
const cols = defineMessages({
  channel: { id: 'shell.tables.columnChannel', defaultMessage: 'Channel' },
  reason: { id: 'shell.tables.columnReason', defaultMessage: 'Reason' },
  approver: { id: 'shell.tables.columnApprover', defaultMessage: 'Approver' },
  detectedBy: { id: 'shell.tables.columnDetectedBy', defaultMessage: 'Detected by' },
  chased: { id: 'shell.tables.columnChased', defaultMessage: 'Chased' },
  action: { id: 'shell.tables.columnAction', defaultMessage: 'Action' },
  scope: { id: 'shell.tables.columnScope', defaultMessage: 'Scope' },
  actor: { id: 'shell.tables.columnActor', defaultMessage: 'Actor' },
  when: { id: 'shell.tables.columnWhen', defaultMessage: 'When' },
  review: { id: 'shell.tables.columnReview', defaultMessage: 'Review' },
});

const shared = defineMessages({
  scopeAllClients: { id: 'shell.tables.scopeAllClients', defaultMessage: 'All clients' },
  scopeClients: { id: 'shell.tables.scopeClients', defaultMessage: '{count} clients' },
});

/**
 * `intl` is a parameter rather than a hook call: this runs at module scope for
 * five different components, and a hook here would be a hook outside a render.
 */
function scopeLabel(intl: IntlShape, names: string[]) {
  if (names.length === 0) return intl.formatMessage(shared.scopeAllClients);
  if (names.length === 1) return names[0];
  return intl.formatMessage(shared.scopeClients, { count: names.length });
}

const inbox = defineMessages({
  title: { id: 'shell.inboxTable.title', defaultMessage: 'Inbox' },
  subtitle: { id: 'shell.inboxTable.subtitle', defaultMessage: '{scope} • processing / to review / ready' },
  statusReady: { id: 'shell.inboxTable.statusReady', defaultMessage: 'Ready' },
  statusReview: { id: 'shell.inboxTable.statusReview', defaultMessage: 'To review' },
  statusPublished: { id: 'shell.inboxTable.statusPublished', defaultMessage: 'Published' },
  statusProcessing: { id: 'shell.inboxTable.statusProcessing', defaultMessage: 'Processing' },
  openAction: { id: 'shell.inboxTable.openAction', defaultMessage: 'Open' },
  openReply: {
    id: 'shell.inboxTable.openReply',
    defaultMessage: '{supplier} — every field shows its confidence and provenance. Click any value to correct it.',
  },
  markReviewedAction: { id: 'shell.inboxTable.markReviewedAction', defaultMessage: 'Mark reviewed' },
  noneCanMoveTitle: { id: 'shell.inboxTable.noneCanMoveTitle', defaultMessage: 'None of these can move yet' },
  onlyReviewCanMove: {
    id: 'shell.inboxTable.onlyReviewCanMove',
    defaultMessage: 'Only documents in To review can be marked reviewed — the Ready and Published ones already are.',
  },
  nothingToPublishTitle: { id: 'shell.inboxTable.nothingToPublishTitle', defaultMessage: 'Nothing selected can publish' },
  nothingToPublishDetail: {
    id: 'shell.inboxTable.nothingToPublishDetail',
    defaultMessage:
      '{publishedCount, plural, =0 {} one {# is already Published — approved and released for export. } other {# are already Published — approved and released for export. }}{otherCount, plural, =0 {} one {# must reach Ready before it can publish.} other {# must reach Ready before they can publish.}}',
  },
  blockedRow: { id: 'shell.inboxTable.blockedRow', defaultMessage: '{supplier} — {missing}' },
  moveToReadyTitle: {
    id: 'shell.inboxTable.moveToReadyTitle',
    defaultMessage: '{count, plural, one {Move # item to Ready?} other {Move # items to Ready?}}',
  },
  moveToReadyDetail: {
    id: 'shell.inboxTable.moveToReadyDetail',
    defaultMessage: 'Ready means every check has passed and they are queued to publish.',
  },
  // No plural: the string this replaces had none, and an extraction does not
  // rewrite copy. Flagged in the report — "1 still missing required fields".
  moveToReadyConsequence: {
    id: 'shell.inboxTable.moveToReadyConsequence',
    defaultMessage: '{count} still missing required fields will be left alone.',
  },
  moveToReadyConfirm: { id: 'shell.inboxTable.moveToReadyConfirm', defaultMessage: 'Yes, mark them Ready' },
  publishAction: { id: 'shell.inboxTable.publishAction', defaultMessage: 'Publish' },
  publishReply: {
    id: 'shell.inboxTable.publishReply',
    defaultMessage: 'Here is the publish batch with gross and VAT totals.',
  },
});

/** Costs / Sales inbox with the three-state model (PRD stage 5). */
export function InboxTable({
  clientIds,
  clientNames,
  statusFilter,
}: {
  clientIds: string[];
  clientNames: string[];
  /** Narrows to one status — "show everything to review" (METH Stage 13). */
  statusFilter?: DocStatus | undefined;
}) {
  const { documents, addMessage, updateDocumentStatus, mandatoryFields, clientNameFor } = useAppContext();
  const intl = useIntl();
  const confirm = useConfirm();
  const rows = documents.filter(
    (d) =>
      (clientIds.length ? clientIds.includes(d.clientId) : true) &&
      (statusFilter !== undefined ? d.status === statusFilter : d.status !== 'rejected'),
  );

  return (
    <DataTable<Document>
      title={intl.formatMessage(inbox.title)}
      subtitle={intl.formatMessage(inbox.subtitle, { scope: scopeLabel(intl, clientNames) })}
      rows={rows}
      rowId={(d) => d.id}
      selectable
      columns={[
        { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
        {
          key: 'clientName',
          label: intl.formatMessage(commonLabels.client),
          // Through the resolver, not the stored string: a live row is filled
          // before the businesses slice answers, and the stored name is the
          // raw `biz_*` id until something re-derives it. The resolver answers
          // from the hydrated slice on every render.
          sortValue: (d) => clientNameFor(d.clientId),
          render: (d) => <span>{clientNameFor(d.clientId)}</span>,
        },
        { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (d) => d.date },
        { key: 'category', label: intl.formatMessage(commonLabels.category), sortValue: (d) => d.category },
        { key: 'total', label: intl.formatMessage(commonLabels.total), align: 'right', sortValue: (d) => d.total, render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total)}</span> },
        {
          key: 'status',
          label: intl.formatMessage(commonLabels.status),
          sortValue: (d) => d.status,
          render: (d) =>
            d.status === 'ready' ? (
              <Pill tone="green">{intl.formatMessage(inbox.statusReady)}</Pill>
            ) : d.status === 'review' ? (
              <Pill tone="amber">{d.statusNote ?? intl.formatMessage(inbox.statusReview)}</Pill>
            ) : d.status === 'published' ? (
              <Pill tone="blue">{intl.formatMessage(inbox.statusPublished)}</Pill>
            ) : (
              <Pill>{intl.formatMessage(inbox.statusProcessing)}</Pill>
            ),
        },
      ]}
      bulkActions={[
        {
          label: intl.formatMessage(inbox.openAction),
          icon: Eye,
          onClick: (sel) =>
            sel.slice(0, 1).forEach((d) =>
              addMessage({
                id: `${Date.now()}-doc`,
                role: 'assistant',
                content: intl.formatMessage(inbox.openReply, { supplier: d.supplier }),
                intent: 'REVIEW_DOCUMENT',
                payload: { documentId: d.id },
              }),
            ),
        },
        {
          label: intl.formatMessage(inbox.markReviewedAction),
          icon: CheckCircle,
          onClick: async (sel) => {
            // Only To-review documents can move to Ready. A Published or Ready
            // row offered this action is the functional lie the user report
            // named: the screen claiming a state change that cannot happen.
            const movable = sel.filter((d) => d.status === 'review');
            if (movable.length === 0) {
              await confirm({
                tone: 'red',
                title: intl.formatMessage(inbox.noneCanMoveTitle),
                detail: intl.formatMessage(inbox.onlyReviewCanMove),
                confirmLabel: intl.formatMessage(commonActions.close),
              });
              return;
            }
            const { ready, blocked } = partitionByReadiness(movable, mandatoryFields, intl);
            if (ready.length === 0) {
              await confirm({
                tone: 'red',
                title: intl.formatMessage(inbox.noneCanMoveTitle),
                detail: blocked
                  .map(({ doc, missing }) =>
                    intl.formatMessage(inbox.blockedRow, {
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
              title: intl.formatMessage(inbox.moveToReadyTitle, { count: ready.length }),
              detail: intl.formatMessage(inbox.moveToReadyDetail),
              ...(blocked.length
                ? { consequence: intl.formatMessage(inbox.moveToReadyConsequence, { count: blocked.length }) }
                : {}),
              confirmLabel: intl.formatMessage(inbox.moveToReadyConfirm),
            });
            if (ok) ready.forEach((d) => updateDocumentStatus(d.id, 'ready'));
          },
        },
        {
          label: intl.formatMessage(inbox.publishAction),
          icon: Send,
          primary: true,
          onClick: async (sel) => {
            // Publish means Ready → Published. A selection with nothing Ready
            // gets the honest refusal, counted by state — a Published document
            // is already released, and offering to publish it again tells an
            // accountant their books are in a state they are not (D42).
            if (!sel.some((d) => d.status === 'ready')) {
              const publishedCount = sel.filter((d) => d.status === 'published').length;
              await confirm({
                tone: 'red',
                title: intl.formatMessage(inbox.nothingToPublishTitle),
                detail: intl.formatMessage(inbox.nothingToPublishDetail, {
                  publishedCount,
                  otherCount: sel.length - publishedCount,
                }),
                confirmLabel: intl.formatMessage(commonActions.close),
              });
              return;
            }
            addMessage({
              id: `${Date.now()}-pub`,
              role: 'assistant',
              content: intl.formatMessage(inbox.publishReply),
              intent: 'PUBLISH',
              payload: { clientIds, clientNames },
            });
          },
        },
      ]}
    />
  );
}

const rejected = defineMessages({
  title: { id: 'shell.rejectedTable.title', defaultMessage: 'Rejected & failed' },
  subtitle: {
    id: 'shell.rejectedTable.subtitle',
    defaultMessage: '{scope} • every failure with a reason and a retry',
  },
  empty: {
    id: 'shell.rejectedTable.empty',
    defaultMessage: 'No failures — extraction and publishing are clean for this scope.',
  },
  retryTitle: {
    id: 'shell.rejectedTable.retryTitle',
    defaultMessage: '{count, plural, one {Retry # failed item?} other {Retry # failed items?}}',
  },
  retryDetail: {
    id: 'shell.rejectedTable.retryDetail',
    defaultMessage:
      'Anything that failed to extract is read again; anything that failed to publish goes back to Ready to be pushed again. Whatever was already read off a document is kept.',
  },
  retryConfirm: { id: 'shell.rejectedTable.retryConfirm', defaultMessage: 'Yes, retry' },
});

/** The 337-vote Rejected / Failed view — nothing fails silently. */
export function RejectedTable({ clientIds, clientNames }: { clientIds: string[]; clientNames: string[] }) {
  const { documents, retryDocument } = useAppContext();
  const intl = useIntl();
  const confirm = useConfirm();
  const rows = documents.filter((d) => (clientIds.length ? clientIds.includes(d.clientId) : true) && d.status === 'rejected');

  return (
    <DataTable<Document>
      title={intl.formatMessage(rejected.title)}
      subtitle={intl.formatMessage(rejected.subtitle, { scope: scopeLabel(intl, clientNames) })}
      rows={rows}
      rowId={(d) => d.id}
      selectable
      emptyMessage={intl.formatMessage(rejected.empty)}
      columns={[
        { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
        { key: 'clientName', label: intl.formatMessage(commonLabels.client), sortValue: (d) => d.clientName },
        { key: 'source', label: intl.formatMessage(cols.channel), sortValue: (d) => d.source },
        {
          key: 'statusNote',
          label: intl.formatMessage(cols.reason),
          render: (d) => <span className="text-red-400 font-medium whitespace-normal">{d.statusNote}</span>,
        },
      ]}
      bulkActions={[{
        label: intl.formatMessage(commonActions.retry), icon: RefreshCw, primary: true,
        onClick: async (sel) => {
          const ok = await confirm({
            title: intl.formatMessage(rejected.retryTitle, { count: sel.length }),
            detail: intl.formatMessage(rejected.retryDetail),
            confirmLabel: intl.formatMessage(rejected.retryConfirm),
          });
          if (ok) sel.forEach((d) => retryDocument(d.id));
        },
      }]}
    />
  );
}

// Named `approvalsMessages`, not `approvals`: the component destructures
// `approvals` off the context, and the shadow would silently resolve
// `approvals.title` to a property of the queue array.
const approvalsMessages = defineMessages({
  title: { id: 'shell.approvalsTable.title', defaultMessage: 'Approval queue' },
  subtitle: { id: 'shell.approvalsTable.subtitle', defaultMessage: '{scope} • oldest first' },
  empty: { id: 'shell.approvalsTable.empty', defaultMessage: 'The approval queue is empty.' },
  waitingDays: { id: 'shell.approvalsTable.waitingDays', defaultMessage: '{days}d' },
  approveAction: { id: 'shell.approvalsTable.approveAction', defaultMessage: 'Approve selected' },
  approveReply: {
    id: 'shell.approvalsTable.approveReply',
    defaultMessage: 'Read the review to see exactly what will be approved.',
  },
});

/** Approval queue (PRD stage 9). */
export function ApprovalsTable({ clientIds, clientNames }: { clientIds: string[]; clientNames: string[] }) {
  const { approvals, clients, addMessage } = useAppContext();
  const intl = useIntl();
  const names = clients.filter((c) => clientIds.includes(c.id)).map((c) => c.name);
  const rows = names.length ? approvals.filter((a) => names.includes(a.clientName)) : approvals;

  return (
    <DataTable<ApprovalItem>
      title={intl.formatMessage(approvalsMessages.title)}
      subtitle={intl.formatMessage(approvalsMessages.subtitle, { scope: scopeLabel(intl, clientNames) })}
      rows={rows}
      rowId={(a) => a.id}
      selectable
      emptyMessage={intl.formatMessage(approvalsMessages.empty)}
      columns={[
        { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (a) => a.supplier, render: (a) => <span className="text-white font-semibold">{a.supplier}</span> },
        { key: 'clientName', label: intl.formatMessage(commonLabels.client), sortValue: (a) => a.clientName },
        { key: 'stage', label: intl.formatMessage(commonLabels.stage), sortValue: (a) => a.stage },
        { key: 'approver', label: intl.formatMessage(cols.approver), sortValue: (a) => a.approver },
        {
          key: 'waitingDays',
          label: intl.formatMessage(commonLabels.waiting),
          align: 'right',
          sortValue: (a) => a.waitingDays,
          render: (a) =>
            a.waitingDays >= 5 ? (
              <Pill tone="red">{intl.formatMessage(approvalsMessages.waitingDays, { days: a.waitingDays })}</Pill>
            ) : (
              <Pill>{intl.formatMessage(approvalsMessages.waitingDays, { days: a.waitingDays })}</Pill>
            ),
        },
        { key: 'total', label: intl.formatMessage(commonLabels.total), align: 'right', sortValue: (a) => a.total, render: (a) => <span className="text-white font-bold tabular-nums">{currency(a.total)}</span> },
      ]}
      bulkActions={[
        {
          label: intl.formatMessage(approvalsMessages.approveAction),
          icon: CheckCircle,
          primary: true,
          onClick: () =>
            addMessage({
              id: `${Date.now()}-appr`,
              role: 'assistant',
              content: intl.formatMessage(approvalsMessages.approveReply),
              intent: 'APPROVE_ITEMS',
              payload: { clientIds, clientNames, query: '' },
            }),
        },
      ]}
    />
  );
}

const missingTable = defineMessages({
  title: { id: 'shell.missingTable.title', defaultMessage: 'Missing paperwork' },
  subtitle: { id: 'shell.missingTable.subtitle', defaultMessage: '{scope} • five detection engines' },
  empty: { id: 'shell.missingTable.empty', defaultMessage: 'Nothing outstanding.' },
  chasedRequested: { id: 'shell.missingTable.chasedRequested', defaultMessage: 'Requested' },
  chasedNot: { id: 'shell.missingTable.chasedNot', defaultMessage: 'Not chased' },
  chaseAction: { id: 'shell.missingTable.chaseAction', defaultMessage: 'Chase' },
  chaseReply: {
    id: 'shell.missingTable.chaseReply',
    defaultMessage: 'Grouped per client. Nothing sends until you read the review and approve.',
  },
});

/** Missing paperwork across all five detection engines (PRD stage 8). */
export function MissingTable({ clientIds, clientNames }: { clientIds: string[]; clientNames: string[] }) {
  const { missing, addMessage } = useAppContext();
  const intl = useIntl();
  const rows = missing.filter((m) => (clientIds.length ? clientIds.includes(m.clientId) : true));

  return (
    <DataTable<MissingItem>
      title={intl.formatMessage(missingTable.title)}
      subtitle={intl.formatMessage(missingTable.subtitle, { scope: scopeLabel(intl, clientNames) })}
      rows={rows}
      rowId={(m) => m.id}
      selectable
      emptyMessage={intl.formatMessage(missingTable.empty)}
      columns={[
        { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (m) => m.supplier, render: (m) => <span className="text-white font-semibold">{m.supplier}</span> },
        { key: 'clientName', label: intl.formatMessage(commonLabels.client), sortValue: (m) => m.clientName },
        { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (m) => m.date },
        { key: 'detectedBy', label: intl.formatMessage(cols.detectedBy), sortValue: (m) => m.detectedBy, render: (m) => <Pill>{m.detectedBy}</Pill> },
        {
          key: 'chased',
          label: intl.formatMessage(cols.chased),
          sortValue: (m) => String(m.chased),
          render: (m) =>
            m.chased ? (
              <Pill tone="blue">{intl.formatMessage(missingTable.chasedRequested)}</Pill>
            ) : (
              <Pill tone="red">{intl.formatMessage(missingTable.chasedNot)}</Pill>
            ),
        },
        { key: 'amount', label: intl.formatMessage(commonLabels.amount), align: 'right', sortValue: (m) => m.amount, render: (m) => <span className="text-white font-bold tabular-nums">{m.amount ? currency(m.amount) : '—'}</span> },
      ]}
      bulkActions={[
        {
          label: intl.formatMessage(missingTable.chaseAction),
          icon: Send,
          primary: true,
          onClick: () =>
            addMessage({
              id: `${Date.now()}-chase`,
              role: 'assistant',
              content: intl.formatMessage(missingTable.chaseReply),
              intent: 'CHASE_MISSING',
              payload: { clientIds, clientNames },
            }),
        },
        { label: intl.formatMessage(commonActions.exportCsv), icon: Download, minSelected: 2, disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel) => exportCsv(sel) },
      ]}
    />
  );
}

const audit = defineMessages({
  title: { id: 'shell.auditTable.title', defaultMessage: 'Audit log' },
  subtitle: { id: 'shell.auditTable.subtitle', defaultMessage: 'Every approved state change in this session' },
  empty: { id: 'shell.auditTable.empty', defaultMessage: 'Nothing approved yet in this session.' },
  reviewOpened: { id: 'shell.auditTable.reviewOpened', defaultMessage: 'Opened' },
});

/** Audit trail of every approved state change (PRD section 8). */
export function AuditTable() {
  const { auditLog } = useAppContext();
  const intl = useIntl();

  return (
    <DataTable<AuditEntry>
      title={intl.formatMessage(audit.title)}
      subtitle={intl.formatMessage(audit.subtitle)}
      rows={auditLog}
      rowId={(a) => a.id}
      emptyMessage={intl.formatMessage(audit.empty)}
      columns={[
        { key: 'action', label: intl.formatMessage(cols.action), sortValue: (a) => a.action, render: (a) => <span className="text-white font-semibold">{a.action}</span> },
        { key: 'scope', label: intl.formatMessage(cols.scope), render: (a) => <span className="whitespace-normal">{a.scope}</span> },
        { key: 'actor', label: intl.formatMessage(cols.actor), sortValue: (a) => a.actor },
        { key: 'at', label: intl.formatMessage(cols.when), sortValue: (a) => a.at },
        { key: 'reviewOpened', label: intl.formatMessage(cols.review), render: () => <Pill tone="green">{intl.formatMessage(audit.reviewOpened)}</Pill> },
      ]}
    />
  );
}

function exportCsv(items: MissingItem[]) {
  const header = 'Client,Supplier,Date,Amount,Detected by,Chased\n';
  const body = items.map((i) => `"${i.clientName}","${i.supplier}","${i.date}",${i.amount},"${i.detectedBy}",${i.chased}`).join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'missing-paperwork.csv';
  a.click();
  URL.revokeObjectURL(url);
}
