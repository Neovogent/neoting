import { Download, RefreshCw, Send, CheckCircle, Eye } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { useConfirm } from './ConfirmProvider';
import { describeMissing, partitionByReadiness } from '../../lib/readiness';
import { currency } from '../../lib/resolver';
import { DataTable, Pill } from './DataTable';
import type { ApprovalItem, AuditEntry, Document, MissingItem } from '../../lib/types';
import { EXPORT_HINT } from '../../lib/exportRules';

function scopeLabel(names: string[]) {
  if (names.length === 0) return 'All clients';
  if (names.length === 1) return names[0];
  return `${names.length} clients`;
}

/** Costs / Sales inbox with the three-state model (PRD stage 5). */
export function InboxTable({ clientIds, clientNames }: { clientIds: string[]; clientNames: string[] }) {
  const { documents, addMessage, updateDocumentStatus, mandatoryFields } = useAppContext();
  const confirm = useConfirm();
  const rows = documents.filter(
    (d) => (clientIds.length ? clientIds.includes(d.clientId) : true) && d.status !== 'rejected',
  );

  return (
    <DataTable<Document>
      title="Inbox"
      subtitle={`${scopeLabel(clientNames)} • processing / to review / ready`}
      rows={rows}
      rowId={(d) => d.id}
      selectable
      columns={[
        { key: 'supplier', label: 'Supplier', sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
        { key: 'clientName', label: 'Client', sortValue: (d) => d.clientName },
        { key: 'date', label: 'Date', sortValue: (d) => d.date },
        { key: 'category', label: 'Category', sortValue: (d) => d.category },
        { key: 'total', label: 'Total', align: 'right', sortValue: (d) => d.total, render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total)}</span> },
        {
          key: 'status',
          label: 'Status',
          sortValue: (d) => d.status,
          render: (d) =>
            d.status === 'ready' ? (
              <Pill tone="green">Ready</Pill>
            ) : d.status === 'review' ? (
              <Pill tone="amber">{d.statusNote ?? 'To review'}</Pill>
            ) : d.status === 'published' ? (
              <Pill tone="blue">Published</Pill>
            ) : (
              <Pill>Processing</Pill>
            ),
        },
      ]}
      bulkActions={[
        {
          label: 'Open',
          icon: Eye,
          onClick: (sel) =>
            sel.slice(0, 1).forEach((d) =>
              addMessage({
                id: `${Date.now()}-doc`,
                role: 'assistant',
                content: `${d.supplier} — every field shows its confidence and provenance. Click any value to correct it.`,
                intent: 'REVIEW_DOCUMENT',
                payload: { documentId: d.id },
              }),
            ),
        },
        {
          label: 'Mark reviewed',
          icon: CheckCircle,
          onClick: async (sel) => {
            const { ready, blocked } = partitionByReadiness(sel, mandatoryFields);
            if (ready.length === 0) {
              await confirm({
                tone: 'red',
                title: 'None of these can move yet',
                detail: blocked
                  .map(({ doc, missing }) => `${doc.supplier} — ${describeMissing(missing).toLowerCase()}`)
                  .slice(0, 4)
                  .join('. '),
                confirmLabel: 'Close',
              });
              return;
            }
            const ok = await confirm({
              title: `Move ${ready.length} item${ready.length === 1 ? '' : 's'} to Ready?`,
              detail: 'Ready means every check has passed and they are queued to publish.',
              consequence: blocked.length
                ? `${blocked.length} still missing required fields will be left alone.`
                : undefined,
              confirmLabel: 'Yes, mark them Ready',
            });
            if (ok) ready.forEach((d) => updateDocumentStatus(d.id, 'ready'));
          },
        },
        {
          label: 'Publish',
          icon: Send,
          primary: true,
          onClick: () =>
            addMessage({
              id: `${Date.now()}-pub`,
              role: 'assistant',
              content: 'Here is the publish batch with gross and VAT totals.',
              intent: 'PUBLISH',
              payload: { clientIds, clientNames },
            }),
        },
      ]}
    />
  );
}

