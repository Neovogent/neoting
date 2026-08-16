import { AsyncLocalStorage } from 'node:async_hooks';

import { HttpStatus } from '@nestjs/common';

import type { ScopeContext } from '../db/scope-context.js';
import { AppException } from '../problem/problem.js';

/**
 * The request-context seam (issue #75).
 *
 * `scopedDb` needs a `ScopeContext` for every query, but the thing that
 * *produces* one for an HTTP request — auth/tenancy — is S1 and has not landed.
 * Rather than block, this defines the socket S1 plugs into: a `RequestContext`
 * a controller injects, backed by AsyncLocalStorage (the same house pattern as
 * `common/trace`), fed by a `ContextResolver` that is config-selected. When S1
 * arrives it replaces one provider — the session resolver — and nothing else in
 * any module moves.
 */

/** Reads a request header by name — the only thing a resolver needs from the request. */
export type HeaderReader = (name: string) => string | undefined;

/**
 * Turns the current request into a `ScopeContext`, or throws 401. The one seam
 * S1 replaces: today a header-reading fixture, tomorrow a real session resolver.
 */
export interface ContextResolver {
  resolve(headers: HeaderReader): ScopeContext;
}

/** What a controller injects (via the `REQUEST_CONTEXT` token). */
export interface RequestContext {
  /** The `ScopeContext` for the current request, or throws 401 `NT-AUTH-001`. */
  require(): ScopeContext;
}

/** The 401 every un-establishable context returns — RFC 7807 `NT-AUTH-001` via `ProblemFilter`. */
export function unauthenticated(detail: string): AppException {
  return new AppException('NT-AUTH-001', HttpStatus.UNAUTHORIZED, 'Authentication required', detail);
}

interface ContextStore {
  readonly headers: HeaderReader;
  resolved?: ScopeContext;
}

const storage = new AsyncLocalStorage<ContextStore>();

/** Open the per-request context store. Mirrors `runWithTrace` — capture at the edge, read in the work. */
export function runWithRequestContext<T>(headers: HeaderReader, fn: () => T): T {
  return storage.run({ headers }, fn);
}

/**
 * The real provider. Resolution is LAZY — deferred to `require()`, which runs
 * inside Nest's pipeline where `ProblemFilter` turns a bad context into a 401.
 * Doing it in the middleware would put the throw in Express-land, before the
 * filter can see it. The result is memoized so repeated `require()` calls in one
 * request are a single resolution.
 */
export class AlsRequestContext implements RequestContext {
  constructor(private readonly resolver: ContextResolver) {}

  require(): ScopeContext {
    const store = storage.getStore();
    if (store === undefined) {
      // Not "unauthenticated" — the middleware never ran, which is a wiring bug.
      // Fail loud (500) rather than dress a misconfiguration up as an auth outcome.
      throw new Error('RequestContext.require() called outside a request — ContextMiddleware is not wired');
    }
    store.resolved ??= this.resolver.resolve(store.headers);
    return store.resolved;
  }
}
