import { expect, test } from 'vitest';

import type {
  BankTransaction as BankTransactionRow,
  Chase as ChaseRow,
  ChaseMessage as ChaseMessageRow,
  SmsLog as SmsLogRow,
} from '@prisma/client';

import {
  extractPortalUrl,
  toChaseDetail,
  toChaseItem,
  toChaseMessage,
  toChaseSummary,
  toSmsOutboxMessage,
} from './chase-projection.js';

const NOW = new Date('2026-08-18T09:00:00.000Z');
const BOOKED = new Date('2026-08-09T12:00:00.000Z');

function chase(over: Partial<ChaseRow> = {}): ChaseRow {
  return {
    id: 'chase_1',
    businessId: 'biz_burger',
    detectionEngine: 'UNMATCHED_TRANSACTION',
    transactionId: 'txn_currys',
    itemRefs: ['txn_currys'],
    recipientContactId: 'contact_1',
    state: 'SENT',
    schedule: null,
    firstSentAt: NOW,
    lastSentAt: NOW,
    escalatedAt: null,
    closedAt: null,
    closedReason: null,
    closedByDocumentId: null,
    actionProposalId: 'prop_1',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as unknown as ChaseRow;
}

function txn(over: Partial<BankTransactionRow> = {}): BankTransactionRow {
  return {
    id: 'txn_currys',
    businessId: 'biz_burger',
    accountId: 'acct_1',
    providerTransactionId: null,
    bookedAt: BOOKED,
    pendingAt: null,
    amountPence: -129_900,
    currency: 'GBP',
    descriptionRaw: 'CURRYS 1234 LONDON',
    merchantName: 'Currys',
    classification: null,
    balanceAfterPence: null,
    counterparty: null,
    standingOrderRef: null,
    importBatchId: null,
    rawPayloadRef: null,
    matchState: 'UNMATCHED',
    chaseSuppressed: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as unknown as BankTransactionRow;
}

function message(over: Partial<ChaseMessageRow> = {}): ChaseMessageRow {
  return {
    id: 'msg_1',
    chaseId: 'chase_1',
    channel: 'sms',
    body: "American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: abc.def",
    recipientE164: '+447700900001',
    providerMessageId: 'demo-sms-1',
    deliveryState: 'sent',
    sentAt: NOW,
    createdAt: NOW,
    ...over,
  } as unknown as ChaseMessageRow;
}

function sms(over: Partial<SmsLogRow> = {}): SmsLogRow {
  return {
    id: 'sms_1',
    businessId: 'biz_burger',
    toE164: '+447700900001',
    body: "American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: abc.def",
    providerMessageId: 'demo-sms-1',
    deliveryState: 'sent',
    costPence: null,
    chaseId: 'chase_1',
    sentAt: NOW,
    ...over,
  } as unknown as SmsLogRow;
}

test('toChaseSummary projects the row, counts grouped items, and emits ISO instants', () => {
  const out = toChaseSummary(chase({ itemRefs: ['txn_a', 'txn_b', 'txn_c'] }));
  expect(out.id).toBe('chase_1');
  expect(out.businessId).toBe('biz_burger');
  expect(out.detectionEngine).toBe('UNMATCHED_TRANSACTION');
  expect(out.state).toBe('SENT');
  expect(out.itemCount).toBe(3); // grouped per client, never one text per receipt
  expect(out.actionProposalId).toBe('prop_1');
  expect(out.firstSentAt).toBe(NOW.toISOString());
  expect(out.createdAt).toBe(NOW.toISOString());
});

test('toChaseSummary nulls absent optionals rather than omitting them', () => {
  const out = toChaseSummary(
    chase({ recipientContactId: null, actionProposalId: null, firstSentAt: null, lastSentAt: null, closedAt: null, closedReason: null, closedByDocumentId: null }),
  );
  expect(out.recipientContactId).toBeNull();
  expect(out.actionProposalId).toBeNull();
  expect(out.firstSentAt).toBeNull();
  expect(out.closedAt).toBeNull();
});

test('itemCount never drops below 1, falling back to the convenience column', () => {
  // A malformed row with empty refs still reports its single-transaction column.
  expect(toChaseSummary(chase({ itemRefs: [], transactionId: 'txn_only' })).itemCount).toBe(1);
  // Even a row with neither is clamped to the contract minimum of 1.
  expect(toChaseSummary(chase({ itemRefs: [], transactionId: null })).itemCount).toBe(1);
  // A non-array Json (a corrupt write) does not throw — it falls back.
  expect(toChaseSummary(chase({ itemRefs: 'oops' as unknown as ChaseRow['itemRefs'], transactionId: 'txn_only' })).itemCount).toBe(1);
});

test('toChaseItem carries pence as an integer, unchanged, and derives received from match state', () => {
  const unmatched = toChaseItem(txn({ amountPence: -129_900, matchState: 'UNMATCHED' }), false);
  expect(unmatched.amountPence).toBe(-129_900); // integer pence, no coercion
  expect(unmatched.received).toBe(false);
  expect(unmatched.merchantName).toBe('Currys');
  expect(unmatched.descriptionRaw).toBe('CURRYS 1234 LONDON');
  expect(unmatched.bookedAt).toBe(BOOKED.toISOString());

  // A confirmed match means the paperwork arrived — received, even on an open chase.
  expect(toChaseItem(txn({ matchState: 'CONFIRMED' }), false).received).toBe(true);
});

test('toChaseDetail joins items by ref, orders them by the chase, and drops refs RLS withheld', () => {
  const row = chase({ itemRefs: ['txn_currys', 'txn_google', 'txn_hidden'] });
  const detail = toChaseDetail(row, [txn({ id: 'txn_google', merchantName: 'Google' }), txn({ id: 'txn_currys' })], [message()]);

  // Two of the three refs were reachable; the order follows itemRefs, not the fetch.
  expect(detail.items.map((i) => i.transactionId)).toEqual(['txn_currys', 'txn_google']);
  expect(detail.messages).toHaveLength(1);
  expect(detail.messages[0]?.body).toContain("we're missing the receipt for Currys");
  // Summary fields survive onto the detail — built on top of toChaseSummary.
  expect(detail.state).toBe('SENT');
  expect(detail.itemCount).toBe(3);
});

test('toChaseDetail marks every item received when the chase closed as CLOSED_RECEIVED', () => {
  const detail = toChaseDetail(chase({ state: 'CLOSED_RECEIVED', itemRefs: ['txn_currys'] }), [txn({ matchState: 'UNMATCHED' })], []);
  expect(detail.items[0]?.received).toBe(true); // the auto-close beat: all items received
});

test('toChaseMessage passes the verbatim body through untouched', () => {
  const body = 'exact text shown at review and sent';
  const out = toChaseMessage(message({ body, sentAt: null }));
  expect(out.body).toBe(body);
  expect(out.sentAt).toBeNull();
  expect(out.chaseId).toBe('chase_1');
});

test('toSmsOutboxMessage extracts the portal link so the phone screen can tap it', () => {
  const out = toSmsOutboxMessage(sms());
  expect(out.toE164).toBe('+447700900001');
  expect(out.chaseId).toBe('chase_1');
  expect(out.portalUrl).toBe('abc.def');
  expect(out.sentAt).toBe(NOW.toISOString());
});

test('extractPortalUrl returns the link, or null when the body carries none', () => {
  expect(extractPortalUrl('foo. Upload securely: token123')).toBe('token123');
  expect(extractPortalUrl('foo. Upload securely: token123 and then some')).toBe('token123');
  expect(extractPortalUrl('a message with no link at all')).toBeNull();
  expect(extractPortalUrl('Upload securely: ')).toBeNull();
});
