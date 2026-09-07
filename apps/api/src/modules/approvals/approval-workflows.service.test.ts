import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

// ⚠ `createApprovalWorkflowResponse` does NOT exist: orval emits a Response
// schema for a 200 and not for a 201. `replaceApprovalWorkflowResponse` is the
// same `ApprovalWorkflow`, so the create is checked against it.
import { listApprovalWorkflowsResponse, listRulesResponse, replaceApprovalWorkflowResponse } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { ApprovalWorkflowsService } from './approval-workflows.service.js';

/**
 * Workflows (review package H), through a recording fake Prisma. What these
 * pin, in order of what it would cost to lose:
 *
 * 1. **Neither write path can arm a workflow.** `isActive` is the whole
 *    Governance §10 argument for this service existing in the shape it does,
 *    and the test asserts the `data` that REACHES the database rather than the
 *    response — a service that armed a row and mapped it back as inactive
 *    would pass any assertion made on the return value.
 * 2. **Deleting an active workflow is refused.** Disarm-by-DELETE would be the
 *    way round `policy.activate` entirely: no review, no audit line naming the
 *    gate that went away.
 * 3. **The seed's OLD stage shape is dropped, not thrown on.** This table's one
 *    historical writer used `{index, approvers[], condition}`, so a real
 *    database can hold rows this contract does not describe.
 */

const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const NOW = new Date('2026-09-07T09:00:00.000Z');

