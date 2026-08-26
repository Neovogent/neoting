import { expect, test } from 'vitest';

import {
  buildSetupLink,
  DEFAULT_APP_ORIGIN,
  hashSetupToken,
  mintSetupToken,
  SETUP_LINK_TTL_DAYS,
  setupLinkExpiry,
  setupTokenHashEquals,
} from './setup-link.js';

test('two setup tokens are never the same, and neither is guessable from the other', () => {
  const tokens = new Set(Array.from({ length: 200 }, () => mintSetupToken()));

  expect(tokens.size).toBe(200);
  // base64url of 32 bytes: 43 characters, no padding, nothing an email client
  // or a URL parser will mangle.
  for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

test('only the hash is storable — the token cannot be recovered from what the row holds', () => {
  const token = mintSetupToken();
  const hash = hashSetupToken(token);

  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(hash).not.toContain(token);
  expect(token).not.toContain(hash);
});

test('hashing is stable, so the verifier (A2) finds the row the mint wrote', () => {
  const token = mintSetupToken();

  expect(hashSetupToken(token)).toBe(hashSetupToken(token));
  expect(hashSetupToken(`${token}x`)).not.toBe(hashSetupToken(token));
});

test('digest comparison is exact, and a length mismatch is not an exception', () => {
  const hash = hashSetupToken('a');

  expect(setupTokenHashEquals(hash, hash)).toBe(true);
  expect(setupTokenHashEquals(hash, hashSetupToken('b'))).toBe(false);
  // timingSafeEqual throws on unequal lengths; a truncated digest must be a
  // `false`, not a 500 on someone's sign-in.
  expect(setupTokenHashEquals(hash, hash.slice(0, 10))).toBe(false);
});

test('the link carries the token under the name the portal contract uses', () => {
  const link = buildSetupLink(DEFAULT_APP_ORIGIN, 'tok-en+/with special');

  expect(link.startsWith(`${DEFAULT_APP_ORIGIN}/app/setup?setupToken=`)).toBe(true);
  // Encoded, because a real base64url token is safe but the encoder must not be
  // the thing standing between us and a `+` becoming a space.
  expect(link).toContain('tok-en%2B%2Fwith%20special');
});

test('a trailing slash on the origin does not produce a double slash in the link', () => {
  expect(buildSetupLink('https://app.example.test/', 'abc')).toBe('https://app.example.test/app/setup?setupToken=abc');
});

test('the link expires in seven days, stated in UTC', () => {
  const noon = Date.parse('2026-08-26T12:00:00.000Z');

  expect(SETUP_LINK_TTL_DAYS).toBe(7);
  expect(setupLinkExpiry(noon).toISOString()).toBe('2026-09-02T12:00:00.000Z');
});
