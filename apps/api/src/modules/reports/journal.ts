/**
 * The derived double-entry journal (rush/reports, 15 Oct 2026).
 *
 * PURE: plain data in, balanced entries out. No Prisma, no clock. Every
 * amount is integer pence and every posting is SIGNED — positive is a debit,
 * negative a credit — so "balanced" is simply "the postings of every entry
 * sum to zero", which `journal.test.ts` asserts over every scenario.
 *
 * The rules:
 * - purchase invoice → Dr category (net) + Dr VAT_INPUT, Cr TRADE_CREDITORS;
 * - sales invoice → Dr TRADE_DEBTORS, Cr category (net) + Cr VAT_OUTPUT;
 * - a credit note is the same entry with every sign flipped;
 * - a RECEIPT is paid at point of sale: the portion a confirmed bank match
 *   covers is credited (debited, for a sale) to that BANK account directly,
 *   and the rest to EXPENSE_CLAIMS (a claimant paid) or SUSPENSE (we cannot
 *   see how it was paid);
 * - a confirmed bank match against an invoice/credit note clears the
 *   creditor/debtor against the bank;
 * - whatever part of a bank line no counted document explains posts to
 *   SUSPENSE.
 *
 * ⚠ The bank account always receives exactly the signed statement amount of
 * each line, whichever entry carries it, so a bank balance here can be
 * reconciled to the statement. That is why an allocation is only made when
 * the bank line's direction agrees with the document's (money out for a
 * purchase, in for a sale, reversed for a credit note) — a contrary match
 * stays in suspense rather than bending the bank.
 */

export type ReportClass =
  | 'income'
  | 'cost-of-sales'
  | 'overhead'
  | 'fixed-asset'
  | 'current-asset'
  | 'bank'
  | 'current-liability'
  | 'equity';

export interface Account {
  readonly code: string;
  readonly name: string;
  readonly reportClass: ReportClass;
}

export const SYSTEM_ACCOUNTS: readonly Account[] = [
  { code: 'TRADE_DEBTORS', name: 'Trade debtors', reportClass: 'current-asset' },
  { code: 'TRADE_CREDITORS', name: 'Trade creditors', reportClass: 'current-liability' },
  { code: 'VAT_INPUT', name: 'VAT on purchases', reportClass: 'current-liability' },
  { code: 'VAT_OUTPUT', name: 'VAT on sales', reportClass: 'current-liability' },
  { code: 'EXPENSE_CLAIMS', name: 'Expense claims owed', reportClass: 'current-liability' },
  { code: 'LOANS', name: 'Loans', reportClass: 'current-liability' },
  { code: 'SUSPENSE', name: 'Suspense (unexplained)', reportClass: 'current-liability' },
  { code: 'CAPITAL', name: 'Capital', reportClass: 'equity' },
  { code: 'RETAINED_EARNINGS', name: 'Retained earnings', reportClass: 'equity' },
  { code: 'DRAWINGS', name: 'Drawings', reportClass: 'equity' },
  { code: 'UNCATEGORISED_COSTS', name: 'Uncategorised costs', reportClass: 'overhead' },
  { code: 'UNCATEGORISED_SALES', name: 'Uncategorised sales', reportClass: 'income' },
];

/** The chart's ledgers (`rules-suggestions` `LEDGERS`) → report class. */
export const LEDGER_CLASS: Readonly<Record<string, ReportClass>> = {
  Sales: 'income',
  'Cost of sales': 'cost-of-sales',
  Expenses: 'overhead',
  'Fixed assets': 'fixed-asset',
  'Current assets': 'current-asset',
};

export const bankCode = (accountId: string): string => `BANK:${accountId}`;

export interface DocInput {
  readonly id: string;
  readonly label: string;
  /** Calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly dueDate: string | null;
  readonly direction: 'purchase' | 'sale';
  readonly docType: 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE';
  /** Magnitudes as printed; the sign comes from `docType`, never the column. */
  readonly totalPence: number;
  readonly taxPence: number;
  readonly categoryCode: string | null;
  readonly claimant: boolean;
  readonly party: string;
}

export interface BankLineInput {
  readonly id: string;
  readonly accountId: string;
  readonly date: string;
  /** Signed: negative is money out. */
  readonly amountPence: number;
  readonly label: string;
  /** Confirmed matches only. Ids outside the counted documents are ignored. */
  readonly matchedDocumentIds: readonly string[];
}

export interface ManualJournalInput {
  readonly id: string;
  readonly date: string;
  readonly narrative: string;
  readonly lines: readonly { accountCode: string; debitPence: number; creditPence: number }[];
}

export interface SourceRef {
  readonly kind: 'document' | 'bank-transaction' | 'journal';
  readonly id: string;
  readonly label: string;
}

