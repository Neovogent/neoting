import { defineMessages, useIntl } from 'react-intl';
import type { ActionProposal } from '@neoting/contracts/model';
import { useAppContext } from '../context/AppContext';
import { KIND_LABEL, decisionReason, useProposalHistory } from '../api/proposals';
import { errorLabel } from '../api/slices';
import { DataTable, Pill } from '../components/DynamicComponents/DataTable';
import { commonLabels } from '../i18n/common';

const m = defineMessages({
  columnKind: { id: 'approvals.liveHistory.columnKind', defaultMessage: 'Proposal' },
  columnOutcome: { id: 'approvals.liveHistory.columnOutcome', defaultMessage: 'Outcome' },
  columnReason: { id: 'approvals.liveHistory.columnReason', defaultMessage: 'Reason' },
  columnDecided: { id: 'approvals.liveHistory.columnDecided', defaultMessage: 'Decided' },
  executed: { id: 'approvals.liveHistory.executed', defaultMessage: 'Approved' },
  denied: { id: 'approvals.liveHistory.denied', defaultMessage: 'Denied' },
  cancelled: { id: 'approvals.liveHistory.cancelled', defaultMessage: 'Cancelled' },
  expired: { id: 'approvals.liveHistory.expired', defaultMessage: 'Expired' },
  deniedBy: { id: 'approvals.liveHistory.deniedBy', defaultMessage: '{who}: {reason}' },
  empty: { id: 'approvals.liveHistory.empty', defaultMessage: 'No decided proposals yet.' },
  loading: { id: 'approvals.liveHistory.loading', defaultMessage: 'Loading the decision history…' },
  loadMore: { id: 'approvals.liveHistory.loadMore', defaultMessage: 'Show older decisions' },
  loadingMore: { id: 'approvals.liveHistory.loadingMore', defaultMessage: 'Loading…' },
  retry: { id: 'approvals.liveHistory.retry', defaultMessage: 'Try again' },
});

const OUTCOME = {
  EXECUTED: { tone: 'green', label: m.executed },
  DENIED: { tone: 'red', label: m.denied },
  CANCELLED: { tone: 'neutral', label: m.cancelled },
  EXPIRED: { tone: 'amber', label: m.expired },
} as const;

/**
 * The decided proposals, read from the server — so the History tab survives a
 * reload and shows decisions made in other browsers, not only this session's.
 */
export function ApprovalsLiveHistory() {
  const intl = useIntl();
  const { businesses } = useAppContext();
  const history = useProposalHistory({ enabled: true });
  const nameFor = (id: string | null | undefined) => (id ? (businesses.find((b) => b.id === id)?.name ?? '—') : '—');
  const decidedAt = (p: ActionProposal) => p.executedAt ?? p.approvedAt ?? p.reviewedAt ?? p.createdAt;
  const when = (iso: string) =>
    intl.formatDate(iso, { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (history.error) {
    return (
      <div role="alert" className="flex items-center gap-3 text-[13px] text-red-400">
        {errorLabel(history.error)}
        <button onClick={() => void history.refetch()} className="font-bold text-brand hover:text-brand-hover">
          {intl.formatMessage(m.retry)}
        </button>
      </div>
    );
  }
  if (history.isLoading) return <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.loading)}</p>;

  return (
    <div className="flex flex-col gap-3">
      <DataTable<ActionProposal>
        className="max-w-none"
        rows={history.proposals}
        rowId={(p) => p.id}
        emptyMessage={intl.formatMessage(m.empty)}
        columns={[
          { key: 'kind', label: intl.formatMessage(m.columnKind), render: (p) => <span className="text-white font-semibold">{intl.formatMessage(KIND_LABEL[p.kind])}</span> },
          { key: 'businessId', label: intl.formatMessage(commonLabels.client), sortValue: (p) => nameFor(p.businessId), render: (p) => <span>{nameFor(p.businessId)}</span> },
          {
            key: 'state',
            label: intl.formatMessage(m.columnOutcome),
            sortValue: (p) => p.state,
            render: (p) => {
              const o = OUTCOME[p.state as keyof typeof OUTCOME];
              return o ? <Pill tone={o.tone}>{intl.formatMessage(o.label)}</Pill> : <Pill>{p.state}</Pill>;
            },
          },
          {
            key: 'outcome',
            label: intl.formatMessage(m.columnReason),
            render: (p) => {
              const d = decisionReason(p);
              if (!d) return <span className="text-zinc-700">—</span>;
              return (
                <span className="text-zinc-400 whitespace-normal">
                  {d.deniedBy ? intl.formatMessage(m.deniedBy, { who: d.deniedBy, reason: d.reason }) : d.reason}
                </span>
              );
            },
          },
          { key: 'executedAt', label: intl.formatMessage(m.columnDecided), sortValue: decidedAt, render: (p) => <span className="tabular-nums">{when(decidedAt(p))}</span> },
        ]}
      />
      {history.hasNextPage && (
        <button
          onClick={() => void history.fetchNextPage()}
          disabled={history.isFetchingNextPage}
          className="self-start px-4 py-2 rounded-xl text-[12px] font-bold text-zinc-300 border border-white/10 hover:border-brand/40 disabled:opacity-50"
        >
          {intl.formatMessage(history.isFetchingNextPage ? m.loadingMore : m.loadMore)}
        </button>
      )}
    </div>
  );
}