/** The 337-vote Rejected / Failed view — nothing fails silently. */
export function RejectedTable({ clientIds, clientNames }: { clientIds: string[]; clientNames: string[] }) {
  const { documents, retryDocument } = useAppContext();
  const confirm = useConfirm();
  const rows = documents.filter((d) => (clientIds.length ? clientIds.includes(d.clientId) : true) && d.status === 'rejected');

  return (
    <DataTable<Document>
      title="Rejected & failed"
      subtitle={`${scopeLabel(clientNames)} • every failure with a reason and a retry`}
      rows={rows}
      rowId={(d) => d.id}
      selectable
      emptyMessage="No failures — extraction and publishing are clean for this scope."
      columns={[
        { key: 'supplier', label: 'Supplier', sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
        { key: 'clientName', label: 'Client', sortValue: (d) => d.clientName },
        { key: 'source', label: 'Channel', sortValue: (d) => d.source },
        {
          key: 'statusNote',
          label: 'Reason',
          render: (d) => <span className="text-red-400 font-medium whitespace-normal">{d.statusNote}</span>,
        },
      ]}
      bulkActions={[{
        label: 'Retry', icon: RefreshCw, primary: true,
        onClick: async (sel) => {
          const ok = await confirm({
            title: `Retry ${sel.length} failed item${sel.length === 1 ? '' : 's'}?`,
            detail: 'Anything that failed to extract is read again; anything that failed to publish goes back to Ready to be pushed again. Whatever was already read off a document is kept.',
            confirmLabel: 'Yes, retry',
          });
          if (ok) sel.forEach((d) => retryDocument(d.id));
        },
      }]}
    />
  );
}

/** Approval queue (PRD stage 9). */
export function ApprovalsTable({ clientIds, clientNames }: { clientIds: string[]; clientNames: string[] }) {
  const { approvals, clients, addMessage } = useAppContext();
  const names = clients.filter((c) => clientIds.includes(c.id)).map((c) => c.name);
  const rows = names.length ? approvals.filter((a) => names.includes(a.clientName)) : approvals;

  return (
    <DataTable<ApprovalItem>
      title="Approval queue"
      subtitle={`${scopeLabel(clientNames)} • oldest first`}
      rows={rows}
      rowId={(a) => a.id}
      selectable
      emptyMessage="The approval queue is empty."
      columns={[
        { key: 'supplier', label: 'Supplier', sortValue: (a) => a.supplier, render: (a) => <span className="text-white font-semibold">{a.supplier}</span> },
        { key: 'clientName', label: 'Client', sortValue: (a) => a.clientName },
        { key: 'stage', label: 'Stage', sortValue: (a) => a.stage },
        { key: 'approver', label: 'Approver', sortValue: (a) => a.approver },
        {
          key: 'waitingDays',
          label: 'Waiting',
          align: 'right',
          sortValue: (a) => a.waitingDays,
          render: (a) => (a.waitingDays >= 5 ? <Pill tone="red">{a.waitingDays}d</Pill> : <Pill>{a.waitingDays}d</Pill>),
        },
        { key: 'total', label: 'Total', align: 'right', sortValue: (a) => a.total, render: (a) => <span className="text-white font-bold tabular-nums">{currency(a.total)}</span> },
      ]}
      bulkActions={[
        {
          label: 'Approve selected',
          icon: CheckCircle,
          primary: true,
          onClick: () =>
            addMessage({
              id: `${Date.now()}-appr`,
              role: 'assistant',
              content: 'Read the review to see exactly what will be approved.',
              intent: 'APPROVE_ITEMS',
              payload: { clientIds, clientNames, query: '' },
            }),
        },
      ]}
    />
  );
}

/** Missing paperwork across all five detection engines (PRD stage 8). */
export function MissingTable({ clientIds, clientNames }: { clientIds: string[]; clientNames: string[] }) {
  const { missing, addMessage } = useAppContext();
  const rows = missing.filter((m) => (clientIds.length ? clientIds.includes(m.clientId) : true));

  return (
    <DataTable<MissingItem>
      title="Missing paperwork"
      subtitle={`${scopeLabel(clientNames)} • five detection engines`}
      rows={rows}
      rowId={(m) => m.id}
      selectable
      emptyMessage="Nothing outstanding."
      columns={[
        { key: 'supplier', label: 'Supplier', sortValue: (m) => m.supplier, render: (m) => <span className="text-white font-semibold">{m.supplier}</span> },
        { key: 'clientName', label: 'Client', sortValue: (m) => m.clientName },
        { key: 'date', label: 'Date', sortValue: (m) => m.date },
        { key: 'detectedBy', label: 'Detected by', sortValue: (m) => m.detectedBy, render: (m) => <Pill>{m.detectedBy}</Pill> },
        { key: 'chased', label: 'Chased', sortValue: (m) => String(m.chased), render: (m) => (m.chased ? <Pill tone="blue">Requested</Pill> : <Pill tone="red">Not chased</Pill>) },
        { key: 'amount', label: 'Amount', align: 'right', sortValue: (m) => m.amount, render: (m) => <span className="text-white font-bold tabular-nums">{m.amount ? currency(m.amount) : '—'}</span> },
      ]}
      bulkActions={[
        {
          label: 'Chase',
          icon: Send,
          primary: true,
          onClick: () =>
            addMessage({
              id: `${Date.now()}-chase`,
              role: 'assistant',
              content: 'Grouped per client. Nothing sends until you read the review and approve.',
              intent: 'CHASE_MISSING',
              payload: { clientIds, clientNames },
            }),
        },
        { label: 'Export CSV', icon: Download, minSelected: 2, disabledHint: EXPORT_HINT, onClick: (sel) => exportCsv(sel) },
      ]}
    />
  );
}

/** Audit trail of every approved state change (PRD section 8). */
export function AuditTable() {
  const { auditLog } = useAppContext();

  return (
    <DataTable<AuditEntry>
      title="Audit log"
      subtitle="Every approved state change in this session"
      rows={auditLog}
      rowId={(a) => a.id}
      emptyMessage="Nothing approved yet in this session."
      columns={[
        { key: 'action', label: 'Action', sortValue: (a) => a.action, render: (a) => <span className="text-white font-semibold">{a.action}</span> },
        { key: 'scope', label: 'Scope', render: (a) => <span className="whitespace-normal">{a.scope}</span> },
        { key: 'actor', label: 'Actor', sortValue: (a) => a.actor },
        { key: 'at', label: 'When', sortValue: (a) => a.at },
        { key: 'reviewOpened', label: 'Review', render: () => <Pill tone="green">Opened</Pill> },
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
