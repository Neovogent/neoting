import { expect, test } from 'vitest';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { DemoSmsSender, type OutboundSms } from './sms-sender.js';

/** A recording fake — the assertions are on the two outbox rows written. */
function harness() {
  const messageUpdates: { where: unknown; data: Record<string, unknown> }[] = [];
  const smsLogs: Record<string, unknown>[] = [];
  const db = {
    chaseMessage: {
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        messageUpdates.push(args);
        return {};
      },
    },
    smsLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        smsLogs.push(data);
        return data;
      },
    },
  } as unknown as ScopedClient;
  return { db, messageUpdates, smsLogs };
}

const msg: OutboundSms = {
  businessId: 'biz_1',
  chaseId: 'chase_1',
  chaseMessageId: 'msg_1',
  toE164: '+447700900001',
  body: 'the exact reviewed text',
};

test('the demo sender records the send on the chase_messages row and appends an sms_log', async () => {
  const { db, messageUpdates, smsLogs } = harness();
  const sent = await new DemoSmsSender().send(db, [msg]);

  // The chase_messages row is stamped sent — it is NOT rewritten (body untouched).
  expect(messageUpdates[0]?.data).toMatchObject({ providerMessageId: 'demo-sms-msg_1', deliveryState: 'sent' });
  expect(messageUpdates[0]?.data).not.toHaveProperty('body');
  expect(messageUpdates[0]?.data['sentAt']).toBeInstanceOf(Date);

  // The sms_log row is the per-business send log, body verbatim, no cost.
  expect(smsLogs[0]).toMatchObject({
    businessId: 'biz_1',
    toE164: '+447700900001',
    body: 'the exact reviewed text',
    providerMessageId: 'demo-sms-msg_1',
    deliveryState: 'sent',
    chaseId: 'chase_1',
  });

  expect(sent).toEqual([{ chaseMessageId: 'msg_1', providerMessageId: 'demo-sms-msg_1', deliveryState: 'sent' }]);
});

test('the demo provider id is deterministic in the message id', async () => {
  const { db } = harness();
  const [a] = await new DemoSmsSender().send(db, [msg]);
  const { db: db2 } = harness();
  const [b] = await new DemoSmsSender().send(db2, [msg]);
  expect(a?.providerMessageId).toBe(b?.providerMessageId);
});
