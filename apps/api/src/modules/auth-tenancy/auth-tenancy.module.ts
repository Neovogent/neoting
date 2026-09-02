import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BusinessesController } from './businesses.controller.js';
import { BusinessesService } from './businesses.service.js';
import {
  NOTIFICATIONS_SERVICE,
  type NotificationsService,
  NotificationsModule,
} from '../notifications/index.js';
import { EmailVerificationService } from './email-verification.service.js';
import { InvitationAcceptanceService } from './invitation-acceptance.service.js';
import { NotificationsSignupMailer } from './notifications-signup-mailer.js';
import { PracticeSignupService } from './practice-signup.service.js';
import { PracticesController } from './practices.controller.js';
import { InMemorySignInThrottle, type SignInThrottle } from './sign-in-throttle.js';
import type { SignupMailer } from './signup-mailer.js';
import { SignupChainController } from './signup-chain.controller.js';
import { TotpEnrolmentService } from './totp-enrolment.service.js';
import {
  AUTH_SERVICE,
  BUSINESSES_SERVICE,
  EMAIL_VERIFICATION_SERVICE,
  INVITATION_ACCEPTANCE_SERVICE,
  PRACTICE_SIGNUP_SERVICE,
  PRISMA,
  SIGN_IN_THROTTLE,
  SIGNUP_MAILER,
  TOTP_ENROLMENT_SERVICE,
} from './tokens.js';

/**
 * The demo-auth surface (METH Stage 1, issue #118). The Prisma client is the
 * shared pooled one (Governance §5.1), received rather than constructed; it
 * connects as `nt_app`, so `/me`'s queries only see what RLS allows.
 *
 * The OTHER half of session auth — cookie → `ScopeContext` on every request —
 * is not wired here: `common/context/context.module.ts` composes this module's
 * seam exports (`verifySessionCookieHeader`, `loadScopeForUser`) into the
 * `SessionContextResolver`. This module owns the pieces; the context module
 * owns the assembly.
 */
/**
 * ✅ **The signup verification link's origin is `env.APP_ORIGIN` now.**
 *
 * It was the constant `https://neoacc.neovogent.com`, carried here because
 * `config/env.ts` had no public web origin at the time and `config/` was not
 * A1's to change. The key exists (the chase lane added it, defaulting to
 * `https://app.neoting.neovogent.com`), so the constant is gone and this mail,
 * the client setup link and the chase portal link now all read one value.
 *
 * ⚠ **The argument the constant carried survives as an operator instruction, so
 * do not lose it.** Both hostnames are aliases on the same CloudFront
 * distribution, so either resolves — but a practice signs up on ONE of them, and
 * the first thing we send them is a link asking them to click through and
 * confirm their identity. A different hostname in that mail from the one they
 * just used is precisely the shape of a phishing mail, to an audience trained to
 * distrust exactly that. **`APP_ORIGIN` must be set to the host customers
 * actually arrive on**, in every environment; the default is a fallback, not a
 * decision.
 */

@Module({
  imports: [NotificationsModule],
  controllers: [AuthController, BusinessesController, PracticesController, SignupChainController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      // ⚠ ONE INSTANCE FOR THE PROCESS. Nest providers are singletons by
      // default and this one depends on it: a throttle rebuilt per request
      // counts every attempt as the first. The counters are in memory, so the
      // ceiling is really per API task — `sign-in-throttle.ts` states the cost
      // and names the Redis follow-up.
      provide: SIGN_IN_THROTTLE,
      useFactory: (): SignInThrottle => new InMemorySignInThrottle(),
    },
    {
      provide: AUTH_SERVICE,
      useFactory: (prisma: PrismaClient, env: Env, throttle: SignInThrottle) => new AuthService(prisma, env, throttle),
      inject: [PRISMA, ENV, SIGN_IN_THROTTLE],
    },
    {
      // The QR-enrolment half of A2, routed by A14 (`SignupChainController`).
      //
      // ⚠ IT TAKES THE SAME THROTTLE INSTANCE AS `AuthService`, and that is the
      // point of injecting it rather than constructing one here. Enrolment
      // checks a password with NO second factor in front of it, so it is the
      // cheaper of the two endpoints to guess against; a counter of its own
      // would mean ten guesses at `/auth/sessions` plus ten more here, per
      // window, for the same address.
      provide: TOTP_ENROLMENT_SERVICE,
      useFactory: (prisma: PrismaClient, env: Env, throttle: SignInThrottle) => new TotpEnrolmentService(prisma, env, throttle),
      inject: [PRISMA, ENV, SIGN_IN_THROTTLE],
    },
    {
      // A14's other half: the endpoint that spends A1's verification token.
      // Shares the throttle too, though it keys on a hash of the token rather
      // than on an address — see `email-verification.service.ts` for why that
      // bounds one link rather than one caller, and what it would take to
      // bound a caller.
      provide: EMAIL_VERIFICATION_SERVICE,
      useFactory: (prisma: PrismaClient, env: Env, throttle: SignInThrottle) => new EmailVerificationService(prisma, env, throttle),
      inject: [PRISMA, ENV, SIGN_IN_THROTTLE],
    },
    {
      // The colleague's way in. Shares the throttle for the third time, keyed on
      // a hash of the invitation token under its own `inv:` prefix — three
      // disjoint key spaces on one counter, so no path can lock another out.
      // It takes no `Env`: nothing here signs anything, because the invitation
      // is a database row rather than an HMAC (`setup-link.ts`).
      provide: INVITATION_ACCEPTANCE_SERVICE,
      useFactory: (prisma: PrismaClient, throttle: SignInThrottle) => new InvitationAcceptanceService(prisma, throttle),
      inject: [PRISMA, SIGN_IN_THROTTLE],
    },
    {
      // ✅ **THE LINE A1 LEFT FOR S2, CONNECTED.** It said: *"the composition
      // root swaps the implementation when it lands"*. S2 landed and nothing
      // swapped it, so `RecordingSignupMailer` — which sends nothing — stayed
      // wired, `PracticeSignupService` kept refusing every signup under
      // NODE_ENV=production, and signup was therefore dead on staging. A14's
      // `POST /v1/auth/email-verification` had no mail to consume either.
      //
      // ✅ The origin is `env.APP_ORIGIN` — the one line the old comment here
      // said promoting it would be. See the note above the class for the
      // operator instruction that survived the constant.
      provide: SIGNUP_MAILER,
      useFactory: (notifications: NotificationsService, env: Env): SignupMailer =>
        new NotificationsSignupMailer(notifications, env.APP_ORIGIN),
      inject: [NOTIFICATIONS_SERVICE, ENV],
    },
    {
      provide: PRACTICE_SIGNUP_SERVICE,
      // The idempotency store is the shared in-memory one, per-process, exactly
      // as the proposal engine and web-upload use it (common/idempotency —
      // there is no idempotency table, prisma/ is LAW). A durable store is the
      // known follow-up for all three at once.
      useFactory: (prisma: PrismaClient, env: Env, mailer: SignupMailer) =>
        new PracticeSignupService(prisma, env, mailer, new InMemoryIdempotencyStore()),
      inject: [PRISMA, ENV, SIGNUP_MAILER],
    },
    {
      // The businesses read surface (`GET /v1/businesses`) lives in this
      // module because businesses ARE this module's nouns ("practices,
      // businesses, users, memberships" — its stated purpose), and the list
      // is the same RLS-visible set `/me` reports, from the same context.
      provide: BUSINESSES_SERVICE,
      useFactory: (prisma: PrismaClient) => new BusinessesService(prisma),
      inject: [PRISMA],
    },
  ],
})
export class AuthTenancyModule {}
