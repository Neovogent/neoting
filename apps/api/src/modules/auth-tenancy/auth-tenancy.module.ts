import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AUTH_SERVICE, PRISMA } from './tokens.js';

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
  controllers: [AuthController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: AUTH_SERVICE,
      useFactory: (prisma: PrismaClient, env: Env) => new AuthService(prisma, env),
      inject: [PRISMA, ENV],
    },
  ],
})
export class AuthTenancyModule {}
