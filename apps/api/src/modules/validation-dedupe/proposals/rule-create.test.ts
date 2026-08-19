import type { RuleCreatePayload } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { ruleCreateExecutor } from './rule-create.js';

/**
 * `rule.create` (METH S13, #142) — the recording-fake style of
 * `executors.test.ts`, in its own suite because this executor reads two models
 * the shared harness does not carry (`rule`, `actionProposal`). The assertions
 * are on the writes that reach the database: the row is stamped with the
 * proposal that activated it, born active, anchored to the PROPOSAL's business
 * — and a replay never writes a second row.
 */

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

const PAYLOAD: RuleCreatePayload = {
  tier: 'SUPPLIER_CUSTOMER',
  scopeKey: 'Bidfood',
  conditions: null,
  sets: { categoryCode: 'COST_OF_SALES_FOOD', vatTreatment: 'standard' },
};

interface RuleRow {
  id: string;
  actionProposalId: string | null;
  [key: string]: unknown;
}

function harness(opts: { proposalBusinessId?: string | null; existingRules?: RuleRow[]; businesses?: string[] } = {}) {
  const rules: RuleRow[] = [...(opts.existingRules ?? [])];
  const creates: Record<string, unknown>[] = [];
  const db = {
    rule: {
      findFirst: async ({ where }: { where: { actionProposalId: string } }) =>
        rules.find((r) => r.actionProposalId === where.actionProposalId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        const row = { id: `rul_${creates.length}`, ...data } as RuleRow;
        rules.push(row);
        return { id: row.id };
      },
    },
    actionProposal: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'prop_rule' ? { businessId: opts.proposalBusinessId ?? null } : null,
    },
    business: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        (opts.businesses ?? ['biz_1']).includes(where.id) ? { id: where.id } : null,
    },
  } as unknown as ScopedClient;
  return { db, creates, rules };
}

const input = (payload: RuleCreatePayload) => ({ proposalId: 'prop_rule', payload, ctx: CTX, traceId: 'trace-142' });

test('creates the rule active, anchored to the proposal business and stamped with the proposal', async () => {
  const { db, creates } = harness({ proposalBusinessId: 'biz_1' });
  const result = await ruleCreateExecutor.execute(db, input(PAYLOAD));

  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    businessId: 'biz_1',
    tier: 'SUPPLIER_CUSTOMER',
    scopeKey: 'Bidfood',
    sets: { categoryCode: 'COST_OF_SALES_FOOD', vatTreatment: 'standard' },
    isActive: true,
    createdVia: 'chat',
    createdByUserId: 'usr_1',
    actionProposalId: 'prop_rule',
  });
  // Null conditions stay absent rather than becoming a stored `null` blob.
  expect('conditions' in (creates[0] ?? {})).toBe(false);
  expect(result.changed).toEqual([{ entity: 'rule', id: 'rul_1' }]);
  expect(result.alreadyApplied).toBe(false);
});

test('a replay finds the stamped rule and writes nothing', async () => {
  const { db, creates } = harness({
    proposalBusinessId: 'biz_1',
    existingRules: [{ id: 'rul_prior', actionProposalId: 'prop_rule' }],
  });
  const result = await ruleCreateExecutor.execute(db, input(PAYLOAD));

  expect(creates).toHaveLength(0);
  expect(result.changed).toEqual([{ entity: 'rule', id: 'rul_prior' }]);
  expect(result.alreadyApplied).toBe(true);
});

test('a proposal without a business refuses — rules.business_id is required', async () => {
  const { db, creates } = harness({ proposalBusinessId: null });
  await expect(ruleCreateExecutor.execute(db, input(PAYLOAD))).rejects.toBeInstanceOf(ProposalExecutionRefused);
  expect(creates).toHaveLength(0);
});

test('an unreachable business refuses before any write', async () => {
  const { db, creates } = harness({ proposalBusinessId: 'biz_other', businesses: ['biz_1'] });
  await expect(ruleCreateExecutor.execute(db, input(PAYLOAD))).rejects.toBeInstanceOf(ProposalExecutionRefused);
  expect(creates).toHaveLength(0);
});

test('richer conditions are stored verbatim for the four-tier engine', async () => {
  const { db, creates } = harness({ proposalBusinessId: 'biz_1' });
  await ruleCreateExecutor.execute(db, input({ ...PAYLOAD, conditions: { totalPenceGreaterThan: 200_000 } }));
  expect(creates[0]?.['conditions']).toEqual({ totalPenceGreaterThan: 200_000 });
});
