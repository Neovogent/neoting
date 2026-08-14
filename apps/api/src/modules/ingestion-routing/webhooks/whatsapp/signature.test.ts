import { createHmac } from 'node:crypto';

import { expect, test } from 'vitest';

import { verifyMetaSignature, verifyTokenMatches } from './signature.js';

const SECRET = 'test-app-secret';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('accepts a correctly signed body', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
});

test('rejects a tampered body — the test that matters most', () => {
  const body = Buffer.from(JSON.stringify({ amount: 100 }));
  const header = sign(body);
  const tampered = Buffer.from(JSON.stringify({ amount: 999999 }));
  expect(verifyMetaSignature(tampered, header, SECRET)).toBe(false);
});

test('rejects a signature made with the wrong secret', () => {
  const body = Buffer.from('payload');
  expect(verifyMetaSignature(body, sign(body, 'attacker-secret'), SECRET)).toBe(false);
});

test('fails closed when the app secret is unset', () => {
  const body = Buffer.from('payload');
  expect(verifyMetaSignature(body, sign(body), '')).toBe(false);
});

test('rejects a missing, empty, legacy, or malformed signature header', () => {
  const body = Buffer.from('payload');
  expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
  expect(verifyMetaSignature(body, '', SECRET)).toBe(false);
  expect(verifyMetaSignature(body, 'sha1=deadbeef', SECRET)).toBe(false); // legacy SHA-1 ignored
  expect(verifyMetaSignature(body, 'sha256=not-hex-value', SECRET)).toBe(false);
  expect(verifyMetaSignature(body, 'sha256=abcd', SECRET)).toBe(false); // wrong width
});

test('rejects an empty or absent body', () => {
  const empty = Buffer.alloc(0);
  expect(verifyMetaSignature(empty, sign(empty), SECRET)).toBe(false);
  expect(verifyMetaSignature(undefined, `sha256=${'a'.repeat(64)}`, SECRET)).toBe(false);
});

test('verifyTokenMatches compares constant-time and fails closed when unset', () => {
  expect(verifyTokenMatches('tok', 'tok')).toBe(true);
  expect(verifyTokenMatches('tok', 'nope')).toBe(false);
  expect(verifyTokenMatches(undefined, 'tok')).toBe(false);
  expect(verifyTokenMatches('tok', '')).toBe(false);
});
