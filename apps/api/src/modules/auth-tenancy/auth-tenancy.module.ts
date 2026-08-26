import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BusinessesController } from './businesses.controller.js';
import { BusinessesService } from './businesses.service.js';
import { PracticeSignupService } from './practice-signup.service.js';
import { PracticesController } from './practices.controller.js';
import { RecordingSignupMailer, type SignupMailer } from './signup-mailer.js';
import { AUTH_SERVICE, BUSINESSES_SERVICE, PRACTICE_SIGNUP_SERVICE, PRISMA, SIGNUP_MAILER } from './tokens.js';

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
@Module({
  controllers: [AuthController, BusinessesController, PracticesController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: AUTH_SERVICE,
      useFactory: (prisma: PrismaClient, env: Env) => new AuthService(prisma, env),
      inject: [PRISMA, ENV],
    },
    {
      // ⚠ THE ONE LINE S2 CHANGES. `RecordingSignupMailer` sends nothing — the
      // notifications module has not merged, so A1 builds against its seam
      // (`signup-mailer.ts`) and the composition root swaps the implementation
      // when it lands. `PracticeSignupService` refuses to create an account at
      // all under NODE_ENV=production while this stand-in is what is wired, so
      // the gap cannot ship quietly.
      provide: SIGNUP_MAILER,
      useFactory: (): SignupMailer => new RecordingSignupMailer(),
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
