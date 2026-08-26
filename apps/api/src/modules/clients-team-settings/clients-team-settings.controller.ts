import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';

import type { Business, Invite } from '@neoting/contracts/model';
import {
  createBusinessBody,
  createBusinessHeader,
  inviteBusinessMemberBody,
  inviteBusinessMemberHeader,
  inviteBusinessMemberParams,
  listBusinessMembersParams,
  listBusinessMembersQueryParams,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { coerceQuery } from '../../common/validation/query-coercion.js';
import type { ClientIntakeService } from './client-intake.service.js';
import type { TeamService } from './team.service.js';
import { CLIENT_INTAKE_SERVICE, TEAM_SERVICE } from './tokens.js';

/**
 * Clients and their teams — `POST /v1/businesses`,
 * `GET`/`POST /v1/businesses/{businessId}/members` (A11, SoT §24.5, D44, D45, D47).
 *
 * **The resource is `businesses`, not `clients`.** "Client" is the word on
 * screen; the resource is the one `GET /v1/businesses` already serves,
 * `businessId` already filters on, and prisma already calls `Business`. A second
 * name for one resource is a second door (`packages/contracts/CLAUDE.md`,
 * convention 1). The list itself stays in `auth-tenancy` where it was built —
 * this class adds the write surface beside it and does not duplicate the read.
 *
 * **No connection step exists here (D47)** — no bank, no accounting software,
 * not as a field, not as a follow-up call. What intake captures instead is the
 * business-type profile, which the generated body schema makes required.
 *
 * Thin by design (`apps/api/CLAUDE.md`, 200-line cap): parse with the generated
 * schemas, take the request context, call ONE service, return its result.
 */
@Controller('businesses')
export class ClientsTeamSettingsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(CLIENT_INTAKE_SERVICE) private readonly intake: ClientIntakeService,
    @Inject(TEAM_SERVICE) private readonly team: TeamService,
  ) {}

  /** Add a client. `x-nt-side-effect: ingest` — new records, no state changed. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createClient(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Business> {
    const key = parseIdempotencyKey(createBusinessHeader, idempotencyKey);
    const request = parseBoundary(createBusinessBody, body, 'request body');
    // `require()` resolves the context inside Nest's pipeline, so a bad one
    // leaves as a 401 problem+json rather than an Express-level crash (#75).
    return this.intake.createClient(await this.context.require(), request, key);
  }

  /** Who can reach this client workspace. */
  @Get(':businessId/members')
  @HttpCode(HttpStatus.OK)
  async listMembers(@Param('businessId') businessId: string, @Query() query: unknown) {
    const params = parseBoundary(listBusinessMembersParams, { businessId }, 'businessId');
    // `coerceQuery` first: Express delivers `limit` as a string while the
    // generated schema types it as a number. Schema-driven, so it cannot drift.
    const parsed = parseBoundary(
      listBusinessMembersQueryParams,
      coerceQuery(listBusinessMembersQueryParams, query),
      'query parameters',
    );
    return this.team.listMembers(await this.context.require(), params.businessId, parsed);
  }

  /** Invite someone into this client workspace. The token is never in the response. */
  @Post(':businessId/members')
  @HttpCode(HttpStatus.CREATED)
  async inviteMember(
    @Param('businessId') businessId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Invite> {
    const key = parseIdempotencyKey(inviteBusinessMemberHeader, idempotencyKey);
    const params = parseBoundary(inviteBusinessMemberParams, { businessId }, 'businessId');
    const request = parseBoundary(inviteBusinessMemberBody, body, 'request body');
    return this.team.inviteMember(await this.context.require(), params.businessId, request, key);
  }
}
