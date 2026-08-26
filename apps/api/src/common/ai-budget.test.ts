import { describe, expect, test } from 'vitest';

import { budgetKey, InMemoryAiBudget } from './ai-budget.js';

const AT = () => new Date('2026-08-21T14:00:00.000Z');

describe('the per-firm daily AI budget (Governance §9.7)', () => {
  test('the key is §9.7 verbatim, and the day is UTC', () => {
    // A budget day that moved with BST would give British Summer Time one
    // 23-hour day and one 25-hour day per year, on a ceiling nobody would
    // think to check on those dates.
    expect(budgetKey('prac_1', new Date('2026-08-21T23:59:59.000Z'))).toBe('nt:prac_1:_:ai:budget:2026-08-21');
    expect(budgetKey('prac_1', new Date('2026-08-22T00:00:01.000Z'))).toBe('nt:prac_1:_:ai:budget:2026-08-22');
  });

  test('warns at 80% and stops at 100%', async () => {
    const budget = new InMemoryAiBudget(500, AT);

    expect((await budget.check('prac_1')).warning).toBe(false);

    await budget.record('prac_1', 399);
    let verdict = await budget.check('prac_1');
    expect(verdict.warning).toBe(false);
    expect(verdict.allowed).toBe(true);

    await budget.record('prac_1', 1); // 400 = exactly 80%
    verdict = await budget.check('prac_1');
    expect(verdict.warning).toBe(true);
    expect(verdict.allowed).toBe(true);
    expect(verdict.remainingPence).toBe(100);

    await budget.record('prac_1', 100); // 500 = the ceiling
    verdict = await budget.check('prac_1');
    expect(verdict.allowed).toBe(false);
    expect(verdict.remainingPence).toBe(0);
  });

  test('one practice cannot spend another practice out of its allowance', async () => {
    const budget = new InMemoryAiBudget(500, AT);
    await budget.record('prac_1', 500);

    expect((await budget.check('prac_1')).allowed).toBe(false);
    expect((await budget.check('prac_2')).allowed).toBe(true);
  });

  test('the ledger rolls over at midnight UTC', async () => {
    let today = new Date('2026-08-21T23:00:00.000Z');
    const budget = new InMemoryAiBudget(500, () => today);

    await budget.record('prac_1', 500);
    expect((await budget.check('prac_1')).allowed).toBe(false);

    today = new Date('2026-08-22T00:30:00.000Z');
    expect((await budget.check('prac_1')).allowed).toBe(true);
  });

  test('a zero or negative charge is not recorded', async () => {
    const budget = new InMemoryAiBudget(500, AT);
    await budget.record('prac_1', 0);
    await budget.record('prac_1', -100);
    expect((await budget.check('prac_1')).spentPence).toBe(0);
  });
});
