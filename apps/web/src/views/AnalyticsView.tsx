import { useMemo, useState } from 'react';
import { BarChart2, Download } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { commonLabels } from '../i18n/common';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import type { Client, SourceChannel } from '../lib/types';

// The union stays English — it is the `Document.source` value, compared and
// filtered on. Only the words on the chart are translated.
const CHANNELS: SourceChannel[] = ['email', 'web', 'whatsapp', 'sms-link', 'csv', 'chat', 'portal'];

/** What each intake channel is called on the chart. Descriptors, formatted at the call site. */
const CHANNEL_LABEL: Record<SourceChannel, MessageDescriptor> = defineMessages({
  email: { id: 'analytics.analyticsView.channelEmail', defaultMessage: 'Email' },
  web: { id: 'analytics.analyticsView.channelWeb', defaultMessage: 'Web upload' },
  whatsapp: { id: 'analytics.analyticsView.channelWhatsapp', defaultMessage: 'WhatsApp' },
  'sms-link': { id: 'analytics.analyticsView.channelSmsLink', defaultMessage: 'SMS link' },
  csv: { id: 'analytics.analyticsView.channelCsv', defaultMessage: 'CSV / XLSX' },
  chat: { id: 'analytics.analyticsView.channelChat', defaultMessage: 'Chat' },
  portal: { id: 'analytics.analyticsView.channelPortal', defaultMessage: 'Business portal' },
});

