import { describe, expect, test } from 'vitest';

import { costPence, DEGRADE_CHAIN, MODELS, modelVersionOf, TASK_BUDGETS, TASKS } from './models.js';

describe('the pinned model config (Governance §9.1)', () => {
  test('no cross-region inference profile can be pinned — D30 residency', () => {
    // The IAM policy grants foundation-model ARNs only, so an `eu.`/`global.`
    // id here would fail closed at call time rather than process UK client
    // documents abroad. This asserts the intent at the config layer too, so the
    // mistake is caught in review rather than in a CloudWatch AccessDenied.
    for (const id of Object.values(MODELS)) {
      expect(id.startsWith('eu.')).toBe(false);
      expect(id.startsWith('global.')).toBe(false);
    }
  });

  test('chat runs on the judgment tier, always — no split-personality chat', () => {
    expect(TASKS.chatWorkspace.model).toBe('judgment');
  });

  test('chat may not degrade to a tier whose evals it has not passed (§9.3)', () => {
    // `evals/` covers the judgment tier only. Until a lower tier passes, the
    // chain is empty and §9.3's floor applies: an honest error, never a guess
    // from an unmeasured model. This test is what makes growing the chain a
    // deliberate act rather than a passing thought.
    expect(DEGRADE_CHAIN.chatWorkspace).toEqual([]);
  });

  test('every task has a budget — an unbudgeted call is an unbounded one', () => {
    for (const task of Object.keys(TASKS) as (keyof typeof TASKS)[]) {
      expect(TASK_BUDGETS[task].maxTokens).toBeGreaterThan(0);
      expect(TASK_BUDGETS[task].timeoutMs).toBeGreaterThan(0);
    }
  });

  test('modelVersion carries the config revision, not just the model id', () => {
    // §9.8 reproducibility: the parameters around a model move independently of
    // the model, so the id alone cannot identify what produced an answer.
    expect(modelVersionOf('judgment')).toMatch(/^anthropic\.claude-opus-4-6-v1@\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});

describe('cost, in integer pence (R5)', () => {
  test('rounds up, so a budget never under-counts', () => {
    expect(costPence('judgment', 1, 1)).toBe(1);
    expect(Number.isInteger(costPence('judgment', 123_456, 7_890))).toBe(true);
  });

  test('a free call costs nothing', () => {
    expect(costPence('judgment', 0, 0)).toBe(0);
  });

  test('the mechanical tier really is the cheap one', () => {
    expect(costPence('mechanical', 1_000_000, 1_000_000)).toBeLessThan(costPence('judgment', 1_000_000, 1_000_000));
  });
});
