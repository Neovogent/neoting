import type { ReportKind, ReportLine, ReportSection, ReportSource } from '@neoting/contracts/model';

import type { Account, DerivedJournal, DocInput, Posting, ReportClass } from './journal.js';

/**
 * The five reports, built from a derived journal. PURE — dates are calendar
 * days (`YYYY-MM-DD`) compared as strings, money is integer pence throughout.
 */

export interface Period {
  readonly from: string;
  readonly to: string;
}

export interface ReportBody {
  readonly title: string;
  readonly sections: readonly ReportSection[];
}

const PNL_CLASSES: ReadonlySet<ReportClass> = new Set(['income', 'cost-of-sales', 'overhead']);
const isPnl = (account: Account | undefined): boolean => account !== undefined && PNL_CLASSES.has(account.reportClass);

/** Credit-natured classes are displayed credit-positive. */
const CREDIT_NATURED: ReadonlySet<ReportClass> = new Set(['income', 'current-liability', 'equity']);
const displaySign = (cls: ReportClass): 1 | -1 => (CREDIT_NATURED.has(cls) ? -1 : 1);

function postings(journal: DerivedJournal): Posting[] {
  return journal.entries.flatMap((entry) => entry.postings);
}

const inRange = (date: string, from: string | null, to: string): boolean => (from === null || date >= from) && date <= to;

interface Bucket {
  total: number;
  sources: Map<string, ReportSource>;
}

/** Account code → balance and its sources, over postings that pass `keep`. */
function balances(all: readonly Posting[], keep: (p: Posting) => boolean): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (const p of all) {
    if (!keep(p)) continue;
    const bucket = out.get(p.accountCode) ?? { total: 0, sources: new Map<string, ReportSource>() };
    bucket.total += p.amountPence;
    const key = `${p.source.kind}:${p.source.id}`;
    const prior = bucket.sources.get(key);
    bucket.sources.set(key, {
      kind: p.source.kind,
      id: p.source.id,
      label: p.source.label,
      date: p.date,
      amountPence: (prior?.amountPence ?? 0) + p.amountPence,
    });
    out.set(p.accountCode, bucket);
  }
  return out;
}

