import { describe, expect, test } from 'vitest';

import { buildApprovals, expenseClaimDocumentIds, workflowFor } from './generate';
import { parseWorkflow } from './workflowParser';
import type { ApprovalWorkflow, Document, ExpenseClaim } from './types';

/**
 * Which workflow claims a document.
 *
 * The bug these pin: `workflowFor` recognised three scopes and swept every
 * other one into `return doc.kind === 'cost'`. `workflowParser` mints a
 * fourth — `All expense claims` — so an approval policy an accountant scoped
 * to employee expenses paused the client's whole purchase ledger, silently,
 * and the free-text `appliesTo` field in the workflow editor did the same for
 * any typo. The matcher is now a closed set whose default is "claims
 * nothing", which under-matches rather than over-matching.
 */

const WORKFLOW: ApprovalWorkflow = {
  id: 'wf-test',
  name: 'Test workflow',
  appliesTo: 'All cost items',
  clientIds: ['1'],
  specificity: 1,
  stages: [{ name: 'Manager review', approver: 'Manager', canEdit: true }],
  branches: [],
  selfApproval: false,
  autoPublishOnApproval: false,
  active: true,
};

const DOC: Document = {
  id: 'doc-1',
  clientId: '1',
  clientName: 'American Burger Ltd',
  supplier: 'Bidfood',
  date: '06 Aug 2026',
  total: 480,
  category: 'Cost of Sales Food',
  status: 'ready',
  source: 'email',
  uploader: 'accounts@bidfood.co.uk',
  currency: 'GBP',
  kind: 'cost',
  fields: [],
  lineItems: [],
};

const scoped = (appliesTo: string, over: Partial<ApprovalWorkflow> = {}): ApprovalWorkflow => ({
  ...WORKFLOW,
  appliesTo,
  ...over,
});

const doc = (over: Partial<Document> = {}): Document => ({ ...DOC, ...over });

const CLAIM: ExpenseClaim = {
  id: 'exp-1',
  clientId: '1',
  clientName: 'American Burger Ltd',
  claimant: 'Tom Whyte',
  period: 'August 2026',
  status: 'internally-approved',
  items: [
    { id: 'exp-1-a', description: 'Taxi', date: '06 Aug 2026', total: 28.4, category: 'Travel', documentId: 'claim-doc' },
    // Unevidenced: no document, so it contributes no id.
    { id: 'exp-1-b', description: 'Trade show entry', date: '08 Aug 2026', total: 145, category: 'Marketing' },
  ],
};

describe('the expense-claim scope', () => {
  test('⚠ an expense-claim workflow does NOT claim an ordinary cost document', () => {
    // The regression. Before the fix this fell through to `doc.kind === 'cost'`
    // and every purchase invoice the client had was held at an approval stage
    // meant for employee expenses.
    expect(workflowFor(doc(), [scoped('All expense claims')], expenseClaimDocumentIds([CLAIM]))).toBeUndefined();
  });

  test('it claims a document that is a line on a claim', () => {
    const claimed = doc({ id: 'claim-doc', supplier: 'Uber', category: 'Travel', total: 28.4 });
    expect(workflowFor(claimed, [scoped('All expense claims')], expenseClaimDocumentIds([CLAIM]))?.id).toBe('wf-test');
  });

  test('with no claims supplied it claims nothing rather than everything', () => {
    // The safe direction for a caller that has not passed the claims: a
    // workflow nobody notices beats one that pauses a ledger.
    expect(workflowFor(doc({ id: 'claim-doc' }), [scoped('All expense claims')])).toBeUndefined();
  });

  test('a claim line with no receipt contributes no document id', () => {
    expect([...expenseClaimDocumentIds([CLAIM])]).toEqual(['claim-doc']);
  });
});

