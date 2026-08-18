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
 * S1 replaces: a header-reading fixture in dev, the cookie-verifying session
 * resolver under `AUTH_MODE=session`.
 *
 * `resolve` may be async (S1's session resolver loads memberships from the
 * database); the fixture resolver stays synchronous and the seam accepts both.
 */
export interface ContextResolver {
  resolve(headers: HeaderReader): ScopeContext | Promise<ScopeContext>;
}

/** What a controller injects (via the `REQUEST_CONTEXT` token). */
export interface RequestContext {
  /** The `ScopeContext` for the current request, or rejects 401 `NT-AUTH-001`. */
  require(): Promise<ScopeContext>;
}

/** The 401 every un-establishable context returns — RFC 7807 `NT-AUTH-001` via `ProblemFilter`. */
export function unauthenticated(detail: string): AppException {
  return new AppException('NT-AUTH-001', HttpStatus.UNAUTHORIZED, 'Authentication required', detail);
}

/** A session that WAS valid and ran out — `NT-AUTH-002`, so the UI can say "log in again" rather than "who are you". */
export function sessionExpired(detail: string): AppException {
  return new AppException('NT-AUTH-002', HttpStatus.UNAUTHORIZED, 'Session expired', detail);
}

interface ContextStore {
  readonly headers: HeaderReader;
  resolved?: Promise<ScopeContext>;
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
 * filter can see it. The result is memoized as a promise so repeated
 * `require()` calls in one request are a single resolution — including a single
 * membership lookup on the session path.
 */
export class AlsRequestContext implements RequestContext {
  constructor(private readonly resolver: ContextResolver) {}

  require(): Promise<ScopeContext> {
    const store = storage.getStore();
    if (store === undefined) {
      // Not "unauthenticated" — the middleware never ran, which is a wiring bug.
      // Fail loud (500) rather than dress a misconfiguration up as an auth outcome.
      throw new Error('RequestContext.require() called outside a request — ContextMiddleware is not wired');
    }
    // A SYNCHRONOUS resolver throw (the fixture path) is deliberately not
    // memoized — `store.resolved` stays unset and the throw propagates. That is
    // fine: the same headers produce the same throw on a retry, and an async
    // rejection IS memoized, which is the case that costs a database round-trip.
    store.resolved ??= Promise.resolve(this.resolver.resolve(store.headers));
    return store.resolved;
  }
}
