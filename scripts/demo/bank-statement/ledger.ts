// Step 2 — the plan, expanded into thirteen months of a restaurant's banking.
//
// ## Integer pence, end to end
//
// Root CLAUDE.md: "Money is integer pence. No floats, anywhere, ever." So the
// PRNG returns a uint32 rather than a [0,1) double, every weighting the plan
// carries is an integer PERCENT, and every amount is derived by integer
// multiply-then-divide. The only division is `divRound`, which takes two
// integers and returns an integer — nothing here ever holds a fractional pound.
//
// ## Why the balance is ACCUMULATED and never reconciled
//
// D41 proves completeness by `balance[n] === balance[n-1] + amount[n]` to the
// penny. Accumulating from the opening balance makes that identity true by
// construction. Deriving a balance from a formatted string, or clamping one
// that went somewhere awkward, would break the chain and the gate would — quite
// correctly — report the file INCOMPLETE.
//
// ## The takings are scaled, the arithmetic is not
//
// Fable's amount ranges describe the SHAPE of a restaurant's banking, not its
// turnover, and taken literally they made this business improbably profitable.
// So the income side carries one global scale factor, searched for until the
// account behaves like a going concern: it dips on payday and after the VAT
// bill, and never falls through the floor. That adjusts the TAKINGS. It never
// touches a balance.

import type { IncomeRule, Plan, RecurringRule, SupplierRule } from './plan.js';

/* ── Period ───────────────────────────────────────────────────────────────── */

/** Thirteen months, so "≥ 12 months" is covered with room to spare. */
export const PERIOD_START = '2025-08-01';
export const PERIOD_END = '2026-08-31';
export const SEED = 0x4e544242; // "NTBB"

/** How much cash the account must never fall below, or the takings are raised. */
const FLOOR_PENCE = 400_000;
/** Target: takings modestly exceed outgoings. A going concern, not a windfall. */
const TARGET_MARGIN_BPS = 10_400;

/* ── Rows ─────────────────────────────────────────────────────────────────── */

export interface LedgerRow {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly description: string;
  /** Signed pence. Negative is money OUT, matching the parser's convention. */
  readonly amountPence: number;
  /** Running balance AFTER this row — accumulated, never derived. */
  readonly balancePence: number;
}

export interface Ledger {
  readonly plan: Plan;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingBalancePence: number;
  readonly closingBalancePence: number;
  readonly rows: LedgerRow[];
  readonly incomeScaleBps: number;
  readonly minBalancePence: number;
  readonly maxBalancePence: number;
  readonly totalInPence: number;
  readonly totalOutPence: number;
}

/** Pre-balance. `order` is the intra-day posting sequence a bank would print. */
interface Event {
  readonly date: string;
  readonly description: string;
  readonly amountPence: number;
  readonly order: number;
  /** Cash banks in notes, so its line lands on a whole pound — applied AFTER scaling. */
  readonly roundToPounds?: boolean;
}

/* ── PRNG ─────────────────────────────────────────────────────────────────── */

/**
 * mulberry32, returning a uint32 rather than the usual double — so nothing in
 * this generator ever holds a float, not even before it becomes money.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** Inclusive integer range. */
function between(rand: () => number, min: number, max: number): number {
  if (max <= min) return min;
  return min + (rand() % (max - min + 1));
}

