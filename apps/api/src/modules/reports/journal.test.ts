import { describe, expect, it } from 'vitest';

import { type Account, type BankLineInput, type DeriveInput, type DocInput, deriveJournal, entryBalance } from './journal.js';
import { ageBucket, aged, balanceSheet, outstandingDocuments, profitAndLoss, trialBalance } from './reports.js';

const chart = new Map<string, Account>([
  ['PURCHASES', { code: 'PURCHASES', name: 'Purchases', reportClass: 'cost-of-sales' }],
  ['RENT', { code: 'RENT', name: 'Rent', reportClass: 'overhead' }],
  ['SALES', { code: 'SALES', name: 'Sales', reportClass: 'income' }],
  ['FA_COMPUTER_EQUIPMENT', { code: 'FA_COMPUTER_EQUIPMENT', name: 'Computer equipment', reportClass: 'fixed-asset' }],
]);

const doc = (over: Partial<DocInput> & Pick<DocInput, 'id'>): DocInput => ({
  label: over.id,
  date: '2026-04-10',
  dueDate: null,
  direction: 'purchase',
  docType: 'INVOICE',
  totalPence: 12_000,
  taxPence: 2_000,
  categoryCode: 'PURCHASES',
  claimant: false,
  party: 'Bidfood',
  ...over,
});

const line = (over: Partial<BankLineInput> & Pick<BankLineInput, 'id' | 'amountPence'>): BankLineInput => ({
  accountId: 'acc1',
  date: '2026-04-20',
  label: over.id,
  matchedDocumentIds: [],
  ...over,
});

const input = (documents: DocInput[], bankLines: BankLineInput[] = [], journals: DeriveInput['journals'] = []): DeriveInput => ({
  documents,
  bankLines,
  journals,
  chart,
  bankAccounts: new Map([['acc1', 'Current account']]),
});

const PERIOD = { from: '2026-04-01', to: '2026-04-30' };

/** Every entry balances, the whole journal balances, and the reports agree with themselves. */
function assertBalanced(derive: DeriveInput) {
  const journal = deriveJournal(derive);
  for (const entry of journal.entries) expect(entryBalance(entry), entry.id).toBe(0);
  const tb = trialBalance(journal, PERIOD, null).sections[0]!.lines.at(-1)!;
  expect(tb.debitPence).toBe(tb.creditPence);
  const bs = balanceSheet(journal, PERIOD, null).sections;
  const netAssets = bs.find((s) => s.key === 'net-assets')!.lines.find((l) => l.key === 'net-assets')!.amountPence;
  const reserves = bs.find((s) => s.key === 'capital-and-reserves')!.lines.at(-1)!.amountPence;
  expect(netAssets).toBe(reserves);
  for (const p of journal.entries.flatMap((e) => e.postings)) expect(Number.isInteger(p.amountPence)).toBe(true);
  return journal;
}

const balanceOf = (journal: ReturnType<typeof deriveJournal>, code: string): number =>
  journal.entries.flatMap((e) => e.postings).filter((p) => p.accountCode === code).reduce((s, p) => s + p.amountPence, 0);

