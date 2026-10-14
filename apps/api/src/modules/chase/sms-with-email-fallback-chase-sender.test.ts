import { describe, expect, it, vi } from 'vitest';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import type { OutboundSms, SentSms, SmsSender } from './sms-sender.js';
import { SmsWithEmailFallbackChaseSender } from './sms-with-email-fallback-chase-sender.js';

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

describe('SmsWithEmailFallbackChaseSender', () => {
  it('emails a contact with no mobile instead of refusing the chase', async () => {
    // The 14 Oct 2026 incident: an email-only contact under SMS_SENDER=aws
    // refused at approve with NT-PRP-006 and the request never left.
    const log: string[] = [];
    const sender = new SmsWithEmailFallbackChaseSender(spy('sms', log), spy('email', log));

    const sent = await sender.send(db, [message('cm_1', null)]);

    expect(log).toEqual(['email:cm_1']);
    expect(sent).toEqual([{ chaseMessageId: 'cm_1', providerMessageId: 'email-id', deliveryState: 'sent' }]);
  });

  it('texts a contact with a mobile and does not email them too', async () => {
    const log: string[] = [];
    const sender = new SmsWithEmailFallbackChaseSender(spy('sms', log), spy('email', log));

    await sender.send(db, [message('cm_1', '+447700900001')]);

    expect(log).toEqual(['sms:cm_1']);
  });

  it('splits a mixed batch, texting FIRST, and keeps the caller order in the result', async () => {
    // SMS runs first because it is the half that refuses before anything
    // irreversible (every per-number ceiling is consumed before the first send).
    const log: string[] = [];
    const sender = new SmsWithEmailFallbackChaseSender(spy('sms', log), spy('email', log));

    const sent = await sender.send(db, [
      message('cm_1', null),
      message('cm_2', '+447700900002'),
      message('cm_3', null),
    ]);

    expect(log).toEqual(['sms:cm_2', 'email:cm_1,cm_3']);
    expect(sent.map((s) => [s.chaseMessageId, s.providerMessageId])).toEqual([
      ['cm_1', 'email-id'],
      ['cm_2', 'sms-id'],
      ['cm_3', 'email-id'],
    ]);
  });

  it('lets an SMS refusal (STOP, ceiling) stand — and emails nobody in that batch', async () => {
    // A refusal is the approver's to act on, not this file's to route around.
    const log: string[] = [];
    const refusing: SmsSender = {
      send: vi.fn(async () => {
        throw new Error('the recipient has opted out of SMS');
      }),
    };
    const sender = new SmsWithEmailFallbackChaseSender(refusing, spy('email', log));

    await expect(sender.send(db, [message('cm_1', '+447700900001'), message('cm_2', null)])).rejects.toThrow(
      'opted out',
    );
    expect(log).toEqual([]);
  });

  it('sends nothing, either way, for an empty batch', async () => {
    const log: string[] = [];
    const sender = new SmsWithEmailFallbackChaseSender(spy('sms', log), spy('email', log));

    expect(await sender.send(db, [])).toEqual([]);
    expect(log).toEqual([]);
  });
});
