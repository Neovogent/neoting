import type { ChaseSendPayload } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import type { OutboundSms, SentSms, SmsSender } from '../../chase/index.js';
import { chaseSendExecutor } from './chase-send.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1', businessId: 'biz_1' });

interface TxnRow {
  id: string;
  businessId: string;
}
interface ContactRow {
  id: string;
  businessId: string;
}

/** A recording fake — assertions are on the rows written and the messages sent. */
function harness(over: { txns?: TxnRow[]; contacts?: ContactRow[]; existingForProposal?: string[] } = {}) {
  const txns = over.txns ?? [{ id: 'txn_currys', businessId: 'biz_1' }];
  const contacts = over.contacts ?? [{ id: 'contact_1', businessId: 'biz_1' }];
  const chases: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const existing = over.existingForProposal ?? [];
  let chaseSeq = 0;
  let messageSeq = 0;

  const db = {
    chase: {
      // `existing` holds chase ids already stamped with this proposal — the
      // executor queries by the single input proposalId, so any non-empty set
      // is "this proposal already ran".
      findFirst: async () => (existing.length > 0 ? { id: existing[0] } : null),
      findMany: async () => existing.map((id) => ({ id })),
      create: async ({ data, select }: { data: Record<string, unknown>; select: unknown }) => {
        chaseSeq += 1;
        const id = `chase_${chaseSeq}`;
        chases.push({ id, ...data });
        return select === undefined ? { id, ...data } : { id };
      },
    },
    chaseMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        messageSeq += 1;
        const id = `msg_${messageSeq}`;
        messages.push({ id, ...data });
        return { id };
      },
    },
    bankTransaction: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => txns.find((t) => t.id === id)).filter((t): t is TxnRow => t !== undefined),
    },
    contact: {
      findFirst: async ({ where }: { where: { id: string; businessId: string } }) =>
        contacts.find((c) => c.id === where.id && c.businessId === where.businessId) ?? null,
    },
  } as unknown as ScopedClient;

  return { db, chases, messages };
}

class RecordingSmsSender implements SmsSender {
  readonly sent: OutboundSms[] = [];
  async send(_db: ScopedClient, msgs: readonly OutboundSms[]): Promise<SentSms[]> {
    this.sent.push(...msgs);
    return msgs.map((m) => ({ chaseMessageId: m.chaseMessageId, providerMessageId: `p-${m.chaseMessageId}`, deliveryState: 'sent' }));
  }
}

const payload = (over: Partial<ChaseSendPayload['messages'][number]> = {}): ChaseSendPayload => ({
  messages: [
    {
      recipientE164: '+447700900001',
      recipientContactId: 'contact_1',
      body: "American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: https://n.to/abc",
      transactionIds: ['txn_currys'],
      ...over,
    },
  ],
});

const input = (p: ChaseSendPayload, proposalId = 'prop_1') => ({ proposalId, payload: p, ctx: CTX, traceId: 'trace-8' });

test('approve creates the chase + message and sends the SMS VERBATIM', async () => {
  const { db, chases, messages } = harness();
  const sender = new RecordingSmsSender();
  const result = await chaseSendExecutor(sender).execute(db, input(payload()));

  expect(result.alreadyApplied).toBe(false);
  expect(result.changed).toEqual([{ entity: 'chase', id: 'chase_1' }]);

  // The chase is SENT (approval IS the send), engine (a), grouped items, and
  // stamped with the proposal for idempotency.
  expect(chases[0]).toMatchObject({
    businessId: 'biz_1',
    detectionEngine: 'UNMATCHED_TRANSACTION',
    state: 'SENT',
    itemRefs: ['txn_currys'],
    recipientContactId: 'contact_1',
    actionProposalId: 'prop_1',
  });

  // The Review → Approve guarantee: the stored body and the sent body are the
  // payload body, byte-for-byte.
  const body = payload().messages[0]?.body;
  expect(messages[0]?.['body']).toBe(body);
  expect(sender.sent).toHaveLength(1);
  expect(sender.sent[0]?.body).toBe(body);
  expect(sender.sent[0]).toMatchObject({ businessId: 'biz_1', chaseId: 'chase_1', toE164: '+447700900001' });
});

test('a replay of the same proposal is an applied no-op — it never sends twice', async () => {
  const { db, chases } = harness({ existingForProposal: ['chase_prior'] });
  const sender = new RecordingSmsSender();
  const result = await chaseSendExecutor(sender).execute(db, input(payload()));

  expect(result.alreadyApplied).toBe(true);
  expect(result.changed).toEqual([{ entity: 'chase', id: 'chase_prior' }]);
  expect(chases).toHaveLength(0); // nothing created
  expect(sender.sent).toHaveLength(0); // nothing sent
});

test('an unreachable chased transaction refuses — an approver cannot chase what they cannot see', async () => {
  const { db } = harness({ txns: [] });
  await expect(chaseSendExecutor(new RecordingSmsSender()).execute(db, input(payload()))).rejects.toThrow(
    ProposalExecutionRefused,
  );
});

test('a grouped message spanning two clients refuses — grouped means ONE client', async () => {
  const { db } = harness({
    txns: [
      { id: 'txn_a', businessId: 'biz_1' },
      { id: 'txn_b', businessId: 'biz_2' },
    ],
  });
  await expect(
    chaseSendExecutor(new RecordingSmsSender()).execute(db, input(payload({ transactionIds: ['txn_a', 'txn_b'] }))),
  ).rejects.toThrow('one client');
});

test('a recipient contact from another client refuses', async () => {
  const { db } = harness({ contacts: [{ id: 'contact_1', businessId: 'biz_other' }] });
  await expect(chaseSendExecutor(new RecordingSmsSender()).execute(db, input(payload()))).rejects.toThrow(
    'not reachable for this client',
  );
});

test('a message with no named contact is legitimate — a forwarded link has no contact', async () => {
  const { db, chases } = harness();
  const result = await chaseSendExecutor(new RecordingSmsSender()).execute(
    db,
    input(payload({ recipientContactId: null })),
  );
  expect(result.alreadyApplied).toBe(false);
  expect(chases[0]).toMatchObject({ recipientContactId: null });
});