describe('the other scopes still match exactly what they did', () => {
  test('"All cost items" claims a cost document and not a sales one', () => {
    expect(workflowFor(doc(), [scoped('All cost items')])?.id).toBe('wf-test');
    expect(workflowFor(doc({ kind: 'sales' }), [scoped('All cost items')])).toBeUndefined();
  });

  test('"All sales items" claims a sales document and not a cost one', () => {
    expect(workflowFor(doc({ kind: 'sales' }), [scoped('All sales items')])?.id).toBe('wf-test');
    expect(workflowFor(doc(), [scoped('All sales items')])).toBeUndefined();
  });

  test('a category scope matches on the document category', () => {
    const w = scoped('Category: Cost of Sales Food, Travel', { specificity: 3 });
    expect(workflowFor(doc(), [w])?.id).toBe('wf-test');
    expect(workflowFor(doc({ category: 'Software' }), [w])).toBeUndefined();
  });

  test('a supplier scope matches on the supplier name', () => {
    const w = scoped('Supplier: Bidfood, Brakes', { specificity: 2 });
    expect(workflowFor(doc(), [w])?.id).toBe('wf-test');
    expect(workflowFor(doc({ supplier: 'Currys' }), [w])).toBeUndefined();
  });

  test('the most specific workflow still wins where several apply', () => {
    const blanket = scoped('All cost items', { id: 'wf-blanket', specificity: 1 });
    const category = scoped('Category: Cost of Sales Food', { id: 'wf-category', specificity: 3 });
    expect(workflowFor(doc(), [blanket, category])?.id).toBe('wf-category');
  });

  test('inactive workflows and other clients are still skipped', () => {
    expect(workflowFor(doc(), [scoped('All cost items', { active: false })])).toBeUndefined();
    expect(workflowFor(doc(), [scoped('All cost items', { clientIds: ['2'] })])).toBeUndefined();
  });
});

describe('an unrecognised scope', () => {
  test('claims nothing instead of falling through to every cost document', () => {
    // `appliesTo` is a free-text field in the workflow editor, so this is what
    // a mistyped scope produces.
    expect(workflowFor(doc(), [scoped('All costs')])).toBeUndefined();
    expect(workflowFor(doc(), [scoped('')])).toBeUndefined();
  });
});

describe('every scope the parser can mint is one the matcher recognises', () => {
  /**
   * The two files have to agree about the vocabulary, and this is the only
   * thing that makes them agree: a fifth scope added to `workflowParser` fails
   * here until `workflowFor` learns it, rather than quietly matching nothing.
   * Each case brings the one document its own scope is supposed to claim —
   * `parseWorkflow` returns the base workflow's id, clientIds and `active`
   * unchanged, so the parsed result is directly matchable.
   */
  test.each([
    ['Anything over £500 needs a manager.', 'All cost items', doc()],
    ['All sales items just need a manager review.', 'All sales items', doc({ kind: 'sales' })],
    ['Expense claims need a manager.', 'All expense claims', doc({ id: 'claim-doc' })],
    ['Computer Equipment goes to the Finance Director.', 'Category: Computer Equipment', doc({ category: 'Computer Equipment' })],
  ])('%s', (text, expected, probe) => {
    const { workflow } = parseWorkflow(text, WORKFLOW);
    expect(workflow.appliesTo).toBe(expected);
    expect(workflowFor(probe, [workflow], expenseClaimDocumentIds([CLAIM]))?.id).toBe('wf-test');
  });
});

describe('buildApprovals', () => {
  // Only documents over the £150 floor and in a reviewable state reach the
  // queue at all, so the fixtures below clear both.
  const bigCost = doc({ id: 'big-cost', total: 480, status: 'ready' });
  const bigClaimDoc = doc({ id: 'claim-doc', total: 320, status: 'ready', supplier: 'Uber', category: 'Travel' });
  const claim: ExpenseClaim = { ...CLAIM, items: [{ ...CLAIM.items[0]!, total: 320 }] };

  test('an expense-claim workflow queues the claim receipt and nothing else', () => {
    const queue = buildApprovals([bigCost, bigClaimDoc], [scoped('All expense claims')], [claim]);
    expect(queue.map((i) => i.documentId)).toEqual(['claim-doc']);
  });

  test('without the claims it queues nothing, rather than every cost document', () => {
    expect(buildApprovals([bigCost, bigClaimDoc], [scoped('All expense claims')])).toEqual([]);
  });

  test('a cost workflow is unaffected by the claims argument', () => {
    const queue = buildApprovals([bigCost, bigClaimDoc], [scoped('All cost items')], [claim]);
    expect(queue.map((i) => i.documentId).sort()).toEqual(['big-cost', 'claim-doc']);
  });
});
