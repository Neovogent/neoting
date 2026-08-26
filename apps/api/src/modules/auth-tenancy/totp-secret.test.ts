import { expect, test } from 'vitest';

import { unwrapTotpMaterial, wrapTotpMaterial } from './totp-secret.js';

const SECRET = 'test-session-secret';
const MATERIAL = { secret: 'JBSWY3DPEHPK3PXP', recoveryHashes: ['aa'.repeat(32), 'bb'.repeat(32)] };

test('a wrapped envelope round-trips, and carries no plaintext seed', () => {
  const ref = wrapTotpMaterial(MATERIAL, SECRET);
  expect(unwrapTotpMaterial(ref, SECRET)).toEqual(MATERIAL);
  // The column is named `totp_secret_ref` and this is what makes the name true:
  // a database dump does not hand anyone a working second factor.
  expect(ref).not.toContain(MATERIAL.secret);
  expect(ref.startsWith('ntotp1.')).toBe(true);
});

test('every wrap uses a FRESH nonce — the one thing AES-GCM does not forgive', () => {
  const refs = new Set(Array.from({ length: 5 }, () => wrapTotpMaterial(MATERIAL, SECRET)));
  expect(refs.size).toBe(5);
});

test('REFUSAL: a tampered ciphertext, a wrong key, a foreign scheme and rubbish are ALL null, never a throw', () => {
  const ref = wrapTotpMaterial(MATERIAL, SECRET);
  const [scheme, iv, tag, body] = ref.split('.') as [string, string, string, string];

  // GCM's auth tag is what catches this: flipping one character of the
  // ciphertext must not yield a decrypted-but-wrong seed.
  const tampered = [scheme, iv, tag, `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`].join('.');

  for (const candidate of [tampered, ref.replace('ntotp1', 'ntotp9'), 'not-an-envelope', '', null]) {
    expect(unwrapTotpMaterial(candidate, SECRET)).toBeNull();
  }
  // A rotated SESSION_SECRET invalidates every enrolment — a failed login and a
  // re-enrolment, not a 500 that reads like corruption.
  expect(unwrapTotpMaterial(ref, 'a-different-session-secret')).toBeNull();
});

test('REFUSAL: an empty SESSION_SECRET fails closed and LOUD, both ways', () => {
  expect(() => wrapTotpMaterial(MATERIAL, '')).toThrow(/SESSION_SECRET is empty/);
  expect(() => unwrapTotpMaterial(wrapTotpMaterial(MATERIAL, SECRET), '')).toThrow(/SESSION_SECRET is empty/);
});

test('REFUSAL: a well-encrypted envelope of the WRONG SHAPE is null — parse, do not trust, even our own plaintext', () => {
  const wrongShape = wrapTotpMaterial({ recoveryHashes: ['aa'] } as unknown as typeof MATERIAL, SECRET);
  expect(unwrapTotpMaterial(wrongShape, SECRET)).toBeNull();
});
