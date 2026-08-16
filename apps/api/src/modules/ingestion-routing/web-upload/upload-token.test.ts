import { expect, test } from 'vitest';

import { signUploadToken, type UploadClaims, verifyUploadToken } from './upload-token.js';

const SECRET = 'unit-secret';

function claims(over: Partial<UploadClaims> = {}): UploadClaims {
  return {
    businessId: 'biz_1',
    practiceId: 'prac_1',
    channel: 'WEB_UPLOAD',
    filename: 'batch.pdf',
    mimeType: 'application/pdf',
    byteSize: 1234,
    splitMode: 'AUTO_SPLIT',
    s3Key: 'w/biz_1/uploads/abc',
    expiresAtMs: 1_700_000_000_000,
    ...over,
  };
}

test('a signed token round-trips its claims', () => {
  const token = signUploadToken(claims(), SECRET);
  const result = verifyUploadToken(token, SECRET);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.claims).toEqual(claims());
});

test('a token signed with a different secret is rejected (not forgeable)', () => {
  const token = signUploadToken(claims(), SECRET);
  const result = verifyUploadToken(token, 'other-secret');
  expect(result).toEqual({ ok: false, reason: 'bad_signature' });
});

test('a tampered payload is rejected — the signature does not cover the new claims', () => {
  const token = signUploadToken(claims({ byteSize: 10 }), SECRET);
  const [, sig] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify(claims({ byteSize: 999_999_999 }))).toString('base64url');
  const result = verifyUploadToken(`${forgedPayload}.${sig}`, SECRET);
  expect(result).toEqual({ ok: false, reason: 'bad_signature' });
});

test('a malformed token is rejected, not thrown', () => {
  expect(verifyUploadToken('nonsense', SECRET)).toEqual({ ok: false, reason: 'malformed' });
  expect(verifyUploadToken('a.', SECRET)).toEqual({ ok: false, reason: 'malformed' });
});

test('an empty secret is refused on both sides — fail closed', () => {
  expect(() => signUploadToken(claims(), '')).toThrow(/empty/i);
  expect(() => verifyUploadToken('a.b', '')).toThrow(/empty/i);
});
