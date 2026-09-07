import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createApprovalWorkflow,
  deleteApprovalWorkflow,
  draftApprovalWorkflow,
  listApprovalWorkflows,
  listRules,
  replaceApprovalWorkflow,
} from '@neoting/contracts/client';
import {
  draftApprovalWorkflowResponse,
  listApprovalWorkflowsResponse,
  listRulesResponse,
  replaceApprovalWorkflowResponse,
} from '@neoting/contracts/zod';
import type { ApprovalWorkflow, ApprovalWorkflowEditRequest, Rule } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * Approval workflows and the coding rules they sit beside (review package H).
 *
 * Until this, the Workflows tab was React state seeded from `lib/seed2.ts`:
 * `approval_workflows` was a prisma table with no operations behind it, so a
 * policy an accountant composed survived exactly as long as the tab stayed
 * open. Items 51, 52 and 53 all needed the same thing first.
 *
 * ⚠ **This module must stay OFF the bundle floor.** It is imported by
 * `WorkflowsPanel`, which both views reach through `lazy()`, and by NOTHING in
 * `AppContext` — the `api/proposals.ts` rule, for the same reason: a fill
 * effect in the context would put the generated approvals client on every
 * route in the product. The panel is lazy rather than the module merely being
 * careful, so the whole tab — cards, editor, queries — downloads on the click
 * that opens it.
 *
 * ⚠ **Thresholds are PENCE on the wire and pence in this app.** The synthetic
 * generators work in float pounds (`Document.total`), which is why the two
 * comparison sites in `lib/generate.ts` multiply rather than this module
 * dividing: a conversion here would put a float back into a field the contract
 * spent an `x-nt-money` marker making integral.
 */

const WORKFLOWS_KEY = ['approval-workflows'] as const;
const RULES_KEY = ['rules'] as const;

/**
 * Hand-rolled query keys rather than the generated `getList…QueryKey`
 * builders — `api/proposals.ts` records the measurement behind that habit:
 * every extra export touched from a generated client module ships wherever
 * that module already lives.
 */
export interface UseWorkflowsOptions {
  /** Off entirely on seed data — there is no server to ask. */
  enabled: boolean;
  /** One client's workflows, or every one the caller can reach. */
  businessId?: string | undefined;
}

export function useWorkflows({ enabled, businessId }: UseWorkflowsOptions) {
  const query = useQuery({
    queryKey: [...WORKFLOWS_KEY, businessId ?? 'all'],
    queryFn: () => listApprovalWorkflows({ limit: 50, ...(businessId === undefined ? {} : { businessId }) }),
    enabled,
  });

  const parsed = useMemo(() => {
    if (!query.data) return { workflows: [] as ApprovalWorkflow[], contractError: null as string | null };
    const result = listApprovalWorkflowsResponse.safeParse(unwrapBody(query.data));
    if (!result.success) return { workflows: [], contractError: issues(result.error) };
    return { workflows: result.data.data as ApprovalWorkflow[], contractError: null };
  }, [query.data]);

  return {
    workflows: parsed.workflows,
    contractError: parsed.contractError,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The rules in force for a client (review item 51 §4).
 *
 * `rule.create` has been approvable since METH S13 and the row it wrote was
 * visible nowhere afterwards — so a rule that started coding a client's
 * documents unattended could not be audited or retired by anyone. Read-only,
 * because retiring one is its own proposal and not a DELETE.
 */
export function useRules({ enabled, businessId }: UseWorkflowsOptions) {
  const query = useQuery({
    queryKey: [...RULES_KEY, businessId ?? 'all'],
    queryFn: () => listRules({ limit: 50, ...(businessId === undefined ? {} : { businessId }) }),
    enabled,
  });

  const rules = useMemo(() => {
    if (!query.data) return [] as Rule[];
    const result = listRulesResponse.safeParse(unwrapBody(query.data));
    return result.success ? (result.data.data as Rule[]) : [];
  }, [query.data]);

  return { rules, isLoading: query.isLoading };
}

/** Both write paths and the delete, plus the invalidation that follows each. */
export function useWorkflowWrites(businessId?: string | undefined) {
  const client = useQueryClient();
  const invalidate = () => client.invalidateQueries({ queryKey: WORKFLOWS_KEY });

  return {
    /** Create — the server mints the id and the row lands INACTIVE. */
    async create(body: ApprovalWorkflowEditRequest & { businessId: string }): Promise<ApprovalWorkflow> {
      const parsed = replaceApprovalWorkflowResponse.safeParse(
        unwrapBody(await createApprovalWorkflow(body, { headers: idempotency() })),
      );
      if (!parsed.success) throw new Error(issues(parsed.error));
      await invalidate();
      return parsed.data as ApprovalWorkflow;
    },
    /**
     * Replace. `isActive` is not on the request and cannot be — turning a
     * workflow on or off is a `policy.activate` proposal, and the Activate
     * button stages one rather than calling anything here.
     */
    async replace(workflowId: string, body: ApprovalWorkflowEditRequest): Promise<ApprovalWorkflow> {
      const parsed = replaceApprovalWorkflowResponse.safeParse(
        unwrapBody(await replaceApprovalWorkflow(workflowId, body, { headers: idempotency() })),
      );
      if (!parsed.success) throw new Error(issues(parsed.error));
      await invalidate();
      return parsed.data as ApprovalWorkflow;
    },
    async remove(workflowId: string): Promise<void> {
      await deleteApprovalWorkflow(workflowId, { headers: idempotency() });
      await invalidate();
    },
    businessId,
  };
}

export interface WorkflowDraft {
  status: 'drafted' | 'refused';
  workflow?: (ApprovalWorkflowEditRequest & { businessId: string }) | undefined;
  understood: string[];
  assumed: string[];
  reason?: string | undefined;
}

/**
 * "Describe it instead" — item 52's real parse, served by the pinned model
 * through `POST /approval-workflows/draft`.
 *
 * It stores nothing and returns a DRAFT the human then edits and saves, which
 * is what makes the panel's own promise — *every field below is editable* —
 * true rather than decorative. A `refused` answer is a normal one and carries
 * a reason an accountant can act on.
 */
export async function draftWorkflow(businessId: string, description: string): Promise<WorkflowDraft> {
  const parsed = draftApprovalWorkflowResponse.safeParse(
    unwrapBody(await draftApprovalWorkflow({ businessId, description })),
  );
  if (!parsed.success) throw new Error(issues(parsed.error));
  const data = parsed.data;
  return {
    status: data.status,
    ...(data.workflow === undefined
      ? {}
      : { workflow: data.workflow as ApprovalWorkflowEditRequest & { businessId: string } }),
    understood: data.understood ?? [],
    assumed: data.assumed ?? [],
    ...(data.reason === undefined ? {} : { reason: data.reason }),
  };
}

/**
 * A fresh `Idempotency-Key` per attempt.
 *
 * Per ATTEMPT and not per intent, deliberately: the server 409s a key reused
 * with a different payload, and the editor's Save is a button a person may
 * press twice after correcting a field. `crypto.randomUUID` is available in
 * every browser this app supports and in the test environment.
 */
const idempotency = () => ({ 'Idempotency-Key': crypto.randomUUID() });

const issues = (error: { issues: { path: (string | number)[]; message: string }[] }) =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
    .join('; ');
