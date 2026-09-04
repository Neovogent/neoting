import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, Query } from '@nestjs/common';

import type { Invite } from '@neoting/contracts/model';
import {
  invitePracticeMemberBody,
  invitePracticeMemberHeader,
  listPracticeMembersQueryParams,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { PracticeTeamService } from './practice-team.service.js';
import { PRACTICE_TEAM_SERVICE } from './tokens.js';

/**
 * The practice's own team — `GET`/`POST /v1/practice-members`.
 *
 * **A second controller rather than two more routes on
 * `ClientsTeamSettingsController`**, because that class is
 * `@Controller('businesses')` and this resource is not under `businesses`. It is
 * flat and carries no path id: one practice per session, resolved from the
 * verified session's acting membership rather than named by the caller
 * (`packages/contracts/CLAUDE.md`, convention 1 — a `practiceId` in the URL
 * would be a tenancy question the server had to re-answer on every request).
 *
 * Thin by design (`apps/api/CLAUDE.md`, 200-line cap): parse with the generated
 * schemas, take the request context, call ONE service, return its result. Both
 * gates that matter — who may invite, and which roles may be granted — are the
 * service's, because a check in a controller is a check the next caller of the
 * service does not get.
 */
@Controller('practice-members')
export class PracticeMembersController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(PRACTICE_TEAM_SERVICE) private readonly team: PracticeTeamService,
  ) {}

  /** Colleagues and outstanding invitations. `x-nt-side-effect: none`. */
  @Get()
  @HttpCode(HttpStatus.OK)
  async listMembers(@Query() query: unknown) {
    // `coerceQuery` first: Express delivers `limit` as a string while the
    // generated schema types it as a number. Schema-driven, so it cannot drift.
    const parsed = parseBoundary(
      listPracticeMembersQueryParams,
      coerceQuery(listPracticeMembersQueryParams, query),
      'query parameters',
    );
    // `require()` resolves the context inside Nest's pipeline, so a bad one
    // leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.team.listPracticeMembers(await this.context.require(), parsed);
  }

  /** Invite a colleague. The token is never in the response. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async inviteMember(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Invite> {
    const key = parseIdempotencyKey(invitePracticeMemberHeader, idempotencyKey);
    const request = parseBoundary(invitePracticeMemberBody, body, 'request body');
    return this.team.invitePracticeMember(await this.context.require(), request, key);
  }
}