function accountLines(
  journal: DerivedJournal,
  classes: readonly ReportClass[],
  current: Map<string, Bucket>,
  compare: Map<string, Bucket> | null,
): ReportLine[] {
  const codes = new Set<string>();
  for (const map of [current, compare]) {
    if (map === null) continue;
    for (const [code, bucket] of map) {
      const account = journal.accounts.get(code);
      if (account !== undefined && classes.includes(account.reportClass) && bucket.total !== 0) codes.add(code);
    }
  }
  return [...codes]
    .map((code) => {
      const account = journal.accounts.get(code)!;
      const sign = displaySign(account.reportClass);
      const bucket = current.get(code);
      const line: ReportLine = {
        key: code,
        label: account.name,
        lineKind: 'line',
        accountCode: code,
        amountPence: sign * (bucket?.total ?? 0),
        sources: [...(bucket?.sources.values() ?? [])]
          .filter((s) => s.amountPence !== 0)
          .map((s) => ({ ...s, amountPence: sign * s.amountPence })),
      };
      return compare === null ? line : { ...line, comparePence: sign * (compare.get(code)?.total ?? 0) };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function total(key: string, label: string, lines: readonly ReportLine[], kind: 'subtotal' | 'total' = 'subtotal', withCompare = false): ReportLine {
  const line: ReportLine = { key, label, lineKind: kind, amountPence: lines.reduce((s, l) => s + l.amountPence, 0), sources: [] };
  return withCompare ? { ...line, comparePence: lines.reduce((s, l) => s + (l.comparePence ?? 0), 0) } : line;
}

function figure(key: string, label: string, amount: number, compare: number | null, kind: 'subtotal' | 'total' = 'total'): ReportLine {
  const line: ReportLine = { key, label, lineKind: kind, amountPence: amount, sources: [] };
  return compare === null ? line : { ...line, comparePence: compare };
}

const section = (key: string, title: string, lines: readonly ReportLine[]): ReportSection => ({ key, title, lines: [...lines] });

// ── Profit & Loss ──────────────────────────────────────────────────────────

export function profitAndLoss(journal: DerivedJournal, period: Period, compare: Period | null): ReportBody {
  const all = postings(journal);
  const cur = balances(all, (p) => inRange(p.date, period.from, period.to));
  const cmp = compare === null ? null : balances(all, (p) => inRange(p.date, compare.from, compare.to));
  const c = compare !== null;

  const income = accountLines(journal, ['income'], cur, cmp);
  const cos = accountLines(journal, ['cost-of-sales'], cur, cmp);
  const overheads = accountLines(journal, ['overhead'], cur, cmp);
  const tIncome = total('total-income', 'Total income', income, 'subtotal', c);
  const tCos = total('total-cost-of-sales', 'Total cost of sales', cos, 'subtotal', c);
  const tOver = total('total-overheads', 'Total overheads', overheads, 'subtotal', c);
  const gross = figure('gross-profit', 'Gross profit', tIncome.amountPence - tCos.amountPence, c ? (tIncome.comparePence ?? 0) - (tCos.comparePence ?? 0) : null);
  const net = figure(
    'net-profit',
    'Net profit',
    gross.amountPence - tOver.amountPence,
    c ? (gross.comparePence ?? 0) - (tOver.comparePence ?? 0) : null,
  );
  return {
    title: 'Profit and loss',
    sections: [
      section('income', 'Income', [...income, tIncome]),
      section('cost-of-sales', 'Cost of sales', [...cos, tCos]),
      section('gross-profit', 'Gross profit', [gross]),
      section('overheads', 'Overheads', [...overheads, tOver]),
      section('net-profit', 'Net profit', [net]),
    ],
  };
}

// ── Balance sheet ──────────────────────────────────────────────────────────

function balanceSheetAt(journal: DerivedJournal, period: Period) {
  const all = postings(journal);
  const toDate = balances(all, (p) => p.date <= period.to);
  let profitBefore = 0;
  let profitIn = 0;
  for (const p of all) {
    if (p.date > period.to || !isPnl(journal.accounts.get(p.accountCode))) continue;
    if (p.date < period.from) profitBefore -= p.amountPence;
    else profitIn -= p.amountPence;
  }
  return { toDate, profitBefore, profitIn };
}

export function balanceSheet(journal: DerivedJournal, period: Period, compare: Period | null): ReportBody {
  const cur = balanceSheetAt(journal, period);
  const cmp = compare === null ? null : balanceSheetAt(journal, compare);
  const c = cmp !== null;

  const fixed = accountLines(journal, ['fixed-asset'], cur.toDate, cmp?.toDate ?? null);
  const current = accountLines(journal, ['bank', 'current-asset'], cur.toDate, cmp?.toDate ?? null);
  const liabilities = accountLines(journal, ['current-liability'], cur.toDate, cmp?.toDate ?? null);
  const equity = accountLines(journal, ['equity'], cur.toDate, cmp?.toDate ?? null);

  const tFixed = total('total-fixed-assets', 'Total fixed assets', fixed, 'subtotal', c);
  const tCurrent = total('total-current-assets', 'Total current assets', current, 'subtotal', c);
  const tLiab = total('total-current-liabilities', 'Total current liabilities', liabilities, 'subtotal', c);
  const netCurrent = figure(
    'net-current-assets',
    'Net current assets',
    tCurrent.amountPence - tLiab.amountPence,
    c ? (tCurrent.comparePence ?? 0) - (tLiab.comparePence ?? 0) : null,
    'subtotal',
  );
  const netAssets = figure(
    'net-assets',
    'Net assets',
    tFixed.amountPence + netCurrent.amountPence,
    c ? (tFixed.comparePence ?? 0) + (netCurrent.comparePence ?? 0) : null,
  );
  const reserves: ReportLine[] = [
    ...equity,
    figure('profit-brought-forward', 'Profit brought forward', cur.profitBefore, cmp?.profitBefore ?? null, 'subtotal'),
    figure('profit-for-period', 'Profit for the period', cur.profitIn, cmp?.profitIn ?? null, 'subtotal'),
  ].map((line) => (line.key.startsWith('profit-') ? { ...line, lineKind: 'line' as const } : line));
  const tReserves = total('total-capital-and-reserves', 'Total capital and reserves', reserves, 'total', c);

  return {
    title: 'Balance sheet',
    sections: [
      section('fixed-assets', 'Fixed assets', [...fixed, tFixed]),
      section('current-assets', 'Current assets', [...current, tCurrent]),
      section('current-liabilities', 'Current liabilities', [...liabilities, tLiab]),
      section('net-assets', 'Net assets', [netCurrent, netAssets]),
      section('capital-and-reserves', 'Capital and reserves', [...reserves, tReserves]),
    ],
  };
}

// ── Trial balance ──────────────────────────────────────────────────────────

function trialBalances(journal: DerivedJournal, period: Period): Map<string, Bucket> {
  // Balance-sheet accounts cumulative to `to`; P&L accounts for the period only,
  // with earlier profit rolled into retained earnings so the columns still agree.
  return balances(
    postings(journal).map((p) =>
      isPnl(journal.accounts.get(p.accountCode)) && p.date < period.from ? { ...p, accountCode: 'RETAINED_EARNINGS' } : p,
    ),
    (p) => p.date <= period.to,
  );
}

export function trialBalance(journal: DerivedJournal, period: Period, compare: Period | null): ReportBody {
  const cur = trialBalances(journal, period);
  const cmp = compare === null ? null : trialBalances(journal, compare);
  const codes = new Set([...cur.keys(), ...(cmp?.keys() ?? [])].filter((code) => (cur.get(code)?.total ?? 0) !== 0 || (cmp?.get(code)?.total ?? 0) !== 0));
  const lines: ReportLine[] = [...codes]
    .map((code) => {
      const bucket = cur.get(code);
      const bal = bucket?.total ?? 0;
      const line: ReportLine = {
        key: code,
        label: journal.accounts.get(code)?.name ?? code,
        lineKind: 'line',
        accountCode: code,
        amountPence: bal,
        debitPence: bal > 0 ? bal : 0,
        creditPence: bal < 0 ? -bal : 0,
        sources: [...(bucket?.sources.values() ?? [])].filter((s) => s.amountPence !== 0),
      };
      return cmp === null ? line : { ...line, comparePence: cmp.get(code)?.total ?? 0 };
    })
    .sort((a, b) => (a.accountCode ?? '').localeCompare(b.accountCode ?? ''));
  const debit = lines.reduce((s, l) => s + (l.debitPence ?? 0), 0);
  const credit = lines.reduce((s, l) => s + (l.creditPence ?? 0), 0);
  const totalLine: ReportLine = { key: 'total', label: 'Total', lineKind: 'total', amountPence: debit - credit, debitPence: debit, creditPence: credit, sources: [] };
  return { title: 'Trial balance', sections: [section('accounts', 'Accounts', [...lines, totalLine])] };
}

// ── Aged creditors / debtors ───────────────────────────────────────────────

export type AgeBucket = 'current' | 'days30' | 'days60' | 'days90' | 'over90';

const DAY_MS = 86_400_000;
const dayNumber = (day: string): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;

/** Days past due as at `asAt`: not yet due (or due today) is current. */
export function ageBucket(dueDate: string, asAt: string): AgeBucket {
  const overdue = dayNumber(asAt) - dayNumber(dueDate);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'days30';
  if (overdue <= 60) return 'days60';
  if (overdue <= 90) return 'days90';
  return 'over90';
}

/** Unpaid invoices (credit notes negative) for one direction, as at `asAt`. Paid = fully allocated by bank matches. */
export function outstandingDocuments(
  documents: readonly DocInput[],
  journal: DerivedJournal,
  direction: 'purchase' | 'sale',
  asAt: string,
): { doc: DocInput; outstandingPence: number; bucket: AgeBucket }[] {
  const paid = new Map<string, number>();
  for (const a of journal.allocations) {
    if (a.date <= asAt) paid.set(a.documentId, (paid.get(a.documentId) ?? 0) + a.amountPence);
  }
  return documents
    .filter((doc) => doc.direction === direction && doc.docType !== 'RECEIPT' && doc.date <= asAt)
    .map((doc) => {
      const sign = doc.docType === 'CREDIT_NOTE' ? -1 : 1;
      const outstandingPence = sign * (Math.abs(doc.totalPence) - (paid.get(doc.id) ?? 0));
      return { doc, outstandingPence, bucket: ageBucket(doc.dueDate ?? doc.date, asAt) };
    })
    .filter((row) => row.outstandingPence !== 0);
}

export function aged(
  documents: readonly DocInput[],
  journal: DerivedJournal,
  direction: 'purchase' | 'sale',
  period: Period,
  compare: Period | null,
): ReportBody {
  const rows = outstandingDocuments(documents, journal, direction, period.to);
  const cmpRows = compare === null ? null : outstandingDocuments(documents, journal, direction, compare.to);
  const parties = new Map<string, ReportLine>();
  const blank = (party: string): ReportLine => ({
    key: party,
    label: party,
    lineKind: 'line',
    amountPence: 0,
    currentPence: 0,
    days30Pence: 0,
    days60Pence: 0,
    days90Pence: 0,
    over90Pence: 0,
    sources: [],
    ...(cmpRows === null ? {} : { comparePence: 0 }),
  });
  const field: Record<AgeBucket, 'currentPence' | 'days30Pence' | 'days60Pence' | 'days90Pence' | 'over90Pence'> = {
    current: 'currentPence',
    days30: 'days30Pence',
    days60: 'days60Pence',
    days90: 'days90Pence',
    over90: 'over90Pence',
  };
  for (const row of rows) {
    const line = parties.get(row.doc.party) ?? blank(row.doc.party);
    parties.set(row.doc.party, {
      ...line,
      amountPence: line.amountPence + row.outstandingPence,
      [field[row.bucket]]: (line[field[row.bucket]] ?? 0) + row.outstandingPence,
      sources: [
        ...line.sources,
        { kind: 'document', id: row.doc.id, label: row.doc.label, date: row.doc.dueDate ?? row.doc.date, amountPence: row.outstandingPence },
      ],
    });
  }
  for (const row of cmpRows ?? []) {
    const line = parties.get(row.doc.party) ?? blank(row.doc.party);
    parties.set(row.doc.party, { ...line, comparePence: (line.comparePence ?? 0) + row.outstandingPence });
  }
  const lines = [...parties.values()].sort((a, b) => a.label.localeCompare(b.label));
  const sum = (key: 'currentPence' | 'days30Pence' | 'days60Pence' | 'days90Pence' | 'over90Pence' | 'comparePence'): number =>
    lines.reduce((s, l) => s + (l[key] ?? 0), 0);
  const totalLine: ReportLine = {
    key: 'total',
    label: 'Total',
    lineKind: 'total',
    amountPence: lines.reduce((s, l) => s + l.amountPence, 0),
    currentPence: sum('currentPence'),
    days30Pence: sum('days30Pence'),
    days60Pence: sum('days60Pence'),
    days90Pence: sum('days90Pence'),
    over90Pence: sum('over90Pence'),
    sources: [],
    ...(cmpRows === null ? {} : { comparePence: sum('comparePence') }),
  };
  return direction === 'purchase'
    ? { title: 'Aged creditors', sections: [section('suppliers', 'Suppliers', [...lines, totalLine])] }
    : { title: 'Aged debtors', sections: [section('customers', 'Customers', [...lines, totalLine])] };
}

export function buildReport(
  kind: ReportKind,
  journal: DerivedJournal,
  documents: readonly DocInput[],
  period: Period,
  compare: Period | null,
): ReportBody {
  switch (kind) {
    case 'profit-and-loss':
      return profitAndLoss(journal, period, compare);
    case 'balance-sheet':
      return balanceSheet(journal, period, compare);
    case 'trial-balance':
      return trialBalance(journal, period, compare);
    case 'aged-creditors':
      return aged(documents, journal, 'purchase', period, compare);
    case 'aged-debtors':
      return aged(documents, journal, 'sale', period, compare);
  }
}

/** Suspense balance at `asAt`, credit-positive as the balance sheet shows it. */
export function suspenseBalance(journal: DerivedJournal, asAt: string): number {
  return -postings(journal)
    .filter((p) => p.accountCode === 'SUSPENSE' && p.date <= asAt)
    .reduce((s, p) => s + p.amountPence, 0);
}

// ── CSV ────────────────────────────────────────────────────────────────────

const pounds = (pence: number | null | undefined): string => {
  if (pence === null || pence === undefined) return '';
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

const cell = (value: string): string => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function toCsv(kind: ReportKind, body: ReportBody, notice: string, period: Period, compare: Period | null): string {
  const agedReport = kind === 'aged-creditors' || kind === 'aged-debtors';
  const header = agedReport
    ? ['Section', 'Name', 'Current', '1-30 days', '31-60 days', '61-90 days', 'Over 90 days', 'Total']
    : kind === 'trial-balance'
      ? ['Section', 'Account code', 'Account', 'Debit', 'Credit']
      : ['Section', 'Account code', 'Line', `${period.from} to ${period.to}`];
  if (compare !== null) header.push(`Comparison ${compare.from} to ${compare.to}`);
  const rows = [[notice], [body.title, `${period.from} to ${period.to}`], header];
  for (const s of body.sections) {
    for (const l of s.lines) {
      const row = agedReport
        ? [s.title, l.label, pounds(l.currentPence), pounds(l.days30Pence), pounds(l.days60Pence), pounds(l.days90Pence), pounds(l.over90Pence), pounds(l.amountPence)]
        : kind === 'trial-balance'
          ? [s.title, l.accountCode ?? '', l.label, pounds(l.debitPence), pounds(l.creditPence)]
          : [s.title, l.accountCode ?? '', l.label, pounds(l.amountPence)];
      if (compare !== null) row.push(pounds(l.comparePence));
      rows.push(row);
    }
  }
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
