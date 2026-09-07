/**
 * The public seam of tasks and teams (Boundaries, apps/api/CLAUDE.md).
 *
 * What is exported here is the whole of what other modules' code may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional.
 *
 * Nothing consumes this module today — it is reached only over HTTP, by design:
 * a task is coordination, and a pipeline stage that starts ticking somebody's
 * checklist is the thing `aiPrefilledAt` exists to make honest instead.
 * `TASK_ASSIGNED_EVENT` is exported for the day a second surface renders it.
 */
export { TasksModule } from './tasks.module.js';
export { TASK_ASSIGNED_EVENT, TasksService } from './tasks.service.js';
export { TeamsService } from './teams.service.js';
export { TASKS_SERVICE, TEAMS_SERVICE } from './tokens.js';
