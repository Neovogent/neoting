import { expect, test } from 'vitest';

import { AppException } from '../../common/problem/problem.js';
import type { ScopedClient } from '../../common/db/scoped-db.js';
import {
  DemoEmailSender,
  InMemoryEmailRateLimiter,
  parseEmailAddress,
} from '../notifications/index.js';
import {
  CHASE_EMAIL_CHANNEL,
  CHASE_EMAIL_SUBJECT,
  type ChaseEmailTransport,
  EmailChaseSender,
} from './email-chase-sender.js';
import type { OutboundSms } from './sms-sender.js';
import { composeChaseSms } from './sms-copy.js';

/**
 * `EmailChaseSender` — the A13 transport, offline.
 *
 * Every test here runs against `DemoEmailSender`, which "sends" into memory.
 * **No test in this file can reach a network**: the real `SesEmailSender` is
 * never constructed, never imported, and the lazy factory that would construct
 * it in production is replaced by a fixture the test hands in.
 */

interface ContactRow {
  email: string | null;
  receivesChases: boolean;
}

interface ChaseRow {
  recipientContactId: string | null;
  recipient: ContactRow | null;
}

interface MessageStamp {
  id: string;
  data: Record<string, unknown>;
}

/** A recording fake — the chase read is answered from a map, the stamp recorded. */
function harness(chases: Record<string, ChaseRow | null>) {
  const stamps: MessageStamp[] = [];
  const db = {
    chase: {
      findUnique: async ({ where }: { where: { id: string } }) => chases[where.id] ?? null,
    },
    chaseMessage: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        stamps.push({ id: where.id, data });
        return {};
      },
    },
  } as unknown as ScopedClient;
  return { db, stamps };
}

function transport(over: Partial<ChaseEmailTransport> = {}): ChaseEmailTransport & { email: DemoEmailSender } {
  const email = new DemoEmailSender(() => new Date('2026-08-27T09:00:00.000Z'));
  return {
    sender: email,
    limiter: new InMemoryEmailRateLimiter(),
    parseAddress: parseEmailAddress,
    email,
    ...over,
  };
}

function sender(t: ChaseEmailTransport): EmailChaseSender {
  return new EmailChaseSender(async () => t, () => new Date('2026-08-27T09:00:00.000Z'));
}

const CONTACT: ChaseRow = {
  recipientContactId: 'c_sam',
  recipient: { email: 'sam@cleaning.test', receivesChases: true },
};

function message(over: Partial<OutboundSms> = {}): OutboundSms {
  return {
    businessId: 'biz_1',
    chaseId: 'ch_1',
    chaseMessageId: 'cm_1',
    toE164: '+447700900001',
    body: 'Wright Cleaning Accounts: we’re missing the receipt for Currys £1,299 on 9 Aug. Upload securely: https://portal.test/p/tok',
    ...over,
  };
}

// ── The invariant: the sent bytes are the reviewed bytes ────────────────────

test('the email body is the payload body BYTE-FOR-BYTE — nothing is recomposed', async () => {
  // The body a reviewer would have been shown, produced by the real composer.
  const body = composeChaseSms({
    businessName: 'Wright Cleaning',
    portalLink: 'https://portal.test/p/tok',
    items: [
      {
        transactionId: 't_currys',
        amountPence: -129_900,
        bookedAt: new Date('2026-08-09T12:00:00.000Z'),
        supplierLabel: 'Currys',
      },
    ],
  });

  const t = transport();
  const { db } = harness({ ch_1: CONTACT });
  await sender(t).send(db, [message({ body })]);

  const [outbox] = t.email.readOutbox();
  expect(outbox?.body).toBe(body);
  // Not merely equal after trimming — identical, including the trailing bytes.
  expect(outbox?.body.length).toBe(body.length);
  expect(outbox?.to).toBe('sam@cleaning.test');
  expect(outbox?.kind).toBe('document-request');
});

test('the subject interpolates nothing — no client name, no supplier, no money', async () => {
  const t = transport();
  const { db } = harness({ ch_1: CONTACT });
  await sender(t).send(db, [message()]);

  const [outbox] = t.email.readOutbox();
  expect(outbox?.subject).toBe(CHASE_EMAIL_SUBJECT);
  // The review never showed a subject, so it may carry no fact the review did
  // not show — and no client-controlled text may reach the envelope.
  expect(outbox?.subject).not.toMatch(/Currys|Wright|1,299|£/);
});

test('a supplier name carrying markup travels in the reviewed body and never the subject', async () => {
  // A bank descriptor is client-controlled text (R6: untrusted content is data).
  // It is already inside the reviewed body; the transport must neither strip it
  // — that would break byte-identity — nor promote it into the envelope.
  const body = 'X Accounts: we’re missing the receipt for <script>alert(1)</script> £10 on 9 Aug. Upload securely: https://p.test/p/t';
  const t = transport();
  const { db } = harness({ ch_1: CONTACT });
  await sender(t).send(db, [message({ body })]);

  const [outbox] = t.email.readOutbox();
  expect(outbox?.body).toBe(body);
  expect(outbox?.subject).toBe(CHASE_EMAIL_SUBJECT);
});

// ── The outbox record ───────────────────────────────────────────────────────

test('the send is stamped onto the chase_messages row, with channel email', async () => {
  const t = transport();
  const { db, stamps } = harness({ ch_1: CONTACT });
  const sent = await sender(t).send(db, [message()]);

  expect(stamps).toHaveLength(1);
  expect(stamps[0]?.id).toBe('cm_1');
  expect(stamps[0]?.data).toMatchObject({
    channel: CHASE_EMAIL_CHANNEL,
    deliveryState: 'sent',
    providerMessageId: 'demo-email-1',
  });
  expect(stamps[0]?.data['sentAt']).toEqual(new Date('2026-08-27T09:00:00.000Z'));
  expect(sent).toEqual([{ chaseMessageId: 'cm_1', providerMessageId: 'demo-email-1', deliveryState: 'sent' }]);
});

