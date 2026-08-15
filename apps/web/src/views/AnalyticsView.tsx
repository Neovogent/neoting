import { useMemo, useState } from 'react';
import { BarChart2, Download } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import type { Client, SourceChannel } from '../lib/types';

const CHANNELS: SourceChannel[] = ['email', 'web', 'whatsapp', 'sms-link', 'csv', 'chat', 'portal'];
const CHANNEL_LABEL: Record<SourceChannel, string> = {
  email: 'Email', web: 'Web upload', whatsapp: 'WhatsApp', 'sms-link': 'SMS link', csv: 'CSV / XLSX', chat: 'Chat',
  portal: 'Business portal',
};

export function AnalyticsView() {
  const { clients, documents, missing, chases, approvals, transactions, statementGaps, statsFor, auditLog } = useAppContext();
  const [scope, setScope] = useState('practice');

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
    const counts = CHANNELS.map((ch) => ({ label: CHANNEL_LABEL[ch], value: scoped.filter((d) => d.source === ch).length }));
    return counts.filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
  }, [scoped]);

  const statusMix = [
    { label: 'To review', value: metrics.toReview },
    { label: 'Ready', value: metrics.ready },
    { label: 'Published', value: metrics.published },
    { label: 'Rejected', value: metrics.rejected },
  ].filter((s) => s.value > 0);

  const clientColumns: Column<Client>[] = [
    { key: 'name', label: 'Client', sortValue: (c) => c.name, render: (c) => <span className="text-white font-semibold">{c.name}</span> },
    { key: 'health', label: 'Health', align: 'right', sortValue: (c) => statsFor(c.id).health, render: (c) => <Pill tone={statsFor(c.id).health > 80 ? 'green' : statsFor(c.id).health > 50 ? 'amber' : 'red'}>{statsFor(c.id).health}%</Pill> },
    { key: 'toReview', label: 'To review', align: 'right', sortValue: (c) => statsFor(c.id).toReview, render: (c) => <span className="tabular-nums text-zinc-300">{statsFor(c.id).toReview}</span> },
    { key: 'missing', label: 'Missing', align: 'right', sortValue: (c) => statsFor(c.id).missing, render: (c) => <span className="tabular-nums text-zinc-300">{statsFor(c.id).missing}</span> },
    { key: 'requested', label: 'Requested', align: 'right', sortValue: (c) => statsFor(c.id).requested, render: (c) => <span className="tabular-nums text-zinc-300">{statsFor(c.id).requested}</span> },
    { key: 'unmatched', label: 'Unmatched', align: 'right', sortValue: (c) => statsFor(c.id).unmatched, render: (c) => <span className="tabular-nums text-zinc-300">{statsFor(c.id).unmatched}</span> },
    { key: 'delay', label: 'Item delay', align: 'right', sortValue: (c) => statsFor(c.id).itemDelay, render: (c) => <span className="tabular-nums text-zinc-400">{statsFor(c.id).itemDelay}d</span> },
    { key: 'autopub', label: 'Auto-publish', align: 'right', sortValue: (c) => statsFor(c.id).autoPublishCoverage, render: (c) => <span className="tabular-nums text-zinc-400">{statsFor(c.id).autoPublishCoverage}%</span> },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0c] h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[#202026] flex items-center justify-center text-white border border-white/5 shadow-inner">
              <BarChart2 size={22} />
            </div>
            <div>
              <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">Analytics</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                Document pipeline only — no ledger reporting
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="bg-[#16161a] border border-white/5 rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-300 focus:outline-none focus:border-[#14e3c4] shadow-inner"
            >
              <option value="practice">Whole practice (incl. our own account)</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button
              onClick={() => exportMetrics(metrics, scope === 'practice' ? 'practice' : clients.find((c) => c.id === scope)?.name ?? '')}
              className="flex items-center gap-2 px-6 py-2.5 bg-[#14e3c4] text-white text-sm font-bold rounded-full hover:bg-[#0fcbaf] transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
            >
              <Download size={16} />
              Export
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={scope} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-6">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <Tile label="Documents processed" value={String(metrics.processed)} sub="in scope" />
            <Tile label="Correction rate" value={`${metrics.correctionRate}%`} sub="fields overridden" />
            <Tile label="Published" value={`${metrics.autoPublishedPct}%`} sub={`${metrics.published} items`} />
            <Tile label="Missing documents" value={String(metrics.missing)} sub={currency(metrics.unverified)} tone={metrics.missing > 20 ? 'red' : 'plain'} />
            <Tile label="Overdue chases" value={String(metrics.overdueChases)} sub="past escalation" tone={metrics.overdueChases ? 'red' : 'plain'} />
            <Tile label="Item delay" value={`${metrics.itemDelay}d`} sub="doc date to upload" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <BarPanel title="Channel mix" subtitle="How documents arrive" data={channelMix} />
            <BarPanel title="Pipeline status" subtitle="Where documents sit right now" data={statusMix} />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <Tile label="Awaiting review" value={String(metrics.toReview)} sub="needs attention" />
            <Tile label="Approval queue" value={String(metrics.approvalCount)} sub={`avg ${metrics.approvalAge}d old`} />
            <Tile label="Publish failures" value={String(metrics.rejected)} sub="with a retry" tone={metrics.rejected ? 'red' : 'plain'} />
            <Tile label="Unmatched transactions" value={String(metrics.unmatched)} sub="no evidence" />
            <Tile label="Statement gaps" value={String(metrics.gaps)} sub="balance discontinuity" />
            <Tile label="Low-confidence fields" value={String(metrics.lowConfidence)} sub="under 60%" />
          </div>

          <DataTable<Client>
            className="max-w-none"
            title="Per client"
            subtitle="Every column derived from live pipeline state"
            columns={clientColumns}
            rows={scopedClients}
            rowId={(c) => c.id}
            emptyMessage="No clients in scope."
            footer={`${metrics.integrationsBroken} client(s) with an incomplete integration • ${metrics.inactive} inactive`}
          />

          <div className="border border-white/5 rounded-[32px] bg-[#16161a] p-6 text-[13px] text-zinc-500 leading-relaxed">
            Ledger-health analytics — bank reconciliation status, control accounts, lock dates — are deliberately out of
            scope. This platform reports on its own pipeline; the accounting software remains the ledger.
          </div>
        </motion.div>
      </div>
    </div>
  );
}