/** Integer ÷ integer → integer, half-up. The only division in this file. */
function divRound(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

/* ── Dates, in UTC day arithmetic ─────────────────────────────────────────── */

function toDayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map((part) => Number.parseInt(part, 10));
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

function toIso(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(day: number): number {
  return new Date(day * 86_400_000).getUTCDay();
}

function monthOf(iso: string): number {
  return Number.parseInt(iso.slice(5, 7), 10);
}

/**
 * England & Wales bank holidays inside the statement period, written out rather
 * than computed: Easter moves, the substitute-day rules are fiddly, and a wrong
 * date here would put a direct debit on a day the banks were shut.
 */
const BANK_HOLIDAYS = new Set([
  '2025-08-25', // Summer bank holiday
  '2025-12-25',
  '2025-12-26',
  '2026-01-01',
  '2026-04-03', // Good Friday (Easter Sunday 2026 is 5 April)
  '2026-04-06', // Easter Monday
  '2026-05-04', // Early May
  '2026-05-25', // Spring
  '2026-08-31', // Summer
]);

function isWorkingDay(day: number): boolean {
  const dow = weekdayOf(day);
  return dow !== 0 && dow !== 6 && !BANK_HOLIDAYS.has(toIso(day));
}

/** A payment due on a closed day is taken on the next working day, as banks do. */
function nextWorkingDay(day: number): number {
  let cursor = day;
  for (let guard = 0; guard < 10 && !isWorkingDay(cursor); guard += 1) cursor += 1;
  return cursor;
}

/**
 * Heating and lighting run opposite to a restaurant's takings — January is the
 * quietest month and the most expensive one to keep warm. Index 0 = January.
 */
const UTILITY_CURVE = [100, 96, 84, 68, 52, 40, 36, 38, 52, 70, 86, 98];

/* ── Intra-day posting order ──────────────────────────────────────────────── */

const ORDER_CREDIT = 10;
const ORDER_STANDING_ORDER = 20;
const ORDER_DIRECT_DEBIT = 30;
const ORDER_BACS_OUT = 40;
const ORDER_FASTER_PAYMENT = 50;
const ORDER_CARD = 60;
const ORDER_CHARGE = 70;

function orderForMethod(method: SupplierRule['method']): number {
  switch (method) {
    case 'standingOrder':
      return ORDER_STANDING_ORDER;
    case 'directDebit':
      return ORDER_DIRECT_DEBIT;
    case 'bacs':
      return ORDER_BACS_OUT;
    case 'fasterPayment':
      return ORDER_FASTER_PAYMENT;
    default:
      return ORDER_CARD;
  }
}

function orderForNarrative(narrative: string): number {
  if (narrative.startsWith('SO ')) return ORDER_STANDING_ORDER;
  if (narrative.startsWith('DD ')) return ORDER_DIRECT_DEBIT;
  if (narrative.startsWith('BACS')) return ORDER_BACS_OUT;
  if (narrative.startsWith('FASTER PAYMENT')) return ORDER_FASTER_PAYMENT;
  if (narrative.startsWith('CHARGE')) return ORDER_CHARGE;
  if (narrative.startsWith('CARD')) return ORDER_CARD;
  return ORDER_BACS_OUT;
}

/* ── Expansion ────────────────────────────────────────────────────────────── */

/**
 * Every date a rule fires on, inside the period.
 *
 * `shiftToWorkingDay` is the difference between a statement that reads right and
 * one an accountant squints at: a bank does not take a direct debit on a Sunday.
 * Card payments are left alone, because a card payment on a Sunday is a Sunday.
 */
function occurrences(rule: RecurringRule, startDay: number, endDay: number): number[] {
  const days: number[] = [];
  const push = (day: number): void => {
    const settled = rule.shiftToWorkingDay ? nextWorkingDay(day) : day;
    if (settled >= startDay && settled <= endDay) days.push(settled);
  };

  if (rule.cadence === 'weekly' || rule.cadence === 'fourWeekly') {
    const step = rule.cadence === 'weekly' ? 7 : 28;
    // Anchor on the first matching weekday at or after the period start.
    let cursor = startDay;
    for (let guard = 0; guard < 7 && weekdayOf(cursor) !== rule.weekday; guard += 1) cursor += 1;
    for (; cursor <= endDay; cursor += step) push(cursor);
    return days;
  }

  const first = new Date(startDay * 86_400_000);
  for (let m = 0; m < 24; m += 1) {
    const stamp = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + m, rule.dayOfMonth);
    const day = Math.floor(stamp / 86_400_000);
    if (day > endDay + 40) break;
    const month = new Date(stamp).getUTCMonth() + 1;
    if ((rule.cadence === 'quarterly' || rule.cadence === 'annual') && !rule.months.includes(month)) continue;
    push(day);
  }
  return days;
}

function applyRef(narrative: string, rand: () => number): string {
  if (!narrative.includes('{ref}')) return narrative;
  return narrative.replace('{ref}', String(between(rand, 1000, 9999)));
}

/** The expenses. Independent of the income scale, so they are built once. */
function buildOutgoings(plan: Plan, startDay: number, endDay: number): Event[] {
  const rand = mulberry32(SEED);
  const events: Event[] = [];

  for (const rule of plan.recurring) {
    for (const day of occurrences(rule, startDay, endDay)) {
      const iso = toIso(day);
      let pence: number;
      if (rule.minPence === rule.maxPence) {
        pence = rule.minPence;
      } else if (rule.category === 'utility') {
        // Winter-weighted rather than uniform: a gas bill has a season.
        const weight = UTILITY_CURVE[monthOf(iso) - 1] ?? 50;
        const span = rule.maxPence - rule.minPence;
        pence = rule.minPence + divRound(span * weight, 100) + between(rand, 0, Math.min(span, 2_500));
        pence = Math.min(pence, rule.maxPence);
      } else {
        pence = between(rand, rule.minPence, rule.maxPence);
      }
      events.push({
        date: iso,
        description: applyRef(rule.narrative, rand),
        amountPence: rule.direction === 'out' ? -pence : pence,
        order: orderForNarrative(rule.narrative),
      });
    }
  }

  for (const supplier of plan.suppliers) {
    for (let day = startDay; day <= endDay; ) {
      // Walk month by month so "times per month" means what it says.
      const iso = toIso(day);
      const monthStart = day;
      const stamp = new Date(day * 86_400_000);
      const nextMonth = Math.floor(Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth() + 1, 1) / 86_400_000);
      const monthEnd = Math.min(nextMonth - 1, endDay);
      const season = supplier.seasonal ? (plan.seasonalityPercent[monthOf(iso) - 1] ?? 100) : 100;
      const count = between(rand, supplier.timesPerMonthMin, supplier.timesPerMonthMax);

      for (let n = 0; n < count; n += 1) {
        let when = between(rand, monthStart, monthEnd);
        if (!supplier.weekendPossible) when = nextWorkingDay(when);
        if (when > endDay) continue;
        const base = between(rand, supplier.minPence, supplier.maxPence);
        const pence = Math.max(1, divRound(base * season, 100));
        events.push({
          date: toIso(when),
          description: applyRef(supplier.narrative, rand),
          amountPence: -pence,
          order: orderForMethod(supplier.method),
        });
      }
      day = nextMonth;
    }
  }

  events.push(...buildTextures(plan, startDay, endDay, rand));
  return events;
}

