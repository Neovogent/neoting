import { expect, test } from 'vitest';

import {
  createTotpEnrolment,
  RECOVERY_CODE_COUNT,
  recoveryCodesRemaining,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  TOTP_TOLERANCE_SECONDS,
  totpEngine,
  verifySecondFactor,
} from './totp.js';

const SECRET = 'test-session-secret';
const NOW = 1_756_000_000_000;

function codeAt(secret: string, atMs: number): Promise<string> {
  return totpEngine.generate({ secret, epoch: Math.floor(atMs / 1000) });
}

test('an enrolment mints a seed, a scannable URI and ten recovery codes — and stores none of them in the clear', () => {
  const enrolment = createTotpEnrolment('priya@ledgerline.test', SECRET);

  expect(enrolment.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
  expect(new Set(enrolment.recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
  expect(enrolment.uri.startsWith('otpauth://totp/')).toBe(true);
  expect(enrolment.uri).toContain(`secret=${enrolment.secret}`);
  expect(enrolment.uri).toContain(`issuer=${encodeURIComponent(TOTP_ISSUER)}`);
  // ⚠ `digits` and `period` are ABSENT from the URI, and that is correct:
  // otplib omits a parameter that equals the RFC default, and an authenticator
  // app assumes 6 and 30 when it sees neither. These two assertions are what
  // makes that safe — the day someone "hardens" the server to 8 digits, the URI
  // will still say nothing, every app will still produce 6, and this fails
  // rather than the customer's phone.
  expect(TOTP_DIGITS).toBe(6);
  expect(TOTP_PERIOD_SECONDS).toBe(30);

  // Nothing a thief could use survives into the column.
  for (const code of enrolment.recoveryCodes) expect(enrolment.ref).not.toContain(code);
  expect(enrolment.ref).not.toContain(enrolment.secret);
});

test('the label is percent-encoded into the URI — it is a user-supplied address, not a template hole', () => {
  const enrolment = createTotpEnrolment('a b/c?d#e@firm.test', SECRET);
  // A raw `/` or `?` here would split the otpauth path or start a query string,
  // so the app would read a different account — or nothing.
  expect(enrolment.uri).not.toContain('a b/c?d#e@firm.test');
  expect(enrolment.uri).toContain(encodeURIComponent('a b/c?d#e@firm.test'));
});

test('a live code verifies, and the SAME code one full step outside the tolerance does not', async () => {
  const enrolment = createTotpEnrolment('priya@ledgerline.test', SECRET);
  const code = await codeAt(enrolment.secret, NOW);

  const accepted = await verifySecondFactor(enrolment.ref, code, SECRET, NOW);
  expect(accepted.ok).toBe(true);
  expect(accepted.ok && accepted.usedRecoveryCode).toBe(false);
  expect(accepted.ok && typeof accepted.timeStep).toBe('number');

  // Inside ±1 step, still good; beyond it, gone. The window is the number in
  // the file, asserted rather than described.
  await expect(verifySecondFactor(enrolment.ref, code, SECRET, NOW + TOTP_TOLERANCE_SECONDS * 1000)).resolves.toMatchObject({ ok: true });
  await expect(
    verifySecondFactor(enrolment.ref, code, SECRET, NOW + (TOTP_TOLERANCE_SECONDS + TOTP_PERIOD_SECONDS + 1) * 1000),
  ).resolves.toEqual({ ok: false });
});

test('REFUSAL: a malformed code NEVER throws — otplib does, and a mistyped digit must not be a 500', async () => {
  const enrolment = createTotpEnrolment('priya@ledgerline.test', SECRET);
  // otplib's guardrails raise TokenLengthError on anything but six digits.
  // Every one of these is a failed login, not a server error.
  for (const code of ['', '12345', '1234567', 'abcdef', '  ', '000000000000000000000']) {
    await expect(verifySecondFactor(enrolment.ref, code, SECRET, NOW)).resolves.toEqual({ ok: false });
  }
});

test('REFUSAL: no enrolment, and an envelope from another key, both fail closed', async () => {
  const enrolment = createTotpEnrolment('priya@ledgerline.test', SECRET);
  const code = await codeAt(enrolment.secret, NOW);

  expect(await verifySecondFactor(null, code, SECRET, NOW)).toEqual({ ok: false });
  expect(await verifySecondFactor(enrolment.ref, code, 'a-different-session-secret', NOW)).toEqual({ ok: false });
});

test('a recovery code is accepted case- and punctuation-insensitively, and is spent exactly once', async () => {
  const enrolment = createTotpEnrolment('priya@ledgerline.test', SECRET);
  const [code] = enrolment.recoveryCodes as readonly [string, ...string[]];

  // Typed off a printout by someone who has lost their phone: upper case,
  // spaces instead of dashes. Refusing that is refusing the person the codes
  // exist for.
  const messy = code.toUpperCase().replaceAll('-', ' ');
  const spent = await verifySecondFactor(enrolment.ref, messy, SECRET, NOW);
  expect(spent.ok).toBe(true);
  expect(spent.ok && spent.usedRecoveryCode).toBe(true);
  expect(spent.ok && spent.timeStep).toBeNull();

  const updatedRef = spent.ok ? spent.updatedRef! : '';
  expect(recoveryCodesRemaining(updatedRef, SECRET)).toBe(RECOVERY_CODE_COUNT - 1);
  // Against the UPDATED envelope it is gone. That is what "single use" means,
  // and it is why the verdict carries a ref the caller must persist.
  expect(await verifySecondFactor(updatedRef, code, SECRET, NOW)).toEqual({ ok: false });
  // The time-based factor still works — spending a recovery code does not
  // disturb the seed.
  const timed = await codeAt(enrolment.secret, NOW);
  await expect(verifySecondFactor(updatedRef, timed, SECRET, NOW)).resolves.toMatchObject({ ok: true });
});

test('every recovery code works, one at a time, until there are none left', async () => {
  const enrolment = createTotpEnrolment('priya@ledgerline.test', SECRET);
  let ref = enrolment.ref;
  for (const code of enrolment.recoveryCodes) {
    const verdict = await verifySecondFactor(ref, code, SECRET, NOW);
    expect(verdict.ok).toBe(true);
    ref = verdict.ok ? verdict.updatedRef! : ref;
  }
  expect(recoveryCodesRemaining(ref, SECRET)).toBe(0);
  // An exhausted enrolment is not an open one: with no codes left, none match.
  const [first] = enrolment.recoveryCodes as readonly [string, ...string[]];
  expect(await verifySecondFactor(ref, first, SECRET, NOW)).toEqual({ ok: false });
});

test("REFUSAL: one account's recovery code does not open another's", async () => {
  const mine = createTotpEnrolment('priya@ledgerline.test', SECRET);
  const theirs = createTotpEnrolment('someone@else.test', SECRET);
  const [code] = theirs.recoveryCodes as readonly [string, ...string[]];
  expect(await verifySecondFactor(mine.ref, code, SECRET, NOW)).toEqual({ ok: false });
});
