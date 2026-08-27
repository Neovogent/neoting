import { describe, expect, test } from 'vitest';

import type { NotificationsService, SendOutcome } from '../notifications/index.js';

import {
  buildVerificationLink,
  NotificationsSignupMailer,
  VERIFY_EMAIL_PATH,
} from './notifications-signup-mailer.js';

/**
 * The seam A1 left and S2 never connected.
 *
 * The behaviour worth pinning is the **asymmetry**: a rate-limited verification
 * mail must fail the signup, while a rate-limited duplicate notice must not.
 * They pull in opposite directions for the same reason — the `202` may never
 * reveal whether an address is registered.
 */

const ORIGIN = 'https://app.neoting.neovogent.com';

function verification(overrides: Partial<Parameters<NotificationsSignupMailer['sendEmailVerification']>[0]> = {}) {
  return {
    to: 'priya@ledgerline.test',
    firstName: 'Priya',
    practiceName: 'Ledgerline',
    token: 'tok_abc.sig',
    expiresAt: new Date('2026-08-06T09:00:00Z'),
    ...overrides,
  };
}

/** A NotificationsService stub that records calls and answers as told. */
function stub(outcome: SendOutcome) {
  const calls: { method: string; input: unknown }[] = [];
  const service = {
    sendEmailVerification: async (input: unknown) => {
      calls.push({ method: 'verification', input });
      return outcome;
    },
    sendDuplicateSignupNotice: async (input: unknown) => {
      calls.push({ method: 'duplicate', input });
      return outcome;
    },
  } as unknown as NotificationsService;
  return { calls, service };
}

const SENT: SendOutcome = { sent: true, kind: 'email-verification', providerMessageId: 'msg_1' };
const REFUSED: SendOutcome = {
  sent: false,
  kind: 'email-verification',
  reason: 'rate-limited',
  retryAfterSeconds: 900,
};

describe('the verification link', () => {
  test('is origin + the path M9 must serve + the token, escaped', () => {
    expect(buildVerificationLink(ORIGIN, 'tok_abc.sig')).toBe(
      `${ORIGIN}${VERIFY_EMAIL_PATH}?token=tok_abc.sig`,
    );
  });

  test('escapes a token containing URL-significant characters', () => {
    expect(buildVerificationLink(ORIGIN, 'a+b/c=d')).toContain('token=a%2Bb%2Fc%3Dd');
  });

  test('tolerates a trailing slash on the origin rather than doubling it', () => {
    expect(buildVerificationLink(`${ORIGIN}/`, 't')).toBe(`${ORIGIN}${VERIFY_EMAIL_PATH}?token=t`);
  });
});

describe('sending the verification', () => {
  test('hands the notifications module a built link, not a raw token', async () => {
    const { calls, service } = stub(SENT);
    await new NotificationsSignupMailer(service, ORIGIN).sendEmailVerification(verification());

    const input = calls[0]?.input as { verifyLink: string; token?: string };
    expect(input.verifyLink).toBe(`${ORIGIN}${VERIFY_EMAIL_PATH}?token=tok_abc.sig`);
    // The token is the mailer's business, not the copy's.
    expect(input.token).toBeUndefined();
  });

  test('⚠ THROWS when the send is refused — a signup whose mail never left is not a signup', async () => {
    const { service } = stub(REFUSED);
    await expect(
      new NotificationsSignupMailer(service, ORIGIN).sendEmailVerification(verification()),
    ).rejects.toThrow(/not sent/i);
  });

  test('resolves when it sent', async () => {
    const { service } = stub(SENT);
    await expect(
      new NotificationsSignupMailer(service, ORIGIN).sendEmailVerification(verification()),
    ).resolves.toBeUndefined();
  });
});

describe('the duplicate-signup notice', () => {
  test('⚠ does NOT throw when refused — the opposite of the verification, deliberately', async () => {
    const { service } = stub(REFUSED);
    // Turning a rate-limited courtesy into a 500 would tell the caller the
    // address exists, which is the leak the uninformative 202 exists to close.
    await expect(
      new NotificationsSignupMailer(service, ORIGIN).sendDuplicateSignupNotice({
        to: 'priya@ledgerline.test',
      }),
    ).resolves.toBeUndefined();
  });

  test('carries the address and nothing else', async () => {
    const { calls, service } = stub(SENT);
    await new NotificationsSignupMailer(service, ORIGIN).sendDuplicateSignupNotice({
      to: 'priya@ledgerline.test',
    });
    expect(calls[0]?.input).toStrictEqual({ to: 'priya@ledgerline.test' });
  });
});
