import { HttpStatus } from '@nestjs/common';
import type { ApprovalWorkflow as WorkflowRow, Prisma, Rule as RuleRow } from '@prisma/client';
import { z } from 'zod';

import type { ApprovalWorkflow, ApprovalWorkflowBranch, ApprovalWorkflowStage, Rule } from '@neoting/contracts/model';
import type {
  createApprovalWorkflowBody,
  listApprovalWorkflowsQueryParams,
  replaceApprovalWorkflowBody,
} from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';

type ListQuery = z.infer<typeof listApprovalWorkflowsQueryParams>;
type CreateBody = z.infer<typeof createApprovalWorkflowBody>;
type EditBody = z.infer<typeof replaceApprovalWorkflowBody>;

/**
 * Approval workflows — the surface `approval_workflows` never had.
 *
 * The table has existed since the init migration. Nothing in `apps/api` ever
 * touched it and no operation in the contract named it, so the Workflows tab
 * composed, saved, toggled and deleted policies entirely in React state: it
 * looked like a feature and persisted nothing. Review items 51, 52 and 53 all
 * sat on top of that hole, which is why this landed first — an AI that parses a
 * description into a form whose Save evaporates on reload is polish on a mock.
 *
 * ## The one rule that shapes every method here
 *
 * **A workflow written through this service is INERT.** `isActive` is not a
 * field on either write body and this class never sets it; only the
 * `policy.activate` executor does, on the far side of Review → Approve.
 *
 * That split is Governance §10 read literally rather than a ceremony. Composing
 * a policy is an accountant's ordinary work (D44's compose-and-edit half) and
 * costs nobody anything while it sits unarmed. Arming it is a state change on
 * the approval spine itself: from that moment other people's items stop and
 * wait for a signature, and disarming it silently removes a control a client
 * may be relying on. Both directions are the same kind, because both change
 * what the spine does.
 *
 * ## Tenancy
 *
 * `approval_workflows` and `rules` both carry `business_id` directly and both
 * are on rls.sql's `direct_tables` loop, so `app_can_access_business` bounds
 * every row. Every query here runs inside `scopedDb` and none of them adds an
 * application filter on top: unlike a chat conversation, a workflow is a
 * practice-wide record — a colleague's policy on a shared client is *meant* to
 * be visible, and it is the thing they would otherwise have to be told about.
 */
export class ApprovalWorkflowsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async list(ctx: ScopeContext, query: ListQuery): Promise<Page<ApprovalWorkflow>> {
    const filters: Prisma.ApprovalWorkflowWhereInput =
      query.businessId === undefined ? {} : { businessId: query.businessId };
    const request: PageRequest<WorkflowRow> = {
      sort: WORKFLOW_UPDATED_AT,
      order: 'desc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      query: { businessId: query.businessId ?? null, limit: query.limit, cursor: undefined },
    };
    const seek = pageQuery(request);

