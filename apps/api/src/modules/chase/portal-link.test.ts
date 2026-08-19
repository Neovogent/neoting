import { expect, test } from 'vitest';

import { signPortalLink, verifyPortalLink } from './portal-link.js';

const SECRET = 'test-portal-secret-0000000000000000';

test('a freshly-signed link round-trips to its chaseId', () => {
  const token = signPortalLink({ chaseId: 'chase_1', expSeconds: 3600 }, SECRET);
  const result = verifyPortalLink(token, SECRET);
  expect(result).toEqual({ ok: true, chaseId: 'chase_1' });
});

test('a tampered payload fails the signature (invalid), never resolves to a chase', () => {
  const token = signPortalLink({ chaseId: 'chase_1' }, SECRET);
  const [, sig] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ chaseId: 'chase_other', expiresAtMs: Date.now() + 1000 })).toString('base64url')}.${sig}`;
  expect(verifyPortalLink(forged, SECRET)).toEqual({ ok: false, reason: 'invalid' });
});

test('a link signed with another secret is invalid', () => {
  const token = signPortalLink({ chaseId: 'chase_1' }, SECRET);
  expect(verifyPortalLink(token, 'a-different-secret-1111111111111111')).toEqual({ ok: false, reason: 'invalid' });
});

test('an expired link is reported as expired, distinct from invalid', () => {
  const token = signPortalLink({ chaseId: 'chase_1', expSeconds: 1 }, SECRET, 0);
  // Verify at a time well past the 1s expiry.
  expect(verifyPortalLink(token, SECRET, 10_000)).toEqual({ ok: false, reason: 'expired' });
});

test('a garbage token is invalid, not a throw', () => {
  expect(verifyPortalLink('not-a-token', SECRET)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifyPortalLink('', SECRET)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifyPortalLink('.', SECRET)).toEqual({ ok: false, reason: 'invalid' });
});

test('fail-closed: an empty secret refuses to sign or verify', () => {
  expect(() => signPortalLink({ chaseId: 'chase_1' }, '')).toThrow('PORTAL_LINK_SECRET is empty');
  expect(() => verifyPortalLink('a.b', '')).toThrow('PORTAL_LINK_SECRET is empty');
});
