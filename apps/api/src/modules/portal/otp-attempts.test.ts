import { expect, test } from 'vitest';

import { hashOtp, isOtpLocked, nextOtpAttempt, OTP_ATTEMPTS_CLEARED, otpMatches, PORTAL_OTP_LOCKOUT_MS, PORTAL_OTP_MAX_ATTEMPTS } from './otp-attempts.js';

const NOW = 1_756_000_000_000;

test('a link with no history is not locked, and neither is one whose lock has lapsed', () => {
  expect(isOtpLocked(null, NOW)).toBe(false);
  expect(isOtpLocked({ attempts: 3, lockedUntil: null }, NOW)).toBe(false);
  expect(isOtpLocked({ attempts: 5, lockedUntil: new Date(NOW - 1) }, NOW)).toBe(false);
  expect(isOtpLocked({ attempts: 5, lockedUntil: new Date(NOW + 1) }, NOW)).toBe(true);
});

test('wrong codes accumulate, and the fifth locks the link', () => {
  let state: { attempts: number; lockedUntil: Date | null } | null = null;
  for (let attempt = 1; attempt < PORTAL_OTP_MAX_ATTEMPTS; attempt += 1) {
    state = nextOtpAttempt(state, NOW);
    expect(state).toEqual({ attempts: attempt, lockedUntil: null });
  }
  state = nextOtpAttempt(state, NOW);
  expect(state).toEqual({ attempts: PORTAL_OTP_MAX_ATTEMPTS, lockedUntil: new Date(NOW + PORTAL_OTP_LOCKOUT_MS) });
});

test('a lapsed lock restarts the count rather than resuming it', () => {
  const locked = { attempts: PORTAL_OTP_MAX_ATTEMPTS, lockedUntil: new Date(NOW) };
  // Resuming would re-lock the client on the single next mistype, hours later,
  // with no way for them to understand why.
  expect(nextOtpAttempt(locked, NOW + 1)).toEqual({ attempts: 1, lockedUntil: null });
});

test('a successful verification clears both columns', () => {
  expect(OTP_ATTEMPTS_CLEARED).toEqual({ attempts: 0, lockedUntil: null });
});

test('otpMatches: the right code inside its expiry, and nothing else', () => {
  const hash = hashOtp('483920');
  const expires = new Date(NOW + 60_000);

  expect(otpMatches(hash, expires, '483920', NOW)).toBe(true);
  // Whitespace a phone keyboard adds is not a wrong code.
  expect(otpMatches(hash, expires, ' 483920 ', NOW)).toBe(true);

  expect(otpMatches(hash, expires, '483921', NOW)).toBe(false);
  // Expired, and — the fail-closed case — a code with NO expiry at all. "Unset"
  // must never read as "for ever".
  expect(otpMatches(hash, new Date(NOW), '483920', NOW)).toBe(false);
  expect(otpMatches(hash, null, '483920', NOW)).toBe(false);
  // No code minted for this session yet: there is nothing to match, so nothing
  // matches. This is the state `OTP_MODE=totp` is in until something writes
  // `otp_hash`.
  expect(otpMatches(null, expires, '483920', NOW)).toBe(false);
  expect(otpMatches('', expires, '483920', NOW)).toBe(false);
});

test('the stored value is a hash, not the code', () => {
  expect(hashOtp('483920')).not.toContain('483920');
  expect(hashOtp('483920')).toBe(hashOtp('483920'));
  expect(hashOtp('483920')).not.toBe(hashOtp('483921'));
});