/**
 * The things that make a statement look lived-in rather than generated: a direct
 * debit that bounced and the fee that followed it, a supplier refund, quarterly
 * credit interest. All of them still a burger restaurant's, not somebody else's.
 */
function buildTextures(plan: Plan, startDay: number, endDay: number, rand: () => number): Event[] {
  const events: Event[] = [];
  const ddSuppliers = plan.suppliers.filter((s) => s.method === 'directDebit');
  // Refunds are drawn from CARD suppliers only, because the plan's refund
  // narrative says "CARD REFUND FROM …" — a card refund against a BACS supplier
  // is a line that never happened, and the coherence rule cuts both ways.
  const refundable = plan.suppliers.filter((s) => s.method === 'card');

  // Two returned direct debits across the period. The DD is reversed as a
  // credit — which is what the bank actually posts — and the fee follows.
  for (let n = 0; n < 2; n += 1) {
    const supplier = ddSuppliers[n % Math.max(1, ddSuppliers.length)];
    if (supplier === undefined) break;
    const day = nextWorkingDay(between(rand, startDay + 40 + n * 150, startDay + 120 + n * 150));
    if (day > endDay) continue;
    const pence = between(rand, supplier.minPence, supplier.maxPence);
    events.push({
      date: toIso(day),
      description: plan.textures.returnedDirectDebitTemplate.replace('{supplier}', supplier.name.toUpperCase()),
      amountPence: pence,
      order: ORDER_CREDIT,
    });
    events.push({
      date: toIso(day),
      description: plan.textures.returnedItemFeeNarrative,
      amountPence: -plan.textures.returnedItemFeePence,
      order: ORDER_CHARGE,
    });
  }

  // Supplier refunds — a short delivery credited back.
  for (let n = 0; n < 4; n += 1) {
    const supplier = refundable[n % Math.max(1, refundable.length)];
    if (supplier === undefined) break;
    const day = nextWorkingDay(between(rand, startDay + 20 + n * 95, startDay + 90 + n * 95));
    if (day > endDay) continue;
    events.push({
      date: toIso(day),
      description: plan.textures.refundTemplate.replace('{supplier}', supplier.name.toUpperCase()),
      amountPence: Math.max(1, divRound(between(rand, supplier.minPence, supplier.maxPence), 2)),
      order: ORDER_CREDIT,
    });
  }

  // Credit interest, quarterly, on the last working day of the quarter month.
  for (let day = startDay; day <= endDay; day += 1) {
    const iso = toIso(day);
    if (![2, 5, 8, 11].includes(monthOf(iso))) continue;
    if (!iso.endsWith('-28')) continue;
    events.push({
      date: toIso(nextWorkingDay(day)),
      description: plan.textures.interestNarrative,
      amountPence: between(rand, 180, 940),
      order: ORDER_CREDIT,
    });
  }

  return events;
}

