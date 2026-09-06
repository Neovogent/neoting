import { useEffect, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';

import { parseUkDate } from '../../lib/tableImport';

/**
 * **The one UK date control** — review items 16, 28 and 46 (package D).
 *
 * > *"The date selector must be in this format 3rd March 2026 – 12th December
 * > 2026 type, not 07/30/2025"* — item 28
 *
 * Three screens asked for the same thing and each had a different wrong answer:
 * the statement-request dialog took a bare `<input type="month">` with a
 * `YYYY-MM` regex nobody could discover, ExportView's FROM/TO were native
 * `<input type="date">`, and the document-date correction was a free-text box.
 *
 * ## ⚠ What is actually broken about `<input type="date">`, precisely
 *
 * It renders in the **browser's** locale, and NO attribute can force a format —
 * not `lang`, not `pattern`, not a `min`/`max`. On the reviewer's machine that
 * is US month-first, so `30 July 2025` is typed and read back as `07/30/2025`.
 * The failure is not that it looks foreign; it is that `03/08/2026` is a valid
 * date **either way round**, so a misreading is silent and the wrong VAT
 * quarter is the first anyone hears of it.
 *
 * ## What replaces it, and what is deliberately kept
 *
 * - **Typing is d/m/y, always.** A text field with a `dd/mm/yyyy` placeholder,
 *   parsed by `parseUkDate` — the repo's existing day-first parser, the one the
 *   spreadsheet importer uses. Reused rather than rewritten: two parsers for
 *   "what date did a human mean" is how `03/08/2026` comes to import as one date
 *   and save as another, and it is already on the bundle floor so it costs
 *   nothing (`lib/tableImport.ts`).
 * - **Reading is long form.** `30 July 2025` under the field, live, because
 *   words cannot be misread in any locale. That is item 28's interim fix on
 *   ExportView, kept and made everyone's.
 * - **The native picker STAYS**, behind the calendar button — `showPicker()` on
 *   a real `<input type="date">`. It is the platform's own calendar, it is the
 *   date entry a phone actually wants, and its grid of numbered days is
 *   unambiguous however the field beside it is formatted. What is discarded is
 *   only its *text rendering*, which is the part that was wrong. If
 *   `showPicker` is unavailable the button focuses the native input instead, and
 *   the typed field — which never depended on any of it — still works.
 * - **`YYYY-MM-DD` in and out.** Callers are unchanged; this is a rendering
 *   change, and the wire stays ISO (Rule 8).
 *
 * ## ⚠ No date library, and the timezone rule that made one look necessary
 *
 * Adding one would be a stop-and-ask, and it would buy nothing: the whole job is
 * one parse and one format. What it would also have bought is the bug — a
 * `Date` put through `toISOString()` is converted to UTC, so west of Greenwich
 * the calendar date moves back a day and a receipt files into the day before.
 * Nothing here ever crosses that boundary: `parseUkDate` returns the ISO string
 * built from local components, and {@link ukLongDate} renders through
 * `Date.UTC` and back out in `UTC`. A picker that shifts the date it was handed
 * is worse than the format bug it replaced.
 */

const m = defineMessages({
  // The placeholder is the whole instruction — the field it replaced said
  // nothing at all about what to type, which is item 16's original complaint.
  placeholder: { id: 'common.ukDate.placeholder', defaultMessage: 'dd/mm/yyyy' },
  openCalendar: { id: 'common.ukDate.openCalendar', defaultMessage: 'Pick from a calendar' },
  // ⚠ Named as a REFUSAL of the text, never a correction of it. Guessing at
  // `31/02/2026` is exactly what `parseUkDate` refuses to do.
  notADate: { id: 'common.ukDate.notADate', defaultMessage: 'That is not a date — try 30/07/2025.' },
  monthLabel: { id: 'common.ukDate.monthLabel', defaultMessage: 'Month' },
  yearLabel: { id: 'common.ukDate.yearLabel', defaultMessage: 'Year' },
  monthPlaceholder: { id: 'common.ukDate.monthPlaceholder', defaultMessage: 'Choose a month' },
});

/**
 * `YYYY-MM-DD` → "30 July 2025".
 *
 * Long form because it cannot be misread in ANY locale, which digits with
 * slashes can. Built on a UTC date and rendered in UTC so the calendar date
 * never shifts across a timezone. Moved here from `ExportView`, where it landed
 * as item 28's interim fix; that screen still renders it beside the field, and
 * so does every other screen now.
 */
export function ukLongDate(intl: IntlShape, isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) return isoDate;
  return intl.formatDate(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** `2026-08` → "August 2026". The month-shaped sibling of {@link ukLongDate}. */
export function ukLongMonth(intl: IntlShape, period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (match === null) return period;
  return intl.formatDate(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * ⚠ **What a half-typed date must NOT do.**
 *
 * `parseUkDate`'s last branch is `new Date(raw)`, which is right for a
 * spreadsheet cell (it catches "12 August 2026" and every variant a client's
 * export invents) and wrong for a field somebody is still typing into: `new
 * Date('3')` is **1 March 2001**, so the long-form line would announce a
 * confident wrong date after a single keystroke.
 *
 * So the field gates on SHAPE first and only then asks the shared parser. The
 * parser is still the one that decides what a date means — the day-first rule
 * and the roll-over refusal are not restated here — this only decides when the
 * text is finished enough to ask.
 */
const COMPLETE = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})$/;

function parseTyped(text: string): string | null {
  const raw = text.trim();
  return COMPLETE.test(raw) ? parseUkDate(raw) : null;
}

/** `YYYY-MM-DD` → `30/07/2025`, for the text field's own display. */
function toUkText(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match === null ? '' : `${match[3]}/${match[2]}/${match[1]}`;
}

const FIELD =
  'w-full bg-ground border border-white/10 rounded-2xl px-4 py-3 text-sm font-semibold text-white ' +
  'placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

export function UkDateField({
  id,
  value,
  onChange,
  min,
  max,
  disabled = false,
  describedBy,
}: {
  readonly id: string;
  /** `YYYY-MM-DD`, or `''` for empty. */
  readonly value: string;
  /** `YYYY-MM-DD` while the text parses, `''` while it does not — so a caller's gate stays honest. */
  readonly onChange: (isoDate: string) => void;
  readonly min?: string;
  readonly max?: string;
  readonly disabled?: boolean;
  readonly describedBy?: string;
}) {
  const intl = useIntl();
  const native = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => toUkText(value));
  // The refusal waits for the field to be LEFT. Announcing "that is not a date"
  // after the first keystroke of one is noise that trains people to ignore it.
  const [blurred, setBlurred] = useState(false);

  // Follow the value when the CALLER changes it (a suggestion taken, a form
  // reset, the calendar). Keyed on the value rather than on every render, so it
  // never fights what is being typed.
  useEffect(() => {
    setText((current) => (parseTyped(current) === value ? current : toUkText(value)));
  }, [value]);

  const typed = (next: string) => {
    setText(next);
    setBlurred(false);
    onChange(next.trim() === '' ? '' : (parseTyped(next) ?? ''));
  };

  const unparsed = text.trim() !== '' && parseTyped(text) === null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={text}
          disabled={disabled}
          onChange={(event) => typed(event.target.value)}
          onBlur={() => setBlurred(true)}
          placeholder={intl.formatMessage(m.placeholder)}
          aria-invalid={unparsed}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
          className={`${FIELD} pr-12`}
        />
        {/* The native picker, kept for what it is good at. The input itself is
            transparent and sits under the icon: `showPicker()` needs a rendered
            element, so it may not be `display:none` or unmounted. It carries no
            tab stop and no accessible name — the BUTTON is the control, and the
            typed field above is the keyboard path. */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            const el = native.current;
            if (el === null) return;
            try {
              el.showPicker();
            } catch {
              // Safari before 16, an unusual embedding, a picker refused
              // without a gesture. The typed field never depended on this.
              el.focus();
            }
          }}
          aria-label={intl.formatMessage(m.openCalendar)}
          title={intl.formatMessage(m.openCalendar)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-2 rounded-xl text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-40 transition-colors"
        >
          <CalendarDays size={16} />
        </button>
        <input
          ref={native}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          value={value}
          {...(min === undefined ? {} : { min })}
          {...(max === undefined ? {} : { max })}
          onChange={(event) => {
            onChange(event.target.value);
            setText(toUkText(event.target.value));
            setBlurred(false);
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 opacity-0 pointer-events-none"
        />
      </div>

      {/* The half that cannot be misread. It is the answer to "which number was
          the month", and it is why this line stays even where a picker is used. */}
      {blurred && unparsed ? (
        <p role="alert" className="text-[12px] font-semibold text-amber-400">
          {intl.formatMessage(m.notADate)}
        </p>
      ) : value === '' ? null : (
        <p className="text-[12px] font-semibold text-zinc-400">{ukLongDate(intl, value)}</p>
      )}
    </div>
  );
}

/**
 * The MONTH shape of the same control — a whole month, not a day in one.
 *
 * ⚠ **Two components rather than one with a `granularity` prop**, because they
 * are not the same question. A statement request is *for August*; a document is
 * dated *on the ninth*. `<input type="month">` renders as an unlabelled free
 * text box in several browsers — which is literally item 16's screenshot, with
 * `12` typed into it and the confirm greyed out against a `YYYY-MM` regex the
 * accountant had no way to discover.
 *
 * Two selects, and the month is a NAME. There is nothing to parse, nothing to
 * mis-order, no locale to get wrong and no picker to be unavailable — the same
 * argument as the long-form line, applied to input instead of output.
 */
export function UkMonthField({
  id,
  value,
  onChange,
  years = 3,
  disabled = false,
}: {
  readonly id: string;
  /** `YYYY-MM`, or `''` for empty. */
  readonly value: string;
  readonly onChange: (period: string) => void;
  /** How far back the year list runs from this year. Statements are recent business. */
  readonly years?: number;
  readonly disabled?: boolean;
}) {
  const intl = useIntl();
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const year = match?.[1] ?? '';
  const month = match?.[2] ?? '';

  // ⚠ Europe/London, like every other rendered date. "This year" on the 1st of
  // January is a different year eight hours west, and a statement request for
  // the wrong year is a chase the client cannot answer.
  const thisYear = Number(
    intl.formatDate(new Date(), { year: 'numeric', timeZone: 'Europe/London', calendar: 'gregory' }),
  );
  const yearOptions = Array.from({ length: years + 1 }, (_, index) => String(thisYear - index));

  const emit = (nextMonth: string, nextYear: string) =>
    onChange(nextMonth === '' || nextYear === '' ? '' : `${nextYear}-${nextMonth}`);

  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label htmlFor={id} className="sr-only">
          {intl.formatMessage(m.monthLabel)}
        </label>
        <select
          id={id}
          value={month}
          disabled={disabled}
          onChange={(event) => emit(event.target.value, year === '' ? String(thisYear) : year)}
          className={FIELD}
        >
          <option value="">{intl.formatMessage(m.monthPlaceholder)}</option>
          {Array.from({ length: 12 }, (_, index) => {
            const key = String(index + 1).padStart(2, '0');
            return (
              <option key={key} value={key}>
                {/* The month's own NAME, from the locale's calendar data. */}
                {intl.formatDate(new Date(Date.UTC(2000, index, 1)), { month: 'long', timeZone: 'UTC' })}
              </option>
            );
          })}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-year`} className="sr-only">
          {intl.formatMessage(m.yearLabel)}
        </label>
        <select
          id={`${id}-year`}
          value={year}
          disabled={disabled}
          onChange={(event) => emit(month, event.target.value)}
          className={FIELD}
        >
          {year === '' && <option value="">{intl.formatMessage(m.yearLabel)}</option>}
          {yearOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
