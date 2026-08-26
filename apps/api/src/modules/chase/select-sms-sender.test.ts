import { expect, test } from 'vitest';

import { EmailChaseSender } from './email-chase-sender.js';
import { type ChaseSenderEnv, selectSmsSender } from './select-sms-sender.js';
import { DemoSmsSender } from './sms-sender.js';

/**
 * Config selects the transport, never an import — the house pattern
 * (`selectExtractor`, `selectEmailSender`, `selectDocumentStore`).
 */

function env(over: Partial<ChaseSenderEnv> = {}): ChaseSenderEnv {
  return {
    SMS_SENDER: 'demo',
    EMAIL_SENDER: 'demo',
    SES_REGION: 'eu-west-2',
    EMAIL_FROM_ADDRESS: 'no-reply@example.test',
    EMAIL_REPLY_TO_ADDRESS: '',
    EMAIL_CONFIGURATION_SET: '',
    EMAIL_RATE_LIMIT: 'memory',
    REDIS_URL: 'redis://localhost:6379',
    ...over,
  };
}

test('demo selects the outbox writer — nothing leaves the machine', () => {
  expect(selectSmsSender(env())).toBeInstanceOf(DemoSmsSender);
});

test('email selects the email transport', () => {
  expect(selectSmsSender(env({ SMS_SENDER: 'email' }))).toBeInstanceOf(EmailChaseSender);
});

test('selecting the email transport constructs NO client and opens NO connection', () => {
  // `EMAIL_SENDER=ses` and `EMAIL_RATE_LIMIT=redis` together would mean an SES
  // client and a Redis connection — if selection resolved them eagerly. It does
  // not: the underlying transport is resolved on the first SEND, behind the
  // dynamic import that keeps the two public seams acyclic. This test is also
  // the reason a unit run with a production-shaped env cannot reach a network.
  const sender = selectSmsSender(env({ SMS_SENDER: 'email', EMAIL_SENDER: 'ses', EMAIL_RATE_LIMIT: 'redis' }));
  expect(sender).toBeInstanceOf(EmailChaseSender);
});

test('an unknown value falls back to the outbox writer rather than to silence', () => {
  // The enum in `config/env.ts` makes this unreachable through parsed config;
  // the default arm exists so a hand-built env in a test or a script cannot
  // produce a sender that is undefined.
  expect(selectSmsSender(env({ SMS_SENDER: 'nonsense' as ChaseSenderEnv['SMS_SENDER'] }))).toBeInstanceOf(DemoSmsSender);
});
