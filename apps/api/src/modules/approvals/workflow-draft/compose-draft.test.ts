import { expect, test } from 'vitest';

import { composeWorkflowDraft } from './compose-draft.js';
import { parseModelWorkflowDraft, WORKFLOW_TOOL_SCHEMA, WorkflowDraftSchema } from './workflow-instructions.js';
import type { ModelWorkflowDraft } from './workflow-instructions.js';

/**
 * The pure half of "Describe it instead" (review item 52). What these pin, in
 * order of what it would cost to lose:
 *
 * 1. **A category not on the client's chart is REFUSED, never nearest-matched.**
 *    `drafts.ts`'s rule: fuzzy-matching a chart of accounts is how a client's
 *    food costs quietly become drink costs, and the accountant approving it has
 *    no way to see that happened.
 * 2. **Pounds become integer pence.** The model reads the accountant's own
 *    figure off their own sentence; money is integer pence where it is stored.
 * 3. **The branch label is COMPOSED, not the model's.** There is no `label`
 *    field in the tool schema, so the sentence and the condition cannot drift.
 */

const CHART = [
  { name: 'Cost of sales: Food and drink' },
  { name: 'Computer equipment' },
  { name: 'Cost of sales: Drink' },
];

const DRAFT: ModelWorkflowDraft = {
  name: 'Purchases over £500',
  scope: { kind: 'costs' },
  stages: [
    { name: 'Manager review', approver: 'Manager', thresholdAboveGbp: 500, canEdit: true },
    { name: 'Director sign-off', approver: 'Finance Director', thresholdAboveGbp: 2000, canEdit: false },
  ],
  branches: [],
  selfApproval: false,
  understood: ['Thresholds at £500 and £2,000'],
  assumed: ['Assumed it applies to all cost items'],
};

test('pounds off the sentence become integer pence', () => {
  const result = composeWorkflowDraft(DRAFT, 'biz_1', CHART);
  expect(result.status).toBe('drafted');
  expect(result.workflow?.stages[0]?.thresholdAbovePence).toBe(50_000);
  expect(result.workflow?.stages[1]?.thresholdAbovePence).toBe(200_000);
  // 12.345 is not money. Rounded, never floored into a fractional penny.
  const odd = composeWorkflowDraft(
    { ...DRAFT, stages: [{ name: 'x', approver: 'y', thresholdAboveGbp: 12.345, canEdit: true }] },
    'biz_1',
    CHART,
  );
  expect(odd.workflow?.stages[0]?.thresholdAbovePence).toBe(1235);
  expect(Number.isInteger(odd.workflow?.stages[0]?.thresholdAbovePence)).toBe(true);
});

test('⚠ a category NOT on the chart is refused, and the reason names what IS available', () => {
  const result = composeWorkflowDraft(
    { ...DRAFT, scope: { kind: 'categories', categoryNames: ['Cost of sales: Foood'] } },
    'biz_1',
    CHART,
  );
  expect(result.status).toBe('refused');
  expect(result.workflow).toBeUndefined();
  expect(result.reason).toContain('Cost of sales: Foood');
  expect(result.reason).toContain('Cost of sales: Food and drink');
});

test('⚠ a NEAR-MISS is refused too — "Food" does not become "Food and drink"', () => {
  // The mistake this whole function exists to prevent: a prefix, an edit
  // distance or a synonym silently recoding a client's books.
  const result = composeWorkflowDraft(
    { ...DRAFT, scope: { kind: 'categories', categoryNames: ['Cost of sales: Food'] } },
    'biz_1',
    CHART,
  );
  expect(result.status).toBe('refused');
});

test('casing and stray whitespace are transcription, not meaning — and the CHART spelling is stored', () => {
  const result = composeWorkflowDraft(
    { ...DRAFT, scope: { kind: 'categories', categoryNames: ['  computer EQUIPMENT '] } },
    'biz_1',
    CHART,
  );
  expect(result.status).toBe('drafted');
  expect(result.workflow?.appliesTo).toBe('Category: Computer equipment');
});

test('a client with no chart cannot get a category-scoped policy', () => {
  const result = composeWorkflowDraft(
    { ...DRAFT, scope: { kind: 'categories', categoryNames: ['Computer equipment'] } },
    'biz_1',
    [],
  );
  expect(result.status).toBe('refused');
  expect(result.reason).toContain('no synced chart of accounts');
});

