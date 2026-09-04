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
 *
 * `bulkHint` is a seventh, and it is not `selectHint` reused. `selectHint`
 * hangs off the button as a hover title, so it can say "select more rows" and
 * let the button say which action it means. The amber line stands away from
 * every button and has to name the one it is about, which is a different
 * sentence, not the same sentence in a different place.
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
  bulkHint: {
    id: 'shell.dataTable.bulkHint',
    defaultMessage: '{action} needs {count, plural, one {# row} other {# rows}} selected',
  },
  /**
   * ⚠ The eighth, and it closes a real complaint: on the Documents screen the
   * only two bulk actions read as permanently greyed out. They were disabled
   * because NOTHING WAS SELECTED — every action needs at least one row — and
   * the screen said so nowhere a person could read it. `selectHint` is a hover
   * `title`, which is invisible on a phone and unfindable on a desktop unless
   * you already suspect the answer; `bulkHint` only appears once a selection
   * has begun. A bar of disabled buttons with no stated reason teaches an
   * accountant that the feature is broken.
   *
   * It names the shift-range too, because that is the affordance nobody
   * discovers by accident and the one that makes a bulk bar worth having.
   */
  selectNothing: {
    id: 'shell.dataTable.selectNothing',
    defaultMessage: 'Nothing is selected. Tick a row to act on it — or tick one and shift-click another to take the range.',
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
  /**
   * How the card layout (narrow containers) treats this column. Omit for the
   * default: the first column becomes the card title, a column with an empty
   * label is an action group and goes to the card's foot, anything else is a
   * label/value pair. `hidden` drops it from cards altogether.
   */
  card?: 'title' | 'field' | 'actions' | 'hidden';
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
  /**
   * Force the action off regardless of the selection — for an action whose
   * write has no live path yet (the S14 rule: a disabled button wearing its
   * reason beats one whose write the next poll reverts, and beats hiding a
   * real affordance). `disabledHint` carries the reason.
   */
  disabled?: boolean;
  /**
   * Stable `data-tour` anchor. Explicit rather than derived from `label`,
   * which the frame this came from did: `label` is translated copy here, so a
   * derived key would be a different key in every locale and the tour would
   * find nothing outside English.
   */
  tourKey?: string;
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

/**
 * Sortable, bulk-selectable table (PRD section 8: "Tables").
 *
 * Two layouts, chosen by CONTAINER width rather than viewport width: below the
 * `@3xl` container breakpoint each row is a card, above it the table. The
 * container query is the point — the same table renders inside a chat card
 * about half the width of the page, so a viewport media query would give a
 * phone layout to a wide screen's chat column and a table to neither.
 */
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
  /** The last row toggled without shift — one end of a shift-click range. */
  const [anchorId, setAnchorId] = useState<string | null>(null);

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

  /**
   * Shift-click takes a RANGE, from the last row toggled to this one, in the
   * order the table is currently sorted in — which is the order on screen, and
   * the only order a person could mean. It ADDS rather than toggling: dragging
   * a selection open and having half of it close again is the behaviour every
   * file manager decided against decades ago.
   *
   * The anchor is the last row toggled without shift. A shift-click with no
   * anchor (the first click on a fresh table) is an ordinary toggle rather than
   * nothing happening.
   */
  const toggleOne = (id: string, extend = false) => {
    const anchorIndex = anchorId === null ? -1 : allIds.indexOf(anchorId);
    const targetIndex = allIds.indexOf(id);
    if (extend && anchorIndex !== -1 && targetIndex !== -1 && anchorIndex !== targetIndex) {
      const [from, to] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      const range = allIds.slice(from, to + 1);
      setSelected((prev) => [...prev, ...range.filter((x) => !prev.includes(x))]);
      return;
    }
    setAnchorId(id);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const emptyText = emptyMessage ?? intl.formatMessage(m.empty);

  /** The hover title on a disabled action: the button says which action. */
  const hoverHint = (a: BulkAction<T>) => {
    const need = a.minSelected ?? 1;
    return (
      a.disabledHint ?? intl.formatMessage(need > 1 ? m.selectHintGroup : m.selectHint, { count: need })
    );
  };

  // A hover title is invisible on a phone — there is nothing to hover with —
  // so once the user has started selecting, the reason an action is still off
  // is written under the bar where a thumb can read it. It names the action,
  // because unlike the title it is not attached to the button.
  const shortAction =
    selectable && selected.length > 0
      ? bulkActions.find((a) => a.disabled === true || selected.length < (a.minSelected ?? 1))
      : undefined;
  const shortHint = shortAction
    ? shortAction.disabledHint ??
      intl.formatMessage(m.bulkHint, {
        action: shortAction.label,
        count: shortAction.minSelected ?? 1,
      })
    : undefined;

  /**
   * The reason EVERY action is off, said where a reason belongs. See the note
   * on `m.selectNothing`: this is the line whose absence made the Documents
   * screen's bulk bar read as broken.
   */
  const nothingSelected = selectable && bulkActions.length > 0 && selected.length === 0 && rows.length > 0;

  /** One definition, rendered above and/or below the rows. */
  const actionButtons = bulkActions.map((a) => {
    const need = a.minSelected ?? 1;
    const short = a.disabled === true || (selectable && selected.length < need);
    return (
      <button
        key={a.label}
        {...(a.tourKey === undefined ? {} : { 'data-tour': a.tourKey })}
        disabled={short}
        title={short ? hoverHint(a) : undefined}
        onClick={() => a.onClick(selectable ? selectedRows : rows)}
        /*
         * `whitespace-nowrap` + `shrink-0`: the labels were WRAPPING — "Move to
         * / client", "Export / CSV" — because the strip stretched each button
         * to an equal share of a narrow bar and then let the words break. A
         * bulk bar is a row of named actions; a name broken across two lines
         * reads as two controls. The strip scrolls sideways instead (see the
         * footer below), which is what `scroll-x` exists for.
         *
         * ⚠ The disabled state is a real state, not a faded one. `opacity-40`
         * over zinc-on-card put these controls near-unreadable, and disabled is
         * what most of them are most of the time — an accountant cannot read a
         * label they might want. So disabled is an explicit token pair with
         * legible contrast, and what it MEANS is said in words under the bar
         * rather than encoded in a shade.
         */
        className={`flex shrink-0 whitespace-nowrap items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold rounded-2xl transition-all disabled:cursor-not-allowed disabled:shadow-none ${
          a.primary
            ? 'text-white bg-brand hover:bg-brand-hover shadow-glow-btn-soft disabled:bg-raised disabled:text-zinc-400 disabled:border disabled:border-white/10'
            : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 bg-card shadow-inner disabled:bg-raised disabled:text-zinc-400 disabled:border-white/10'
        }`}
      >
        {a.icon && <a.icon size={16} />}
        {a.label}
      </button>
    );
  });

  /**
   * Which card slot a column falls into. Read once per render rather than once
   * per row — it depends on the column set, not on the data.
   */
  const kindOf = (c: Column<T>, i: number): NonNullable<Column<T>['card']> =>
    c.card ?? (i === 0 ? 'title' : c.label.trim() === '' ? 'actions' : 'field');
  const titleCols = columns.filter((c, i) => kindOf(c, i) === 'title');
  const fieldCols = columns.filter((c, i) => kindOf(c, i) === 'field');
  const actionCols = columns.filter((c, i) => kindOf(c, i) === 'actions');

  // No `render` means "just show the field named by `key`". `key` is a plain
  // string rather than `keyof T`, so this read cannot be checked — see the
  // note on `Column.key`.
  const cell = (c: Column<T>, row: T) =>
    c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '');

  return (
    // `@container` establishes the query context both layouts below read, and
    // `overflow-clip` rather than `overflow-hidden` because the latter makes a
    // scroll container, which would break the sticky bulk bar inside it.
    <div
      data-tour="datatable"
      className={`@container w-full ${className} border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-clip flex flex-col`}
    >
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

      {/* Narrow containers (a phone, or a card in the chat) get one card per
          row: the first column as the title, the rest as label/value pairs,
          and any action column at the foot where a thumb can reach it. */}
      <div className="@3xl:hidden flex flex-col divide-y divide-white/5">
        {sorted.length === 0 && <div className="px-5 py-8 text-center text-zinc-500 text-sm">{emptyText}</div>}
        {sorted.map((row) => {
          const id = rowId(row);
          const isSel = selected.includes(id);
          const activate: ((e?: { shiftKey?: boolean }) => void) | undefined = onRowClick
            ? () => onRowClick(row)
            : selectable
              ? (e) => toggleOne(id, e?.shiftKey === true)
              : undefined;
          return (
            <div
              key={id}
              // A card that responds to a click has to respond to a key, and
              // it cannot be a <button> because the checkbox and the action
              // column nest inside it — the same shape, and the same answer,
              // as LeftPanel's history row.
              {...(activate === undefined
                ? {}
                : {
                    role: 'button',
                    tabIndex: 0,
                    onClick: activate,
                    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      activate();
                    },
                  })}
              className={`flex gap-3 p-4 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${
                activate ? 'cursor-pointer' : ''
              } ${isSel ? 'bg-brand/[0.07]' : ''}`}
            >
              {selectable && (
                <div className="pt-0.5 shrink-0">
                  <Checkbox checked={isSel} onChange={(e) => toggleOne(id, e.shiftKey)} />
                </div>
              )}
              <div className="flex-1 min-w-0 flex flex-col gap-2.5">
                {titleCols.map((c) => (
                  <div key={c.key} className="text-sm font-semibold text-white min-w-0 break-words [&_*]:whitespace-normal">
                    {cell(c, row)}
                  </div>
                ))}
                {fieldCols.length > 0 && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {fieldCols.map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="text-[10.5px] font-bold uppercase tracking-widest text-zinc-500">{c.label}</dt>
                        <dd className="text-[13px] text-zinc-300 break-words [&_*]:whitespace-normal">{cell(c, row)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {actionCols.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5 [&>*]:flex-wrap [&>*]:justify-start">
                    {actionCols.map((c) => (
                      <div key={c.key} className="contents">
                        {cell(c, row)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="hidden @3xl:block overflow-x-auto overscroll-x-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
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
                  {emptyText}
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
                  onClick={
                    onRowClick
                      ? () => onRowClick(row)
                      : selectable
                        ? (e) => toggleOne(id, e.shiftKey)
                        : undefined
                  }
                  className={`border-b border-white/5 last:border-0 transition-colors ${
                    selectable || onRowClick ? 'cursor-pointer' : ''
                  } ${isSel ? 'bg-brand/[0.07]' : 'hover:bg-white/[0.02]'}`}
                >
                  {selectable && (
                    <td className="px-5 py-3.5">
                      <Checkbox checked={isSel} onChange={(e) => toggleOne(id, e.shiftKey)} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-5 py-3.5 text-zinc-300 whitespace-nowrap ${
                        c.align === 'right' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {cell(c, row)}
                    </td>
                  ))}
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/*
        ⚠ **One footer block at the end of the table, and everything in it.**
        The count, the actions and the sentence explaining why the actions are
        off are one thing — a bulk bar. They used to be three: the hints sat
        OUTSIDE the grey bar, below it, unattached to anything, colliding with
        whatever the table was sitting on. A reason floating loose under a
        control is not an explanation of that control.
      */}
      {(bulkActions.length > 0 || footer) && (
        <div data-tour="bulk-bar" className="@max-3xl:sticky @max-3xl:bottom-0 z-10 bg-card border-t border-white/5">
          <div className="bg-raised/50 p-3 @3xl:p-4 flex flex-col gap-2.5">
            <div className="flex flex-col @3xl:flex-row @3xl:items-center @3xl:justify-between gap-2.5 @3xl:gap-4">
              <div className="text-[12px] text-zinc-400 font-semibold px-1 min-w-0">
                {footer ?? intl.formatMessage(m.footerCount, { count: rows.length })}
              </div>
              {bulkActions.length > 0 && (
                // Sideways, never wrapped: `scroll-x` hides its own scrollbar
                // and contains the overscroll, which is the responsive layer's
                // established answer for a strip too wide for its container.
                <div className="scroll-x flex items-center gap-2 @3xl:gap-3 min-w-0 -mx-1 px-1">
                  {actionButtons}
                </div>
              )}
            </div>

            {/* Attached to the bar it explains, and never both at once: the
                amber one names an action that is short of rows, the quiet one
                answers the question a bar of disabled buttons asks. */}
            {(shortHint !== undefined || nothingSelected) && (
              <p
                className={`text-[12px] font-semibold px-1 leading-relaxed ${
                  shortHint === undefined ? 'text-zinc-400' : 'text-amber-400'
                }`}
              >
                {shortHint ?? intl.formatMessage(m.selectNothing)}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
}: {
  checked: boolean;
  /** The event is passed so a caller can read `shiftKey` for a range. */
  onChange: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange(e);
      }}
      aria-pressed={checked}
      className={`hit-area w-[18px] h-[18px] rounded-md border flex items-center justify-center transition-all ${
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
