import { createHmac } from 'node:crypto';

import { expect, test } from 'vitest';

import {
  type PortalSessionClaims,
  PORTAL_SESSION_TTL_MS,
  signPortalSessionToken,
  verifyPortalSessionHeader,
  verifyPortalSessionToken,
} from './portal-session-token.js';

const SECRET = 'test-portal-session-secret';
const NOW = 1_755_500_000_000; // fixed instant — expiry math must not depend on wall clock

function claims(over: Partial<PortalSessionClaims> = {}): PortalSessionClaims {
  return {
    otpSessionId: 'otp_1',
    businessId: 'biz_burger',
    practiceId: 'prac_1',
    expiresAtMs: NOW + PORTAL_SESSION_TTL_MS,
    ...over,
  };
}

test('roundtrip: a signed bearer verifies back to every claim it carried', () => {
  const token = signPortalSessionToken(claims(), SECRET);
  expect(verifyPortalSessionHeader(`Bearer ${token}`, SECRET, NOW)).toEqual({ ok: true, claims: claims() });
});

test('the scheme is case-insensitive and the credential is trimmed', () => {
  const token = signPortalSessionToken(claims(), SECRET);
  expect(verifyPortalSessionHeader(`bearer ${token}`, SECRET, NOW)).toEqual({ ok: true, claims: claims() });
  expect(verifyPortalSessionHeader(`BEARER   ${token}  `, SECRET, NOW)).toEqual({ ok: true, claims: claims() });
});

test('missing header, another scheme and an empty credential are all `invalid` — one bucket, no oracle', () => {
  expect(verifyPortalSessionHeader(undefined, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifyPortalSessionHeader('Basic abc', SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifyPortalSessionHeader('Bearer ', SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifyPortalSessionHeader('Bearer', SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifyPortalSessionToken('not-a-token', SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
});

test('a tampered payload fails the signature, and is never parsed', () => {
  const token = signPortalSessionToken(claims(), SECRET);
  const [payload, sig] = token.split('.');
  // The interesting forgery: keep the signature, swap the business — the whole
  // reason the tenant travels inside the envelope rather than beside it.
  const forged = Buffer.from(JSON.stringify(claims({ businessId: 'biz_someone_else' }))).toString('base64url');
  expect(verifyPortalSessionToken(`${forged}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifyPortalSessionToken(`${payload}.AAAA`, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
});

test('a bearer signed with another secret is `invalid`', () => {
  const token = signPortalSessionToken(claims(), 'some-other-secret');
  expect(verifyPortalSessionToken(token, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
});

test('the portal-link secret does NOT verify a portal session — the two secrets are separate on purpose', () => {
  const token = signPortalSessionToken(claims(), 'portal-link-secret');
  expect(verifyPortalSessionToken(token, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
});

test('expiry is `expired`, distinctly — the portal may say "the session lapsed, tap the link again"', () => {
  const token = signPortalSessionToken(claims({ expiresAtMs: NOW }), SECRET);
  expect(verifyPortalSessionToken(token, SECRET, NOW)).toEqual({ ok: false, reason: 'expired' });
  expect(verifyPortalSessionToken(token, SECRET, NOW - 1)).toEqual({ ok: true, claims: claims({ expiresAtMs: NOW }) });
});

test('an empty secret refuses to sign AND to verify — fail closed, never forgeable', () => {
  expect(() => signPortalSessionToken(claims(), '')).toThrow(/PORTAL_SESSION_SECRET/);
  expect(() => verifyPortalSessionHeader('Bearer x.y', '', NOW)).toThrow(/PORTAL_SESSION_SECRET/);
});

test('claims missing a field are `invalid` even when correctly signed', () => {
  // Correctly signed by the real secret, shaped wrong — an old signer or a
  // renamed claim is a bug of ours, and must not become an open door.
  for (const shape of [{ otpSessionId: 'otp_1' }, { ...claims(), businessId: '' }, { ...claims(), practiceId: undefined }]) {
    const payload = Buffer.from(JSON.stringify(shape)).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
    expect(verifyPortalSessionToken(`${payload}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  }
});
