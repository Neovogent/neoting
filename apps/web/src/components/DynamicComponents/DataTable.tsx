import { ReactNode, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, LucideIcon } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { motion } from 'motion/react';

/**
 * The copy this table owns, as opposed to the copy its callers hand it: column
 * labels, titles and bulk-action names arrive as props and are already
 * translated by whoever built them. What is left is the table's own furniture.
 *
 * `footerCount` is the one that mattered most. It is the default footer under
 * every table in the product, and it was `${n} item${n === 1 ? '' : 's'}` —
 * concatenation around a plural, which §12.6 forbids and which no locale with
 * more than two plural forms can express. As ICU the rule is stated once and
 * each locale answers it.
 *
 * `selectHint` and `selectHintGroup` are two whole sentences rather than one
 * with an optional clause, for the reason ActionCard gives: a translator handed
 * a conditional has to reason about both branches at once, and word order
 * around an inserted clause is exactly what differs between languages.
 */
const m = defineMessages({
  empty: { id: 'shell.dataTable.empty', defaultMessage: 'Nothing here.' },
  selectHint: { id: 'shell.dataTable.selectHint', defaultMessage: 'Select {count} or more rows' },
  selectHintGroup: {
    id: 'shell.dataTable.selectHintGroup',
    defaultMessage: 'Select {count} or more rows — this acts on a group',
  },
  selectPrompt: { id: 'shell.dataTable.selectPrompt', defaultMessage: 'Select rows to act' },
  selectedCount: { id: 'shell.dataTable.selectedCount', defaultMessage: '{count} selected' },
  footerCount: {
    id: 'shell.dataTable.footerCount',
    defaultMessage: '{count, plural, one {# item} other {# items}}',
  },
});

export interface Column<T> {
  /**
   * Identifies the column for sorting and for React's key. It is also the
   * field name used when `render` is omitted.
   *
   * Deliberately `string` and not `keyof T`: several tables declare presentation
   * columns — `actions`, `balances` — that correspond to no field at all and
   * always supply `render`. Narrowing this would reject those.
   */
  key: string;
  label: string;
  align?: 'left' | 'right';
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  width?: string;
}

export interface BulkAction<T> {
  label: string;
  icon?: LucideIcon;
  primary?: boolean;
  /**
   * How many rows this action needs before it means anything. Export is the
   * case that matters: a CSV of one row is not an export, it is a worse way
   * to read a document that already has its own View. Defaults to 1.
   */
  minSelected?: number;
  /** Shown on hover when the selection is too small. */
  disabledHint?: string;
  onClick: (rows: T[]) => void;
}

interface DataTableProps<T> {
  /** Omit to render the table without its own header — for full-page use. */
  title?: string;
  subtitle?: string;
  columns: Column<T>[];
  rows: T[];
  rowId: (row: T) => string;
  selectable?: boolean;
  bulkActions?: BulkAction<T>[];
  /** Defaults to "Nothing here." — applied at the render site, not here, so it
   *  can go through the catalogue. A parameter default cannot call `useIntl`. */
  emptyMessage?: string;
  footer?: ReactNode;
  onRowClick?: (row: T) => void;
  /**
   * Also render the bulk actions above the rows. Worth it on a long working
   * table, where scrolling to the bottom to act on a selection made at the
   * top is the whole friction.
   */
  actionsOnTop?: boolean;
  /** Extra controls rendered in the top bar, left of the bulk actions. */
  toolbar?: ReactNode;
  /** Overrides the chat-card width constraint. */
  className?: string;
}

