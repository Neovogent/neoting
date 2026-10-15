import { useMemo, useState } from 'react';
import { BarChart2, Download } from 'lucide-react';
import { API_ENABLED } from '../api/config';
import { analyticsCsvHref, isoDaysAgo, useAnalyticsReport, type AnalyticsReport } from '../api/analytics';
import { UkDateField } from '../components/DynamicComponents/UkDateField';
import { motion } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { commonLabels } from '../i18n/common';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { buildPracticeReport, type ClientReportRow } from '../lib/analyticsReport';
import { currency } from '../lib/resolver';
import { isUnexplained } from '../lib/matching';
import type { Client, SourceChannel } from '../lib/types';

// The union stays English — it is the `Document.source` value, compared and
// filtered on. Only the words on the chart are translated.
const CHANNELS: SourceChannel[] = ['email', 'web', 'whatsapp', 'sms-link', 'csv', 'chat', 'portal'];

/** What each intake channel is called on the chart. Descriptors, formatted at the call site. */
const CHANNEL_LABEL: Record<SourceChannel, MessageDescriptor> = defineMessages({
  email: { id: 'analytics.analyticsView.channelEmail', defaultMessage: 'Email' },
  web: { id: 'analytics.analyticsView.channelWeb', defaultMessage: 'Web upload' },
  whatsapp: { id: 'analytics.analyticsView.channelWhatsapp', defaultMessage: 'WhatsApp' },
  'sms-link': { id: 'analytics.analyticsView.channelSmsLink', defaultMessage: 'Chase link' },
  csv: { id: 'analytics.analyticsView.channelCsv', defaultMessage: 'CSV / XLSX' },
  chat: { id: 'analytics.analyticsView.channelChat', defaultMessage: 'Chat' },
  // "Client portal" everywhere (item 21's sweep): the same surface must not be
  // "Business portal" on this chart and "Client portal" on every row cell.
  portal: { id: 'analytics.analyticsView.channelPortal', defaultMessage: 'Client portal' },
});

const m = defineMessages({
  heading: { id: 'analytics.analyticsView.heading', defaultMessage: 'Analytics' },
  subheading: {
    id: 'analytics.analyticsView.subheading',
    defaultMessage: 'Document pipeline only — no accounts reporting',
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
    defaultMessage: '{inactive} inactive client(s)',
  },
  outOfScope: {
    id: 'analytics.analyticsView.outOfScope',
    defaultMessage:
      'Accounts-health analytics — bank reconciliation status, control accounts, lock dates — are deliberately out of scope. This platform reports on its own document pipeline; the accounting software remains the system of record.',
  },
});

/**
 * Live, every figure is the SERVER's (`GET /v1/analytics/…`, SoT §11) for a
 * chosen period; the synthetic cast keeps its client-side derivation so the
 * demo still walks with no API (METH_MODE §1).
 */
export function AnalyticsView() {
  return API_ENABLED ? <LiveAnalytics /> : <SyntheticAnalytics />;
}

const mLive = defineMessages({
  preset: { id: 'analytics.live.preset', defaultMessage: 'Last {days} days' },
  from: { id: 'analytics.live.from', defaultMessage: 'From' },
  to: { id: 'analytics.live.to', defaultMessage: 'To' },
  csv: { id: 'analytics.live.csv', defaultMessage: 'Download CSV' },
  loading: { id: 'analytics.live.loading', defaultMessage: 'Working out the numbers for this period…' },
  failed: { id: 'analytics.live.failed', defaultMessage: 'Analytics could not be loaded: {error}' },
  notMeasurable: { id: 'analytics.live.notMeasurable', defaultMessage: 'Nothing to measure in this period' },
  hours: { id: 'analytics.live.hours', defaultMessage: '{value}h' },
  seriesTitle: { id: 'analytics.live.seriesTitle', defaultMessage: 'Documents received and processed' },
  seriesSubtitle: {
    id: 'analytics.live.seriesSubtitle',
    defaultMessage: '{bucket, select, week {By week} other {By day}} · {from} to {to}',
  },
  received: { id: 'analytics.live.received', defaultMessage: 'Received' },
  seriesTip: {
    id: 'analytics.live.seriesTip',
    defaultMessage: '{period} · {received} received · {processed} processed',
  },
  processed: { id: 'analytics.live.processed', defaultMessage: 'Processed' },
  breakdownSubtitle: { id: 'analytics.live.breakdownSubtitle', defaultMessage: 'In this period' },
  inactiveTitle: { id: 'analytics.live.inactiveTitle', defaultMessage: 'Clients with nothing received' },
  inactiveNone: { id: 'analytics.live.inactiveNone', defaultMessage: 'Every active client sent something in this period.' },
  lastSeen: { id: 'analytics.live.lastSeen', defaultMessage: 'Last document {date}' },
  neverSeen: { id: 'analytics.live.neverSeen', defaultMessage: 'No documents yet' },
});

