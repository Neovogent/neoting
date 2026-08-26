import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { AppException } from '../../common/problem/problem.js';
import { assertAllowedReturnUrl, parseAllowedOrigins } from './return-url.js';

const ALLOWED = parseAllowedOrigins('https://app.neoting.neovogent.com, http://localhost:5173');

test('a URL on an allowed origin is returned unchanged', () => {
  const url = 'https://app.neoting.neovogent.com/app/clients/biz_1?subscribed=1#plan';
  expect(assertAllowedReturnUrl(url, ALLOWED, 'successUrl')).toBe(url);
});

test('THE PREFIX ATTACK: a look-alike host that startsWith() would have admitted', () => {
  // `'https://app.neoting.neovogent.com.attacker.example'.startsWith(allowed)`
  // is true. Origin equality is what makes this impossible rather than unlikely.
  expect(() =>
    assertAllowedReturnUrl('https://app.neoting.neovogent.com.attacker.example/steal', ALLOWED, 'successUrl'),
  ).toThrow();
  expect(() => assertAllowedReturnUrl('https://app.neoting.neovogent.com@evil.example/', ALLOWED, 'successUrl')).toThrow();
});

test('scheme and port are part of the origin', () => {
  expect(() => assertAllowedReturnUrl('http://app.neoting.neovogent.com/app', ALLOWED, 'successUrl')).toThrow();
  expect(() => assertAllowedReturnUrl('http://localhost:5174/app', ALLOWED, 'successUrl')).toThrow();
  expect(assertAllowedReturnUrl('http://localhost:5173/app', ALLOWED, 'successUrl')).toBeTruthy();
});

test('a non-http scheme is refused even though URL() happily parses it', () => {
  // `new URL('javascript:alert(1)').origin` is the STRING "null", which would
  // sail through a naive `allowed.has(origin)` if "null" were ever in the set.
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'mailto:a@b.example']) {
    expect(() => assertAllowedReturnUrl(url, ALLOWED, 'cancelUrl')).toThrow();
  }
});

test('a relative or unparseable URL is refused', () => {
  for (const url of ['/app/clients', '//evil.example/app', 'not a url', '']) {
    expect(() => assertAllowedReturnUrl(url, ALLOWED, 'returnUrl')).toThrow();
  }
});

test('the refusal is a 400 NT-VAL-001 that names the field and never echoes the URL', () => {
  let thrown: AppException | undefined;
  try {
    assertAllowedReturnUrl('https://evil.example/steal?token=secret', ALLOWED, 'successUrl');
  } catch (error) {
    thrown = error as AppException;
  }
  expect(thrown?.code).toBe('NT-VAL-001');
  expect(thrown?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(thrown?.fieldErrors?.[0]?.field).toBe('successUrl');
  expect(JSON.stringify(thrown?.fieldErrors)).not.toContain('evil.example');
  expect(thrown?.publicDetail ?? '').not.toContain('secret');
});

test('an empty allowlist admits nothing — closed, not open', () => {
  const none = parseAllowedOrigins('');
  expect(none.size).toBe(0);
  expect(() => assertAllowedReturnUrl('https://app.neoting.neovogent.com/', none, 'successUrl')).toThrow();
});

test('origins are normalised, so a trailing slash, a path or odd casing all still match', () => {
  const parsed = parseAllowedOrigins('https://APP.Neoting.Neovogent.com/, https://other.example/some/path');
  expect([...parsed].sort()).toEqual(['https://app.neoting.neovogent.com', 'https://other.example']);
});

test('a malformed entry is dropped rather than taking the process down', () => {
  // Composition-time parsing: throwing on one typo would break /healthz for
  // every request, and dropping fails closed for that origin alone.
  const parsed = parseAllowedOrigins('https://good.example, ???, ,https://also-good.example');
  expect([...parsed].sort()).toEqual(['https://also-good.example', 'https://good.example']);
});
