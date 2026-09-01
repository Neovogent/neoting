import { expect, test } from 'vitest';

import { AppException } from '../../common/problem/problem.js';
import type { ScopedClient } from '../../common/db/scoped-db.js';
import { AwsSmsSender, type AwsSmsSenderDeps } from './aws-sms-sender.js';
import { OptedOutRecipientError } from './aws-sms-transport.js';
import type { OutboundSms } from './sms-sender.js';

/**
 * The real SMS sender against fakes: the reviewed bytes go on the wire
 * verbatim, the two audit rows record the send, and every refusal happens
 * BEFORE anything irreversible. No AWS client is ever constructed here — the
 * transport is a recorder, which is exactly what the seam exists to allow.
 */

const MESSAGE: OutboundSms = {
  businessId: 'biz_1',
  chaseId: 'chase_1',
  chaseMessageId: 'msg_1',
  toE164: '+447700900001',
  body: 'Acme Accounts: we’re missing the receipt for Currys £1,299 on 9 Aug. Upload securely: https://app.test/p/tok',
};

function harness(over: Partial<AwsSmsSenderDeps> = {}) {
  const sends: { to: string; body: string }[] = [];
  const consumed: string[] = [];
  const updates: unknown[] = [];
  const logs: unknown[] = [];
  let built = 0;

  const deps: AwsSmsSenderDeps = {
    transport: {
      async sendText(to, body) {
        sends.push({ to, body });
        return { messageId: `aws-${sends.length}` };
      },
    },
    limiter: {
      async consume(request) {
        consumed.push(request.address);
        return { allowed: true };
      },
    },
    ...over,
  };

  const db = {
    chaseMessage: {
      update: async (args: unknown) => {
        updates.push(args);
        return {};
      },
    },
    smsLog: {
      create: async (args: unknown) => {
        logs.push(args);
        return {};
      },
    },
  } as unknown as ScopedClient;

  const sender = new AwsSmsSender(async () => {
    built += 1;
    return deps;
  });

  return { sender, db, sends, consumed, updates, logs, builtCount: () => built };
}

test('the reviewed bytes go on the wire verbatim, and both audit rows record the send', async () => {
  const h = harness();
  const sent = await h.sender.send(h.db, [MESSAGE]);

  expect(h.sends).toEqual([{ to: '+447700900001', body: MESSAGE.body }]);
  expect(sent).toEqual([{ chaseMessageId: 'msg_1', providerMessageId: 'aws-1', deliveryState: 'sent' }]);

  const update = h.updates[0] as { where: { id: string }; data: { providerMessageId: string } };
  expect(update.where.id).toBe('msg_1');
  expect(update.data.providerMessageId).toBe('aws-1');
  const log = h.logs[0] as { data: { toE164: string; body: string; chaseId: string; costPence?: unknown } };
  expect(log.data.toE164).toBe('+447700900001');
  expect(log.data.body).toBe(MESSAGE.body);
  expect(log.data.chaseId).toBe('chase_1');
  // No invented cost: AWS reports price on the delivery event stream.
  expect('costPence' in log.data).toBe(false);
});

test('a rate-limited recipient refuses BEFORE the first send — nothing leaves', async () => {
  const h = harness({ limiter: { consume: async () => ({ allowed: false }) } });

  await expect(h.sender.send(h.db, [MESSAGE])).rejects.toBeInstanceOf(AppException);
  expect(h.sends).toEqual([]);
  expect(h.updates).toEqual([]);
});

test('an opted-out recipient (STOP) refuses with NT-PRP-006 — the product never argues with a STOP', async () => {
  const h = harness({
    transport: {
      sendText: async () => {
        throw new OptedOutRecipientError();
      },
    },
  });

  const error = await h.sender.send(h.db, [MESSAGE]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppException);
  expect((error as AppException).code).toBe('NT-PRP-006');
  expect((error as AppException).publicDetail).toContain('opted out');
  expect(h.logs).toEqual([]);
});

test('the ceiling is consumed per recipient, keyed on the E164', async () => {
  const h = harness();
  await h.sender.send(h.db, [MESSAGE, { ...MESSAGE, chaseMessageId: 'msg_2', toE164: '+447700900002' }]);
  expect(h.consumed).toEqual(['+447700900001', '+447700900002']);
});

test('the factory runs once and is memoised — a sender that never sends builds nothing', async () => {
  const h = harness();
  expect(h.builtCount()).toBe(0);
  await h.sender.send(h.db, [MESSAGE]);
  await h.sender.send(h.db, [{ ...MESSAGE, chaseMessageId: 'msg_2' }]);
  expect(h.builtCount()).toBe(1);
});
