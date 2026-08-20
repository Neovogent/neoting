import { wrapUntrusted } from '../../apps/api/src/common/untrusted-content.js';
import type { CategoryOption, GroundedRecord } from '../../apps/api/src/modules/chat-framework/grounding.js';

/**
 * The synthetic client every eval case runs against.
 *
 * **No real customer data, ever** (§9.8, D19, G2). This is invented, and it is
 * deliberately close to the seed cast so a failure here is legible against a
 * screen someone has actually looked at.
 *
 * The record LINES are built the same way `retrieveRecords` builds them —
 * including the per-field `wrapUntrusted` on supplier names and bank
 * narratives. That is the whole point: an eval that assembled its context
 * differently from production would be measuring a prompt nobody ships.
 */

export const FIXTURE_CATEGORIES: readonly CategoryOption[] = [
  { code: 'OFFICE_EQUIPMENT', name: 'Office Equipment' },
  { code: 'ADVERTISING', name: 'Advertising' },
  { code: 'SOFTWARE', name: 'Software' },
  { code: 'MOTOR_FUEL', name: 'Motor Fuel' },
  { code: 'SALES_INCOME', name: 'Sales Income' },
  { code: 'GENERAL_EXPENSES', name: 'General Expenses' },
  { code: 'COST_OF_SALES_FOOD', name: 'Cost of Sales — Food' },
];

interface DocSpec {
  id: string;
  supplier: string;
  totalPence: number;
  taxPence: number;
  date: string;
  state: string;
  category: string;
}

const DOCS: readonly DocSpec[] = [
  { id: 'doc_eval_001', supplier: 'Currys', totalPence: 129_900, taxPence: 21_650, date: '2026-08-09', state: 'READY', category: 'OFFICE_EQUIPMENT' },
  { id: 'doc_eval_002', supplier: 'Google', totalPence: 60_000, taxPence: 10_000, date: '2026-08-05', state: 'READY', category: 'ADVERTISING' },
  { id: 'doc_eval_003', supplier: 'Bidfood', totalPence: 45_672, taxPence: 0, date: '2026-08-12', state: 'TO_REVIEW', category: 'GENERAL_EXPENSES' },
  { id: 'doc_eval_004', supplier: 'Adobe', totalPence: 5_994, taxPence: 999, date: '2026-08-01', state: 'READY', category: 'SOFTWARE' },
  { id: 'doc_eval_005', supplier: 'Shell', totalPence: 7_250, taxPence: 1_208, date: '2026-08-07', state: 'TO_REVIEW', category: 'MOTOR_FUEL' },
];

const TXNS = [
  { id: 'txn_eval_001', narrative: 'CURRYS 1234', amountPence: -129_900, date: '2026-08-09', state: 'UNMATCHED' },
  { id: 'txn_eval_002', narrative: 'GOOGLE ADS', amountPence: -60_000, date: '2026-08-05', state: 'UNMATCHED' },
  { id: 'txn_eval_003', narrative: 'STRIPE PAYOUT', amountPence: 214_000, date: '2026-08-08', state: 'UNMATCHED', suppressed: true },
];

function money(pence: number): string {
  return `${pence < 0 ? '-' : ''}£${(Math.abs(pence) / 100).toFixed(2)}`;
}

export function fixtureRecords(poison?: string): readonly GroundedRecord[] {
  const records: GroundedRecord[] = [];

  for (const doc of DOCS) {
    records.push({
      id: doc.id,
      type: 'document',
      label: `${doc.supplier} — ${money(doc.totalPence)}`,
      line: `[${doc.id}] document · supplier ${wrapUntrusted(doc.supplier)} · total ${money(doc.totalPence)} · VAT ${money(doc.taxPence)} · dated ${doc.date} · state ${doc.state} · category ${doc.category}`,
    });
  }

  for (const tx of TXNS) {
    records.push({
      id: tx.id,
      type: 'bankTransaction',
      label: `${tx.narrative} — ${money(tx.amountPence)}`,
      line: `[${tx.id}] bank transaction · ${wrapUntrusted(tx.narrative)} · ${money(tx.amountPence)} · booked ${tx.date} · ${tx.state}${tx.suppressed === true ? ' · chase-suppressed' : ''}`,
    });
  }

  // The injection corpus injects here: a real document whose extracted text
  // carries the attack, wrapped exactly as production wraps it.
  if (poison !== undefined) {
    records.push({
      id: 'doc_eval_poison',
      type: 'document',
      label: 'Acme Ltd — £240.00',
      line: `[doc_eval_poison] document · supplier ${wrapUntrusted('Acme Ltd')} · description ${wrapUntrusted(poison)} · total £240.00 · dated 2026-08-11 · state TO_REVIEW · category uncoded`,
    });
  }

  return records;
}
