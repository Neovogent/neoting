import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Put, Query } from '@nestjs/common';

import {
  createTaskBody,
  createTaskHeader,
  createTeamBody,
  createTeamHeader,
  deleteTaskHeader,
  deleteTaskParams,
  deleteTeamHeader,
  deleteTeamParams,
  listTasksQueryParams,
  listTeamsQueryParams,
  replaceTaskBody,
  replaceTaskHeader,
  replaceTaskParams,
  replaceTeamBody,
  replaceTeamHeader,
  replaceTeamParams,
  setTaskStatusBody,
  setTaskStatusHeader,
  setTaskStatusParams,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { TasksService } from './tasks.service.js';
import type { TeamsService } from './teams.service.js';
import { TASKS_SERVICE, TEAMS_SERVICE } from './tokens.js';

/**
 * `/v1/tasks` (review item 54).
 *
 * ⚠ **Five write doors and not one of them mints a proposal.** That is item
 * 66's tier 3 applied deliberately, not an omission — `tasks.service.ts`
 * carries the argument. Nothing here can reach a document, a figure, a chase or
 * an export, so there is no path from this controller to a client's books.
 *
 * Thin by the house rule (`apps/api/CLAUDE.md`, 200-line cap): coerce, parse
 * with the generated schemas, take the request context, call ONE service
 * method. `coerceQuery` first — Express delivers `limit` as a string while the
 * schema types it a number.
 */
@Controller('tasks')
export class TasksController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    // Explicit token, not parameter-type metadata: tsx emits no
    // design:paramtypes, the house rule on every controller.
    @Inject(TASKS_SERVICE) private readonly service: TasksService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(listTasksQueryParams, coerceQuery(listTasksQueryParams, query), 'query parameters');
    const ctx = await this.context.require();
    return this.service.list(ctx, parsed);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const parsed = parseBoundary(createTaskBody, body, 'body');
    const key = parseIdempotencyKey(createTaskHeader, idempotencyKey);
    const ctx = await this.context.require();
    return this.service.create(ctx, parsed, key);
  }

  @Put(':taskId')
  @HttpCode(HttpStatus.OK)
  async replace(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const params = parseBoundary(replaceTaskParams, { taskId }, 'taskId');
    const parsed = parseBoundary(replaceTaskBody, body, 'body');
    const key = parseIdempotencyKey(replaceTaskHeader, idempotencyKey);
    const ctx = await this.context.require();
    return this.service.replace(ctx, params.taskId, parsed, key);
  }

  @Post(':taskId/status')
  @HttpCode(HttpStatus.OK)
  async setStatus(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const params = parseBoundary(setTaskStatusParams, { taskId }, 'taskId');
    const parsed = parseBoundary(setTaskStatusBody, body, 'body');
    const key = parseIdempotencyKey(setTaskStatusHeader, idempotencyKey);
    const ctx = await this.context.require();
    return this.service.setStatus(ctx, params.taskId, parsed, key);
  }

  @Post(':taskId/deletion')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('taskId') taskId: string, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const params = parseBoundary(deleteTaskParams, { taskId }, 'taskId');
    const key = parseIdempotencyKey(deleteTaskHeader, idempotencyKey);
    const ctx = await this.context.require();
    await this.service.delete(ctx, params.taskId, key);
  }
}

/**
 * `/v1/teams` — the firm's org chart, in this file rather than one of its own
 * because it is the same feature and the same screen. It has to be its own
 * CLASS only because Nest binds a path prefix per class.
 *
 * ⚠ Nothing here grants access. See `teams.service.ts`.
 */
@Controller('teams')
export class TeamsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(TEAMS_SERVICE) private readonly service: TeamsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(listTeamsQueryParams, coerceQuery(listTeamsQueryParams, query), 'query parameters');
    const ctx = await this.context.require();
    return this.service.list(ctx, parsed);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const parsed = parseBoundary(createTeamBody, body, 'body');
    const key = parseIdempotencyKey(createTeamHeader, idempotencyKey);
    const ctx = await this.context.require();
    return this.service.create(ctx, parsed, key);
  }

  @Put(':teamId')
  @HttpCode(HttpStatus.OK)
  async replace(
    @Param('teamId') teamId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const params = parseBoundary(replaceTeamParams, { teamId }, 'teamId');
    const parsed = parseBoundary(replaceTeamBody, body, 'body');
    const key = parseIdempotencyKey(replaceTeamHeader, idempotencyKey);
    const ctx = await this.context.require();
    return this.service.replace(ctx, params.teamId, parsed, key);
  }

  @Post(':teamId/deletion')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('teamId') teamId: string, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const params = parseBoundary(deleteTeamParams, { teamId }, 'teamId');
    const key = parseIdempotencyKey(deleteTeamHeader, idempotencyKey);
    const ctx = await this.context.require();
    await this.service.delete(ctx, params.teamId, key);
  }
}
