import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Put } from '@nestjs/common';

import { updatePortalBusinessProfileBody, updatePortalBusinessProfileHeader } from '@neoting/contracts/zod';

import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import type { PortalBusinessProfileService } from './portal-business-profile.service.js';
import type { PortalSessionContextResolver } from './portal-session-context.js';
import { PORTAL_BUSINESS_PROFILE_SERVICE, PORTAL_SESSION_CONTEXT } from './tokens.js';

/**
 * **The business fills in its own record** — `PUT /portal/business-profile`, the
 * setup journey's details step (5 Sep 2026 review finding: the emailed link told
 * the client they would fill in their account information, and the journey asked
 * them nothing between the code and the payment).
 *
 * A **third** controller on the portal surface, for the reason
 * `portal-people.controller.ts` gives at length: `portal.controller.ts` pins its
 * handler list so a new route there is a contract decision rather than a
 * convenience, and it is already over `apps/api`'s 200-line cap. The split is by
 * SURFACE — the session and the documents, the people who may send them, and
 * (here) the business they work for. Each pins its own list; all three are
 * registered in `portal.module.ts`.
 *
 * The three things this layer decides, and the one it does not, are the people
 * controller's exactly:
 *
 * 1. **`resolveOnboarding`** — own-portal sessions only. A chase link is
 *    deliberately forwardable to whoever physically holds the paperwork; letting
 *    its holder rewrite the business's company number because somebody passed
 *    them a text is a widening nothing asked for.
 * 2. **Authenticate, THEN validate.** A caller with no valid bearer gets
 *    `401 NT-OTP-002` and learns nothing about which of their fields we would
 *    have objected to.
 * 3. **`Idempotency-Key` is required and replay-cached**, namespaced by session
 *    in the service so one caller can never observe another's.
 *
 * What it does NOT decide is **authority**. `assertCan(actor,
 * 'business.profile.manage')` runs in the service, inside the same transaction as
 * the write, against an actor resolved from the `otp_sessions` row — never here,
 * and never from anything the caller sent.
 */
@Controller('portal/business-profile')
export class PortalBusinessProfileController {
  constructor(
    @Inject(PORTAL_SESSION_CONTEXT) private readonly resolver: PortalSessionContextResolver,
    @Inject(PORTAL_BUSINESS_PROFILE_SERVICE) private readonly profile: PortalBusinessProfileService,
  ) {}

  /**
   * `PUT /portal/business-profile` — `204`, because the answer is the portal
   * context's on its next read and a second shape of the same facts here would be
   * one more thing that could disagree with it.
   *
   * Every field is optional and an omitted field is UNCHANGED: the step is
   * skippable by design, because a missing company number must never stand
   * between a client and sending their first receipt.
   */
  @Put()
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateBusinessProfile(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    const facts = await this.resolver.resolveOnboarding(authorization);
    const key = parseIdempotencyKey(updatePortalBusinessProfileHeader, idempotencyKey);
    const request = parseBoundary(updatePortalBusinessProfileBody, body, 'request body');
    await this.profile.updateProfile(facts, request, key);
  }
}