export interface Posting {
  readonly accountCode: string;
  /** Signed: debit positive. */
  readonly amountPence: number;
  readonly date: string;
  readonly source: SourceRef;
}

export interface Entry {
  readonly id: string;
  readonly date: string;
  readonly postings: readonly Posting[];
}

export interface Allocation {
  readonly documentId: string;
  readonly bankLineId: string;
  readonly date: string;
  /** Magnitude applied to the document. */
  readonly amountPence: number;
}

export interface DerivedJournal {
  readonly entries: readonly Entry[];
  readonly allocations: readonly Allocation[];
  /** Every account any posting touches, classified. */
  readonly accounts: ReadonlyMap<string, Account>;
  /** Category codes not on the chart — classified by the document's direction. */
  readonly unmapped: readonly string[];
  /** Bank lines no counted document explains at all. */
  readonly unmatchedBankLineIds: readonly string[];
}

export interface DeriveInput {
  readonly documents: readonly DocInput[];
  readonly bankLines: readonly BankLineInput[];
  readonly journals: readonly ManualJournalInput[];
  /** Chart account code → account (catalogue + anything the caller knows). */
  readonly chart: ReadonlyMap<string, Account>;
  /** Bank account id → display name. */
  readonly bankAccounts: ReadonlyMap<string, string>;
}

/** +1 for an invoice/receipt, −1 for a credit note. */
const instrumentSign = (doc: DocInput): 1 | -1 => (doc.docType === 'CREDIT_NOTE' ? -1 : 1);

/** The sign a bank line must have to settle this document: purchases pay out, sales take in. */
const expectedBankSign = (doc: DocInput): 1 | -1 => ((doc.direction === 'sale' ? 1 : -1) * instrumentSign(doc)) as 1 | -1;

