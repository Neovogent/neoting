import { expect, test } from 'vitest';

import { addressDomain, parseEmailAddress, rateLimitIdentity } from './email-address.js';

test('ordinary addresses parse, and are trimmed', () => {
  expect(parseEmailAddress('ada@example.com')).toBe('ada@example.com');
  expect(parseEmailAddress('  ada@example.com  ')).toBe('ada@example.com');
  expect(parseEmailAddress('ada.lovelace+receipts@sub.example.co.uk')).toBe('ada.lovelace+receipts@sub.example.co.uk');
});

test('CR and LF are refused — the header-injection class', () => {
  // Structured JSON makes this unreachable through SES v2 today. It is refused
  // here so that it stays unreachable the day a raw-MIME sender lands behind
  // the same seam, with no call site changed.
  for (const bad of ['ada@example.com\r\nBcc: victim@example.com', 'ada\n@example.com', 'a\rb@example.com']) {
    expect(() => parseEmailAddress(bad)).toThrow();
  }

  // A newline off the END is TRIMMED rather than refused, and the distinction
  // is deliberate: trimming runs before the guard, so what gets validated is
  // exactly what gets sent. A trailing newline is a form field with a stray
  // keystroke in it, not an injection — an injection needs something after the
  // newline, and that is what the loop above refuses.
  expect(parseEmailAddress('ada@example.com\n')).toBe('ada@example.com');
});

test('shapes that would bounce are refused', () => {
  for (const bad of ['ada', 'ada@', '@example.com', 'ada@example', 'ada @example.com', 'a@b@c.com', 'ada@exam ple.com']) {
    expect(() => parseEmailAddress(bad)).toThrow();
  }
});

test('an address longer than RFC 5321 allows is refused', () => {
  expect(() => parseEmailAddress(`${'a'.repeat(250)}@example.com`)).toThrow();
});

test('the rate-limit identity folds case; the envelope does not', () => {
  const address = parseEmailAddress('AdA@Example.COM');
  // Sent exactly as given — RFC 5321 makes the local part case-sensitive.
  expect(address).toBe('AdA@Example.COM');
  // Counted folded — no provider honours that, so an unfolded key is a
  // mailbombing bypass that needs no tooling at all.
  expect(rateLimitIdentity(address)).toBe('ada@example.com');
  expect(rateLimitIdentity(parseEmailAddress('ada@example.com'))).toBe(rateLimitIdentity(address));
});

test('the log identity is the domain only, lowercased', () => {
  expect(addressDomain(parseEmailAddress('Ada@Example.COM'))).toBe('example.com');
  // A `+` tag and a subdomain both survive intact — the domain is what makes a
  // delivery traceable to a provider.
  expect(addressDomain(parseEmailAddress('ada+tag@mail.example.co.uk'))).toBe('mail.example.co.uk');
});