const m = defineMessages({
  heading: { id: 'analytics.analyticsView.heading', defaultMessage: 'Analytics' },
  subheading: {
    id: 'analytics.analyticsView.subheading',
    defaultMessage: 'Document pipeline only — no ledger reporting',
  },
  scopePractice: {
    id: 'analytics.analyticsView.scopePractice',
    defaultMessage: 'Whole practice (incl. our own account)',
  },
  exportAction: { id: 'analytics.analyticsView.exportAction', defaultMessage: 'Export' },

  // A bare percentage and a bare day count are still copy: the space before `%`
  // and the abbreviation for "day" both move between locales.
  percent: { id: 'analytics.analyticsView.percent', defaultMessage: '{value}%' },
  days: { id: 'analytics.analyticsView.days', defaultMessage: '{days}d' },

  statusToReview: { id: 'analytics.analyticsView.statusToReview', defaultMessage: 'To review' },
  statusReady: { id: 'analytics.analyticsView.statusReady', defaultMessage: 'Ready' },
  statusPublished: { id: 'analytics.analyticsView.statusPublished', defaultMessage: 'Published' },
  statusRejected: { id: 'analytics.analyticsView.statusRejected', defaultMessage: 'Rejected' },

  columnHealth: { id: 'analytics.analyticsView.columnHealth', defaultMessage: 'Health' },
  columnToReview: { id: 'analytics.analyticsView.columnToReview', defaultMessage: 'To review' },
  columnMissing: { id: 'analytics.analyticsView.columnMissing', defaultMessage: 'Missing' },
  columnRequested: { id: 'analytics.analyticsView.columnRequested', defaultMessage: 'Requested' },
  columnUnmatched: { id: 'analytics.analyticsView.columnUnmatched', defaultMessage: 'Unmatched' },
  columnItemDelay: { id: 'analytics.analyticsView.columnItemDelay', defaultMessage: 'Item delay' },
  columnAutoPublish: { id: 'analytics.analyticsView.columnAutoPublish', defaultMessage: 'Auto-publish' },

  tileProcessed: { id: 'analytics.analyticsView.tileProcessed', defaultMessage: 'Documents processed' },
  tileProcessedSub: { id: 'analytics.analyticsView.tileProcessedSub', defaultMessage: 'in scope' },
  tileCorrectionRate: { id: 'analytics.analyticsView.tileCorrectionRate', defaultMessage: 'Correction rate' },
  tileCorrectionRateSub: {
    id: 'analytics.analyticsView.tileCorrectionRateSub',
    defaultMessage: 'fields overridden',
  },
  tilePublished: { id: 'analytics.analyticsView.tilePublished', defaultMessage: 'Published' },
  tilePublishedSub: { id: 'analytics.analyticsView.tilePublishedSub', defaultMessage: '{count} items' },
  tileMissing: { id: 'analytics.analyticsView.tileMissing', defaultMessage: 'Missing documents' },
  tileOverdueChases: { id: 'analytics.analyticsView.tileOverdueChases', defaultMessage: 'Overdue chases' },
  tileOverdueChasesSub: {
    id: 'analytics.analyticsView.tileOverdueChasesSub',
    defaultMessage: 'past escalation',
  },
  tileItemDelay: { id: 'analytics.analyticsView.tileItemDelay', defaultMessage: 'Item delay' },
  tileItemDelaySub: { id: 'analytics.analyticsView.tileItemDelaySub', defaultMessage: 'doc date to upload' },
  tileAwaitingReview: { id: 'analytics.analyticsView.tileAwaitingReview', defaultMessage: 'Awaiting review' },
  tileAwaitingReviewSub: {
    id: 'analytics.analyticsView.tileAwaitingReviewSub',
    defaultMessage: 'needs attention',
  },
  tileApprovalQueue: { id: 'analytics.analyticsView.tileApprovalQueue', defaultMessage: 'Approval queue' },
  tileApprovalQueueSub: {
    id: 'analytics.analyticsView.tileApprovalQueueSub',
    defaultMessage: 'avg {days}d old',
  },
  tilePublishFailures: { id: 'analytics.analyticsView.tilePublishFailures', defaultMessage: 'Publish failures' },
  tilePublishFailuresSub: {
    id: 'analytics.analyticsView.tilePublishFailuresSub',
    defaultMessage: 'with a retry',
  },
  tileUnmatched: {
    id: 'analytics.analyticsView.tileUnmatched',
    defaultMessage: 'Unmatched transactions',
  },
  tileUnmatchedSub: { id: 'analytics.analyticsView.tileUnmatchedSub', defaultMessage: 'no evidence' },
  tileStatementGaps: { id: 'analytics.analyticsView.tileStatementGaps', defaultMessage: 'Statement gaps' },
  tileStatementGapsSub: {
    id: 'analytics.analyticsView.tileStatementGapsSub',
    defaultMessage: 'balance discontinuity',
  },
  tileLowConfidence: {
    id: 'analytics.analyticsView.tileLowConfidence',
    defaultMessage: 'Low-confidence fields',
  },
  tileLowConfidenceSub: { id: 'analytics.analyticsView.tileLowConfidenceSub', defaultMessage: 'under 60%' },

  channelMixTitle: { id: 'analytics.analyticsView.channelMixTitle', defaultMessage: 'Channel mix' },
  channelMixSubtitle: {
    id: 'analytics.analyticsView.channelMixSubtitle',
    defaultMessage: 'How documents arrive',
  },
  pipelineStatusTitle: { id: 'analytics.analyticsView.pipelineStatusTitle', defaultMessage: 'Pipeline status' },
  pipelineStatusSubtitle: {
    id: 'analytics.analyticsView.pipelineStatusSubtitle',
    defaultMessage: 'Where documents sit right now',
  },

  tableTitle: { id: 'analytics.analyticsView.tableTitle', defaultMessage: 'Per client' },
  tableSubtitle: {
    id: 'analytics.analyticsView.tableSubtitle',
    defaultMessage: 'Every column derived from live pipeline state',
  },
  tableEmpty: { id: 'analytics.analyticsView.tableEmpty', defaultMessage: 'No clients in scope.' },
  tableFooter: {
    id: 'analytics.analyticsView.tableFooter',
    defaultMessage: '{broken} client(s) with an incomplete integration • {inactive} inactive',
  },
  outOfScope: {
    id: 'analytics.analyticsView.outOfScope',
    defaultMessage:
      'Ledger-health analytics — bank reconciliation status, control accounts, lock dates — are deliberately out of scope. This platform reports on its own pipeline; the accounting software remains the ledger.',
  },
});