/**
 * Single-series horizontal bars: no legend needed (the row labels name each
 * value), values in text ink rather than the series colour, recessive track.
 */
function BarPanel({ title, subtitle, data }: { title: string; subtitle: string; data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((n, d) => n + d.value, 0);

  return (
    <div className="border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
      <div className="p-6 pb-4 border-b border-white/5">
        <h3 className="font-sans font-bold text-lg text-white tracking-tight">{title}</h3>
        <p className="text-[12px] text-zinc-500 mt-0.5 font-semibold uppercase tracking-wider">{subtitle}</p>
      </div>
      <div className="p-6 flex flex-col gap-4">
        {data.length === 0 && <p className="text-[13px] text-zinc-600">Nothing in scope.</p>}
        {data.map((d) => (
          <div key={d.label}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[13px] font-semibold text-zinc-300">{d.label}</span>
              <span className="text-[12px] font-bold text-zinc-500 tabular-nums">
                {d.value} · {Math.round((d.value / total) * 100)}%
              </span>
            </div>
            <div className="h-2 w-full bg-[#202026] rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-[#14e3c4]" style={{ width: `${(d.value / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, sub, tone = 'plain' }: { label: string; value: string; sub: string; tone?: 'plain' | 'red' }) {
  return (
    <div className="bg-[#16161a] border border-white/5 rounded-[24px] p-5 shadow-2xl">
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