describe('deriveJournal — debits equal credits in every scenario', () => {
  it('purchase invoice, unpaid: Dr cost + Dr VAT, Cr creditors', () => {
    const j = assertBalanced(input([doc({ id: 'inv1' })]));
    expect(balanceOf(j, 'PURCHASES')).toBe(10_000);
    expect(balanceOf(j, 'VAT_INPUT')).toBe(2_000);
    expect(balanceOf(j, 'TRADE_CREDITORS')).toBe(-12_000);
  });

  it('purchase invoice paid by a matched bank line clears the creditor against the bank', () => {
    const j = assertBalanced(input([doc({ id: 'inv1' })], [line({ id: 't1', amountPence: -12_000, matchedDocumentIds: ['inv1'] })]));
    expect(balanceOf(j, 'TRADE_CREDITORS')).toBe(0);
    expect(balanceOf(j, 'BANK:acc1')).toBe(-12_000);
    expect(balanceOf(j, 'SUSPENSE')).toBe(0);
  });

  it('sales invoice partly paid: Dr debtors, Cr sales + VAT output; the rest stays owed', () => {
    const j = assertBalanced(
      input(
        [doc({ id: 's1', direction: 'sale', categoryCode: 'SALES', party: 'Acme' })],
        [line({ id: 't1', amountPence: 5_000, matchedDocumentIds: ['s1'] })],
      ),
    );
    expect(balanceOf(j, 'SALES')).toBe(-10_000);
    expect(balanceOf(j, 'VAT_OUTPUT')).toBe(-2_000);
    expect(balanceOf(j, 'TRADE_DEBTORS')).toBe(7_000);
    expect(balanceOf(j, 'BANK:acc1')).toBe(5_000);
  });

  it('credit notes reverse, for both directions', () => {
    const j = assertBalanced(
      input([
        doc({ id: 'cn1', docType: 'CREDIT_NOTE', totalPence: 1_200, taxPence: 200 }),
        doc({ id: 'cn2', docType: 'CREDIT_NOTE', direction: 'sale', categoryCode: 'SALES', totalPence: 600, taxPence: 100 }),
      ]),
    );
    expect(balanceOf(j, 'PURCHASES')).toBe(-1_000);
    expect(balanceOf(j, 'TRADE_CREDITORS')).toBe(1_200);
    expect(balanceOf(j, 'SALES')).toBe(500);
    expect(balanceOf(j, 'TRADE_DEBTORS')).toBe(-600);
  });

  it('a matched receipt credits the bank directly; the bank still equals the statement', () => {
    const j = assertBalanced(
      input(
        [doc({ id: 'r1', docType: 'RECEIPT', totalPence: 1_000, taxPence: 0 })],
        [line({ id: 't1', amountPence: -1_050, matchedDocumentIds: ['r1'] })],
      ),
    );
    expect(balanceOf(j, 'BANK:acc1')).toBe(-1_050);
    expect(balanceOf(j, 'TRADE_CREDITORS')).toBe(0);
    expect(balanceOf(j, 'SUSPENSE')).toBe(50);
  });

  it('an unmatched receipt goes to expense claims when a claimant paid, else suspense', () => {
    const j = assertBalanced(
      input([
        doc({ id: 'r1', docType: 'RECEIPT', totalPence: 900, taxPence: 150, claimant: true }),
        doc({ id: 'r2', docType: 'RECEIPT', totalPence: 300, taxPence: 0 }),
      ]),
    );
    expect(balanceOf(j, 'EXPENSE_CLAIMS')).toBe(-900);
    expect(balanceOf(j, 'SUSPENSE')).toBe(-300);
  });

  it('an unmatched bank line posts to suspense', () => {
    const j = assertBalanced(input([], [line({ id: 't1', amountPence: -4_321 })]));
    expect(balanceOf(j, 'SUSPENSE')).toBe(4_321);
    expect(j.unmatchedBankLineIds).toEqual(['t1']);
  });

  it('one payment settling two invoices allocates oldest first and suspends the overpayment', () => {
    const j = assertBalanced(
      input(
        [doc({ id: 'a', date: '2026-04-01' }), doc({ id: 'b', date: '2026-04-05', totalPence: 6_000, taxPence: 1_000 })],
        [line({ id: 't1', amountPence: -20_000, matchedDocumentIds: ['b', 'a'] })],
      ),
    );
    expect(j.allocations.map((a) => [a.documentId, a.amountPence])).toEqual([
      ['a', 12_000],
      ['b', 6_000],
    ]);
    expect(balanceOf(j, 'TRADE_CREDITORS')).toBe(0);
    expect(balanceOf(j, 'SUSPENSE')).toBe(2_000);
  });

  it('a match in the wrong direction is not an allocation — it stays in suspense', () => {
    const j = assertBalanced(input([doc({ id: 'inv1' })], [line({ id: 't1', amountPence: 12_000, matchedDocumentIds: ['inv1'] })]));
    expect(j.allocations).toEqual([]);
    expect(balanceOf(j, 'TRADE_CREDITORS')).toBe(-12_000);
  });

  it('uncategorised and off-chart codes still post, and are reported', () => {
    const j = assertBalanced(input([doc({ id: 'x', categoryCode: null }), doc({ id: 'y', categoryCode: '400' })]));
    expect(balanceOf(j, 'UNCATEGORISED_COSTS')).toBe(10_000);
    expect(j.unmapped).toEqual(['400']);
  });

  it('opening balances and a manual journal post as entered', () => {
    const j = assertBalanced(
      input(
        [],
        [],
        [
          {
            id: 'ob',
            date: '2026-03-31',
            narrative: 'Opening balances',
            lines: [
              { accountCode: 'BANK:acc1', debitPence: 50_000, creditPence: 0 },
              { accountCode: 'FA_COMPUTER_EQUIPMENT', debitPence: 20_000, creditPence: 0 },
              { accountCode: 'CAPITAL', debitPence: 0, creditPence: 70_000 },
            ],
          },
        ],
      ),
    );
    expect(balanceOf(j, 'CAPITAL')).toBe(-70_000);
  });

  it('a mixed month — randomised — always balances', () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let round = 0; round < 50; round += 1) {
      const docs: DocInput[] = [];
      const lines: BankLineInput[] = [];
      for (let i = 0; i < 12; i += 1) {
        const total = 100 + rand(50_000);
        docs.push(
          doc({
            id: `d${i}`,
            date: `2026-04-${String(1 + rand(28)).padStart(2, '0')}`,
            direction: rand(2) === 0 ? 'purchase' : 'sale',
            docType: (['INVOICE', 'RECEIPT', 'CREDIT_NOTE'] as const)[rand(3)]!,
            totalPence: total,
            taxPence: rand(total),
            categoryCode: (['PURCHASES', 'RENT', 'SALES', null, 'UNKNOWN'] as const)[rand(5)]!,
            claimant: rand(2) === 0,
          }),
        );
      }
      for (let i = 0; i < 10; i += 1) {
        lines.push(
          line({
            id: `t${i}`,
            date: `2026-04-${String(1 + rand(28)).padStart(2, '0')}`,
            amountPence: (rand(2) === 0 ? -1 : 1) * (1 + rand(60_000)),
            matchedDocumentIds: rand(3) === 0 ? [] : [`d${rand(12)}`, `d${rand(12)}`],
          }),
        );
      }
      const j = assertBalanced(input(docs, lines));
      expect(balanceOf(j, 'BANK:acc1')).toBe(lines.reduce((s, l) => s + l.amountPence, 0));
    }
  });
});

