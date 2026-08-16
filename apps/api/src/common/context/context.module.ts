import { Global, Module } from '@nestjs/common';

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
 */
@Global()
@Module({
  providers: [
    { provide: CONTEXT_RESOLVER, useFactory: (env: Env): ContextResolver => selectContextResolver(env.AUTH_MODE), inject: [ENV] },
    { provide: REQUEST_CONTEXT, useFactory: (resolver: ContextResolver): RequestContext => new AlsRequestContext(resolver), inject: [CONTEXT_RESOLVER] },
  ],
  exports: [REQUEST_CONTEXT],
})
export class ContextModule {}
