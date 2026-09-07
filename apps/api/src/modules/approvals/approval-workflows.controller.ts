import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Put, Query } from '@nestjs/common';

import {
  createApprovalWorkflowBody,
  createApprovalWorkflowHeader,
  deleteApprovalWorkflowHeader,
  deleteApprovalWorkflowParams,
  draftApprovalWorkflowBody,
  listApprovalWorkflowsQueryParams,
  listRulesQueryParams,
  replaceApprovalWorkflowBody,
  replaceApprovalWorkflowHeader,
  replaceApprovalWorkflowParams,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { ApprovalWorkflowsService } from './approval-workflows.service.js';
import { APPROVAL_WORKFLOWS_SERVICE } from './tokens.js';

/**
 * The workflows surface (review package H). A SECOND controller beside
 * `action-proposals.controller.ts` deliberately: that one is the single
 * execution door and its file says so structurally; these are ordinary
 * `ingest`-class writes of a policy DRAFT, and none of them can arm anything.
 *
 * Thin, as the house rule says: coerce and parse with the generated schemas,
 * one service call each.
 */
@Controller('approval-workflows')
export class ApprovalWorkflowsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(APPROVAL_WORKFLOWS_SERVICE) private readonly service: ApprovalWorkflowsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(
      listApprovalWorkflowsQueryParams,
      coerceQuery(listApprovalWorkflowsQueryParams, query),
      'query parameters',
    );
    const ctx = await this.context.require();
    return this.service.list(ctx, parsed);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined) {
    const parsed = parseBoundary(createApprovalWorkflowBody, body, 'body');
    const key = parseIdempotencyKey(createApprovalWorkflowHeader, idempotencyKey);
    const ctx = await this.context.require();
    return this.service.create(ctx, parsed, key);
  }

  /**
   * ⚠ Declared BEFORE `:workflowId`'s routes and on its own literal path, so
   * `/approval-workflows/draft` can never be read as a workflow id. It is a
   * POST that WRITES NOTHING (`x-nt-side-effect: none`) and therefore takes no
   * `Idempotency-Key` — the `beginTotpEnrolment` precedent, and the contract
   * checker agrees.
   */
  @Post('draft')
  @HttpCode(HttpStatus.OK)
  async draft(@Body() body: unknown) {
    const parsed = parseBoundary(draftApprovalWorkflowBody, body, 'body');
    const ctx = await this.context.require();
    return this.service.draft(ctx, parsed);
  }

  @Put(':workflowId')
  @HttpCode(HttpStatus.OK)
  async replace(
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const params = parseBoundary(replaceApprovalWorkflowParams, { workflowId }, 'workflowId');
    const parsed = parseBoundary(replaceApprovalWorkflowBody, body, 'body');
    const key = parseIdempotencyKey(replaceApprovalWorkflowHeader, idempotencyKey);
    const ctx = await this.context.require();
    return this.service.replace(ctx, params.workflowId, parsed, key);
  }

  @Post(':workflowId/deletion')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('workflowId') workflowId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const params = parseBoundary(deleteApprovalWorkflowParams, { workflowId }, 'workflowId');
    const key = parseIdempotencyKey(deleteApprovalWorkflowHeader, idempotencyKey);
    const ctx = await this.context.require();
    await this.service.delete(ctx, params.workflowId, key);
  }
}

/**
 * `GET /v1/rules` (review item 51 §4) — in this file rather than one of its
 * own, because it is a single read on the same service, under the same tag, and
 * a twenty-line controller in a file by itself is a file to keep in step for no
 * benefit. It has to be its own CLASS only because Nest binds a path prefix per
 * controller and this one is not under `/approval-workflows`.
 */
@Controller('rules')
export class RulesController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(APPROVAL_WORKFLOWS_SERVICE) private readonly service: ApprovalWorkflowsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(listRulesQueryParams, coerceQuery(listRulesQueryParams, query), 'query parameters');
    const ctx = await this.context.require();
    return this.service.listRules(ctx, parsed);
  }
}
