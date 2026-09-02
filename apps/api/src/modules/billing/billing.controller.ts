import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';

import type { HostedBillingSession } from '@neoting/contracts/model';
import {
  createBillingPortalSessionBody,
  createBillingPortalSessionHeader,
  createCheckoutSessionBody,
  createCheckoutSessionHeader,
} from '@neoting/contracts/zod';

import { REQUEST_CONTEXT } from '../../common/context/context.module.js';
import type { RequestContext } from '../../common/context/request-context.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { AppException } from '../../common/problem/problem.js';
import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import { PORTAL_SESSION_CONTEXT, PortalSessionContextResolver, systemScopeFor } from '../portal/index.js';
import type { BillingService } from './billing.service.js';
import { BILLING_SERVICE } from './tokens.js';

/**
 * The billing surface (D48) — two POSTs, both of which hand back a URL Stripe
 * hosts and neither of which renders anything itself.
 *
 * Thin by design (`apps/api/CLAUDE.md`, 200-line cap): parse with the
 * generated schemas, take the request context, call ONE service method, return
 * it. `Idempotency-Key` is `required: true` on both operations
 * (`x-nt-side-effect: ingest`), so a missing one is a 400 here rather than a
 * silently non-idempotent call to a payment provider.
 *
 * ## ⚠ BOTH operations have TWO principals, and only one of them is an accountant
 *
 * `openapi.yaml` puts `portalSession` beside `workspaceSession` on
 * `createCheckoutSession` (contract-change issue #205), because **D48 says the
 * CLIENT pays** and the client holds a portal bearer, not a workspace cookie.
 * The invited client subscribes inside their own onboarding — the journey the
 * setup email invites them into, and the only one SoT §24.5 describes. The
 * cookie path is unchanged: the accountant is the one who can SEE that a client
 * is unsubscribed, so they keep a door too.
 *
 * **`createBillingPortalSession` joined it on 2 Sep 2026**, and the note that
 * used to stand here — that card changes, invoices and cancellation belong
 * "behind a session that has been through more than a setup link" — was
 * overtaken by D49's client portal and is recorded rather than quietly deleted.
 * The Settings tab IS that client's own settings; the session behind it is the
 * same one that paid; and Stripe's hosted portal is the only surface in the
 * product for any of those three acts. Without it the client could subscribe
 * and then had no way to change a card, read an invoice or cancel — a
 * subscription its payer cannot leave, which is not one they consented to.
 *
 * ⚠ Both doors share `principalFor`, which is the whole of the portal-path
 * tenancy check. `BillingPortalSessionRequest` carried no such guard of its own
 * (it had never needed one), so the principal and the guard had to arrive
 * together or the second door would have opened another business's invoices.
 */
@Controller('billing')
export class BillingController {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(BILLING_SERVICE) private readonly service: BillingService,
    @Inject(PORTAL_SESSION_CONTEXT) private readonly portalAuth: PortalSessionContextResolver,
  ) {}

  @Post('checkout-sessions')
  @HttpCode(HttpStatus.CREATED)
  async checkout(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<HostedBillingSession> {
    const key = parseIdempotencyKey(createCheckoutSessionHeader, idempotencyKey);
    const parsed = parseBoundary(createCheckoutSessionBody, body, 'request body');
    const ctx = await this.principalFor(parsed.businessId, authorization);
    return this.service.createCheckoutSession(ctx, parsed, key);
  }

  /**
   * Which of the two principals is asking, and the one rule that keeps the
   * second one honest.
   *
   * **A bearer means the portal, and it is judged as a portal session on its own
   * merits** — `resolveOnboarding` refuses a delegated (chase) session, an
   * unverified row and an expired one, so holding a cookie as well changes
   * nothing about the answer. No header at all is the accountant, unchanged.
   *
   * ⚠ **The 404 below is the WHOLE of the tenancy check on the portal path, and
   * it has to be.** `systemScopeFor` yields the practice SYSTEM context — it can
   * see every business in the practice — so RLS will not narrow this request;
   * the session row is the only thing that does. A body naming a different
   * business is **404, never 403**: a 403 would confirm the other business
   * exists, and a client holding a forwarded setup link does not get to
   * enumerate a practice. The upload path avoids this problem by giving
   * `PortalUploadRequest` no `businessId` at all; neither billing operation
   * can, because both request schemas are shared with the accountant, who
   * legitimately names which client they are acting for.
   *
   * ⚠ **Both `checkout` and `portal` call this, and that is deliberate rather
   * than tidy.** The customer-portal door gained its portal principal on
   * 2 Sep 2026 and had never carried a business check of its own; a copy of
   * this rule would be a second place for it to be right, and one of the two
   * would eventually not be.
   */
  private async principalFor(businessId: string, authorization: string | undefined): Promise<ScopeContext> {
    if (authorization === undefined || authorization.trim() === '') {
      // `require()` resolves the context inside Nest's pipeline, so a bad one
      // leaves as a 401 problem+json rather than an Express-level crash (#75).
      return this.context.require();
    }

    const facts = await this.portalAuth.resolveOnboarding(authorization);
    if (facts.businessId !== businessId) {
      throw new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No such client business.');
    }
    return systemScopeFor(facts);
  }

  /**
   * `POST /billing/portal-sessions` — the Stripe customer portal: change the
   * card, read an invoice, cancel.
   *
   * ⚠ **It gained the portal principal on 2 Sep 2026, and the guard came with
   * it in the same edit.** `BillingPortalSessionRequest` carries a `businessId`
   * and had none of checkout's "the body's business must equal the session's
   * own" check, because until now no session that could name a different
   * business could reach this operation. Adding the principal without the guard
   * would have let a client holding one workspace's portal bearer open
   * ANOTHER's billing portal — every invoice, the card, and cancellation. So
   * both halves are `principalFor`, which is shared with checkout rather than
   * copied: one rule, one place, and a future change to it cannot land on one
   * door and miss the other.
   *
   * The header on this class explains why it did NOT gain the principal in
   * #205, and why that reasoning has been overtaken: D48 makes the client the
   * payer, D49 gives them a Settings tab, and a subscription its payer cannot
   * leave is not one they consented to.
   */
  @Post('portal-sessions')
  @HttpCode(HttpStatus.CREATED)
  async portal(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<HostedBillingSession> {
    const key = parseIdempotencyKey(createBillingPortalSessionHeader, idempotencyKey);
    const parsed = parseBoundary(createBillingPortalSessionBody, body, 'request body');
    const ctx = await this.principalFor(parsed.businessId, authorization);
    return this.service.createPortalSession(ctx, parsed, key);
  }
}