/** Sortable, bulk-selectable table (PRD section 8: "Tables"). */
export function DataTable<T>({
  title,
  subtitle,
  columns,
  rows,
  rowId,
  selectable = false,
  bulkActions = [],
  emptyMessage,
  footer,
  onRowClick,
  actionsOnTop = false,
  toolbar,
  className = 'max-w-3xl',
}: DataTableProps<T>) {
  const intl = useIntl();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = useState<string[]>([]);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av === bv) return 0;
      const cmp = av > bv ? 1 : -1;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir, columns]);

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const allIds = sorted.map(rowId);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.includes(id));
  const selectedRows = rows.filter((r) => selected.includes(rowId(r)));

  const toggleAll = () => setSelected(allSelected ? [] : allIds);
  const toggleOne = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /** One definition, rendered above and/or below the rows. */
  const actionButtons = bulkActions.map((a) => {
    const need = a.minSelected ?? 1;
    const short = selectable && selected.length < need;
    return (
      <button
        key={a.label}
        disabled={short}
        title={
          short
            ? a.disabledHint ??
              intl.formatMessage(need > 1 ? m.selectHintGroup : m.selectHint, { count: need })
            : undefined
        }
        onClick={() => a.onClick(selectable ? selectedRows : rows)}
        className={`flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold rounded-2xl transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
          a.primary
            ? 'text-white bg-brand hover:bg-brand-hover shadow-glow-btn-soft'
            : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 bg-card shadow-inner'
        }`}
      >
        {a.icon && <a.icon size={16} />}
        {a.label}
      </button>
    );
  });

  return (
    <div className={`w-full ${className} border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col`}>
      {title && (
        <div className="p-6 pb-4 flex items-start justify-between gap-4 border-b border-white/5">
          <div>
            <h3 className="font-sans font-bold text-xl text-white tracking-tight">{title}</h3>
            {subtitle && (
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">{subtitle}</p>
            )}
          </div>
          {selectable && selected.length > 0 && (
            <span className="shrink-0 px-3 py-1.5 rounded-full bg-brand/15 border border-brand/30 text-[11px] font-bold text-brand tracking-wide">
              {intl.formatMessage(m.selectedCount, { count: selected.length })}
            </span>
          )}
        </div>
      )}

      {(actionsOnTop || toolbar) && (
        <div className="flex items-center justify-between gap-3 p-4 border-b border-white/5 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap min-w-0">{toolbar}</div>
          {actionsOnTop && bulkActions.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              {selectable && (
                <span className="text-[12px] text-zinc-500 font-semibold px-1">
                  {selected.length === 0
                    ? intl.formatMessage(m.selectPrompt)
                    : intl.formatMessage(m.selectedCount, { count: selected.length })}
                </span>
              )}
              {actionButtons}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-white/5">
              {selectable && (
                <th className="w-12 px-5 py-3 text-left">
                  <Checkbox checked={allSelected} onChange={toggleAll} />
                </th>
              )}
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ width: c.width }}
                  className={`px-5 py-3 text-[11px] font-bold text-zinc-500 uppercase tracking-widest ${
                    c.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {c.sortValue ? (
                    <button
                      onClick={() => toggleSort(c.key)}
                      className={`inline-flex items-center gap-1.5 hover:text-white transition-colors ${
                        sortKey === c.key ? 'text-white' : ''
                      }`}
                    >
                      {c.label}
                      {sortKey === c.key &&
                        (sortDir === 'asc' ? <ArrowUp size={11} strokeWidth={3} /> : <ArrowDown size={11} strokeWidth={3} />)}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)} className="px-5 py-8 text-center text-zinc-500 text-sm">
                  {emptyMessage ?? intl.formatMessage(m.empty)}
                </td>
              </tr>
            )}
            {sorted.map((row, i) => {
              const id = rowId(row);
              const isSel = selected.includes(id);
              return (
                <motion.tr
                  key={id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.3) }}
                  onClick={onRowClick ? () => onRowClick(row) : selectable ? () => toggleOne(id) : undefined}
                  className={`border-b border-white/5 last:border-0 transition-colors ${
                    selectable || onRowClick ? 'cursor-pointer' : ''
                  } ${isSel ? 'bg-brand/[0.07]' : 'hover:bg-white/[0.02]'}`}
                >
                  {selectable && (
                    <td className="px-5 py-3.5">
                      <Checkbox checked={isSel} onChange={() => toggleOne(id)} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-5 py-3.5 text-zinc-300 whitespace-nowrap ${
                        c.align === 'right' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {/* No `render` means "just show the field named by `key`".
                          `key` is a plain string rather than `keyof T`, so this
                          read cannot be checked — see the note on `Column.key`. */}
                      {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                    </td>
                  ))}
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(bulkActions.length > 0 || footer) && (
        <div className="flex items-center justify-between gap-3 bg-raised/50 p-4 flex-wrap">
          <div className="text-[12px] text-zinc-500 font-semibold px-2">
            {footer ?? intl.formatMessage(m.footerCount, { count: rows.length })}
          </div>
          <div className="flex items-center gap-3 flex-wrap">{actionButtons}</div>
        </div>
      )}
    </div>
  );
}

function Checkbox({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={`w-[18px] h-[18px] rounded-md border flex items-center justify-center transition-all ${
        checked ? 'bg-brand border-brand shadow-glow-check' : 'border-white/20 hover:border-white/40'
      }`}
    >
      {checked && <Check size={12} strokeWidth={4} className="text-white" />}
    </button>
  );
}

/** Small pill used inside table cells and cards. */
export function Pill({ children, tone = 'neutral', title }: {
  children: ReactNode;
  tone?: 'neutral' | 'blue' | 'red' | 'green' | 'amber';
  /** Full text on hover, for a label a cell has to trim. */
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-raised text-zinc-300 border-white/5',
    blue: 'bg-brand/15 text-brand border-brand/30',
    red: 'bg-red-500/10 text-red-400 border-red-500/20',
    green: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  };
  return (
    <span title={title} className={`inline-flex items-center px-2.5 py-1 rounded-full border text-[11px] font-bold tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  );
}
