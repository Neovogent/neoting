import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createTask,
  createTeam,
  deleteTask,
  deleteTeam,
  listPracticeMembers,
  listTasks,
  listTeams,
  replaceTask,
  replaceTeam,
  setTaskStatus,
} from '@neoting/contracts/client';
import {
  listPracticeMembersResponse,
  listTasksResponse,
  listTeamsResponse,
  replaceTaskResponse,
  replaceTeamResponse,
} from '@neoting/contracts/zod';
import type { Task, TaskEditRequest, TaskStatus, TaskWriteRequest, Team, TeamWriteRequest } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * The practice's checklist and the firm's org chart (review item 54).
 *
 * **Before this module both tabs were a drawing.** `tasks` was a prisma table
 * with no operation behind it and `teams` had no table at all, so "+ New task"
 * was disabled with an honest tooltip and the Teams cards carried an amber
 * banner saying nothing here is saved. This is the server half both were
 * waiting for.
 *
 * ⚠ **This module must stay OFF the bundle floor.** It is imported by
 * `TeamView` and by `ClientDetailView`'s Tasks tab and by NOTHING in
 * `AppContext` — the `api/workflows.ts` / `api/proposals.ts` rule, for the same
 * measured reason: a fill effect in the context would put the generated tasks
 * client on every route in the product.
 *
 * ## It computes its own `sliceStatus` and does NOT widen `SliceName`
 *
 * `api/slices.ts` names the DEMO ROUTE's context arrays; tasks are not one of
 * them. `DataSourceBadge`'s `slice` prop is already a plain `string`, so a view
 * passes its own label — the `ExportView` / `api/team.ts` precedent, followed
 * deliberately.
 *
 * ## The plain generated functions, not the generated hooks
 *
 * Same reason `api/proposals.ts` gives: the marginal cost of a generated module
 * is per-EXPORT once its barrel is floor-reachable, so touching `listTasks`
 * costs one function while `useListTasks` would additionally pull the hook and
 * the query-key machinery. Read that comment before "cleaning this up".
 */

const TASKS_KEY = ['tasks'] as const;
const TEAMS_KEY = ['teams'] as const;

export type { Task, Team, TaskStatus };

export interface UseTasksOptions {
  /** Off entirely on seed data — there is no server to ask. */
  enabled: boolean;
  /** One client's tasks, or every one the caller can reach. */
  businessId?: string | undefined;
}

/**
 * The board. Server-ordered soonest-due-first with undated last, and the order
 * is NOT re-sorted here — the cursor seeks on it, so a second opinion in the
 * client would disagree with page 2.
 */
