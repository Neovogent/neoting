import type {
  ApprovalWorkflowBranch,
  ApprovalWorkflowDraftResult,
  ApprovalWorkflowStage,
  ApprovalWorkflowWriteRequest,
} from '@neoting/contracts/model';

import type { ModelWorkflowDraft } from './workflow-instructions.js';

/**
 * Model draft → the contract's `ApprovalWorkflowWriteRequest` (review item 52).
 *
 * A PURE function over the draft and the client's chart, so the whole of what
 * this task decides is testable offline. `bedrock-workflow.ts` is the wire.
 *
 * Four things happen here and none of them is the model's:
 *
 * 1. **A category name is checked against the chart, and refused if it is not
 *    on it.** `drafts.ts`'s rule, verbatim in its reasoning: *"Fuzzy-matching a
 *    chart of accounts is how a client's food costs quietly become drink
 *    costs, and the accountant approving it has no way to see that happened."*
 *    Not corrected, not nearest-matched — refused, with the available names in
 *    the reason so the person can pick.
 * 2. **Pounds become PENCE.** The model reads the accountant's own figure off
 *    their own sentence; money is integer pence everywhere it is stored.
 * 3. **The branch sentence is composed HERE.** `WorkflowEditor`'s `withLabel`
 *    established the rule for the hand-built composer: the words a person reads
 *    and the condition the engine tests come out of one object, so they cannot
 *    drift. The model has no `label` field to fill.
 * 4. **`specificity` is derived from the scope**, not asked for. It is a
 *    tie-break between workflows, not a fact about this description, and a
 *    model that could set it could make one client's policy outrank another's.
 */

const SCOPE_LABEL = {
  costs: 'All cost items',
  sales: 'All sales items',
  'expense-claims': 'All expense claims',
} as const;

/**
 * The wireframe's ladder: scope type → owners → suppliers → categories. A
 * category-scoped policy beats a blanket one when both could claim an item.
 */
const SCOPE_SPECIFICITY = { costs: 1, sales: 2, 'expense-claims': 2, categories: 3 } as const;

/** Not copy — a currency symbol inside a composed sentence. */
const POUND = '£';

export function composeWorkflowDraft(
  draft: ModelWorkflowDraft,
  businessId: string,
  chart: readonly { readonly name: string }[],
): ApprovalWorkflowDraftResult {
  const understood = [...draft.understood];
  const assumed = [...draft.assumed];

  const scope = resolveScope(draft, chart);
  if (!scope.ok) return { status: 'refused', reason: scope.reason, understood, assumed };

  const stages: ApprovalWorkflowStage[] = draft.stages.map((stage) => ({
    name: stage.name,
    approver: stage.approver,
    // A client-side approver never edits — they see the coding, not a form.
    // Enforced here rather than trusted from the answer, because the two
    // fields are independent in the schema and the rule is not.
    canEdit: stage.clientSide === true ? false : stage.canEdit,
    ...(stage.thresholdAboveGbp === undefined ? {} : { thresholdAbovePence: toPence(stage.thresholdAboveGbp) }),
    ...(stage.clientSide === undefined ? {} : { clientSide: stage.clientSide }),
  }));

  const branches: ApprovalWorkflowBranch[] = [];
  for (const branch of draft.branches) {
    if (branch.field === 'category') {
      const matched = matchCategory(branch.categoryName ?? '', chart);
      if (matched === null) {
        // A branch is dropped rather than the whole draft refused: the scope is
        // what the policy IS, and a condition that could not be resolved is one
        // line the accountant can re-add. Said out loud, never silently.
        assumed.push(
          `Left out the "${branch.categoryName ?? ''}" condition — that category is not on this client's chart of accounts`,
        );
        continue;
      }
      branches.push({
        field: 'category',
        value: matched,
        addApprover: branch.addApprover,
        label: `Category ${matched} adds ${branch.addApprover}`,
      });
      continue;
    }
    if (branch.field === 'amount') {
      // `superRefine` requires the figure for this field, so reaching here
      // without one is impossible; the guard is what makes that true in types.
      if (branch.thresholdAboveGbp === undefined) continue;
      const pence = toPence(branch.thresholdAboveGbp);
      branches.push({
        field: 'amount',
        thresholdAbovePence: pence,
        addApprover: branch.addApprover,
        label: `Amount over ${POUND}${(pence / 100).toLocaleString('en-GB')} adds ${branch.addApprover}`,
      });
      continue;
    }
    branches.push({
      field: 'supplierAge',
      value: 'new',
      addApprover: branch.addApprover,
      label: `A brand-new supplier adds ${branch.addApprover}`,
    });
  }

  const workflow: ApprovalWorkflowWriteRequest = {
    businessId,
    name: draft.name,
    appliesTo: scope.appliesTo,
    specificity: SCOPE_SPECIFICITY[draft.scope.kind],
    stages,
    branches,
    selfApproval: draft.selfApproval,
  };

  return { status: 'drafted', workflow, understood, assumed };
}

type ScopeResult = { ok: true; appliesTo: string } | { ok: false; reason: string };

/**
 * The scope sentence, with every category name checked against the client's own
 * chart. This is the refusal rule; everything else here is arithmetic.
 */
function resolveScope(draft: ModelWorkflowDraft, chart: readonly { readonly name: string }[]): ScopeResult {
  if (draft.scope.kind !== 'categories') return { ok: true, appliesTo: SCOPE_LABEL[draft.scope.kind] };

  if (chart.length === 0) {
    return {
      ok: false,
      reason: 'This client has no synced chart of accounts yet, so a policy scoped to categories has nothing to match on.',
    };
  }

  const names: string[] = [];
  for (const wanted of draft.scope.categoryNames ?? []) {
    const matched = matchCategory(wanted, chart);
    if (matched === null) {
      const known = chart.map((category) => category.name).join(', ');
      return {
        ok: false,
        reason: `I could not match "${wanted}" on this client's chart of accounts, and I will not guess at the nearest one. The available categories are: ${known}.`,
      };
    }
    names.push(matched);
  }
  if (names.length === 0) {
    return { ok: false, reason: 'That described a category policy without naming a category.' };
  }
  return { ok: true, appliesTo: `Category: ${names.join(', ')}` };
}

/**
 * A category name, or null.
 *
 * ⚠ **Case-insensitive and trimmed, and NOTHING else.** That is not
 * fuzzy-matching: casing and stray whitespace are transcription, not meaning,
 * and the stored value is always the chart's own spelling. Anything looser —
 * a prefix, an edit distance, a synonym — is the failure this whole function
 * exists to prevent.
 */
function matchCategory(wanted: string, chart: readonly { readonly name: string }[]): string | null {
  const needle = wanted.trim().toLowerCase();
  if (needle === '') return null;
  return chart.find((category) => category.name.trim().toLowerCase() === needle)?.name ?? null;
}

/** Pounds off a sentence → integer pence. Rounded, because `12.345` is not money. */
function toPence(gbp: number): number {
  return Math.round(gbp * 100);
}
