import type { ChatDisplayBlock } from '@neoting/contracts/model';
import { currency } from '../../lib/resolver';
import { fromIsoDate } from '../../api/documents';

/**
 * The renderer for a grounded answer's display blocks (§9.4's pictures): a
 * table or a bar chart the SERVER composed from the client's own records —
 * nothing here invents a value, and nothing here is interactive state; it is
 * a rendering of facts the reply already stands on.
 *
 * Cells arrive as strings typed by their column: `pence` is signed integer
 * pence in decimal digits crossing the app's one money boundary right here;
 * `date` is the ISO calendar date rendered the way every screen renders one;
 * an empty string is "unknown" and draws as an em dash, never as a zero
 * nobody read. Bars are counts by definition — the contract carries no money
 * on a chart.
 *
 * All strings on this surface are the server's (titles, labels, states) or
 * punctuation, so there is nothing to catalogue.
 */

function cellText(value: string, cellType: 'text' | 'pence' | 'date' | 'count'): string {
  if (value === '') return '—';
  if (cellType === 'pence') return currency(Number(value) / 100);
  if (cellType === 'date') return fromIsoDate(value);
  return value;
}

function TableBlock({ block }: { block: ChatDisplayBlock }) {
  const columns = block.columns ?? [];
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-card">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-white/5">
            {columns.map((c) => (
              <th
                key={c.name}
                scope="col"
                className={`px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-zinc-500 ${
                  c.cellType === 'pence' || c.cellType === 'count' ? 'text-right' : 'text-left'
                }`}
              >
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(block.rows ?? []).map((row, i) => (
            // Row order is the server's (recent first) and rows have no ids —
            // the index is the identity a rendering of a snapshot actually has.
            <tr key={i} className="border-b border-white/5 last:border-0">
              {row.map((value, j) => {
                const type = columns[j]?.cellType ?? 'text';
                return (
                  <td
                    key={j}
                    className={`px-4 py-2 ${
                      type === 'pence' || type === 'count'
                        ? 'text-right tabular-nums font-semibold text-white'
                        : 'text-zinc-300'
                    }`}
                  >
                    {cellText(value, type)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChartBlock({ block }: { block: ChatDisplayBlock }) {
  const bars = block.bars ?? [];
  const max = Math.max(1, ...bars.map((b) => b.count));
  return (
    <div className="rounded-2xl border border-white/10 bg-card p-4 flex flex-col gap-2.5">
      {bars.map((bar) => (
        <div key={bar.label} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-[12px] font-semibold text-zinc-400" title={bar.label}>
            {bar.label}
          </span>
          <div className="flex-1 h-5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full bg-brand transition-all"
              style={{ width: `${Math.round((bar.count / max) * 100)}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-[12px] font-bold tabular-nums text-white">{bar.count}</span>
        </div>
      ))}
    </div>
  );
}

export function ChatDisplayBlocks({ blocks }: { blocks: ChatDisplayBlock[] }) {
  return (
    <div className="flex flex-col gap-3 mb-4">
      {blocks.map((block) => (
        <section key={block.title} aria-label={block.title}>
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-zinc-500 mb-2">{block.title}</h4>
          {block.kind === 'table' ? <TableBlock block={block} /> : <BarChartBlock block={block} />}
        </section>
      ))}
    </div>
  );
}