export function useTasks({ enabled, businessId }: UseTasksOptions) {
  const query = useQuery({
    queryKey: [...TASKS_KEY, businessId ?? 'all'],
    queryFn: () => listTasks({ limit: 100, ...(businessId === undefined ? {} : { businessId }) }),
    enabled,
  });

  const parsed = useMemo(() => {
    if (!query.data) return { tasks: [] as Task[], contractError: null as string | null };
    const result = listTasksResponse.safeParse(unwrapBody(query.data));
    if (!result.success) return { tasks: [], contractError: issues(result.error) };
    return { tasks: result.data.data as Task[], contractError: null };
  }, [query.data]);

  return {
    tasks: parsed.tasks,
    contractError: parsed.contractError,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Both write paths, the tick and the delete, plus the invalidation after each. */
export function useTaskWrites() {
  const client = useQueryClient();
  const invalidate = () => client.invalidateQueries({ queryKey: TASKS_KEY });

  return {
    async create(body: TaskWriteRequest): Promise<Task> {
      const parsed = replaceTaskResponse.safeParse(unwrapBody(await createTask(body, { headers: idempotency() })));
      if (!parsed.success) throw new Error(issues(parsed.error));
      await invalidate();
      return parsed.data as Task;
    },
    async replace(taskId: string, body: TaskEditRequest): Promise<Task> {
      const parsed = replaceTaskResponse.safeParse(
        unwrapBody(await replaceTask(taskId, body, { headers: idempotency() })),
      );
      if (!parsed.success) throw new Error(issues(parsed.error));
      await invalidate();
      return parsed.data as Task;
    },
    /**
     * The tick. Its own operation rather than a whole-task PUT because it is
     * the write that happens a hundred times a day, and a stale field in that
     * payload is how one person's tick silently reverts another's edit.
     *
     * A recurring task's completion returns the next occurrence; the
     * invalidation refetches the board, so the new row simply appears — nothing
     * here has to splice it in.
     */
    async setStatus(taskId: string, status: TaskStatus): Promise<void> {
      await setTaskStatus(taskId, { status }, { headers: idempotency() });
      await invalidate();
    },
    async remove(taskId: string): Promise<void> {
      await deleteTask(taskId, { headers: idempotency() });
      await invalidate();
    },
  };
}

/**
 * The firm's teams.
 *
 * ⚠ `accessLevel` is DERIVED server-side from the members' own memberships and
 * is read-only — there is no column behind it and no field that sets it. A
 * team confers no access; joining or leaving one changes nothing about what
 * anybody can reach (`apps/api/src/modules/tasks/teams.service.ts`).
 */
export function useTeams({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: TEAMS_KEY,
    queryFn: () => listTeams({ limit: 100 }),
    enabled,
  });

  const parsed = useMemo(() => {
    if (!query.data) return { teams: [] as Team[], contractError: null as string | null };
    const result = listTeamsResponse.safeParse(unwrapBody(query.data));
    if (!result.success) return { teams: [], contractError: issues(result.error) };
    return { teams: result.data.data as Team[], contractError: null };
  }, [query.data]);

  return { teams: parsed.teams, contractError: parsed.contractError, isLoading: query.isLoading };
}

export function useTeamWrites() {
  const client = useQueryClient();
  const invalidate = () => client.invalidateQueries({ queryKey: TEAMS_KEY });

  return {
    async save(teamId: string | null, body: TeamWriteRequest): Promise<Team> {
      const response =
        teamId === null
          ? await createTeam(body, { headers: idempotency() })
          : await replaceTeam(teamId, body, { headers: idempotency() });
      const parsed = replaceTeamResponse.safeParse(unwrapBody(response));
      if (!parsed.success) throw new Error(issues(parsed.error));
      await invalidate();
      return parsed.data as Team;
    },
    async remove(teamId: string): Promise<void> {
      await deleteTeam(teamId, { headers: idempotency() });
      await invalidate();
    },
  };
}

/** Who a task can be put on: a user id and the name a chip draws. */
export interface Assignee {
  id: string;
  name: string;
}

/**
 * The practice's members, as assignees.
 *
 * ⚠ **Six lines here rather than importing `usePracticeTeam` from
 * `api/team.ts`, and the reason is measured.** That module carries the whole
 * Colleagues surface — invite, update, remove, resend, revoke — and is
 * currently reachable only from `TeamView`. `ClientDetailView` had **2,469 B**
 * of headroom against the 250 kB route budget when this landed, and pulling
 * `api/team.ts` onto it would have spent well past that on exports its Tasks
 * tab never calls. The reachability rule, `apps/web/CLAUDE.md`, *Bundle*.
 *
 * It is **not a second source of truth**: same operation, and the same query
 * key `api/team.ts` uses, so on a screen holding both React Query serves one
 * request and both read the same cache entry.
 */
export function useAssignees({ enabled }: { enabled: boolean }): Assignee[] {
  const query = useQuery({
    // The literal, not `PRACTICE_TEAM_QUERY_KEY` — importing the constant would
    // import the module this function exists to keep off the route. Keep the
    // two in step; they are three characters apart and a test pins it.
    queryKey: ['practice-members'],
    queryFn: () => listPracticeMembers({ limit: 100 }),
    enabled,
  });

  return useMemo(() => {
    if (!query.data) return [];
    const result = listPracticeMembersResponse.safeParse(unwrapBody(query.data));
    if (!result.success) return [];
    return result.data.data.map((member) => ({
      id: member.userId,
      // The email is the fallback, never the raw id — an id means nothing to a
      // reader. Same rule the server's own `assigneeName` projection follows.
      name: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email || member.userId,
    }));
  }, [query.data]);
}

/**
 * A fresh `Idempotency-Key` per attempt.
 *
 * Per ATTEMPT and not per intent, deliberately: the server 409s a key reused
 * with a different payload, and Save is a button a person may press twice after
 * correcting a field.
 */
const idempotency = () => ({ 'Idempotency-Key': crypto.randomUUID() });

const issues = (error: { issues: { path: (string | number)[]; message: string }[] }) =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
    .join('; ');
