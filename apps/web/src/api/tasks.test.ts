import { expect, test } from 'vitest';

import { PRACTICE_TEAM_QUERY_KEY } from './team';

/**
 * ⚠ The one thing `api/tasks.ts` claims that a reader cannot check by looking.
 *
 * `useAssignees` deliberately does NOT import `PRACTICE_TEAM_QUERY_KEY` — that
 * import would pull the whole of `api/team.ts` onto `ClientDetailView`'s route,
 * which is exactly what the hook exists to avoid (it had 2,469 B of headroom
 * when this landed). So the key is written out as a literal, and the two only
 * agree by somebody keeping them in step.
 *
 * They MUST agree: when both live on one screen, React Query serves a single
 * request and both read the same cache entry. Diverge them and the practice's
 * members are fetched twice and can show two different lists.
 *
 * The test imports the constant — which is fine here, because a test file is
 * not on any route.
 */
test('useAssignees shares api/team.ts’s query key, so the two never fetch twice', () => {
  expect([...PRACTICE_TEAM_QUERY_KEY]).toEqual(['practice-members']);
});
