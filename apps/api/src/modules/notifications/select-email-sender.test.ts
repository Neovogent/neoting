import { expect, test } from 'vitest';

import { InMemoryEmailRateLimiter } from './email-rate-limit.js';
import { DemoEmailSender } from './email-sender.js';
import { selectEmailRateLimiter, selectEmailSender } from './select-email-sender.js';
import { SesEmailSender } from './ses-email-sender.js';
import { SmtpEmailSender } from './smtp-email-sender.js';

const base = {
  SES_REGION: 'eu-west-2',
  EMAIL_FROM_ADDRESS: 'no-reply@neoting.neovogent.com',
  EMAIL_REPLY_TO_ADDRESS: 'support@neovogent.com',
  EMAIL_CONFIGURATION_SET: 'nt-staging-default',
  SMTP_HOST: 'localhost',
  SMTP_PORT: 1025,
} as const;

test('the sender is chosen by config, never by import', () => {
  expect(selectEmailSender({ ...base, EMAIL_SENDER: 'demo' })).toBeInstanceOf(DemoEmailSender);
  // The local MailHog transport is chosen the same way — explicitly, never as
  // a fallback from a failed `ses` send.
  expect(selectEmailSender({ ...base, EMAIL_SENDER: 'smtp' })).toBeInstanceOf(SmtpEmailSender);
  expect(selectEmailSender({ ...base, EMAIL_SENDER: 'ses' })).toBeInstanceOf(SesEmailSender);
});

test('there is no fallback from ses to demo', () => {
  // `select-extractor.ts` carries the long version of why, paid for on 25 Aug
  // 2026. The email equivalent would report a delivered sign-in code that no
  // human will ever receive.
  const ses = selectEmailSender({ ...base, EMAIL_SENDER: 'ses' });
  expect(ses).not.toBeInstanceOf(DemoEmailSender);
});

test('the rate-limit store is chosen by config, and redis is not constructed for memory', () => {
  let redisBuilt = 0;
  const make = () => {
    redisBuilt += 1;
    return new InMemoryEmailRateLimiter();
  };

  expect(selectEmailRateLimiter({ EMAIL_RATE_LIMIT: 'memory', REDIS_URL: 'redis://localhost:6379' }, make)).toBeInstanceOf(
    InMemoryEmailRateLimiter,
  );
  expect(redisBuilt).toBe(0);

  selectEmailRateLimiter({ EMAIL_RATE_LIMIT: 'redis', REDIS_URL: 'redis://localhost:6379' }, make);
  expect(redisBuilt).toBe(1);
});
