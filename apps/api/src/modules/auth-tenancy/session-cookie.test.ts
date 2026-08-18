import { createHmac } from 'node:crypto';

import { expect, test } from 'vitest';

import { SESSION_COOKIE_NAME, SESSION_TTL_MS, signSessionToken, verifySessionCookieHeader } from './session-cookie.js';

const SECRET = 'test-session-secret';
const NOW = 1_755_500_000_000; // fixed instant — expiry math must not depend on wall clock

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

test('roundtrip: a signed token verifies back to its userId', () => {
  const token = signSessionToken({ userId: 'usr_1', expiresAtMs: NOW + SESSION_TTL_MS }, SECRET);
  const verdict = verifySessionCookieHeader(cookieHeader(token), SECRET, NOW);
  expect(verdict).toEqual({ ok: true, userId: 'usr_1' });
});

test('the cookie is found among others, whitespace and all', () => {
  const token = signSessionToken({ userId: 'usr_1', expiresAtMs: NOW + 1000 }, SECRET);
  const header = `theme=dark; ${SESSION_COOKIE_NAME}=${token} ; other=1`;
  expect(verifySessionCookieHeader(header, SECRET, NOW)).toEqual({ ok: true, userId: 'usr_1' });
});

test('missing header, missing cookie and empty value are all `invalid` — one bucket, no oracle', () => {
  expect(verifySessionCookieHeader(undefined, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifySessionCookieHeader('theme=dark', SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifySessionCookieHeader(`${SESSION_COOKIE_NAME}=`, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
});

test('a tampered payload fails the signature, and is never parsed', () => {
  const token = signSessionToken({ userId: 'usr_1', expiresAtMs: NOW + 1000 }, SECRET);
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ userId: 'usr_2', expiresAtMs: NOW + 1000 })).toString('base64url');
  expect(verifySessionCookieHeader(cookieHeader(`${forged}.${sig}`), SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifySessionCookieHeader(cookieHeader(`${payload}.AAAA`), SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
});

test('a token signed with another secret is `invalid`', () => {
  const token = signSessionToken({ userId: 'usr_1', expiresAtMs: NOW + 1000 }, 'other-secret');
  expect(verifySessionCookieHeader(cookieHeader(token), SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
});

test('expiry is `expired`, distinctly — the UI may say "log in again"', () => {
  const token = signSessionToken({ userId: 'usr_1', expiresAtMs: NOW }, SECRET);
  expect(verifySessionCookieHeader(cookieHeader(token), SECRET, NOW)).toEqual({ ok: false, reason: 'expired' });
  expect(verifySessionCookieHeader(cookieHeader(token), SECRET, NOW - 1)).toEqual({ ok: true, userId: 'usr_1' });
});

test('an empty secret refuses to sign AND to verify — fail closed, never forgeable', () => {
  expect(() => signSessionToken({ userId: 'usr_1', expiresAtMs: NOW }, '')).toThrow(/SESSION_SECRET/);
  expect(() => verifySessionCookieHeader('nt_session=x.y', '', NOW)).toThrow(/SESSION_SECRET/);
});

test('claims missing their fields are `invalid` even when correctly signed', () => {
  // Correctly signed by the real secret, shaped wrong — a bug of ours (an old
  // signer, a future claim rename) must not become an open door.
  const payload = Buffer.from(JSON.stringify({ nope: true })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  expect(verifySessionCookieHeader(cookieHeader(`${payload}.${sig}`), SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
});
