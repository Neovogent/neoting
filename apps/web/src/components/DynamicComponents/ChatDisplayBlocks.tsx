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
 * `count` is a non-negative integer, printed as the digits it is; `date` is
 * the ISO calendar date rendered the way every screen renders one; an empty
 * string is "unknown" and draws as an em dash, never as a zero nobody read.
 * Bars are counts by definition — the contract carries no money on a chart.
 *
 * ⚠ **Reachable only through a `lazy()` in `ChatArea`** — the chat route is
 * over its 250 kB budget and every byte on its opening download is reviewed;
 * a display block renders only AFTER a model turn returns, so the chunk fetch
 * hides behind a wait the user is already having (the `IntentRenderer` rule).
 * The chart is inline SVG for the same reason: no charting library, nothing
 * on the floor.
 *
 * All strings on this surface are the server's (titles, labels, states) or
 * punctuation, so there is nothing to catalogue.
 */

type CellType = 'text' | 'pence' | 'date' | 'count';

const NUMERIC: ReadonlySet<CellType> = new Set<CellType>(['pence', 'count']);

export function cellText(value: string, cellType: CellType): string {
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
                  NUMERIC.has(c.cellType) ? 'text-right' : 'text-left'
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
                    data-cell-type={type}
                    className={`px-4 py-2 ${
                      NUMERIC.has(type) ? 'text-right tabular-nums font-semibold text-white' : 'text-zinc-300'
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

/** Geometry of the inline chart, in SVG user units (the viewBox scales it). */
const BAR_HEIGHT = 18;
const BAR_GAP = 10;
const LABEL_WIDTH = 150;
const VALUE_WIDTH = 36;
const TRACK_WIDTH = 300;
const WIDTH = LABEL_WIDTH + TRACK_WIDTH + VALUE_WIDTH;

/**
 * One horizontal bar per label, drawn as SVG rectangles — the lightest chart
 * that is still a chart. Colours are the theme's: the track and the fill take
 * `currentColor` from Tailwind utility classes on the `<g>` elements, so no
 * literal colour is written here (issue #86's gate) and both themes resolve
 * the tokens themselves. Every bar carries its count as text beside it, so
 * the picture never says more than the number does.
 */
function BarChartBlock({ block }: { block: ChatDisplayBlock }) {
  const bars = block.bars ?? [];
  const max = Math.max(1, ...bars.map((b) => b.count));
  const height = bars.length * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
  return (
    <div className="rounded-2xl border border-white/10 bg-card p-4">
      <svg
        viewBox={`0 0 ${WIDTH} ${Math.max(height, BAR_HEIGHT)}`}
        width="100%"
        height={Math.max(height, BAR_HEIGHT)}
        role="img"
        aria-label={block.title}
        className="block max-w-full text-[12px]"
      >
        {bars.map((bar, i) => {
          const y = i * (BAR_HEIGHT + BAR_GAP);
          const fill = Math.round((bar.count / max) * TRACK_WIDTH);
          return (
            <g key={bar.label} data-bar={bar.label} data-count={bar.count}>
              <title>{`${bar.label}: ${bar.count}`}</title>
              <text
                x={LABEL_WIDTH - 10}
                y={y + BAR_HEIGHT / 2}
                textAnchor="end"
                dominantBaseline="central"
                className="fill-current text-zinc-400 font-semibold"
                fill="currentColor"
              >
                {bar.label}
              </text>
              <g className="text-white/5" fill="currentColor">
                <rect x={LABEL_WIDTH} y={y} width={TRACK_WIDTH} height={BAR_HEIGHT} rx={BAR_HEIGHT / 2} />
              </g>
              <g className="text-brand" fill="currentColor">
                <rect x={LABEL_WIDTH} y={y} width={fill} height={BAR_HEIGHT} rx={BAR_HEIGHT / 2} data-fill-width={fill} />
              </g>
              <text
                x={LABEL_WIDTH + TRACK_WIDTH + VALUE_WIDTH - 2}
                y={y + BAR_HEIGHT / 2}
                textAnchor="end"
                dominantBaseline="central"
                className="text-white font-bold tabular-nums"
                fill="currentColor"
              >
                {bar.count}
              </text>
            </g>
          );
        })}
      </svg>
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
