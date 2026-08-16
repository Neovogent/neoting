import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import { AppException } from '../problem/problem.js';
import { AlsRequestContext, type HeaderReader, runWithRequestContext } from './request-context.js';
import { selectContextResolver } from './select-context-resolver.js';

/** A header reader over a plain map (Node lower-cases header names). */
function headers(map: Record<string, string>): HeaderReader {
  return (name) => map[name.toLowerCase()];
}

const fixtureContext = new AlsRequestContext(selectContextResolver('fixture'));

test('fixture mode: valid headers build a ScopeContext, ready for scopedDb with no casting', () => {
  const ctx = runWithRequestContext(headers({ 'x-nt-actor': 'usr_1', 'x-nt-practice': 'prac_1' }), () =>
    fixtureContext.require(),
  );
  expect(ctx.actorId).toBe('usr_1');
  expect(ctx.practiceId).toBe('prac_1');
  expect(ctx.sessionScope).toBe('user'); // schema default applied
});

test('fixture mode: a business-only context is built (a standalone business has no practice)', () => {
  const ctx = runWithRequestContext(headers({ 'x-nt-actor': 'usr_1', 'x-nt-business': 'biz_1' }), () =>
    fixtureContext.require(),
  );
  expect(ctx.businessId).toBe('biz_1');
  expect(ctx.practiceId).toBeUndefined();
});

test('fixture mode: a missing actor is a 401 NT-AUTH-001, not an empty context', () => {
  const err = grab(() => runWithRequestContext(headers({ 'x-nt-practice': 'prac_1' }), () => fixtureContext.require()));
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  expect((err as AppException).code).toBe('NT-AUTH-001');
});

test('fixture mode: an actor with neither practice nor business is refused (would read empty in SQL)', () => {
  const err = grab(() => runWithRequestContext(headers({ 'x-nt-actor': 'usr_1' }), () => fixtureContext.require()));
  expect(err).toBeInstanceOf(AppException);
  expect((err as AppException).code).toBe('NT-AUTH-001');
});

test('resolution is memoized — one resolve per request even across many require() calls', () => {
  const [a, b] = runWithRequestContext(headers({ 'x-nt-actor': 'usr_1', 'x-nt-practice': 'prac_1' }), () => [
    fixtureContext.require(),
    fixtureContext.require(),
  ]);
  expect(a).toBe(b); // same object instance, not merely equal
});

test('session mode: not implemented yet (S1 fills it in)', () => {
  const sessionContext = new AlsRequestContext(selectContextResolver('session'));
  const err = grab(() =>
    runWithRequestContext(headers({ 'x-nt-actor': 'usr_1', 'x-nt-practice': 'prac_1' }), () => sessionContext.require()),
  );
  expect((err as Error).message).toMatch(/not implemented/i);
});

test('require() outside any request is a wiring bug, not a 401', () => {
  const err = grab(() => fixtureContext.require());
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(AppException);
});

/** Run a thunk, return whatever it throws (or undefined). */
function grab(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
