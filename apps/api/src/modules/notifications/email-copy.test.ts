import { describe, expect, test } from 'vitest';

import type { ChaseItem } from '../chase/index.js';
import {
  composeClientInvite,
  composeDocumentRequest,
  composeDuplicateSignupNotice,
  composeEmailVerification,
  composeSignInCode,
  SENDER_DISPLAY_NAME,
} from './email-copy.js';
import { SignInCode } from './sign-in-code.js';

const ALL = [
  composeClientInvite({
    practiceName: 'Harrow & Co',
    businessName: 'Sparkle Cleaning Ltd',
    inviteLink: 'https://neoacc.neovogent.com/invite/abc123',
    expiresAt: new Date('2026-09-02T09:00:00Z'),
  }),
  composeSignInCode({ code: SignInCode.parse('482913'), expiresInMinutes: 10 }),
  composeDocumentRequest({
    businessName: 'Sparkle Cleaning',
    items: [item('Currys', 129_900, '2026-08-09T12:00:00Z')],
    portalLink: 'https://neoacc.neovogent.com/p/xyz789',
  }),
];

function item(supplierLabel: string, amountPence: number, bookedAt: string): ChaseItem {
  return { transactionId: `txn_${supplierLabel}`, amountPence, bookedAt: new Date(bookedAt), supplierLabel };
}

// ── The rules that apply to every message ──────────────────────────────────

test('every message is plain text — no HTML, no tracking pixel, no marketing chrome', () => {
  for (const { subject, body } of ALL) {
    expect(body).not.toMatch(/<[a-z!/][^>]*>/i);
    expect(body).not.toMatch(/<img|href=|style=|\bunsubscribe\b/i);
    expect(subject).not.toMatch(/<[a-z!/][^>]*>/i);
  }
});

test('no message claims a ledger was written to (D42)', () => {
  for (const { subject, body } of ALL) {
    expect(`${subject}\n${body}`).not.toMatch(/\bposted\b|\bsynced\b|\bsent to VT\b|\bXero\b|\bQuickBooks\b/i);
  }
});

test('every message ends with the sender name and a trailing newline', () => {
  for (const { body } of ALL) {
    expect(body.endsWith(`${SENDER_DISPLAY_NAME}\n`)).toBe(true);
    // `\n`, never `\r\n`: SES v2 does its own MIME encoding, so a CR here is a
    // literal character inside the encoded part rather than a line ending.
    expect(body).not.toContain('\r');
  }
});

test('every message says what to do if you were not expecting it', () => {
  for (const { body } of ALL) {
    expect(body).toMatch(/ignore this email/i);
  }
});

// ── 1 · Client invite ──────────────────────────────────────────────────────

test('the invite is sent in the ACCOUNTANT’s name, and names the client business', () => {
  const { subject, body } = ALL[0] as { subject: string; body: string };
  expect(subject).toBe(`Harrow & Co has invited you to ${SENDER_DISPLAY_NAME}`);
  expect(body).toContain('Harrow & Co');
  expect(body).toContain('Sparkle Cleaning Ltd');
  expect(body).toContain('https://neoacc.neovogent.com/invite/abc123');
});

test('the invite renders its expiry in Europe/London, not UTC', () => {
  const { body } = composeClientInvite({
    practiceName: 'Harrow & Co',
    businessName: 'Sparkle Cleaning Ltd',
    inviteLink: 'https://example.test/i',
    // 23:30 UTC in BST is 00:30 on the FOLLOWING day in London.
    expiresAt: new Date('2026-09-02T23:30:00Z'),
  });
  expect(body).toContain('3 Sep');
  expect(body).not.toContain('2 Sep');
});

test('the invite offers no connections (D47)', () => {
  const { body } = ALL[0] as { body: string };
  expect(body).not.toMatch(/connect your bank|open banking|link your|accounting software/i);
});

// ── 2 · Sign-in code ───────────────────────────────────────────────────────

test('the code is in the body and NOT in the subject', () => {
  const { subject, body } = ALL[1] as { subject: string; body: string };
  expect(body).toContain('482913');
  // A subject is rendered on a lock screen, in a notification banner and in
  // every mail server's logs along the way.
  expect(subject).not.toContain('482913');
  expect(subject).toBe(`Your ${SENDER_DISPLAY_NAME} sign-in code`);
});

