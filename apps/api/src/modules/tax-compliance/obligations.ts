/**
 * The obligation calendar, pure: a client's tax profile + today → the filing
 * and payment deadlines in a window around today.
 *
 * Every date is a CALENDAR date (`YYYY-MM-DD`) and every piece of arithmetic is
 * on UTC components — `tasks/due-date.ts` explains the west-of-Greenwich bug
 * that rule exists for. Nothing here touches money.
 *
 * The rules (HMRC / Companies House, as the practice reads them):
 * - VAT return: period from `vatPeriodStart` + frequency; due one calendar
 *   month and seven days after the period ends (31 Mar → 7 May). Annual
 *   accounting: two months after the year ends.
 * - PAYE/NIC: the 22nd of every month, when the business has employees.
 * - Self Assessment (sole trader / partnership): 31 Jan (return, balancing
 *   payment, 1st payment on account), 31 Jul (2nd payment on account), and the
 *   5 Oct registration deadline after the tax year trading started.
 * - Corporation Tax (limited company): payment nine months and one day after
 *   the year end; CT600 filing twelve months after.
 * - Companies House (limited company / LLP): accounts nine months after the
 *   year end (month-end to month-end); confirmation statement from the CH
 *   date, else the incorporation anniversary + 14 days.
 */

export type LegalStructure = 'SOLE_TRADER' | 'PARTNERSHIP' | 'LIMITED_COMPANY' | 'LLP' | 'OTHER';
export type VatFrequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type ObligationKind =
  | 'VAT_RETURN'
  | 'PAYE'
  | 'SA_PAYMENT'
  | 'SA_REGISTRATION'
  | 'CT_PAYMENT'
  | 'CT600'
  | 'CH_ACCOUNTS'
  | 'CH_CONFIRMATION'
  | 'MANUAL';
export type ObligationStatus = 'UPCOMING' | 'DUE' | 'OVERDUE' | 'DONE';

export interface ObligationInputs {
  readonly legalStructure: LegalStructure | null;
  readonly vatRegistered: boolean;
  readonly vatFrequency: VatFrequency | null;
  readonly vatPeriodStart: string | null;
  readonly hasEmployees: boolean | null;
  readonly yearEndMonth: number | null;
  readonly yearEndDay: number | null;
  /** Incorporation date — or, for a sole trader, the date trading started. */
  readonly incorporatedOn: string | null;
  readonly accountsNextDue: string | null;
  readonly confirmationStatementNextDue: string | null;
}

export interface ComputedObligation {
  readonly computeKey: string;
  readonly kind: ObligationKind;
  readonly title: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly dueDate: string;
}

/** How far back an unticked deadline is still (re)generated, and how far ahead. */
export const LOOKBACK_DAYS = 120;
export const HORIZON_DAYS = 400;
/** DUE means due within this many days, today included. */
export const DUE_SOON_DAYS = 7;

// ── calendar arithmetic, UTC only ────────────────────────────────────────

interface Ymd {
  readonly y: number;
  readonly m: number; // 1-12
  readonly d: number;
}