test('no sms_log row is written — an email send never invents a phone number', async () => {
  const t = transport();
  // The fake has no `smsLog` at all, so any attempt to write one throws.
  const { db } = harness({ ch_1: CONTACT });
  await expect(sender(t).send(db, [message()])).resolves.toHaveLength(1);
});

// ── Who it is addressed to ──────────────────────────────────────────────────

test('a chase naming no contact refuses rather than guessing a recipient', async () => {
  const t = transport();
  const { db } = harness({ ch_1: { recipientContactId: null, recipient: null } });

  await expect(sender(t).send(db, [message()])).rejects.toSatisfy(
    (e: unknown) => e instanceof AppException && e.code === 'NT-PRP-006',
  );
  expect(t.email.readOutbox()).toHaveLength(0);
});

test('a contact with no email refuses, and the detail names no id and no address', async () => {
  const t = transport();
  const { db } = harness({ ch_1: { recipientContactId: 'c_sam', recipient: { email: null, receivesChases: true } } });

  const error = await sender(t).send(db, [message()]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppException);
  const detail = (error as AppException).publicDetail ?? '';
  expect(detail).toContain('no email address on file');
  expect(detail).not.toContain('c_sam');
  expect(detail).not.toContain('ch_1');
  expect(t.email.readOutbox()).toHaveLength(0);
});

test('a contact that does not receive document requests is never emailed', async () => {
  const t = transport();
  const { db, stamps } = harness({
    ch_1: { recipientContactId: 'c_sam', recipient: { email: 'sam@cleaning.test', receivesChases: false } },
  });

  await expect(sender(t).send(db, [message()])).rejects.toBeInstanceOf(AppException);
  expect(t.email.readOutbox()).toHaveLength(0);
  expect(stamps).toHaveLength(0);
});

test('an undeliverable address on the contact refuses instead of 500ing', async () => {
  const t = transport();
  const { db } = harness({
    ch_1: { recipientContactId: 'c_sam', recipient: { email: 'sam@@cleaning', receivesChases: true } },
  });

  const error = await sender(t).send(db, [message()]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppException);
  expect((error as AppException).code).toBe('NT-PRP-006');
});

test('a chase RLS did not return is the same refusal as one that names no contact', async () => {
  const t = transport();
  const { db } = harness({});

  const error = await sender(t).send(db, [message()]).catch((e: unknown) => e);
  expect((error as AppException).code).toBe('NT-PRP-006');
  // Never confirms whether the row exists.
  expect((error as AppException).publicDetail).not.toContain('ch_1');
});

// ── Nothing leaves before everything is known to be sendable ────────────────

test('a batch whose SECOND message is unsendable sends NOTHING at all', async () => {
  const t = transport();
  const { db, stamps } = harness({
    ch_1: CONTACT,
    ch_2: { recipientContactId: 'c_no', recipient: { email: null, receivesChases: true } },
  });

  await expect(
    sender(t).send(db, [message(), message({ chaseId: 'ch_2', chaseMessageId: 'cm_2' })]),
  ).rejects.toBeInstanceOf(AppException);

  // The first client did not receive a request for a chase that was then rolled
  // back — the whole reason recipients are resolved before anything is sent.
  expect(t.email.readOutbox()).toHaveLength(0);
  expect(stamps).toHaveLength(0);
});

// ── The last-resort over-ask guard ──────────────────────────────────────────

test('the per-address ceiling refuses an eleventh request in an hour, and sends nothing', async () => {
  const limiter = new InMemoryEmailRateLimiter();
  const t = transport({ limiter });
  const { db } = harness({ ch_1: CONTACT });
  const s = sender(t);

  // The `document-request` ceiling in `email-rate-limit.ts` is 10 per address
  // per hour. Ten approved chases to one client in one hour is already far
  // beyond a human pressing Approve; the eleventh is a runaway.
  for (let i = 0; i < 10; i += 1) await s.send(db, [message()]);
  expect(t.email.readOutbox()).toHaveLength(10);

  const error = await s.send(db, [message()]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppException);
  expect((error as AppException).code).toBe('NT-RATE-001');
  // Refused BEFORE the send: still ten, not eleven.
  expect(t.email.readOutbox()).toHaveLength(10);
});

test('the ceiling is consumed without an IP — an approved chase has no request behind it', async () => {
  const seen: unknown[] = [];
  const t = transport({
    limiter: {
      consume: async (request) => {
        seen.push(request);
        return { allowed: true, retryAfterSeconds: 0, limitedBy: null };
      },
    },
  });
  const { db } = harness({ ch_1: CONTACT });
  await sender(t).send(db, [message()]);

  expect(seen).toEqual([{ kind: 'document-request', address: 'sam@cleaning.test' }]);
});

// ── The transport is resolved lazily, and only once ─────────────────────────

test('the transport factory is not called until the first send, and is memoised', async () => {
  let calls = 0;
  const t = transport();
  const s = new EmailChaseSender(async () => {
    calls += 1;
    return t;
  });
  expect(calls).toBe(0);

  const { db } = harness({ ch_1: CONTACT });
  await s.send(db, [message()]);
  await s.send(db, [message({ chaseMessageId: 'cm_2' })]);
  expect(calls).toBe(1);
});

test('an empty batch sends nothing and resolves no transport', async () => {
  let calls = 0;
  const s = new EmailChaseSender(async () => {
    calls += 1;
    return transport();
  });
  const { db } = harness({});
  expect(await s.send(db, [])).toEqual([]);
  expect(calls).toBe(0);
});
