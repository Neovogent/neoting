import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test } from 'vitest';

import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { ukLongDate, UkDateField, UkMonthField } from './UkDateField';

/**
 * **The one UK date control** — review items 16, 28 and 46 (package D).
 *
 * > *"Why the fuck there is this 2025 recommendation here to export data?? The
 * > date selector must be in this format 3rd March 2026 - 12th December 2026
 * > type, not 07/30/2025"*
 *
 * The defect was never that a native `<input type="date">` looked foreign. It is
 * that `03/08/2026` is a valid date **both ways round**, so a locale-ordered
 * field misreads silently and the first anyone hears of it is the wrong VAT
 * quarter. So what is pinned here is, in order:
 *
 * 1. **Day first, on the way in.** `30/07/2025` is July, never 7 March.
 * 2. **Words, on the way out.** The long-form line is what makes a misreading
 *    impossible, and it is why that line survives the picker that replaced the
 *    field it was added to.
 * 3. **⚠ An impossible date is REFUSED, not rolled.** `31/02/2026` becoming
 *    3 March is the failure mode `parseUkDate`'s "read the components back"
 *    rule exists for — it is how `01/13/2026` once imported as 1 January 2027
 *    with a confident date on screen.
 * 4. **The calendar date never shifts.** Every conversion here is string or
 *    `Date.UTC`; the moment one goes through `toISOString()` on a local date,
 *    everyone west of Greenwich files a receipt into the previous day.
 * 5. **ISO on the wire.** Callers were not changed by any of this.
 */

function Field({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <AppIntlProvider>
      <UkDateField id="d" value={value} onChange={setValue} />
      <output data-testid="iso">{value}</output>
    </AppIntlProvider>
  );
}

const type = (text: string) => {
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
};

test('day first, always — 30/07/2025 is July', () => {
  render(<Field />);
  type('30/07/2025');
  expect(screen.getByTestId('iso').textContent).toBe('2025-07-30');
  // And the half a person reads: words, which cannot be misread in any locale.
  expect(screen.getByText('30 July 2025')).toBeInTheDocument();
});

test('the ambiguous one lands day-first too — 03/08/2026 is 3 August', () => {
  render(<Field />);
  type('03/08/2026');
  expect(screen.getByTestId('iso').textContent).toBe('2026-08-03');
  expect(screen.getByText('3 August 2026')).toBeInTheDocument();
});

test('⚠ an impossible date is refused, never rolled forward into a plausible one', () => {
  render(<Field />);
  type('31/02/2026');

  // Not 3 March. Not anything.
  expect(screen.getByTestId('iso').textContent).toBe('');
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.queryByText(/March/)).not.toBeInTheDocument();
});

test('a half-typed date claims nothing — the refusal waits for the field to be left', () => {
  render(<Field />);
  // `new Date('3')` is 1 March 2001. The shape gate is what stops the long-form
  // line announcing that after one keystroke.
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '3' } });
  expect(screen.getByTestId('iso').textContent).toBe('');
  expect(screen.queryByText(/2001/)).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('an existing ISO value renders day-first, and clearing it empties the caller’s value', () => {
  render(<Field initial="2026-08-09" />);
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('09/08/2026');
  expect(screen.getByText('9 August 2026')).toBeInTheDocument();

  type('');
  expect(screen.getByTestId('iso').textContent).toBe('');
});

test('⚠ the calendar date does not shift — the long form is rendered in UTC, not the machine’s zone', () => {
  // The bug this refuses: `new Date('2026-01-01')` is midnight UTC, and reading
  // it back with a local formatter west of Greenwich prints 31 December.
  const intl = { formatDate: (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', o).format(d) };
  expect(ukLongDate(intl as never, '2026-01-01')).toBe('1 January 2026');
  expect(ukLongDate(intl as never, '2026-12-31')).toBe('31 December 2026');
});

test('the month field takes a NAME and a year, and emits YYYY-MM', () => {
  function Month() {
    const [value, setValue] = useState('');
    return (
      <AppIntlProvider>
        <UkMonthField id="p" value={value} onChange={setValue} />
        <output data-testid="period">{value}</output>
      </AppIntlProvider>
    );
  }
  render(<Month />);

  // ⚠ A NAME, not a number: this replaced an `<input type="month">` that
  // rendered as a bare text box, which is the screenshot review item 16 came
  // with — `12` typed into it, and no way to know that meant December.
  fireEvent.change(screen.getByLabelText('Month'), { target: { value: '08' } });
  const period = screen.getByTestId('period').textContent ?? '';
  expect(period).toMatch(/^\d{4}-08$/);

  fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2025' } });
  expect(screen.getByTestId('period').textContent).toBe('2025-08');
});