export function AnalyticsView() {
  const { clients, documents, missing, chases, approvals, transactions, statementGaps, statsFor, auditLog } = useAppContext();
  const [scope, setScope] = useState('practice');
  const intl = useIntl();

  const scoped = useMemo(
    () => (scope === 'practice' ? documents : documents.filter((d) => d.clientId === scope)),
    [documents, scope],
  );
  const scopedClients = scope === 'practice' ? clients : clients.filter((c) => c.id === scope);

  /** Every figure below is computed from live pipeline state, never stored. */
  const metrics = useMemo(() => {
    const processed = scoped.length;
    const published = scoped.filter((d) => d.status === 'published').length;
    const rejected = scoped.filter((d) => d.status === 'rejected').length;
    const toReview = scoped.filter((d) => d.status === 'review').length;
    const ready = scoped.filter((d) => d.status === 'ready').length;

    // Correction rate: fields an accountant overrode, as a share of all fields.
    const allFields = scoped.flatMap((d) => d.fields);
    const corrected = allFields.filter((f) => f.provenance === 'corrected by accountant').length;
    const lowConfidence = allFields.filter((f) => f.confidence < 0.6).length;

    const openMissing = missing.filter((m) => scope === 'practice' || m.clientId === scope);
    const scopedApprovals = approvals.filter((a) => (scope === 'practice' || a.clientId === scope) && a.state === 'pending');
    const scopedTxns = transactions.filter((t) => scope === 'practice' || t.clientId === scope);
    const scopedChases = chases.filter((c) => scope === 'practice' || c.clientId === scope);

    return {
      processed,
      published,
      rejected,
      toReview,
      ready,
      autoPublishedPct: processed ? Math.round((published / processed) * 100) : 0,
      correctionRate: allFields.length ? Math.round((corrected / allFields.length) * 1000) / 10 : 0,
      lowConfidence,
      missing: openMissing.filter((m) => !m.chased).length,
      requested: openMissing.filter((m) => m.chased).length,
      unverified: openMissing.filter((m) => !m.chased).reduce((n, m) => n + m.amount, 0),
      overdueChases: scopedChases.filter((c) => c.stage === 'escalated').length,
      approvalAge: scopedApprovals.length ? Math.round(scopedApprovals.reduce((n, a) => n + a.waitingDays, 0) / scopedApprovals.length) : 0,
      approvalCount: scopedApprovals.length,
      unmatched: scopedTxns.filter((t) => !t.matchedDocId).length,
      gaps: statementGaps.filter((g) => scope === 'practice' || g.clientId === scope).length,
      integrationsBroken: scopedClients.filter((c) => !c.xeroConnected || !c.bankConnected).length,
      inactive: scopedClients.filter((c) => statsFor(c.id).toReview === 0 && statsFor(c.id).ready === 0).length,
      itemDelay: scopedClients.length
        ? Math.round((scopedClients.reduce((n, c) => n + statsFor(c.id).itemDelay, 0) / scopedClients.length) * 10) / 10
        : 0,
      actions: auditLog.length,
    };
  }, [scoped, missing, approvals, transactions, chases, statementGaps, scopedClients, statsFor, scope, auditLog]);

  const channelMix = useMemo(() => {
    const counts = CHANNELS.map((ch) => ({
      label: intl.formatMessage(CHANNEL_LABEL[ch]),
      value: scoped.filter((d) => d.source === ch).length,
    }));
    return counts.filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
  }, [scoped, intl]);

  const statusMix = [
    { label: intl.formatMessage(m.statusToReview), value: metrics.toReview },
    { label: intl.formatMessage(m.statusReady), value: metrics.ready },
    { label: intl.formatMessage(m.statusPublished), value: metrics.published },
    { label: intl.formatMessage(m.statusRejected), value: metrics.rejected },
  ].filter((s) => s.value > 0);

  const clientColumns: Column<Client>[] = [
    { key: 'name', label: intl.formatMessage(commonLabels.client), sortValue: (c) => c.name, render: (c) => <span className="text-white font-semibold">{c.name}</span> },
    { key: 'health', label: intl.formatMessage(m.columnHealth), align: 'right', sortValue: (c) => statsFor(c.id).health, render: (c) => <Pill tone={statsFor(c.id).health > 80 ? 'green' : statsFor(c.id).health > 50 ? 'amber' : 'red'}>{intl.formatMessage(m.percent, { value: statsFor(c.id).health })}</Pill> },
    { key: 'toReview', label: intl.formatMessage(m.columnToReview), align: 'right', sortValue: (c) => statsFor(c.id).toReview, render: (c) => <span className="tabular-nums text-zinc-300">{statsFor(c.id).toReview}</span> },
    { key: 'missing', label: intl.formatMessage(m.columnMissing), align: 'right', sortValue: (c) => statsFor(c.id).missing, render: (c) => <span className="tabular-nums text-zinc-300">{statsFor(c.id).missing}</span> },
    { key: 'requested', label: intl.formatMessage(m.columnRequested), align: 'right', sortValue: (c) => statsFor(c.id).requested, render: (c) => <span className="tabular-nums text-zinc-300">{statsFor(c.id).requested}</span> },
    { key: 'unmatched', label: intl.formatMessage(m.columnUnmatched), align: 'right', sortValue: (c) => statsFor(c.id).unmatched, render: (c) => <span className="tabular-nums text-zinc-300">{statsFor(c.id).unmatched}</span> },
    { key: 'delay', label: intl.formatMessage(m.columnItemDelay), align: 'right', sortValue: (c) => statsFor(c.id).itemDelay, render: (c) => <span className="tabular-nums text-zinc-400">{intl.formatMessage(m.days, { days: statsFor(c.id).itemDelay })}</span> },
    { key: 'autopub', label: intl.formatMessage(m.columnAutoPublish), align: 'right', sortValue: (c) => statsFor(c.id).autoPublishCoverage, render: (c) => <span className="tabular-nums text-zinc-400">{intl.formatMessage(m.percent, { value: statsFor(c.id).autoPublishCoverage })}</span> },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header className="px-4 md:px-10 pt-4 md:pt-8 pb-4 md:pb-5 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
              <BarChart2 size={22} />
            </div>
            <div>
              <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {intl.formatMessage(m.subheading)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="bg-card border border-white/5 rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-300 focus:outline-none focus:border-brand shadow-inner"
            >
              <option value="practice">{intl.formatMessage(m.scopePractice)}</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button
              onClick={() => exportMetrics(metrics, scope === 'practice' ? 'practice' : clients.find((c) => c.id === scope)?.name ?? '')}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
            >
              <Download size={16} />
              {intl.formatMessage(m.exportAction)}
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={scope} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6">
          <div data-tour="analytics-kpis" className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <Tile label={intl.formatMessage(m.tileProcessed)} value={String(metrics.processed)} sub={intl.formatMessage(m.tileProcessedSub)} />
            <Tile label={intl.formatMessage(m.tileCorrectionRate)} value={intl.formatMessage(m.percent, { value: metrics.correctionRate })} sub={intl.formatMessage(m.tileCorrectionRateSub)} />
            <Tile label={intl.formatMessage(m.tilePublished)} value={intl.formatMessage(m.percent, { value: metrics.autoPublishedPct })} sub={intl.formatMessage(m.tilePublishedSub, { count: metrics.published })} />
            <Tile label={intl.formatMessage(m.tileMissing)} value={String(metrics.missing)} sub={currency(metrics.unverified)} tone={metrics.missing > 20 ? 'red' : 'plain'} />
            <Tile label={intl.formatMessage(m.tileOverdueChases)} value={String(metrics.overdueChases)} sub={intl.formatMessage(m.tileOverdueChasesSub)} tone={metrics.overdueChases ? 'red' : 'plain'} />
            <Tile label={intl.formatMessage(m.tileItemDelay)} value={intl.formatMessage(m.days, { days: metrics.itemDelay })} sub={intl.formatMessage(m.tileItemDelaySub)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <BarPanel title={intl.formatMessage(m.channelMixTitle)} subtitle={intl.formatMessage(m.channelMixSubtitle)} data={channelMix} />
            <BarPanel title={intl.formatMessage(m.pipelineStatusTitle)} subtitle={intl.formatMessage(m.pipelineStatusSubtitle)} data={statusMix} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <Tile label={intl.formatMessage(m.tileAwaitingReview)} value={String(metrics.toReview)} sub={intl.formatMessage(m.tileAwaitingReviewSub)} />
            <Tile label={intl.formatMessage(m.tileApprovalQueue)} value={String(metrics.approvalCount)} sub={intl.formatMessage(m.tileApprovalQueueSub, { days: metrics.approvalAge })} />
            <Tile label={intl.formatMessage(m.tilePublishFailures)} value={String(metrics.rejected)} sub={intl.formatMessage(m.tilePublishFailuresSub)} tone={metrics.rejected ? 'red' : 'plain'} />
            <Tile label={intl.formatMessage(m.tileUnmatched)} value={String(metrics.unmatched)} sub={intl.formatMessage(m.tileUnmatchedSub)} />
            <Tile label={intl.formatMessage(m.tileStatementGaps)} value={String(metrics.gaps)} sub={intl.formatMessage(m.tileStatementGapsSub)} />
            <Tile label={intl.formatMessage(m.tileLowConfidence)} value={String(metrics.lowConfidence)} sub={intl.formatMessage(m.tileLowConfidenceSub)} />
          </div>

          <DataTable<Client>
            className="max-w-none"
            title={intl.formatMessage(m.tableTitle)}
            subtitle={intl.formatMessage(m.tableSubtitle)}
            columns={clientColumns}
            rows={scopedClients}
            rowId={(c) => c.id}
            emptyMessage={intl.formatMessage(m.tableEmpty)}
            footer={intl.formatMessage(m.tableFooter, { broken: metrics.integrationsBroken, inactive: metrics.inactive })}
          />

          <div className="border border-white/5 rounded-[32px] bg-card p-6 text-[13px] text-zinc-500 leading-relaxed">
            {intl.formatMessage(m.outOfScope)}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

const mBar = defineMessages({
  empty: { id: 'analytics.barPanel.empty', defaultMessage: 'Nothing in scope.' },
  valueShare: { id: 'analytics.barPanel.valueShare', defaultMessage: '{count} · {percent}%' },
});

/**
 * Single-series horizontal bars: no legend needed (the row labels name each
 * value), values in text ink rather than the series colour, recessive track.
 *
 * `title`, `subtitle` and every row `label` arrive already formatted — this is
 * a presentational shell, so the copy stays with the screen that owns it.
 */
function BarPanel({ title, subtitle, data }: { title: string; subtitle: string; data: { label: string; value: number }[] }) {
  const intl = useIntl();
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((n, d) => n + d.value, 0);

  return (
    <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 pb-4 border-b border-white/5">
        <h3 className="font-sans font-bold text-lg text-white tracking-tight">{title}</h3>
        <p className="text-[12px] text-zinc-500 mt-0.5 font-semibold uppercase tracking-wider">{subtitle}</p>
      </div>
      <div className="p-6 flex flex-col gap-4">
        {data.length === 0 && <p className="text-[13px] text-zinc-600">{intl.formatMessage(mBar.empty)}</p>}
        {data.map((d) => (
          <div key={d.label}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[13px] font-semibold text-zinc-300">{d.label}</span>
              <span className="text-[12px] font-bold text-zinc-500 tabular-nums">
                {intl.formatMessage(mBar.valueShare, { count: d.value, percent: Math.round((d.value / total) * 100) })}
              </span>
            </div>
            <div className="h-2 w-full bg-raised rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-brand" style={{ width: `${(d.value / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone = 'plain' }: { label: string; value: string; sub: string; tone?: 'plain' | 'red' }) {
  return (
    <div className="bg-card border border-white/5 rounded-[24px] p-5 shadow-2xl">
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{label}</div>
      <div className={`mt-2 text-2xl font-bold tracking-tight tabular-nums ${tone === 'red' ? 'text-red-400' : 'text-white'}`}>
        {value}
      </div>
      <div className="text-[11px] text-zinc-600 font-semibold mt-0.5">{sub}</div>
    </div>
  );
}

function exportMetrics(metrics: Record<string, number>, scopeName: string) {
  const header = 'Scope,Metric,Value\n';
  const body = Object.entries(metrics).map(([k, v]) => `"${scopeName}","${k}",${v}`).join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pipeline-analytics.csv';
  a.click();
  URL.revokeObjectURL(url);
}
