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

  // GCM's auth tag is what catches this: altering the ciphertext must not yield
  // a decrypted-but-wrong seed.
  //
  // ⚠ TAMPER THE BYTES, NOT THE BASE64 TEXT. This used to swap the final
  // base64url character between 'A' and 'B', and it was flaky about 1 run in 16.
  // The plaintext is 182 bytes and 182 % 3 == 2, so the last base64url character
  // carries four SIGNIFICANT bits and two PADDING bits, and the padding bits are
  // discarded on decode. 'A' and 'B' differ only in the low bit — so whenever the
  // body happened to end in 'A', 'B', 'C' or 'D', the "tampered" string decoded
  // to byte-identical ciphertext, nothing had actually been tampered with, GCM
  // correctly authenticated it, and the assertion failed. The crypto was never
  // wrong; the test's premise was.
  //
  // Flipping every bit of a decoded byte is a real modification at any length.
  // `readUInt8`/`writeUInt8` rather than `bodyBytes[0] ^= 0xff`: this package
  // runs with `noUncheckedIndexedAccess`, so an index read is `number |
  // undefined` and compound-assigning to it does not typecheck.
  const bodyBytes = Buffer.from(body, 'base64url');
  bodyBytes.writeUInt8(bodyBytes.readUInt8(0) ^ 0xff, 0);
  const tampered = [scheme, iv, tag, bodyBytes.toString('base64url')].join('.');
  // The premise, asserted rather than assumed — if this ever holds, the test
  // above is vacuous again and would pass without proving anything.
  expect(bodyBytes.toString('base64url')).not.toBe(body);

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