    const rows = await scopedDb(this.prisma, ctx, (db) =>
      db.approvalWorkflow.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.ApprovalWorkflowOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toWorkflow), pageInfo: page.pageInfo };
  }

  /**
   * Create, inactive. The id is the SERVER's, unlike a saved chat conversation:
   * that resource namespaces a caller-minted id per (practice, user), and a
   * workflow has no such namespace — two practices both choosing `wfl_001`
   * would collide on the primary key, and the upsert that discovered it would
   * have to answer in a way that says whether the other practice's row exists.
   */
  async create(ctx: ScopeContext, body: CreateBody, idempotencyKey: string): Promise<ApprovalWorkflow> {
    const replay = await this.replayed<ApprovalWorkflow>(ctx, idempotencyKey, { create: body });
    if (replay !== null) return replay;

    const created = await scopedDb(this.prisma, ctx, async (db) => {
      // Resolve the business through RLS BEFORE writing (the executors'
      // guard): the WITH CHECK would otherwise fail the insert as a 500, and a
      // 404 here neither confirms nor denies that the id names anything.
      const business = await db.business.findUnique({ where: { id: body.businessId }, select: { id: true } });
      if (business === null) throw notFound();

      return db.approvalWorkflow.create({
        data: {
          businessId: body.businessId,
          name: body.name,
          appliesTo: body.appliesTo,
          specificity: body.specificity,
          selfApproval: body.selfApproval,
          stages: body.stages as unknown as Prisma.InputJsonValue,
          branches: body.branches as unknown as Prisma.InputJsonValue,
          // Stated rather than left to the column default, because this is the
          // property the whole service is built around and a default is a
          // thing someone can change in a migration without reading this file.
          isActive: false,
        },
      });
    });

    const workflow = toWorkflow(created);
    await this.remember(ctx, idempotencyKey, { create: body }, workflow);
    return workflow;
  }

  /**
   * Replace the editable fields. Whole-workflow, so a retry writes the same
   * bytes; `isActive` and `businessId` are absent from `EditBody` and there is
   * therefore no expression here that could move either.
   */
  async replace(
    ctx: ScopeContext,
    workflowId: string,
    body: EditBody,
    idempotencyKey: string,
  ): Promise<ApprovalWorkflow> {
    const replay = await this.replayed<ApprovalWorkflow>(ctx, idempotencyKey, { workflowId, body });
    if (replay !== null) return replay;

    const updated = await scopedDb(this.prisma, ctx, async (db) => {
      // `updateMany` rather than `update`: RLS makes an unreachable row simply
      // absent, and `update` on an absent row raises a Prisma error that would
      // surface as a 500 instead of the 404 the contract promises.
      const { count } = await db.approvalWorkflow.updateMany({
        where: { id: workflowId },
        data: writableFields(body),
      });
      if (count === 0) throw notFound();
      const row = await db.approvalWorkflow.findUnique({ where: { id: workflowId } });
      if (row === null) throw notFound();
      return row;
    });

    const workflow = toWorkflow(updated);
    await this.remember(ctx, idempotencyKey, { workflowId, body }, workflow);
    return workflow;
  }

  /**
   * Delete — refused while the workflow is armed.
   *
   * Deleting an active policy removes an approval gate, which is the same class
   * of act as arming one and would otherwise be the way around `policy.activate`
   * entirely: disarm-by-DELETE, with no review and no audit line naming the
   * gate that went away. Disarm it through the proposal first.
   *
   * Idempotent otherwise: a workflow that is not there — deleted already, or
   * out of the caller's reach, which looks identical from here — is a 204.
   */
  async delete(ctx: ScopeContext, workflowId: string, idempotencyKey: string): Promise<void> {
    await this.replayed<null>(ctx, idempotencyKey, { delete: workflowId });

    await scopedDb(this.prisma, ctx, async (db) => {
      const row = await db.approvalWorkflow.findUnique({
        where: { id: workflowId },
        select: { id: true, isActive: true, name: true },
      });
      if (row === null) return;
      if (row.isActive) {
        throw new AppException(
          'NT-WFL-001',
          HttpStatus.CONFLICT,
          'This workflow is still active',
          `"${row.name}" is arming an approval step right now. Turn it off first — that goes through Review → Approve — and then it can be deleted.`,
        );
      }
      await db.approvalWorkflow.deleteMany({ where: { id: workflowId } });
    });

    await this.remember(ctx, idempotencyKey, { delete: workflowId }, null);
  }

  /**
   * Coding rules in force (review item 51 §4).
   *
   * `rule.create` has been approvable since METH Stage 13 and the row it writes
   * was visible NOWHERE afterwards — no operation listed it and no screen
   * rendered it. A rule that cannot be seen cannot be audited or retired, and
   * it is the thing that starts coding a client's documents unattended.
   */
  async listRules(ctx: ScopeContext, query: ListQuery): Promise<Page<Rule>> {
    const filters: Prisma.RuleWhereInput = query.businessId === undefined ? {} : { businessId: query.businessId };
    const request: PageRequest<RuleRow> = {
      sort: RULE_CREATED_AT,
      order: 'desc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      query: { businessId: query.businessId ?? null, limit: query.limit, cursor: undefined },
    };
    const seek = pageQuery(request);

    const rows = await scopedDb(this.prisma, ctx, (db) =>
      db.rule.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.RuleOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toRule), pageInfo: page.pageInfo };
  }

  /** The house 409-on-key-reuse guard, returning the first response on a true replay. */
  private async replayed<T>(ctx: ScopeContext, idempotencyKey: string, request: unknown): Promise<T | null> {
    const record = await this.idempotency.get(idempotencyKey);
    if (record === null) return null;
    if (record.requestHash !== fingerprint({ actorId: ctx.actorId, request })) {
      throw new AppException(
        'NT-IDM-001',
        HttpStatus.CONFLICT,
        'This Idempotency-Key was already used with a different payload',
        'Use a fresh Idempotency-Key for a different request.',
      );
    }
    return record.response as T;
  }

  private async remember(ctx: ScopeContext, idempotencyKey: string, request: unknown, response: unknown): Promise<void> {
    await this.idempotency.put(idempotencyKey, {
      requestHash: fingerprint({ actorId: ctx.actorId, request }),
      response: response as never,
    });
  }
}