export function parseIsoDate(iso: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCDate() !== Number(match[3])) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function fromUtc(date: Date): Ymd {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function iso({ y, m, d }: Ymd): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isMonthEnd(date: Ymd): boolean {
  return date.d === daysInMonth(date.y, date.m);
}

export function addDays(date: Ymd, days: number): Ymd {
  return fromUtc(new Date(Date.UTC(date.y, date.m - 1, date.d + days)));
}

/** Clamped: 31 Jan + 1 month = 28/29 Feb, never 3 Mar. */
export function addMonths(date: Ymd, months: number): Ymd {
  const index = date.y * 12 + (date.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}

function monthEnd(date: Ymd): Ymd {
  return { y: date.y, m: date.m, d: daysInMonth(date.y, date.m) };
}

function compare(a: Ymd, b: Ymd): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "7 May 2026" — the long UK form, never a numeric date that reads both ways. */
export function longDate(date: Ymd): string {
  return `${date.d} ${MONTHS[date.m - 1]} ${date.y}`;
}

// ── status ───────────────────────────────────────────────────────────────

export function statusFor(dueDate: string, done: boolean, today: string): ObligationStatus {
  if (done) return 'DONE';
  if (dueDate < today) return 'OVERDUE';
  const soon = parseIsoDate(today);
  if (soon !== null && dueDate <= iso(addDays(soon, DUE_SOON_DAYS - 1))) return 'DUE';
  return 'UPCOMING';
}

// ── the calendar ─────────────────────────────────────────────────────────

export function computeObligations(inputs: ObligationInputs, today: string): ComputedObligation[] {
  const now = parseIsoDate(today);
  if (now === null) return [];
  const from = addDays(now, -LOOKBACK_DAYS);
  const to = addDays(now, HORIZON_DAYS);
  const inWindow = (date: Ymd): boolean => compare(date, from) >= 0 && compare(date, to) <= 0;
  const out: ComputedObligation[] = [];
  const push = (o: Omit<ComputedObligation, 'dueDate'> & { due: Ymd }): void => {
    if (inWindow(o.due)) {
      out.push({ computeKey: o.computeKey, kind: o.kind, title: o.title, periodStart: o.periodStart, periodEnd: o.periodEnd, dueDate: iso(o.due) });
    }
  };

  // VAT returns.
  const vatAnchor = inputs.vatPeriodStart === null ? null : parseIsoDate(inputs.vatPeriodStart);
  if (inputs.vatRegistered && inputs.vatFrequency !== null && vatAnchor !== null) {
    const length = inputs.vatFrequency === 'MONTHLY' ? 1 : inputs.vatFrequency === 'QUARTERLY' ? 3 : 12;
    // Walk periods from well before the window to past it; the anchor may sit anywhere.
    const firstK = Math.floor(((from.y - vatAnchor.y) * 12 + (from.m - vatAnchor.m)) / length) - 2;
    for (let k = firstK; ; k += 1) {
      const start = addMonths(vatAnchor, k * length);
      const end = addDays(addMonths(vatAnchor, (k + 1) * length), -1);
      const due =
        inputs.vatFrequency === 'ANNUAL' ? addDays(addMonths(addDays(end, 1), 2), -1) : addDays(addMonths(addDays(end, 1), 1), 6);
      if (compare(due, to) > 0) break;
      push({
        computeKey: `VAT:${iso(start)}`,
        kind: 'VAT_RETURN',
        title: `VAT return and payment — period ${longDate(start)} to ${longDate(end)}`,
        periodStart: iso(start),
        periodEnd: iso(end),
        due,
      });
    }
  }

  // PAYE / NIC — the 22nd, for the tax month (6th to 5th) that just ended.
  if (inputs.hasEmployees === true) {
    for (let cursor: Ymd = { y: from.y, m: from.m, d: 22 }; compare(cursor, to) <= 0; cursor = addMonths(cursor, 1)) {
      const periodEnd = { y: cursor.y, m: cursor.m, d: 5 };
      const periodStart = addDays(addMonths(periodEnd, -1), 1);
      push({
        computeKey: `PAYE:${iso(cursor).slice(0, 7)}`,
        kind: 'PAYE',
        title: `PAYE and NIC payment — tax month to ${longDate(periodEnd)}`,
        periodStart: iso(periodStart),
        periodEnd: iso(periodEnd),
        due: cursor,
      });
    }
  }

  // Self Assessment.
  if (inputs.legalStructure === 'SOLE_TRADER' || inputs.legalStructure === 'PARTNERSHIP') {
    for (let y = from.y; y <= to.y + 1; y += 1) {
      push({
        computeKey: `SA:${y}-01-31`,
        kind: 'SA_PAYMENT',
        title: `Self Assessment — ${y - 2}/${String(y - 1).slice(2)} return and balancing payment, 1st payment on account for ${y - 1}/${String(y).slice(2)}`,
        periodStart: `${y - 2}-04-06`,
        periodEnd: `${y - 1}-04-05`,
        due: { y, m: 1, d: 31 },
      });
      push({
        computeKey: `SA:${y}-07-31`,
        kind: 'SA_PAYMENT',
        title: `Self Assessment — 2nd payment on account for ${y - 1}/${String(y).slice(2)}`,
        periodStart: `${y - 1}-04-06`,
        periodEnd: `${y}-04-05`,
        due: { y, m: 7, d: 31 },
      });
    }
    const started = inputs.incorporatedOn === null ? null : parseIsoDate(inputs.incorporatedOn);
    if (started !== null) {
      // The tax year ending 5 April after (or on) the start date.
      const endYear = compare(started, { y: started.y, m: 4, d: 5 }) <= 0 ? started.y : started.y + 1;
      push({
        computeKey: `SA_REG:${endYear}`,
        kind: 'SA_REGISTRATION',
        title: `Register for Self Assessment (started trading in ${endYear - 1}/${String(endYear).slice(2)})`,
        periodStart: null,
        periodEnd: null,
        due: { y: endYear, m: 10, d: 5 },
      });
    }
  }

  const yearEndKnown =
    inputs.yearEndMonth !== null && inputs.yearEndDay !== null && inputs.yearEndMonth >= 1 && inputs.yearEndMonth <= 12;
  const yearEnds: Ymd[] = [];
  if (yearEndKnown) {
    for (let y = from.y - 2; y <= to.y; y += 1) {
      const m = inputs.yearEndMonth as number;
      yearEnds.push({ y, m, d: Math.min(inputs.yearEndDay as number, daysInMonth(y, m)) });
    }
  }

  // Corporation Tax.
  if (inputs.legalStructure === 'LIMITED_COMPANY') {
    for (const end of yearEnds) {
      push({
        computeKey: `CT_PAY:${iso(end)}`,
        kind: 'CT_PAYMENT',
        title: `Corporation Tax payment — year ended ${longDate(end)}`,
        periodStart: iso(addDays(addMonths(end, -12), 1)),
        periodEnd: iso(end),
        due: addMonths(addDays(end, 1), 9),
      });
      push({
        computeKey: `CT600:${iso(end)}`,
        kind: 'CT600',
        title: `Corporation Tax return (CT600) — year ended ${longDate(end)}`,
        periodStart: iso(addDays(addMonths(end, -12), 1)),
        periodEnd: iso(end),
        due: addMonths(end, 12),
      });
    }
  }

  // Companies House.
  if (inputs.legalStructure === 'LIMITED_COMPANY' || inputs.legalStructure === 'LLP') {
    const chAccounts = inputs.accountsNextDue === null ? null : parseIsoDate(inputs.accountsNextDue);
    if (chAccounts !== null) {
      // The register's own date wins for its year; later years roll from it.
      for (let due = chAccounts, i = 0; i < 3; due = isMonthEnd(due) ? monthEnd(addMonths(due, 12)) : addMonths(due, 12), i += 1) {
        push({ computeKey: `CH_ACC:${iso(due)}`, kind: 'CH_ACCOUNTS', title: 'Annual accounts to Companies House', periodStart: null, periodEnd: null, due });
      }
    } else {
      for (const end of yearEnds) {
        const due = isMonthEnd(end) ? monthEnd(addMonths(end, 9)) : addMonths(end, 9);
        push({
          computeKey: `CH_ACC:${iso(due)}`,
          kind: 'CH_ACCOUNTS',
          title: `Annual accounts to Companies House — year ended ${longDate(end)}`,
          periodStart: null,
          periodEnd: iso(end),
          due,
        });
      }
    }

    const chConfirmation = inputs.confirmationStatementNextDue === null ? null : parseIsoDate(inputs.confirmationStatementNextDue);
    const incorporated = inputs.incorporatedOn === null ? null : parseIsoDate(inputs.incorporatedOn);
    if (chConfirmation !== null) {
      for (let due = chConfirmation, i = 0; i < 3; due = addMonths(due, 12), i += 1) {
        push({ computeKey: `CH_CS:${iso(due)}`, kind: 'CH_CONFIRMATION', title: 'Confirmation statement to Companies House', periodStart: null, periodEnd: null, due });
      }
    } else if (incorporated !== null) {
      for (let y = Math.max(incorporated.y + 1, from.y - 1); y <= to.y; y += 1) {
        const review = { y, m: incorporated.m, d: Math.min(incorporated.d, daysInMonth(y, incorporated.m)) };
        push({
          computeKey: `CH_CS:${iso(addDays(review, 14))}`,
          kind: 'CH_CONFIRMATION',
          title: `Confirmation statement to Companies House — review date ${longDate(review)}`,
          periodStart: null,
          periodEnd: iso(review),
          due: addDays(review, 14),
        });
      }
    }
  }

  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.computeKey.localeCompare(b.computeKey)));
}

/** A stored free-text `businesses.legal_structure` → the closed set, or null. */
export function readLegalStructure(raw: string | null): LegalStructure | null {
  if (raw === null || raw.trim() === '') return null;
  const key = raw.toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '');
  if (key === 'LLP' || key.includes('LIABILITY_PARTNERSHIP')) return 'LLP';
  if (key.includes('SOLE')) return 'SOLE_TRADER';
  if (key.includes('PARTNERSHIP')) return 'PARTNERSHIP';
  if (key.includes('LIMITED') || key === 'LTD' || key.includes('COMPANY') || key === 'PLC') return 'LIMITED_COMPANY';
  return 'OTHER';
}

/** A stored free-text `businesses.vat_frequency` → the closed set, or null. */
export function readVatFrequency(raw: string | null): VatFrequency | null {
  const key = raw?.trim().toUpperCase() ?? '';
  if (key.startsWith('MONTH')) return 'MONTHLY';
  if (key.startsWith('QUARTER')) return 'QUARTERLY';
  if (key.startsWith('ANNUAL') || key.startsWith('YEAR')) return 'ANNUAL';
  return null;
}