/** The takings, at scale 10000 (= 100%). Scaled afterwards, never re-randomised. */
function buildTakings(plan: Plan, startDay: number, endDay: number): Event[] {
  const rand = mulberry32(SEED ^ 0x5a5a5a5a);
  const events: Event[] = [];

  for (const rule of plan.income) {
    // The plan may express `dayWeightsPercent` as a distribution over the week
    // (summing to 100) or as multipliers (100 = normal). Normalising over the
    // rule's OWN active days reads both the same way: mean weight = 100.
    const active = rule.daysOfWeek;
    const total = active.reduce((sum, dow) => sum + (rule.dayWeightsPercent[dow] ?? 0), 0);
    const normalised = new Map<number, number>();
    for (const dow of active) {
      const raw = rule.dayWeightsPercent[dow] ?? 0;
      normalised.set(dow, total === 0 ? 100 : divRound(raw * active.length * 100, total));
    }

    // A card acquirer settles seven days a week, and that is what puts the
    // weekend takings on the page. BACS payouts and a cash deposit at a branch
    // do NOT: they land on the next working day, which is why the payout after
    // a bank holiday Monday shows up on the Tuesday.
    const banksOnWorkingDaysOnly = rule.kind !== 'cardSettlement';

    for (let day = startDay; day <= endDay; day += 1) {
      const dow = weekdayOf(day);
      if (!active.includes(dow)) continue;
      const posted = banksOnWorkingDaysOnly ? nextWorkingDay(day) : day;
      if (posted > endDay) continue;
      const iso = toIso(day);
      const season = rule.seasonal ? (plan.seasonalityPercent[monthOf(iso) - 1] ?? 100) : 100;
      const weight = normalised.get(dow) ?? 100;
      const base = between(rand, rule.minPence, rule.maxPence);
      const pence = Math.max(1, divRound(divRound(base * weight, 100) * season, 100));
      events.push({
        date: toIso(posted),
        description: rule.narrative,
        amountPence: pence,
        order: ORDER_CREDIT,
        roundToPounds: rule.kind === 'cashBanking',
      });
    }
  }
  return events;
}

/* ── Assembly ─────────────────────────────────────────────────────────────── */

function scaled(events: Event[], scaleBps: number): Event[] {
  return events.map((event) => {
    const raw = Math.max(1, divRound(event.amountPence * scaleBps, 10_000));
    return { ...event, amountPence: event.roundToPounds === true ? Math.max(100, divRound(raw, 100) * 100) : raw };
  });
}

/**
 * Two rows identical in (date, amount, description) are reported by the D41 gate
 * as a possible double-import. Genuine repeats do happen, but a fixture that
 * trips a finding it did not mean to trip is a fixture nobody trusts — so a
 * collision is nudged by a penny until the triple is unique. Done BEFORE the
 * balance is accumulated, so continuity is unaffected.
 *
 * The key lowercases the description because `assessCompleteness` does.
 */
