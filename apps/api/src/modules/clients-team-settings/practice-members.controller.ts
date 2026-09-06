import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query } from '@nestjs/common';

import type { Invite, PracticeMember } from '@neoting/contracts/model';
import {
  invitePracticeMemberBody,
  invitePracticeMemberHeader,
  listPracticeMembersQueryParams,
  removePracticeMemberHeader,
  resendPracticeInvitationHeader,
  revokePracticeInvitationHeader,
  updatePracticeMemberBody,
  updatePracticeMemberHeader,
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

  /**
   * Change a colleague's role or the clients they can reach (review item 57).
   *
   * Every refusal this operation carries is the SERVICE's — the owner being
   * unchangeable, `PRACTICE_ADMIN` being ungrantable, an empty client list
   * meaning every client. A gate written here is a gate the next caller of the
   * service does not get, which is this class's own stated rule.
   */
  @Patch(':userId')
  @HttpCode(HttpStatus.OK)
  async updateMember(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<PracticeMember> {
    const key = parseIdempotencyKey(updatePracticeMemberHeader, idempotencyKey);
    const request = parseBoundary(updatePracticeMemberBody, body, 'request body');
    return this.team.updatePracticeMember(await this.context.require(), userId, request, key);
  }

  /** End a colleague's access to this practice. `204` — no state left to describe. */
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('userId') userId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<void> {
    const key = parseIdempotencyKey(removePracticeMemberHeader, idempotencyKey);
    await this.team.removePracticeMember(await this.context.require(), userId, key);
  }
}

/**
 * The practice's outstanding INVITATIONS — `DELETE /v1/practice-invitations/{id}`
 * and `POST .../resend` (review item 57).
 *
 * ## ⚠ Why a third controller and a different noun
 *
 * An invitation is not a member: it has no `userId`, no role that has taken
 * effect and nothing the holder can do yet — the list operation already keeps
 * them in a separate `pendingInvites` array for exactly that reason. Hanging
 * them off `/practice-members/{userId}` would have made the path id mean two
 * different kinds of thing depending on the verb, and
 * `/practice-members/invitations/{id}` would collide with `{userId}` on any id
 * that happened to read `invitations`.
 *
 * It is flat and carries no practice id, the sibling controller's rule: one
 * practice per session, resolved from the verified session rather than named by
 * the caller.
 */
@Controller('practice-invitations')
export class PracticeInvitationsController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(PRACTICE_TEAM_SERVICE) private readonly team: PracticeTeamService,
  ) {}

  /** Kill the link before its seven days are up. `204`. */
  @Delete(':inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeInvitation(
    @Param('inviteId') inviteId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<void> {
    const key = parseIdempotencyKey(revokePracticeInvitationHeader, idempotencyKey);
    await this.team.revokePracticeInvitation(await this.context.require(), inviteId, key);
  }

  /** A fresh token on the same row, emailed again. The old link dies. */
  @Post(':inviteId/resend')
  @HttpCode(HttpStatus.OK)
  async resendInvitation(
    @Param('inviteId') inviteId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Invite> {
    const key = parseIdempotencyKey(resendPracticeInvitationHeader, idempotencyKey);
    return this.team.resendPracticeInvitation(await this.context.require(), inviteId, key);
  }
}
