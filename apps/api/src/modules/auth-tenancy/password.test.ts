import { expect, test } from 'vitest';

import { DEMO_CREDENTIALS, verifyDemoPassword } from './demo-credentials.js';
import { EMAIL_VERIFICATION_TTL_MS, signEmailVerificationToken, verifyEmailVerificationToken } from './email-verification.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPasswordHash } from './password.js';
import { signSessionToken, verifySessionCookieHeader } from './session-cookie.js';

const SECRET = 'test-session-secret';

test('ONE scheme: the published demo fixtures verify through the same function A1 hashes with', () => {
  // This is the assertion that keeps "do not introduce a second scheme" true.
  // If `password.ts` ever changes format, salt handling or key length, these
  // two hashes — generated long before it existed — stop matching.
  expect(verifyPasswordHash('demo-neoting-2026', DEMO_CREDENTIALS['shakib@neoting.test']!.scryptHash)).toBe(true);
  expect(verifyPasswordHash('wrong', DEMO_CREDENTIALS['shakib@neoting.test']!.scryptHash)).toBe(false);
});

test('a fresh hash is salted — the same password twice gives two different hashes, both verifying', () => {
  const a = hashPassword('a-perfectly-good-passphrase');
  const b = hashPassword('a-perfectly-good-passphrase');
  expect(a).not.toBe(b);
  expect(verifyPasswordHash('a-perfectly-good-passphrase', a)).toBe(true);
  expect(verifyPasswordHash('a-perfectly-good-passphrase', b)).toBe(true);
});

test('a malformed stored hash is a failed verification, never a throw', () => {
  for (const stored of ['', 'nonsense', 'argon2$salt$hash', 'scrypt$$', 'scrypt$salt$', '$$']) {
    expect(verifyPasswordHash('anything', stored)).toBe(false);
  }
  // The timing dummy is well-formed and matches nothing.
  expect(verifyPasswordHash('anything', DUMMY_PASSWORD_HASH)).toBe(false);
});

test('the demo table is refused under NODE_ENV=production and honoured everywhere else', () => {
  expect(verifyDemoPassword('shakib@neoting.test', 'demo-neoting-2026', 'production')).toBeNull();
  expect(verifyDemoPassword('shakib@neoting.test', 'demo-neoting-2026', 'development')).toBe('usr_shakib_demo');
  expect(verifyDemoPassword('shakib@neoting.test', 'demo-neoting-2026', 'test')).toBe('usr_shakib_demo');
  expect(verifyDemoPassword('nobody@neoting.test', 'demo-neoting-2026', 'test')).toBeNull();
});

test('email-verification tokens: round-trip, tamper, expiry, and an empty secret', () => {
  const claims = { userId: 'usr_1', email: 'priya@ledgerline.test', expiresAtMs: Date.now() + EMAIL_VERIFICATION_TTL_MS };
  const token = signEmailVerificationToken(claims, SECRET);

  expect(verifyEmailVerificationToken(token, SECRET)).toEqual({ ok: true, claims });

  // An edited payload does not verify — the claims are inside the signature.
  const forged = `${Buffer.from(JSON.stringify({ ...claims, userId: 'usr_2' })).toString('base64url')}.${token.split('.')[1]}`;
  expect(verifyEmailVerificationToken(forged, SECRET)).toEqual({ ok: false, reason: 'invalid' });

  // Expiry is distinct from invalid: the token was genuinely ours, so "request
  // a fresh link" is safe to say.
  expect(verifyEmailVerificationToken(token, SECRET, claims.expiresAtMs)).toEqual({ ok: false, reason: 'expired' });

  for (const bad of [undefined, '', 'no-dot', '.', 'a.']) {
    expect(verifyEmailVerificationToken(bad, SECRET)).toEqual({ ok: false, reason: 'invalid' });
  }

  // Fail closed, like every other signer in this repo.
  expect(() => signEmailVerificationToken(claims, '')).toThrow(/refusing to sign/);
  expect(() => verifyEmailVerificationToken(token, '')).toThrow(/refusing to sign/);
});

test('the verification key is DERIVED: a session cookie is not a verification token, or vice versa', () => {
  // Both signers are handed the same SESSION_SECRET. If the key were reused
  // rather than domain-separated, one HMAC would validate the other's payload
  // and a session cookie would be a standing email-verification token.
  const claims = { userId: 'usr_1', email: 'priya@ledgerline.test', expiresAtMs: Date.now() + 60_000 };
  const verification = signEmailVerificationToken(claims, SECRET);
  const session = signSessionToken({ userId: 'usr_1', expiresAtMs: Date.now() + 60_000 }, SECRET);

  expect(verifySessionCookieHeader(`nt_session=${verification}`, SECRET)).toEqual({ ok: false, reason: 'invalid' });
  expect(verifyEmailVerificationToken(session, SECRET)).toEqual({ ok: false, reason: 'invalid' });
});