function workflowRow(over: Record<string, unknown> = {}) {
  return {
    id: 'wfl_1',
    businessId: 'biz_1',
    name: 'Purchases over £2,000',
    stages: [
      { name: 'Manager review', approver: 'Manager', canEdit: true },
      { name: 'Director sign-off', approver: 'Finance Director', thresholdAbovePence: 200000, canEdit: false },
    ],
    branches: [{ field: 'amount', thresholdAbovePence: 500000, addApprover: 'Partner', label: 'Over £5,000 adds the Partner' }],
    appliesTo: 'All cost items',
    specificity: 1,
    selfApproval: false,
    isActive: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const RULE_ROW = {
  id: 'rul_1',
  businessId: 'biz_1',
  tier: 'SUPPLIER_CUSTOMER' as const,
  scopeKey: 'Bidfood',
  conditions: null,
  sets: { categoryCode: 'COS_FOOD_AND_DRINK' },
  isActive: true,
  createdVia: 'chat',
  createdByUserId: 'usr_1',
  actionProposalId: 'prp_1',
  createdAt: NOW,
  updatedAt: NOW,
};

interface Calls {
  findMany: { where?: unknown; orderBy?: unknown }[];
  create: { data?: Record<string, unknown> }[];
  updateMany: { where?: unknown; data?: Record<string, unknown> }[];
  deleteMany: { where?: unknown }[];
  ruleFindMany: { where?: unknown; orderBy?: unknown }[];
}

function fixture(options: { rows?: ReturnType<typeof workflowRow>[]; businessVisible?: boolean } = {}) {
  const rows = options.rows ?? [workflowRow()];
  const calls: Calls = { findMany: [], create: [], updateMany: [], deleteMany: [], ruleFindMany: [] };
  const tx = {
    $executeRaw: async () => 0,
    approvalWorkflow: {
      findMany: async (args: Calls['findMany'][number]) => {
        calls.findMany.push(args);
        return rows;
      },
      findUnique: async () => rows[0] ?? null,
      create: async (args: Calls['create'][number]) => {
        calls.create.push(args);
        return workflowRow(args.data ?? {});
      },
      updateMany: async (args: Calls['updateMany'][number]) => {
        calls.updateMany.push(args);
        return { count: rows.length };
      },
      deleteMany: async (args: Calls['deleteMany'][number]) => {
        calls.deleteMany.push(args);
        return { count: rows.length };
      },
    },
    rule: {
      findMany: async (args: Calls['ruleFindMany'][number]) => {
        calls.ruleFindMany.push(args);
        return [RULE_ROW];
      },
    },
    business: {
      findUnique: async () => (options.businessVisible === false ? null : { id: 'biz_1' }),
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  return { calls, service: new ApprovalWorkflowsService(prisma, new InMemoryIdempotencyStore()) };
}

const NEW_WORKFLOW = {
  businessId: 'biz_1',
  name: 'Purchases over £2,000',
  appliesTo: 'All cost items',
  specificity: 1,
  selfApproval: false,
  stages: [{ name: 'Manager review', approver: 'Manager', canEdit: true }],
  branches: [],
};

test('the list parses as the contract and sorts by newest activity', async () => {
  const { calls, service } = fixture();
  const page = await service.list(CTX, { limit: 50 });

  expect(calls.findMany[0]?.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
  expect(listApprovalWorkflowsResponse.safeParse(page).success).toBe(true);
  expect(page.data[0]).toMatchObject({ id: 'wfl_1', isActive: false });
  expect(page.data[0]?.stages).toHaveLength(2);
  expect(page.data[0]?.branches[0]?.thresholdAbovePence).toBe(500000);
});

test('businessId narrows the list; omitting it spans every workspace RLS allows', async () => {
  const { calls, service } = fixture();
  await service.list(CTX, { limit: 50, businessId: 'biz_1' });
  await service.list(CTX, { limit: 50 });

  expect(JSON.stringify(calls.findMany[0]?.where)).toContain('"businessId":"biz_1"');
  expect(calls.findMany[1]?.where).toEqual({});
});

test('⚠ create writes isActive FALSE and carries no field that could set it otherwise', async () => {
  const { calls, service } = fixture();
  const created = await service.create(CTX, NEW_WORKFLOW, 'key-create');

  // The DATA that reaches the database, not the mapped response: a service
  // that armed the row and mapped it back inactive would pass on the latter.
  expect(calls.create[0]?.data?.['isActive']).toBe(false);
  expect(replaceApprovalWorkflowResponse.safeParse(created).success).toBe(true);
  expect(created.isActive).toBe(false);
});

test('⚠ replace never touches isActive or businessId', async () => {
  const { calls, service } = fixture();
  const { businessId: _businessId, ...edit } = NEW_WORKFLOW;
  await service.replace(CTX, 'wfl_1', { ...edit, name: 'Renamed' }, 'key-replace');

  const data = calls.updateMany[0]?.data ?? {};
  expect(Object.keys(data).sort()).toEqual(['appliesTo', 'branches', 'name', 'selfApproval', 'specificity', 'stages']);
  expect(data).not.toHaveProperty('isActive');
  expect(data).not.toHaveProperty('businessId');
});

test('create against a business the caller cannot reach is a 404 that never echoes the id', async () => {
  const { service } = fixture({ businessVisible: false });
  const refusal = await service.create(CTX, { ...NEW_WORKFLOW, businessId: 'biz_other' }, 'key-x').then(
    () => null,
    (error: AppException) => error,
  );
  expect(refusal?.getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect(JSON.stringify(refusal?.getResponse())).not.toContain('biz_other');
});

test('⚠ deleting an ACTIVE workflow is refused — disarm-by-DELETE would bypass policy.activate', async () => {
  const { calls, service } = fixture({ rows: [workflowRow({ isActive: true })] });
  const refusal = await service.delete(CTX, 'wfl_1', 'key-del').then(
    () => null,
    (error: AppException) => error,
  );
  expect(refusal?.getStatus()).toBe(HttpStatus.CONFLICT);
  expect(refusal?.code).toBe('NT-WFL-001');
  expect(calls.deleteMany).toHaveLength(0);
});

test('deleting an inactive workflow deletes it; deleting a missing one is a silent success', async () => {
  const active = fixture();
  await active.service.delete(CTX, 'wfl_1', 'key-del-1');
  expect(active.calls.deleteMany).toHaveLength(1);

  const gone = fixture({ rows: [] });
  await expect(gone.service.delete(CTX, 'wfl_9', 'key-del-2')).resolves.toBeUndefined();
  expect(gone.calls.deleteMany).toHaveLength(0);
});

test("the seed's OLD stage shape is dropped rather than felling the tab", async () => {
  const { service } = fixture({
    rows: [
      workflowRow({
        // What `prisma/seed.ts` wrote into this column for a year, before any
        // surface read it.
        stages: [
          { index: 0, name: 'Preparer review', approvers: ['usr_tom'], condition: { always: true }, canEdit: true },
          { name: 'Director sign-off', approver: 'Finance Director', canEdit: false },
        ],
        appliesTo: { itemType: 'costs' },
        branches: null,
      }),
    ],
  });
  const page = await service.list(CTX, { limit: 50 });

  expect(page.data[0]?.stages).toEqual([{ name: 'Director sign-off', approver: 'Finance Director', canEdit: false }]);
  expect(page.data[0]?.branches).toEqual([]);
  // A non-string scope claims nothing rather than being coerced into one.
  expect(page.data[0]?.appliesTo).toBe('');
  expect(listApprovalWorkflowsResponse.safeParse(page).success).toBe(true);
});

test('the rules read is newest-first and parses as the contract', async () => {
  const { calls, service } = fixture();
  const page = await service.listRules(CTX, { limit: 50, businessId: 'biz_1' });

  expect(calls.ruleFindMany[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  expect(listRulesResponse.safeParse(page).success).toBe(true);
  expect(page.data[0]).toMatchObject({ id: 'rul_1', scopeKey: 'Bidfood', actionProposalId: 'prp_1' });
});
