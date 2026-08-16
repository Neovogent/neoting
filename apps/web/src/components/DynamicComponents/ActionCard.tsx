import { FileSearch, ArrowRight, Eye, Download } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import type { Intent, MissingItem } from '../../lib/types';

const ENGINE_LABEL: Record<MissingItem['detectedBy'], string> = {
  'bank-transaction': 'bank gaps',
  'supplier-statement': 'supplier stmts',
  'statement-gap': 'statement gaps',
  'ledger-attachment': 'ledger gaps',
  recurring: 'recurring missing',
};

/**
 * Missing-evidence action card (PRD stage 8). Summarises what the five
 * detection engines found and offers the next step inline in chat.
 */
// `period?: string | undefined` rather than `?: string` — it is read straight
// off `MessagePayload.period`, which is optional, so the caller genuinely does
// pass an explicit `undefined`. See the note in lib/types.ts.
export function ActionCard({ clientIds, period }: { clientIds: string[]; period?: string | undefined }) {
  const { missing, clients, addMessage } = useAppContext();

  const items = missing.filter((m) => (clientIds.length ? clientIds.includes(m.clientId) : true) && !m.chased);
  const scopeName =
    clientIds.length === 1 ? clients.find((c) => c.id === clientIds[0])?.name ?? 'All clients' : `${clientIds.length || clients.length} clients`;

  const unverified = items.reduce((n, m) => n + m.amount, 0);
  const byEngine = items.reduce<Record<string, number>>((acc, m) => {
    acc[m.detectedBy] = (acc[m.detectedBy] ?? 0) + 1;
    return acc;
  }, {});

  const post = (content: string, intent: Intent) =>
    addMessage({
      id: `${Date.now()}-${intent}`,
      role: 'assistant',
      content,
      intent,
      payload: { clientIds, clientNames: [], period },
    });

  if (items.length === 0) {
    return (
      <div className="w-full max-w-lg border border-emerald-500/20 rounded-[24px] bg-emerald-500/5 p-5 text-sm text-emerald-300 font-semibold">
        Nothing missing for {scopeName}{period ? ` in ${period}` : ''} — every detected gap is closed or already chased.
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-start gap-5 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center text-red-500 shrink-0 border border-red-500/20 shadow-inner">
          <FileSearch size={24} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">
            {items.length} document{items.length === 1 ? '' : 's'} missing
          </h3>
          <p className="text-[13px] font-semibold text-zinc-500 mt-1 uppercase tracking-wider truncate">
            {scopeName}
            {period ? ` • ${period} 2026` : ''}
          </p>
          <div className="flex flex-wrap gap-2 mt-4">
            <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-raised text-[11px] font-bold text-white border border-white/5">
              {currency(unverified)} unverified
            </span>
            {Object.entries(byEngine).map(([engine, count]) => (
              <span
                key={engine}
                className="inline-flex items-center px-3 py-1.5 rounded-full bg-raised text-[11px] font-bold text-white border border-white/5"
              >
                {count} {ENGINE_LABEL[engine as MissingItem['detectedBy']]}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center bg-raised/50 p-4 gap-3">
        <button
          onClick={() => post("Here's the chase, grouped per client. Read the review before it sends.", 'CHASE_MISSING')}
          className="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold text-white bg-brand rounded-2xl hover:bg-brand-hover transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
        >
          Chase missing
          <ArrowRight size={16} strokeWidth={2.5} />
        </button>
        <button
          onClick={() => post('Every outstanding item, sortable and bulk-selectable:', 'SHOW_MISSING_TABLE')}
          className="px-4 py-3 text-zinc-400 hover:text-white hover:bg-white/5 rounded-2xl transition-colors border border-white/5 bg-card shadow-inner"
          title="Review items"
        >
          <Eye size={20} />
        </button>
        <button
          onClick={() => downloadCsv(items)}
          className="px-4 py-3 text-zinc-400 hover:text-white hover:bg-white/5 rounded-2xl transition-colors border border-white/5 bg-card shadow-inner"
          title="Export CSV"
        >
          <Download size={20} />
        </button>
      </div>
    </div>
  );
}

function downloadCsv(items: MissingItem[]) {
  const header = 'Client,Supplier,Date,Amount,Detected by\n';
  const body = items.map((i) => `"${i.clientName}","${i.supplier}","${i.date}",${i.amount},"${i.detectedBy}"`).join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'missing-documents.csv';
  a.click();
  URL.revokeObjectURL(url);
}
