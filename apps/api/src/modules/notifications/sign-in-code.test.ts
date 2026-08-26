import { inspect } from 'node:util';

import { expect, test } from 'vitest';

import { REDACTED, SignInCode } from './sign-in-code.js';

/**
 * These are the tests that make S2's "the code is a CREDENTIAL" rule mechanical
 * rather than aspirational. Each one pins a path by which a value accidentally
 * becomes text — and each of those paths is a real way credentials have leaked
 * into logs in other systems, not a hypothetical.
 */

const code = SignInCode.parse('123456');

test('template interpolation yields the redaction, not the code', () => {
  expect(`your code is ${code}`).toBe(`your code is ${REDACTED}`);
  expect(String(code)).toBe(REDACTED);
  // Concatenation goes through the same `toString`, and is what a hurried
  // `logger.log('otp ' + code)` produces.
  expect(`otp ${String(code)}`).not.toContain('123456');
});

test('JSON.stringify yields the redaction — the error-handler path', () => {
  expect(JSON.stringify({ code })).toBe(`{"code":"${REDACTED}"}`);
  expect(JSON.stringify({ input: { to: 'a@b.com', code } })).not.toContain('123456');
});

test('util.inspect yields the redaction — the Nest Logger path', () => {
  // Nest's Logger inspects objects rather than stringifying them, so this is
  // the path a `logger.log('sending', input)` actually takes.
  expect(inspect(code)).toBe(REDACTED);
  expect(inspect({ code }, { depth: 5 })).not.toContain('123456');
});

test('the value is a true #private, so it is not an enumerable property', () => {
  // TypeScript's `private` is compile-time only; a `private` field would show
  // up here and every guarantee above would be decorative.
  expect(Object.keys(code)).toHaveLength(0);
  expect(Object.getOwnPropertyNames(code)).toHaveLength(0);
});

test('reveal is the one door out', () => {
  expect(code.reveal()).toBe('123456');
});

test('a code that is not six digits is refused, and the message does not echo it', () => {
  for (const bad of ['12345', '1234567', '12345a', '', ' 123456', '123 456']) {
    expect(() => SignInCode.parse(bad)).toThrow(/exactly six digits/);
    try {
      SignInCode.parse(bad);
    } catch (error) {
      // An invalid-code error is precisely the kind of thing that gets logged.
      // (The empty string is skipped because every string contains it.)
      if (bad.trim() !== '') expect((error as Error).message).not.toContain(bad.trim());
    }
  }
});