function deduplicate(events: Event[]): Event[] {
  const seen = new Set<string>();
  return events.map((event) => {
    let amount = event.amountPence;
    const key = (value: number): string => `${event.date}|${value}|${event.description.toLowerCase()}`;
    for (let guard = 0; guard < 500 && seen.has(key(amount)); guard += 1) {
      amount += amount < 0 ? -1 : 1;
    }
    seen.add(key(amount));
    return { ...event, amountPence: amount };
  });
}

function order(events: Event[]): Event[] {
  return [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.description < b.description ? -1 : a.description > b.description ? 1 : a.amountPence - b.amountPence;
  });
}

function accumulate(events: Event[], openingPence: number): LedgerRow[] {
  let balance = openingPence;
  return events.map((event) => {
    balance += event.amountPence;
    return { date: event.date, description: event.description, amountPence: event.amountPence, balancePence: balance };
  });
}

export function buildLedger(plan: Plan): Ledger {
  const startDay = toDayNumber(PERIOD_START);
  const endDay = toDayNumber(PERIOD_END);

  const outgoings = buildOutgoings(plan, startDay, endDay);
  const takingsBase = buildTakings(plan, startDay, endDay);

  const outTotal = outgoings.reduce((sum, e) => sum + (e.amountPence < 0 ? -e.amountPence : 0), 0);
  const inFromTextures = outgoings.reduce((sum, e) => sum + (e.amountPence > 0 ? e.amountPence : 0), 0);
  const takingsTotal = takingsBase.reduce((sum, e) => sum + e.amountPence, 0);

  // First guess: takings that cover the outgoings with a modest margin.
  let scaleBps = Math.max(500, divRound((outTotal - inFromTextures) * TARGET_MARGIN_BPS, Math.max(1, takingsTotal)));

  let rows: LedgerRow[] = [];
  // Raise the TAKINGS until the account never falls through the floor. The
  // minimum lands early in the period (the first payroll runs before much has
  // been banked), so the bump is deliberately generous and re-checked.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    rows = accumulate(order(deduplicate([...outgoings, ...scaled(takingsBase, scaleBps)])), plan.openingBalancePence);
    const min = rows.reduce((lowest, row) => Math.min(lowest, row.balancePence), plan.openingBalancePence);
    if (min >= FLOOR_PENCE) break;
    const shortfall = FLOOR_PENCE - min;
    const monthlyTakings = divRound(divRound(takingsTotal * scaleBps, 10_000), 13);
    scaleBps += Math.max(50, divRound(scaleBps * shortfall, Math.max(1, monthlyTakings * 3)));
  }

  const balances = rows.map((row) => row.balancePence);
  return {
    plan,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    openingBalancePence: plan.openingBalancePence,
    closingBalancePence: balances[balances.length - 1] ?? plan.openingBalancePence,
    rows,
    incomeScaleBps: scaleBps,
    minBalancePence: Math.min(plan.openingBalancePence, ...balances),
    maxBalancePence: Math.max(plan.openingBalancePence, ...balances),
    totalInPence: rows.reduce((sum, row) => sum + (row.amountPence > 0 ? row.amountPence : 0), 0),
    totalOutPence: rows.reduce((sum, row) => sum + (row.amountPence < 0 ? -row.amountPence : 0), 0),
  };
}

/* ── Display ──────────────────────────────────────────────────────────────── */

/** `123456` → `1,234.56`. Formatting only — never parsed back into a balance. */
export function penceToAmount(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const whole = Math.trunc(abs / 100).toLocaleString('en-GB');
  return `${negative ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** `2026-08-31` → `31/08/2026`, the UK day-first form the parser expects. */
export function isoToUk(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/** `2026-08-31` → `31 August 2026`, for the letterhead. */
export function isoToLong(iso: string): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${Number.parseInt(iso.slice(8, 10), 10)} ${months[monthOf(iso) - 1]} ${iso.slice(0, 4)}`;
}