describe('profit and loss', () => {
  it('gross and net profit, with a comparison period', () => {
    const j = deriveJournal(
      input([
        doc({ id: 's1', direction: 'sale', categoryCode: 'SALES', totalPence: 60_000, taxPence: 10_000 }),
        doc({ id: 'p1', totalPence: 24_000, taxPence: 4_000 }),
        doc({ id: 'o1', categoryCode: 'RENT', totalPence: 5_000, taxPence: 0 }),
        doc({ id: 'old', direction: 'sale', categoryCode: 'SALES', date: '2026-03-15', totalPence: 1_000, taxPence: 0 }),
      ]),
    );
    const body = profitAndLoss(j, PERIOD, { from: '2026-03-01', to: '2026-03-31' });
    const fig = (key: string) => body.sections.flatMap((s) => s.lines).find((l) => l.key === key)!;
    expect(fig('gross-profit').amountPence).toBe(30_000);
    expect(fig('net-profit').amountPence).toBe(25_000);
    expect(fig('net-profit').comparePence).toBe(1_000);
    expect(fig('SALES').sources.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('aged buckets', () => {
  it('buckets by days past the due date', () => {
    expect(ageBucket('2026-04-30', '2026-04-30')).toBe('current');
    expect(ageBucket('2026-05-10', '2026-04-30')).toBe('current');
    expect(ageBucket('2026-04-29', '2026-04-30')).toBe('days30');
    expect(ageBucket('2026-03-31', '2026-04-30')).toBe('days30');
    expect(ageBucket('2026-03-30', '2026-04-30')).toBe('days60');
    expect(ageBucket('2026-03-01', '2026-04-30')).toBe('days60');
    expect(ageBucket('2026-02-28', '2026-04-30')).toBe('days90');
    expect(ageBucket('2026-01-30', '2026-04-30')).toBe('days90');
    expect(ageBucket('2026-01-29', '2026-04-30')).toBe('over90');
  });

  it('paid means fully allocated; partials and credit notes stay, receipts never appear', () => {
    const docs = [
      doc({ id: 'paid', dueDate: '2026-04-01' }),
      doc({ id: 'part', dueDate: '2026-02-01', party: 'Brakes' }),
      doc({ id: 'cn', docType: 'CREDIT_NOTE', totalPence: 500, taxPence: 0 }),
      doc({ id: 'rcpt', docType: 'RECEIPT' }),
      doc({ id: 'future', date: '2026-05-02' }),
    ];
    const j = deriveJournal(
      input(docs, [
        line({ id: 't1', amountPence: -12_000, matchedDocumentIds: ['paid'] }),
        line({ id: 't2', amountPence: -2_000, matchedDocumentIds: ['part'] }),
      ]),
    );
    const rows = outstandingDocuments(docs, j, 'purchase', '2026-04-30');
    expect(rows.map((r) => [r.doc.id, r.outstandingPence, r.bucket])).toEqual([
      ['part', 10_000, 'days90'],
      ['cn', -500, 'days30'],
    ]);
    const body = aged(docs, j, 'purchase', PERIOD, null);
    const totalLine = body.sections[0]!.lines.at(-1)!;
    expect(totalLine.amountPence).toBe(9_500);
    expect((totalLine.currentPence ?? 0) + (totalLine.days30Pence ?? 0) + (totalLine.days60Pence ?? 0) + (totalLine.days90Pence ?? 0) + (totalLine.over90Pence ?? 0)).toBe(9_500);
  });
});