/**
 * The fields a human may change by typing, in the one place they are spelled.
 *
 * ⚠ `isActive` and `businessId` are ABSENT and must stay absent. This function
 * is the whole reason neither write path can arm a workflow or re-point it at
 * another client: there is no branch to audit, because there is only one
 * expression that ever builds the `data` for a workflow write.
 */
function writableFields(body: EditBody): Prisma.ApprovalWorkflowUncheckedUpdateInput {
  return {
    name: body.name,
    appliesTo: body.appliesTo,
    specificity: body.specificity,
    selfApproval: body.selfApproval,
    stages: body.stages as unknown as Prisma.InputJsonValue,
    branches: body.branches as unknown as Prisma.InputJsonValue,
  };
}

const WORKFLOW_UPDATED_AT = dateField<WorkflowRow>('updatedAt', (row) => row.updatedAt, false);
const RULE_CREATED_AT = dateField<RuleRow>('createdAt', (row) => row.createdAt, false);

/**
 * The stored shapes, re-checked ON THE WAY OUT.
 *
 * `stages` and `branches` are `Json` columns and the seed has written a
 * DIFFERENT stage shape into this table since the init migration
 * (`{index, approvers[], condition}`), so a row here may genuinely carry
 * something this contract does not describe. A malformed entry is DROPPED
 * rather than felling the whole tab — the `storedMessages` posture, one lane
 * over — and a workflow that loses every stage renders as a policy with no
 * steps, which is visibly wrong rather than quietly wrong.
 */
const StoredStage = z
  .object({
    name: z.string().min(1).max(60),
    approver: z.string().min(1).max(60),
    thresholdAbovePence: z.number().int().min(0).optional(),
    canEdit: z.boolean(),
    clientSide: z.boolean().optional(),
  })
  .strict();

const StoredBranch = z
  .object({
    field: z.enum(['amount', 'supplierAge', 'category']),
    thresholdAbovePence: z.number().int().min(0).optional(),
    value: z.string().max(64).optional(),
    addApprover: z.string().min(1).max(60),
    label: z.string().min(1).max(120),
  })
  .strict();

/**
 * ⚠ Optionals are spread CONDITIONALLY rather than assigned, throughout. This
 * repo compiles with `exactOptionalPropertyTypes`, so an explicit `undefined`
 * is not the same as an absent key — and zod's `.optional()` produces the
 * former. Assigning it straight across is the mistake that does not look like
 * one.
 */
function storedStages(value: Prisma.JsonValue): ApprovalWorkflowStage[] {
  const out: ApprovalWorkflowStage[] = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    const parsed = StoredStage.safeParse(entry);
    if (!parsed.success) continue;
    const { name, approver, canEdit, thresholdAbovePence, clientSide } = parsed.data;
    out.push({
      name,
      approver,
      canEdit,
      ...(thresholdAbovePence === undefined ? {} : { thresholdAbovePence }),
      ...(clientSide === undefined ? {} : { clientSide }),
    });
  }
  return out;
}

function storedBranches(value: Prisma.JsonValue): ApprovalWorkflowBranch[] {
  const out: ApprovalWorkflowBranch[] = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    const parsed = StoredBranch.safeParse(entry);
    if (!parsed.success) continue;
    const { field, addApprover, label, thresholdAbovePence, value: tested } = parsed.data;
    out.push({
      field,
      addApprover,
      label,
      ...(thresholdAbovePence === undefined ? {} : { thresholdAbovePence }),
      ...(tested === undefined ? {} : { value: tested }),
    });
  }
  return out;
}

export function toWorkflow(row: WorkflowRow): ApprovalWorkflow {
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    // The column is `Json?` and the value is a plain string; anything else is a
    // row from before this surface existed, and an empty scope claims nothing.
    appliesTo: typeof row.appliesTo === 'string' ? row.appliesTo : '',
    specificity: row.specificity,
    stages: storedStages(row.stages),
    branches: storedBranches(row.branches ?? null),
    selfApproval: row.selfApproval,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRule(row: RuleRow): Rule {
  return {
    id: row.id,
    businessId: row.businessId,
    tier: row.tier,
    scopeKey: row.scopeKey,
    conditions: (row.conditions ?? null) as NonNullable<Rule['conditions']>,
    sets: (row.sets ?? {}) as Rule['sets'],
    isActive: row.isActive,
    createdVia: row.createdVia,
    actionProposalId: row.actionProposalId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Absent and unreachable answer identically — 404, never 403, id never echoed.
 * `NT-VAL-001` is the house fallback for an otherwise-uncoded 4xx (the note in
 * `action-proposals.service.ts`); there is no NT-NOT family.
 */
function notFound(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No such workflow, or it is not yours.');
}
