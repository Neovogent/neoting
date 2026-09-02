import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Inject, Param, Patch, Post } from '@nestjs/common';

import type { PortalPeople, PortalPerson } from '@neoting/contracts/model';
import {
  invitePortalPersonBody,
  invitePortalPersonHeader,
  removePortalPersonHeader,
  updatePortalPersonBody,
  updatePortalPersonHeader,
} from '@neoting/contracts/zod';

import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import type { PortalPeopleService } from './portal-people.service.js';
import type { PortalSessionContextResolver } from './portal-session-context.js';
import { PORTAL_PEOPLE_SERVICE, PORTAL_SESSION_CONTEXT } from './tokens.js';

/**
 * **Settings → People** — the four operations a client business needs to run its
 * own access list (D45, D49, the product owner's ruling of 2 Sep 2026).
 *
 * ## ⚠ Why this is a SECOND controller rather than four more handlers
 *
 * `portal.controller.ts` documents itself as "the six contracted routes, and
 * exactly those six", and `portal.controller.test.ts` pins that list so a
 * seventh handler is a contract decision rather than a convenience. Four more
 * would have taken it from 257 lines to roughly 380 against `apps/api`'s
 * 200-line controller cap, and it is already over.
 *
 * So the split is by SURFACE: that file is the session and the documents — what
 * a client sends and what is being asked of them — and this one is the people
 * who may do it. Each pins its own handler list, so neither can grow a route in
 * silence. Both are registered in `portal.module.ts`; a reader looking for "what
 * can the portal do" reads two `@Controller('portal')` classes rather than one,
 * which is the cost, and it is stated here rather than discovered.
 *
 * ## The three things this layer decides, and the one it does not
 *
 * 1. **Which resolver.** `resolveOnboarding` — own-portal sessions ONLY, the
 *    same door `GET /portal/documents` uses, and for a stronger version of the
 *    same reason. A chase link is deliberately forwardable to whoever physically
 *    holds the paperwork; letting its holder read (let alone change) the list of
 *    everyone who works at a business, because somebody passed them a text, is
 *    a widening nothing asked for. Every resolver method returns identical
 *    facts, so this choice is invisible in the response and is pinned by a test.
 * 2. **Authenticate, THEN validate.** A caller with no valid bearer gets
 *    `401 NT-OTP-002` and learns nothing about which of their fields we would
 *    have objected to — including, on the invite, whether the address they typed
 *    is already known to us.
 * 3. **`Idempotency-Key` is required on all three mutations**, contract-wide,
 *    and unlike `POST /portal/sessions` it IS replay-cached: these responses
 *    carry a person rather than a credential, and the store key is namespaced by
 *    session so one caller can never be handed another's.
 *
 * What it does NOT decide is **authority**. `assertCan(actor,
 * 'business.people.manage')` is enforced in the service, inside the same
 * transaction as the write, against an actor resolved from the `otp_sessions`
 * row — never here, and never from anything the caller sent. A controller-level
 * check would be a second copy of the rule, and Governance §11.2's point is that
 * there is one.
 */
@Controller('portal/people')
export class PortalPeopleController {
  constructor(
    @Inject(PORTAL_SESSION_CONTEXT) private readonly resolver: PortalSessionContextResolver,
    @Inject(PORTAL_PEOPLE_SERVICE) private readonly people: PortalPeopleService,
  ) {}

  /**
   * `GET /portal/people` — everyone with access, and what the SERVER would let
   * this session do to the list.
   *
   * ⚠ **Everyone with a portal session may read this, including a plain
   * `BUSINESS_STANDARD`.** Who else can send paperwork on your employer's behalf
   * is not a secret from you, and hiding the section would be the *"pretend the
   * action does not exist"* failure Governance §11.2 names. What a
   * `BUSINESS_STANDARD` does not get is the controls, and `canManagePeople` on
   * the response is how a screen knows — a fact for honest degradation, never
   * the gate.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async listPeople(@Headers('authorization') authorization: string | undefined): Promise<PortalPeople> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    return this.people.listPeople(facts);
  }

  /**
   * `POST /portal/people` — add one of this business's own people.
   *
   * `201`, because a row is created. The response is the person as they now
   * appear in the list, so the screen renders server truth rather than
   * predicting it.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async invitePerson(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<PortalPerson> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const key = parseIdempotencyKey(invitePortalPersonHeader, idempotencyKey);
    const request = parseBoundary(invitePortalPersonBody, body, 'request body');
    return this.people.invitePerson(facts, request, key);
  }

  /**
   * `PATCH /portal/people/{personId}` — change what one of your people may do.
   *
   * `email` is absent from the body on purpose: the address is the sign-in
   * channel and the sender-map key at once, so changing it is removing one
   * person and inviting another.
   */
  @Patch(':personId')
  @HttpCode(HttpStatus.OK)
  async updatePerson(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('personId') personId: string,
    @Body() body: unknown,
  ): Promise<PortalPerson> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const key = parseIdempotencyKey(updatePortalPersonHeader, idempotencyKey);
    const request = parseBoundary(updatePortalPersonBody, body, 'request body');
    return this.people.updatePerson(facts, personId, request, key);
  }

  /**
   * `DELETE /portal/people/{personId}` — revoke someone's access.
   *
   * `200` with the person, now inactive, rather than a bare `204`: removal is a
   * revocation and the row survives, so the screen shows what actually happened
   * instead of erasing a name and hoping.
   */
  @Delete(':personId')
  @HttpCode(HttpStatus.OK)
  async removePerson(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('personId') personId: string,
  ): Promise<PortalPerson> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const key = parseIdempotencyKey(removePortalPersonHeader, idempotencyKey);
    return this.people.removePerson(facts, personId, key);
  }
}
