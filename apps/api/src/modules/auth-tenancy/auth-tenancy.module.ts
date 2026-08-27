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
 * The public web origin the signup verification link points at.
 *
 * ⚠ **`neoacc.`, not `app.neoting.` — and the difference is the customer's
 * confidence, not tidiness.** Both names are aliases on the same CloudFront
 * distribution, so either resolves. But a practice signs up at
 * `neoacc.neovogent.com`, and the first thing we send them is a link asking
 * them to click through to confirm their identity. A different hostname in that
 * mail than the one they just used is precisely the shape of a phishing mail,
 * to an audience — accountants — trained to distrust exactly that.
 *
 * `clients-team-settings/setup-link.ts` still carries `app.neoting.` for the
 * CLIENT setup link and should follow this. Both remain constants because
 * `config/env.ts` has no `APP_ORIGIN` key, and both point at that same gap.
 */
const SIGNUP_APP_ORIGIN = 'https://neoacc.neovogent.com';

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
      // ✅ **THE LINE A1 LEFT FOR S2, CONNECTED.** It said: *"the composition
      // root swaps the implementation when it lands"*. S2 landed and nothing
      // swapped it, so `RecordingSignupMailer` — which sends nothing — stayed
      // wired, `PracticeSignupService` kept refusing every signup under
      // NODE_ENV=production, and signup was therefore dead on staging. A14's
      // `POST /v1/auth/email-verification` had no mail to consume either.
      //
      // The origin is a constant for the reason `setup-link.ts` gives: there is
      // no APP_ORIGIN key in `config/env.ts`, and adding one is a `config/`
      // change. It is an argument rather than a literal so promoting it later
      // is this line and nothing else.
      provide: SIGNUP_MAILER,
      useFactory: (notifications: NotificationsService): SignupMailer =>
        new NotificationsSignupMailer(notifications, SIGNUP_APP_ORIGIN),
      inject: [NOTIFICATIONS_SERVICE],
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