function LiveAnalytics() {
  const { businesses } = useAppContext();
  const intl = useIntl();
  const [scope, setScope] = useState('practice');
  const [period, setPeriod] = useState(() => ({ from: isoDaysAgo(29), to: isoDaysAgo(0) }));
  const report = useAnalyticsReport(scope, period);

  // A half-typed date reports '' — keep the last whole one rather than querying nothing.
  const setBound = (key: 'from' | 'to') => (iso: string) => {
    if (iso !== '') setPeriod((p) => ({ ...p, [key]: iso }));
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header className="px-4 md:px-10 pt-4 md:pt-8 pb-4 md:pb-5 shrink-0 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
              <BarChart2 size={22} />
            </div>
            <div>
              <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">{intl.formatMessage(m.subheading)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="bg-card border border-white/5 rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-300 focus:outline-none focus:border-brand shadow-inner"
            >
              <option value="practice">{intl.formatMessage(m.scopePractice)}</option>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <a
              href={analyticsCsvHref(scope, period)}
              download
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-6 py-2.5 bg-brand text-brand-on text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
            >
              <Download size={16} />
              {intl.formatMessage(mLive.csv)}
            </a>
          </div>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          {[7, 30, 90].map((days) => {
            const active = period.from === isoDaysAgo(days - 1) && period.to === isoDaysAgo(0);
            return (
              <button
                key={days}
                type="button"
                onClick={() => setPeriod({ from: isoDaysAgo(days - 1), to: isoDaysAgo(0) })}
                className={`px-4 py-2 rounded-full text-[12px] font-bold border transition-colors ${active ? 'bg-brand text-brand-on border-brand' : 'bg-card text-zinc-300 border-white/5 hover:border-brand'}`}
              >
                {intl.formatMessage(mLive.preset, { days })}
              </button>
            );
          })}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest" htmlFor="analytics-from">
              {intl.formatMessage(mLive.from)}
            </label>
            <UkDateField id="analytics-from" value={period.from} max={period.to} onChange={setBound('from')} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest" htmlFor="analytics-to">
              {intl.formatMessage(mLive.to)}
            </label>
            <UkDateField id="analytics-to" value={period.to} min={period.from} onChange={setBound('to')} />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {report.isPending && <p className="text-[13px] text-zinc-500">{intl.formatMessage(mLive.loading)}</p>}
        {report.isError && (
          <p role="alert" className="text-[13px] text-red-400">
            {intl.formatMessage(mLive.failed, { error: report.error instanceof Error ? report.error.message : String(report.error) })}
          </p>
        )}
        {report.data !== undefined && <LiveReport report={report.data} />}
      </div>
    </div>
  );
}