const byDateThenId = <T extends { date: string; id: string }>(a: T, b: T): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function deriveJournal(input: DeriveInput): DerivedJournal {
  const accounts = new Map<string, Account>();
  for (const account of SYSTEM_ACCOUNTS) accounts.set(account.code, account);
  for (const [id, name] of input.bankAccounts) accounts.set(bankCode(id), { code: bankCode(id), name, reportClass: 'bank' });
  const unmapped = new Set<string>();

  const docs = new Map(input.documents.map((doc) => [doc.id, doc]));
  const gross = (doc: DocInput): number => Math.abs(doc.totalPence);

  // ── 1. allocations: bank lines in date order, each across its matched docs ──
  const allocated = new Map<string, number>();
  const allocations: Allocation[] = [];
  const leftover = new Map<string, number>();
  const unmatchedBankLineIds: string[] = [];
  for (const line of [...input.bankLines].sort(byDateThenId)) {
    let remaining = Math.abs(line.amountPence);
    const lineSign = Math.sign(line.amountPence);
    const matched = line.matchedDocumentIds
      .map((id) => docs.get(id))
      .filter((doc): doc is DocInput => doc !== undefined && expectedBankSign(doc) === lineSign)
      .sort(byDateThenId);
    let any = false;
    for (const doc of matched) {
      const outstanding = gross(doc) - (allocated.get(doc.id) ?? 0);
      const amount = Math.min(remaining, outstanding);
      if (amount <= 0) continue;
      allocations.push({ documentId: doc.id, bankLineId: line.id, date: line.date, amountPence: amount });
      allocated.set(doc.id, (allocated.get(doc.id) ?? 0) + amount);
      remaining -= amount;
      any = true;
    }
    leftover.set(line.id, remaining);
    if (!any && line.amountPence !== 0) unmatchedBankLineIds.push(line.id);
  }
  const allocationsByDoc = new Map<string, Allocation[]>();
  const allocationsByLine = new Map<string, Allocation[]>();
  for (const a of allocations) {
    allocationsByDoc.set(a.documentId, [...(allocationsByDoc.get(a.documentId) ?? []), a]);
    allocationsByLine.set(a.bankLineId, [...(allocationsByLine.get(a.bankLineId) ?? []), a]);
  }
  const bankLineById = new Map(input.bankLines.map((line) => [line.id, line]));

  const entries: Entry[] = [];

  // ── 2. documents ──
  for (const doc of input.documents) {
    const source: SourceRef = { kind: 'document', id: doc.id, label: doc.label };
    const k = instrumentSign(doc);
    // `side` is the sign of the P&L/asset leg: a purchase debits it, a sale credits it.
    const side = doc.direction === 'purchase' ? 1 : -1;
    const g = gross(doc);
    const tax = Math.abs(doc.taxPence);
    const net = g - tax;
    const netAccount = accountForCategory(doc, input.chart, accounts, unmapped);
    const postings: Posting[] = [
      { accountCode: netAccount, amountPence: side * k * net, date: doc.date, source },
      { accountCode: doc.direction === 'purchase' ? 'VAT_INPUT' : 'VAT_OUTPUT', amountPence: side * k * tax, date: doc.date, source },
    ];
    if (doc.docType === 'RECEIPT') {
      let paid = 0;
      for (const a of allocationsByDoc.get(doc.id) ?? []) {
        const bankLine = bankLineById.get(a.bankLineId);
        if (bankLine === undefined) continue;
        postings.push({ accountCode: bankCode(bankLine.accountId), amountPence: -side * a.amountPence, date: doc.date, source });
        paid += a.amountPence;
      }
      const rest = g - paid;
      const restAccount = doc.claimant && doc.direction === 'purchase' ? 'EXPENSE_CLAIMS' : 'SUSPENSE';
      postings.push({ accountCode: restAccount, amountPence: -side * rest, date: doc.date, source });
    } else {
      postings.push({
        accountCode: doc.direction === 'purchase' ? 'TRADE_CREDITORS' : 'TRADE_DEBTORS',
        amountPence: -side * k * g,
        date: doc.date,
        source,
      });
    }
    entries.push({ id: `doc:${doc.id}`, date: doc.date, postings: nonZero(postings) });
  }

  // ── 3. bank lines ──
  for (const line of input.bankLines) {
    const source: SourceRef = { kind: 'bank-transaction', id: line.id, label: line.label };
    const sign = Math.sign(line.amountPence);
    let bankPortion = line.amountPence;
    const postings: Posting[] = [];
    for (const a of allocationsByLine.get(line.id) ?? []) {
      const doc = docs.get(a.documentId);
      if (doc === undefined) continue;
      if (doc.docType === 'RECEIPT') {
        // Already credited/debited to this bank account by the receipt's own entry.
        bankPortion -= sign * a.amountPence;
        continue;
      }
      postings.push({
        accountCode: doc.direction === 'purchase' ? 'TRADE_CREDITORS' : 'TRADE_DEBTORS',
        amountPence: -sign * a.amountPence,
        date: line.date,
        source,
      });
    }
    postings.push({ accountCode: 'SUSPENSE', amountPence: -sign * (leftover.get(line.id) ?? 0), date: line.date, source });
    postings.unshift({ accountCode: bankCode(line.accountId), amountPence: bankPortion, date: line.date, source });
    if (!accounts.has(bankCode(line.accountId))) {
      accounts.set(bankCode(line.accountId), { code: bankCode(line.accountId), name: 'Bank account', reportClass: 'bank' });
    }
    const kept = nonZero(postings);
    if (kept.length > 0) entries.push({ id: `bank:${line.id}`, date: line.date, postings: kept });
  }

  // ── 4. manual journals ──
  for (const journal of input.journals) {
    const source: SourceRef = { kind: 'journal', id: journal.id, label: journal.narrative };
    const postings = journal.lines.map((line) => {
      if (!accounts.has(line.accountCode)) {
        const known = input.chart.get(line.accountCode);
        if (known !== undefined) accounts.set(line.accountCode, known);
        else {
          unmapped.add(line.accountCode);
          // An unknown code in a journal still has to land somewhere for the
          // balance sheet to balance; a current-liability line named by its
          // code is the visible place, and completeness lists it.
          accounts.set(line.accountCode, { code: line.accountCode, name: line.accountCode, reportClass: 'current-liability' });
        }
      }
      return { accountCode: line.accountCode, amountPence: line.debitPence - line.creditPence, date: journal.date, source };
    });
    entries.push({ id: `journal:${journal.id}`, date: journal.date, postings: nonZero(postings) });
  }

  return { entries, allocations, accounts, unmapped: [...unmapped].sort(), unmatchedBankLineIds };
}

function accountForCategory(
  doc: DocInput,
  chart: ReadonlyMap<string, Account>,
  accounts: Map<string, Account>,
  unmapped: Set<string>,
): string {
  const code = doc.categoryCode?.trim() ?? '';
  if (code === '') return doc.direction === 'purchase' ? 'UNCATEGORISED_COSTS' : 'UNCATEGORISED_SALES';
  if (!accounts.has(code)) {
    const known = chart.get(code);
    if (known !== undefined) accounts.set(code, known);
    else {
      unmapped.add(code);
      accounts.set(code, { code, name: code, reportClass: doc.direction === 'purchase' ? 'overhead' : 'income' });
    }
  }
  return code;
}

const nonZero = (postings: readonly Posting[]): Posting[] => postings.filter((p) => p.amountPence !== 0);

/** Σ postings of an entry — zero for every balanced entry. */
export const entryBalance = (entry: Entry): number => entry.postings.reduce((sum, p) => sum + p.amountPence, 0);
