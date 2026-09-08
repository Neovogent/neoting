import { describe, expect, it, vi } from 'vitest';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { EmailAndOutboxChaseSender } from './email-and-outbox-chase-sender.js';
import type { OutboundSms, SentSms, SmsSender } from './sms-sender.js';

const db = {} as ScopedClient;

function message(id: string, toE164: string | null): OutboundSms {
  return { businessId: 'biz_1', chaseId: 'chs_1', chaseMessageId: id, toE164, body: 'Please upload.' };
}

/** Records what it was handed, in call order, on a shared log. */
function spy(name: string, log: string[]): SmsSender {
  return {
    send: vi.fn(async (_db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]> => {
      log.push(`${name}:${messages.map((m) => m.chaseMessageId).join(',')}`);
      return messages.map((m) => ({ chaseMessageId: m.chaseMessageId, providerMessageId: `${name}-id`, deliveryState: 'sent' }));
    }),
  };
}

describe('EmailAndOutboxChaseSender', () => {
  it('writes the outbox row FIRST and delivers by email LAST', async () => {
    // The order is what keeps `chase_messages` honest: the email half stamps
    // channel + the real provider id, so it has to win the last write.
    const log: string[] = [];
    const sender = new EmailAndOutboxChaseSender(spy('outbox', log), spy('email', log));

    await sender.send(db, [message('cm_1', '+447700900001')]);

    expect(log).toEqual(['outbox:cm_1', 'email:cm_1']);
  });

  it('returns the EMAIL half result — the transport that actually delivered', async () => {
    const log: string[] = [];
    const sender = new EmailAndOutboxChaseSender(spy('outbox', log), spy('email', log));

    const sent = await sender.send(db, [message('cm_1', '+447700900001')]);

    expect(sent).toEqual([{ chaseMessageId: 'cm_1', providerMessageId: 'email-id', deliveryState: 'sent' }]);
  });

  it('keeps a contact with no mobile OUT of the outbox but still emails them', async () => {
    // DemoSmsSender throws on a null toE164 (sms_log.to_e164 is NOT NULL), and
    // intake makes the mobile optional. Chasing must not become impossible for
    // an email-only contact just to populate a screen.
    const log: string[] = [];
    const sender = new EmailAndOutboxChaseSender(spy('outbox', log), spy('email', log));

    await sender.send(db, [message('cm_1', null), message('cm_2', '+447700900002')]);

    expect(log).toEqual(['outbox:cm_2', 'email:cm_1,cm_2']);
  });

  it('does not touch the outbox at all when nobody has a mobile', async () => {
    const log: string[] = [];
    const sender = new EmailAndOutboxChaseSender(spy('outbox', log), spy('email', log));

    await sender.send(db, [message('cm_1', null)]);

    expect(log).toEqual(['email:cm_1']);
  });

  it('sends nothing, either way, for an empty batch', async () => {
    const log: string[] = [];
    const sender = new EmailAndOutboxChaseSender(spy('outbox', log), spy('email', log));

    expect(await sender.send(db, [])).toEqual([]);
    expect(log).toEqual([]);
  });
});
