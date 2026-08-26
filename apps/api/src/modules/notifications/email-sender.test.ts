import { expect, test } from 'vitest';

import { parseEmailAddress } from './email-address.js';
import { DemoEmailSender, type OutboundEmail } from './email-sender.js';

function message(to: string, subject = 'a subject'): OutboundEmail {
  return { kind: 'client-invite', to: parseEmailAddress(to), subject, body: 'a body\n' };
}

test('the demo sender records into an outbox and returns a deterministic id', async () => {
  const sender = new DemoEmailSender(() => new Date('2026-08-26T10:00:00Z'));

  expect(await sender.send(message('ada@example.com'))).toEqual({ kind: 'client-invite', providerMessageId: 'demo-email-1' });
  expect(await sender.send(message('grace@example.com'))).toEqual({
    kind: 'client-invite',
    providerMessageId: 'demo-email-2',
  });

  const outbox = sender.readOutbox();
  expect(outbox).toHaveLength(2);
  expect(outbox[0]).toMatchObject({ to: 'ada@example.com', subject: 'a subject', body: 'a body\n' });
  expect(outbox[0]?.sentAt).toEqual(new Date('2026-08-26T10:00:00Z'));
});

test('the outbox is a copy — a caller cannot mutate what was sent', async () => {
  const sender = new DemoEmailSender();
  await sender.send(message('ada@example.com'));

  (sender.readOutbox() as unknown as { length: number }).length = 0;
  expect(sender.readOutbox()).toHaveLength(1);
});

test('lastTo finds the most recent message to an address', async () => {
  const sender = new DemoEmailSender();
  await sender.send(message('ada@example.com', 'first'));
  await sender.send(message('grace@example.com', 'other'));
  await sender.send(message('ada@example.com', 'second'));

  expect(sender.lastTo(parseEmailAddress('ada@example.com'))?.subject).toBe('second');
  expect(sender.lastTo(parseEmailAddress('nobody@example.com'))).toBeUndefined();
});

test('the outbox is a bounded ring — it drops the OLDEST, not the newest', async () => {
  // `pnpm dev` runs for days, and an unbounded array holding sign-in codes in
  // memory is a slow leak of both heap and credentials. The message a developer
  // is looking for is the one they just triggered.
  const sender = new DemoEmailSender();
  for (let i = 0; i < 120; i += 1) await sender.send(message('ada@example.com', `subject ${i}`));

  const outbox = sender.readOutbox();
  expect(outbox).toHaveLength(100);
  expect(outbox[0]?.subject).toBe('subject 20');
  expect(outbox[99]?.subject).toBe('subject 119');
});
