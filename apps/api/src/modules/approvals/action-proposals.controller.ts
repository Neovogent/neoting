import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';

import type { ActionProposal, ProposalReview } from '@neoting/contracts/model';
import {
  approveActionProposalBody,
  approveActionProposalHeader,
  approveActionProposalParams,
  cancelActionProposalBody,
  cancelActionProposalHeader,
  cancelActionProposalParams,
  createActionProposalHeader,
  getActionProposalParams,
  listActionProposalsQueryParams,
  reviewActionProposalHeader,
  reviewActionProposalParams,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { AppException } from '../../common/problem/problem.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { ActionProposalsService } from './action-proposals.service.js';
import { knownProposalKind, parseCreateProposalBody } from './proposal-body.js';
import { ACTION_PROPOSALS_SERVICE } from './tokens.js';

/**
 * The Review → Approve spine over HTTP (METH S3, issue #122) — the five
 * contracted operations, nothing else. Thin by design (apps/api/CLAUDE.md):
 * parse with the generated schemas, take the request context, call ONE
 * service method, return it.
 *
 * `kind` is checked against the registry enum BEFORE the body parse, because
 * the contract distinguishes the two refusals: an unknown kind is
 * `NT-PRP-001` ("rejected outright"), a known kind with a malformed payload
 * is the ordinary `NT-VAL-001` boundary failure.
 *
 * This file must never import the proposals directory — the executors.test.ts
 * walk pins it. The registry is reachable only through the service the module
 * assembles.
 */
@Controller('action-proposals')
export class ActionProposalsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(ACTION_PROPOSALS_SERVICE) private readonly service: ActionProposalsService,
  ) {}

  /** Propose a state change. Creates the proposal and executes nothing. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined): Promise<ActionProposal> {
    const key = parseIdempotencyKey(createActionProposalHeader, idempotencyKey);
    const kind = knownProposalKind(isObject(body) ? body['kind'] : undefined);
    if (kind === null) {
      throw new AppException(
        'NT-PRP-001',
        HttpStatus.BAD_REQUEST,
        'Unknown action kind',
        'The kind is not in the action-kind registry.',
      );
    }
    const request = parseCreateProposalBody(kind, body as Record<string, unknown>);
    return this.service.create(await this.context.require(), { kind, ...request }, key);
  }

  /** The approval queue and its history — a read, so no `Idempotency-Key` (METH S12, issue #140). */
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Query() query: unknown) {
    const parsed = parseBoundary(
      listActionProposalsQueryParams,
      coerceQuery(listActionProposalsQueryParams, query),
      'query parameters',
    );
    return this.service.list(await this.context.require(), parsed);
  }

  @Get(':proposalId')
  @HttpCode(HttpStatus.OK)
  async get(@Param('proposalId') proposalId: string): Promise<ActionProposal> {
    const params = parseBoundary(getActionProposalParams, { proposalId }, 'proposalId');
    return this.service.get(await this.context.require(), params.proposalId);
  }

  /** [Read review] — a POST because it writes `reviewedAt` and the rendered hash. */
  @Post(':proposalId/review')
  @HttpCode(HttpStatus.OK)
  async review(
    @Param('proposalId') proposalId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ProposalReview> {
    const key = parseIdempotencyKey(reviewActionProposalHeader, idempotencyKey);
    const params = parseBoundary(reviewActionProposalParams, { proposalId }, 'proposalId');
    return this.service.review(await this.context.require(), params.proposalId, key);
  }

  /** [Approve] — the one execute operation in the whole API (contract-checked). */
  @Post(':proposalId/approval')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ActionProposal> {
    const key = parseIdempotencyKey(approveActionProposalHeader, idempotencyKey);
    const params = parseBoundary(approveActionProposalParams, { proposalId }, 'proposalId');
    const parsed = parseBoundary(approveActionProposalBody, body, 'request body');
    return this.service.approve(await this.context.require(), params.proposalId, parsed, key);
  }

  /** [Cancel] — nothing executes, nothing is deleted. */
  @Post(':proposalId/cancellation')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('proposalId') proposalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ActionProposal> {
    const key = parseIdempotencyKey(cancelActionProposalHeader, idempotencyKey);
    const params = parseBoundary(cancelActionProposalParams, { proposalId }, 'proposalId');
    // The body is optional in the contract; an absent one arrives as undefined.
    const parsed = parseBoundary(cancelActionProposalBody, body ?? {}, 'request body');
    return this.service.cancel(await this.context.require(), params.proposalId, parsed, key);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
