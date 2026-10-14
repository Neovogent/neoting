import { describe, expect, it, vi } from 'vitest';

import { AppException } from '../../common/problem/problem.js';
import type { ScopedClient } from '../../common/db/scoped-db.js';
import { SmsNotSent } from './aws-sms-sender.js';
import { SmsFirstChaseSender } from './sms-first-chase-sender.js';
import type { OutboundSms, SentSms, SmsSender } from './sms-sender.js';

const db = {} as ScopedClient;

function message(id: string, toE164: string | null): OutboundSms {
  return { businessId: 'biz_1', chaseId: 'chs_1', chaseMessageId: id, toE164, body: 'Please upload.' };
}

/** Records what it was handed on a shared log; `fail` decides per message whether to throw. */
function spy(name: string, log: string[], fail?: (m: OutboundSms) => Error | null): SmsSender {
  return {
    send: vi.fn(async (_db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]> => {
      for (const m of messages) {
        const error = fail?.(m) ?? null;
        if (error) throw error;
      }
      log.push(`${name}:${messages.map((m) => m.chaseMessageId).join(',')}`);
      return messages.map((m) => ({ chaseMessageId: m.chaseMessageId, providerMessageId: `${name}-id`, deliveryState: 'sent' }));
    }),
  };
}

describe('SmsFirstChaseSender', () => {
  it('texts a contact with a mobile and does not email them', async () => {
    const log: string[] = [];
    const sender = new SmsFirstChaseSender(spy('sms', log), spy('email', log));

    const sent = await sender.send(db, [message('cm_1', '+447700900001')]);

    expect(log).toEqual(['sms:cm_1']);
    expect(sent[0]!.providerMessageId).toBe('sms-id');
  });

  it('emails a contact with no mobile — the 14 Oct failure, where they got nothing', async () => {
    const log: string[] = [];
    const sender = new SmsFirstChaseSender(spy('sms', log), spy('email', log));

    await sender.send(db, [message('cm_1', null)]);

    expect(log).toEqual(['email:cm_1']);
  });

  it('emails instead when the text did not leave (a STOP, or AWS refusing it)', async () => {
    for (const reason of ['opted-out', 'rejected'] as const) {
      const log: string[] = [];
      const sms = spy('sms', log, () => new SmsNotSent(reason, 'not sent', new Error('aws')));
      const sender = new SmsFirstChaseSender(sms, spy('email', log));

      const sent = await sender.send(db, [message('cm_1', '+447700900001')]);

      expect(log).toEqual(['email:cm_1']);
      expect(sent[0]!.providerMessageId).toBe('email-id');
    }
  });

  it('does NOT route around the per-number ceiling by emailing instead', async () => {
    // The ceiling is the over-ask guard: an ordinary NT-PRP-006, not SmsNotSent.
    const log: string[] = [];
    const ceiling = new AppException('NT-PRP-006', 409, 'Proposal is not executable', 'over the per-number send ceiling');
    const sender = new SmsFirstChaseSender(spy('sms', log, () => ceiling), spy('email', log));

    await expect(sender.send(db, [message('cm_1', '+447700900001')])).rejects.toBe(ceiling);
    expect(log).toEqual([]);
  });

  it('decides per message, so one client falling back does not change another', async () => {
    const log: string[] = [];
    const sms = spy('sms', log, (m) => (m.chaseMessageId === 'cm_2' ? new SmsNotSent('opted-out', 'x', null) : null));
    const sender = new SmsFirstChaseSender(sms, spy('email', log));

    await sender.send(db, [message('cm_1', '+447700900001'), message('cm_2', '+447700900002'), message('cm_3', null)]);

    expect(log).toEqual(['sms:cm_1', 'email:cm_2', 'email:cm_3']);
  });

  it('sends nothing for an empty batch', async () => {
    const log: string[] = [];
    const sender = new SmsFirstChaseSender(spy('sms', log), spy('email', log));
    expect(await sender.send(db, [])).toEqual([]);
    expect(log).toEqual([]);
  });
});
