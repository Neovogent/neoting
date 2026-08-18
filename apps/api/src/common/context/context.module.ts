import { Global, Module } from '@nestjs/common';

import { getPrismaClient } from '../db/prisma.js';
import { loadScopeForUser, verifySessionCookieHeader } from '../../modules/auth-tenancy/index.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { AlsRequestContext, type ContextResolver, type RequestContext } from './request-context.js';
import { selectContextResolver } from './select-context-resolver.js';

/** DI token for the {@link RequestContext}. Inject with `@Inject(REQUEST_CONTEXT)`. */
export const REQUEST_CONTEXT = Symbol('REQUEST_CONTEXT');

const CONTEXT_RESOLVER = Symbol('CONTEXT_RESOLVER');

/**
 * Global so any controller injects `REQUEST_CONTEXT` without re-importing. The
 * resolver is chosen once, at boot, from `AUTH_MODE`; the provider reads the
 * per-request store lazily on `require()`.
 *
 * The auth-tenancy import is ASSEMBLY, and it goes through that module's public
 * seam (`index.ts`) only. This is the one place the session resolver's two
 * collaborators — the cookie verifier and the membership loader — meet the
 * resolver class, which itself lives in `common/` and receives them as plain
 * functions. Both closures are lazy: nothing touches the database, and nothing
 * demands `SESSION_SECRET`, until a session-mode request actually arrives — so
 * `AUTH_MODE=fixture` boots identically to before, and a session-mode process
 * with no secret fails closed per request (loudly, as a 500 naming the
 * variable) rather than failing the /healthz that keeps the deploy alive.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONTEXT_RESOLVER,
      useFactory: (env: Env): ContextResolver =>
        selectContextResolver(env.AUTH_MODE, {
          verifyCookieHeader: (cookieHeader) => verifySessionCookieHeader(cookieHeader, env.SESSION_SECRET),
          loadScopeForUser: (userId) => loadScopeForUser(getPrismaClient(), userId),
        }),
      inject: [ENV],
    },
    { provide: REQUEST_CONTEXT, useFactory: (resolver: ContextResolver): RequestContext => new AlsRequestContext(resolver), inject: [CONTEXT_RESOLVER] },
  ],
  exports: [REQUEST_CONTEXT],
})
export class ContextModule {}