test('branch labels are COMPOSED — the model has no label field to disagree with', () => {
  const result = composeWorkflowDraft(
    {
      ...DRAFT,
      branches: [
        { field: 'amount', thresholdAboveGbp: 5000, addApprover: 'Partner' },
        { field: 'supplierAge', addApprover: 'Compliance' },
        { field: 'category', categoryName: 'Computer equipment', addApprover: 'Finance Director' },
      ],
    },
    'biz_1',
    CHART,
  );
  expect(result.workflow?.branches.map((b) => b.label)).toEqual([
    'Amount over £5,000 adds Partner',
    'A brand-new supplier adds Compliance',
    'Category Computer equipment adds Finance Director',
  ]);
  expect(result.workflow?.branches[0]?.thresholdAbovePence).toBe(500_000);
  expect(result.workflow?.branches[1]?.value).toBe('new');
  expect(WORKFLOW_TOOL_SCHEMA.properties.branches.items.properties).not.toHaveProperty('label');
});

test('a branch naming an unknown category is DROPPED and said out loud, not silently', () => {
  const result = composeWorkflowDraft(
    { ...DRAFT, branches: [{ field: 'category', categoryName: 'Marketing', addApprover: 'Partner' }] },
    'biz_1',
    CHART,
  );
  // The scope is what the policy IS; one condition that could not be resolved
  // is a line the accountant can re-add, so the draft survives — but never
  // quietly.
  expect(result.status).toBe('drafted');
  expect(result.workflow?.branches).toEqual([]);
  expect(result.assumed?.join(' ')).toContain('Marketing');
});

test('a client-side approver never edits, whatever the model said', () => {
  const result = composeWorkflowDraft(
    { ...DRAFT, stages: [{ name: 'Client sign-off', approver: 'Owner', canEdit: true, clientSide: true }] },
    'biz_1',
    CHART,
  );
  expect(result.workflow?.stages[0]?.canEdit).toBe(false);
});

test('specificity is DERIVED from the scope — a category policy outranks a blanket one', () => {
  const blanket = composeWorkflowDraft(DRAFT, 'biz_1', CHART);
  const category = composeWorkflowDraft(
    { ...DRAFT, scope: { kind: 'categories', categoryNames: ['Computer equipment'] } },
    'biz_1',
    CHART,
  );
  expect(category.workflow?.specificity).toBeGreaterThan(blanket.workflow?.specificity ?? 0);
  // And it is not a field the model could set.
  expect(WORKFLOW_TOOL_SCHEMA.properties).not.toHaveProperty('specificity');
});

test('⚠ the schema is strict: an unexpected key is a failed parse, not a dropped field', () => {
  expect(parseModelWorkflowDraft({ ...DRAFT, isActive: true })).toBeNull();
  expect(parseModelWorkflowDraft({ ...DRAFT, stages: [] })).toBeNull();
  // Intent and payload must agree, the ModelTurn discipline.
  expect(parseModelWorkflowDraft({ ...DRAFT, scope: { kind: 'categories' } })).toBeNull();
  expect(parseModelWorkflowDraft({ ...DRAFT, scope: { kind: 'costs', categoryNames: ['x'] } })).toBeNull();
  expect(
    parseModelWorkflowDraft({ ...DRAFT, branches: [{ field: 'amount', addApprover: 'Partner' }] }),
  ).toBeNull();
  expect(parseModelWorkflowDraft(DRAFT)).not.toBeNull();
});

test('the JSON Schema and the Zod agree about the required keys', () => {
  // Hand-written and adjacent rather than generated (the output-schema.ts
  // argument); this is the pin that keeps the two from drifting.
  const shape = Object.keys((WorkflowDraftSchema._def.schema as { shape: Record<string, unknown> }).shape).sort();
  expect(Object.keys(WORKFLOW_TOOL_SCHEMA.properties).sort()).toEqual(shape);
  expect([...WORKFLOW_TOOL_SCHEMA.required].sort()).toEqual(shape);
});

test('⚠ there is no field a model could arm a workflow with', () => {
  // The safety property, asserted rather than asserted about. `isActive`,
  // `businessId` and `id` are all absent from what the model may say.
  const keys = Object.keys(WORKFLOW_TOOL_SCHEMA.properties);
  expect(keys).not.toContain('isActive');
  expect(keys).not.toContain('businessId');
  expect(keys).not.toContain('id');
});