test('the code is never put in a URL', () => {
  const { body } = ALL[1] as { body: string };
  // A link-scanner run by the recipient's employer would FETCH such a URL and
  // burn a single-use code before the client ever saw it.
  expect(body).not.toMatch(/https?:\/\//);
});

test('the sign-in message states the expiry, single use, and that we never ask for it', () => {
  const { body } = ALL[1] as { body: string };
  expect(body).toContain('expires in 10 minutes');
  expect(body).toMatch(/used once/);
  expect(body).toMatch(/will ever ask you for this code/i);
});

test('the expiry is singular at one minute', () => {
  expect(composeSignInCode({ code: SignInCode.parse('000001'), expiresInMinutes: 1 }).body).toContain('expires in 1 minute ');
});

// ── 3 · Document request ───────────────────────────────────────────────────

test('the chase groups every item into ONE message, one line each (SoT Stage 8.2)', () => {
  const { subject, body } = composeDocumentRequest({
    businessName: 'Sparkle Cleaning',
    items: [item('Currys', 129_900, '2026-08-09T12:00:00Z'), item('Screwfix', 4_250, '2026-08-11T12:00:00Z')],
    portalLink: 'https://neoacc.neovogent.com/p/xyz789',
  });

  expect(subject).toBe("Sparkle Cleaning: we're missing 2 receipts");
  expect(body).toContain('- Currys £1,299 on 9 Aug');
  expect(body).toContain('- Screwfix £42.50 on 11 Aug');
  expect(body).toContain('https://neoacc.neovogent.com/p/xyz789');
});

test('the chase money comes from formatGbp — whole pounds drop the pence, and the magnitude is shown', () => {
  const { body } = composeDocumentRequest({
    businessName: 'Sparkle Cleaning',
    // Signed pence: a payment OUT. The minus is not part of a sentence
    // addressed to the person who spent it.
    items: [item('Costa', -3_60, '2026-08-09T12:00:00Z')],
    portalLink: 'https://example.test/p',
  });
  expect(body).toContain('- Costa £3.60 on 9 Aug');
  expect(body).not.toContain('-£');
});

test('the single-item chase reads as one thing, not as a list of one', () => {
  const { subject, body } = ALL[2] as { subject: string; body: string };
  expect(subject).toBe("Sparkle Cleaning: we're missing a receipt");
  expect(body).toContain('the paperwork for this payment');
});

// ── the two signup messages ─────────────────────────────────────

describe('verify your email address', () => {
  const input = {
    firstName: 'Priya',
    practiceName: 'Ledgerline',
    verifyLink: 'https://app.neoting.neovogent.com/app/verify-email?token=tok_abc',
    expiresAt: new Date('2026-08-06T09:00:00Z'),
  };

  test('states the link on its own line, so it survives a mail client wrapping it', () => {
    const { body } = composeEmailVerification(input);
    expect(body.split('\n')).toContain(input.verifyLink);
  });

  test('names the practice and the expiry, and tells an unexpecting reader to do nothing', () => {
    const { body } = composeEmailVerification(input);
    expect(body).toContain('Ledgerline');
    expect(body).toContain('Priya');
    // `formatDay` is day + short month, no year — shared with the invite copy,
    // and unambiguous for a link that lives 48 hours.
    expect(body).toContain('6 Aug');
    expect(body).toContain('If you did not create this account');
  });

  test('the subject carries no token', () => {
    expect(composeEmailVerification(input).subject).not.toContain('tok_abc');
  });
});

describe('someone tried to sign up with your address', () => {
  test('⚠ names nothing about the attempt — the reader may not be the account holder', () => {
    const { subject, body } = composeDuplicateSignupNotice();
    // No practice, no name, no address, no hint of who tried: a message that
    // described the attempt would leak the account to whoever was probing it.
    expect(body).not.toMatch(/Ledgerline|Priya|@/);
    expect(subject).not.toMatch(/@/);
  });

  test('says plainly that nothing changed, and offers a reply route', () => {
    const { body } = composeDuplicateSignupNotice();
    expect(body).toContain('nothing was created and nothing has changed');
    expect(body).toContain('reply to this email');
  });
});
