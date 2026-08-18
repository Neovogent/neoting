import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { ScopeContext } from '../db/scope-context.js';
import { AppException } from '../problem/problem.js';
import { AlsRequestContext, type HeaderReader, runWithRequestContext } from './request-context.js';
import { selectContextResolver } from './select-context-resolver.js';
import type { SessionContextDeps } from './session-context-resolver.js';

/** A header reader over a plain map (Node lower-cases header names). */
function headers(map: Record<string, string>): HeaderReader {
  return (name) => map[name.toLowerCase()];
}

/**
 * Session deps that must never be reached — fixture-mode tests pass these to
 * prove mode selection, and a call into either is exactly the bug it would be.
 */
const unreachableSessionDeps: SessionContextDeps = {
  verifyCookieHeader: () => {
    throw new Error('unreachable — fixture mode must not consult the session verifier');
  },
  loadScopeForUser: () => {
    throw new Error('unreachable — fixture mode must not load memberships');
  },
};

/** Deps returning a canned verdict + scope, for exercising the session path without a database. */
function sessionDeps(over: Partial<SessionContextDeps> = {}): SessionContextDeps {
  return {
    verifyCookieHeader: () => ({ ok: true, userId: 'usr_1' }),
    loadScopeForUser: (userId) =>
      Promise.resolve({ actorId: userId, practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] } as ScopeContext),
    ...over,
  };
}

const fixtureContext = new AlsRequestContext(selectContextResolver('fixture', unreachableSessionDeps));

test('fixture mode: valid headers build a ScopeContext, ready for scopedDb with no casting', async () => {
  const ctx = await runWithRequestContext(headers({ 'x-nt-actor': 'usr_1', 'x-nt-practice': 'prac_1' }), () =>
    fixtureContext.require(),
  );
  expect(ctx.actorId).toBe('usr_1');
  expect(ctx.practiceId).toBe('prac_1');
  expect(ctx.sessionScope).toBe('user'); // schema default applied
});

test('fixture mode: a business-only context is built (a standalone business has no practice)', async () => {
  const ctx = await runWithRequestContext(headers({ 'x-nt-actor': 'usr_1', 'x-nt-business': 'biz_1' }), () =>
    fixtureContext.require(),
  );
  expect(ctx.businessId).toBe('biz_1');
  expect(ctx.practiceId).toBeUndefined();
});

test('fixture mode: a missing actor is a 401 NT-AUTH-001, not an empty context', async () => {
  const err = await grab(() => runWithRequestContext(headers({ 'x-nt-practice': 'prac_1' }), () => fixtureContext.require()));
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  expect((err as AppException).code).toBe('NT-AUTH-001');
});

test('fixture mode: an actor with neither practice nor business is refused (would read empty in SQL)', async () => {
  const err = await grab(() => runWithRequestContext(headers({ 'x-nt-actor': 'usr_1' }), () => fixtureContext.require()));
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).code).toBe('NT-AUTH-001');
});

test('resolution is memoized — one resolve per request even across many require() calls', async () => {
  let loads = 0;
  const counted = new AlsRequestContext(
    selectContextResolver(
      'session',
      sessionDeps({
        loadScopeForUser: (userId) => {
          loads += 1;
          return Promise.resolve({ actorId: userId, practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] } as ScopeContext);
        },
      }),
    ),
  );
  const [a, b] = await runWithRequestContext(headers({}), () => Promise.all([counted.require(), counted.require()]));
  expect(a).toBe(b); // same object instance, not merely equal
  expect(loads).toBe(1); // one membership lookup per request, however many queries run
});

test('session mode: a valid cookie resolves to the scope its memberships build', async () => {
  const sessionContext = new AlsRequestContext(selectContextResolver('session', sessionDeps()));
  const ctx = await runWithRequestContext(headers({ cookie: 'nt_session=whatever' }), () => sessionContext.require());
  expect(ctx.actorId).toBe('usr_1');
  expect(ctx.practiceId).toBe('prac_1');
});

test('session mode: an invalid cookie is 401 NT-AUTH-001 with ONE detail for missing/malformed/forged', async () => {
  const sessionContext = new AlsRequestContext(
    selectContextResolver('session', sessionDeps({ verifyCookieHeader: () => ({ ok: false, reason: 'invalid' }) })),
  );
  const err = await grab(() => runWithRequestContext(headers({}), () => sessionContext.require()));
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).code).toBe('NT-AUTH-001');
});

test('session mode: an expired cookie is 401 NT-AUTH-002 — the one distinction safe to reveal', async () => {
  const sessionContext = new AlsRequestContext(
    selectContextResolver('session', sessionDeps({ verifyCookieHeader: () => ({ ok: false, reason: 'expired' }) })),
  );
  const err = await grab(() => runWithRequestContext(headers({}), () => sessionContext.require()));
  expect((err as AppException).code).toBe('NT-AUTH-002');
  expect((err as AppException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
});

test('session mode: a valid cookie whose user has no memberships is 401, not an empty workspace', async () => {
  const sessionContext = new AlsRequestContext(
    selectContextResolver('session', sessionDeps({ loadScopeForUser: () => Promise.resolve(null) })),
  );
  const err = await grab(() => runWithRequestContext(headers({}), () => sessionContext.require()));
  expect((err as AppException).code).toBe('NT-AUTH-001');
});

test('require() outside any request is a wiring bug, not a 401', async () => {
  const err = await grab(() => fixtureContext.require());
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(AppException);
});

/** Run a thunk (sync or async), return whatever it throws/rejects with (or undefined). */
async function grab(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