function LiveReport({ report }: { report: AnalyticsReport }) {
  const intl = useIntl();
  const value = (metric: AnalyticsReport['metrics'][number]): string => {
    if (metric.value === null) return '—';
    if (metric.unit === 'percent') return intl.formatMessage(m.percent, { value: metric.value });
    if (metric.unit === 'days') return intl.formatMessage(m.days, { days: metric.value });
    if (metric.unit === 'hours') return intl.formatMessage(mLive.hours, { value: metric.value });
    return intl.formatNumber(metric.value);
  };
  const max = Math.max(1, ...report.series.map((s) => s.received));
  const day = (iso: string) => intl.formatDate(new Date(`${iso}T00:00:00.000Z`), { day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <motion.div key={`${report.scope}-${report.from}-${report.to}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6">
      <div data-tour="analytics-kpis" className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
        {report.metrics.map((metric) => (
          <Tile
            key={metric.key}
            label={metric.label}
            value={value(metric)}
            sub={metric.value === null ? intl.formatMessage(mLive.notMeasurable) : ''}
          />
        ))}
      </div>

      <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 pb-4 border-b border-white/5">
          <h3 className="font-sans font-bold text-lg text-white tracking-tight">{intl.formatMessage(mLive.seriesTitle)}</h3>
          <p className="text-[12px] text-zinc-500 mt-0.5 font-semibold uppercase tracking-wider">
            {intl.formatMessage(mLive.seriesSubtitle, { bucket: report.bucket, from: day(report.from), to: day(report.to) })}
          </p>
        </div>
        <div className="p-6 flex items-end gap-1 h-48 overflow-x-auto">
          {report.series.map((s) => (
            <div
              key={s.period}
              className="flex-1 min-w-[10px] h-full flex flex-col justify-end"
              title={intl.formatMessage(mLive.seriesTip, { period: day(s.period), received: s.received, processed: s.processed })}
            >
              <div className="w-full rounded-t bg-brand/30 relative" style={{ height: `${(s.received / max) * 100}%` }}>
                <div className="absolute bottom-0 inset-x-0 rounded-t bg-brand" style={{ height: s.received === 0 ? 0 : `${(s.processed / s.received) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="px-6 pb-5 flex gap-4 text-[12px] font-semibold text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-brand/30" />
            {intl.formatMessage(mLive.received)}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm bg-brand" />
            {intl.formatMessage(mLive.processed)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {report.breakdowns.map((b) => (
          <BarPanel
            key={b.key}
            title={b.title}
            subtitle={intl.formatMessage(mLive.breakdownSubtitle)}
            data={b.rows.map((r) => ({ label: r.label, value: r.count }))}
          />
        ))}
      </div>

      <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl p-6 flex flex-col gap-3">
        <h3 className="font-sans font-bold text-lg text-white tracking-tight">{intl.formatMessage(mLive.inactiveTitle)}</h3>
        {report.inactiveClients.length === 0 ? (
          <p className="text-[13px] text-zinc-500">{intl.formatMessage(mLive.inactiveNone)}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {report.inactiveClients.map((c) => (
              <li key={c.businessId} className="flex items-baseline justify-between gap-4 text-[13px]">
                <span className="text-zinc-200 font-semibold">{c.name}</span>
                <span className="text-zinc-500">
                  {c.lastDocumentAt === null
                    ? intl.formatMessage(mLive.neverSeen)
                    : intl.formatMessage(mLive.lastSeen, {
                        date: intl.formatDate(new Date(c.lastDocumentAt), {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                          timeZone: 'Europe/London',
                        }),
                      })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border border-white/5 rounded-[32px] bg-card p-6 text-[13px] text-zinc-500 leading-relaxed">
        {intl.formatMessage(m.outOfScope)}
      </div>
    </motion.div>
  );
}

function SyntheticAnalytics() {
  const { clients, businesses, documents, missing, chases, approvals, transactions, statementGaps, statsFor, auditLog } = useAppContext();
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
      // ⚠ This key was `autoPublishedPct` — D42-forbidden vocabulary (nothing
      // auto-publishes in ID; Published is a human release). What it measures
      // is the share of processed documents that reached Published, so that is
      // its name (review item 56).
      publishedPct: processed ? Math.round((published / processed) * 100) : 0,
      correctionRate: allFields.length ? Math.round((corrected / allFields.length) * 1000) / 10 : 0,
      lowConfidence,
      missing: openMissing.filter((m) => !m.chased).length,
      requested: openMissing.filter((m) => m.chased).length,
      unverified: openMissing.filter((m) => !m.chased).reduce((n, m) => n + m.amount, 0),
      overdueChases: scopedChases.filter((c) => c.stage === 'escalated').length,
      approvalAge: scopedApprovals.length ? Math.round(scopedApprovals.reduce((n, a) => n + a.waitingDays, 0) / scopedApprovals.length) : 0,
      approvalCount: scopedApprovals.length,
      // ⚠ This was `!t.matchedDocId`, and on live data it counted EVERY
      // transaction. A server row carries `matchState` and, until a match is
      // CONFIRMED, no document id at all — `lib/matching.ts` says in as many
      // words not to branch on that field. So the tile read the size of the
      // bank feed while the per-client Unmatched column beside it, which goes
      // through `statsFor` and therefore through the server's own counts, read
      // the real figure. `isUnexplained` is what both are on now.
      unmatched: scopedTxns.filter(isUnexplained).length,
      gaps: statementGaps.filter((g) => scope === 'practice' || g.clientId === scope).length,
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
              onClick={() =>
                downloadReport(
                  buildPracticeReport({
                    // One row per client in scope, from `statsFor` — live that
                    // is the server's own BusinessSummary counts, so the file
                    // cannot disagree with the Clients board (item 56).
                    rows: scopedClients.map(
                      (c): ClientReportRow => ({
                        name: c.name,
                        stats: statsFor(c.id),
                        subscriptionStatus: businesses.find((b) => b.id === c.id)?.subscription?.status ?? null,
                      }),
                    ),
                    scopeName:
                      scope === 'practice'
                        ? intl.formatMessage(m.scopePractice)
                        : clients.find((c) => c.id === scope)?.name ?? '',
                    // Rule 8: Europe/London in rendering; long form so no locale can misread it.
                    generatedOn: intl.formatDate(new Date(), {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                      timeZone: 'Europe/London',
                    }),
                  }),
                )
              }
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
            <Tile label={intl.formatMessage(m.tilePublished)} value={intl.formatMessage(m.percent, { value: metrics.publishedPct })} sub={intl.formatMessage(m.tilePublishedSub, { count: metrics.published })} />
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
            footer={intl.formatMessage(m.tableFooter, { inactive: metrics.inactive })}
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

/**
 * The old export serialised the internal KPI object — metric keys and bare
 * numbers, no client dimension (review item 56: "super dumb"). The file is now
 * `lib/analyticsReport.ts`'s designed report; this only downloads the bytes.
 * The BOM is for Excel, which misreads a bare UTF-8 CSV's accented names.
 */
function downloadReport(csv: string) {
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'practice-analytics-report.csv';
  a.click();
  URL.revokeObjectURL(url);
}
