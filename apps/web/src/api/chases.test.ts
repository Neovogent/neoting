import { expect, test } from 'vitest';

import { ChaseState, type Chase as ApiChase } from '@neoting/contracts/model';
import { getChaseResponse } from '@neoting/contracts/zod';
import { fromIsoInstant, parseChaseDetail, portalPathFrom, toLiveChase, toLiveSms } from './chases';

/**
 * The chase read boundary (METH Stage 12): the money crossing (signed pence →
 * the unsigned pounds a chased line displays as), the open/closed split pinned
 * against the CONTRACT's state enum, and the outbox link being re-homed under
 * this origin — the tap that makes the demo's phone real.
 */

const chase = (over: Partial<ApiChase> = {}): ApiChase =>
  ({
    id: 'chase_1',
    businessId: 'biz_burger',
    detectionEngine: 'UNMATCHED_TRANSACTION',
    state: 'SENT',
    recipientContactId: 'con_dee',
    itemCount: 1,
    actionProposalId: 'prop_1',
    firstSentAt: '2026-08-17T10:00:00.000Z',
    lastSentAt: '2026-08-17T10:00:00.000Z',
    closedAt: null,
    closedReason: null,
    closedByDocumentId: null,
    createdAt: '2026-08-17T10:00:00.000Z',
    items: [
      {
        transactionId: 'txn_currys',
        merchantName: 'Currys',
        descriptionRaw: 'CURRYS 1234 LONDON',
        amountPence: -129_900,
        bookedAt: '2026-08-09T00:00:00.000Z',
        received: false,
      },
    ],
    messages: [
      {
        id: 'msg_1',
        chaseId: 'chase_1',
        channel: 'sms',
        body: 'Upload securely: tok.sig',
        recipientE164: '+447700900123',
        deliveryState: 'delivered',
        sentAt: '2026-08-17T10:00:00.000Z',
        createdAt: '2026-08-17T10:00:00.000Z',
      },
    ],
    ...over,
  }) as ApiChase;

/* ── the boundary parse and its measured orval gap ────────────────────────── */

test('parseChaseDetail accepts a body the GENERATED schema still refuses — the strict-intersection pin', () => {
  const body = chase();
  // The pin: orval emits `Chase` (allOf) as an intersection of two `.strict()`
  // objects, each rejecting the other's keys, so the whole schema rejects a
  // VALID body. When orval fixes this, this assertion fails on purpose —
  // delete the halves workaround in chases.ts and parse with the schema.
  expect(getChaseResponse.safeParse(body).success).toBe(false);
  const parsed = parseChaseDetail(body);
  expect(parsed?.id).toBe('chase_1');
  expect(parsed?.items).toHaveLength(1);
  expect(parsed?.messages).toHaveLength(1);
});

test('parseChaseDetail refuses what either half refuses — empty items (minItems 1) and a float in pence', () => {
  expect(parseChaseDetail(chase({ items: [] }))).toBeNull();
  const pounds = -1299.5; // the R5 lint refuses a float literal in a *Pence slot
  expect(parseChaseDetail(chase({ items: [{ ...chase().items[0]!, amountPence: pounds }] }))).toBeNull();
});

/* ── the open/closed split, pinned against the contract enum ─────────────── */

test('every contract state is either open or closed, and the split is the CLOSED_ prefix', () => {
  for (const state of Object.values(ChaseState)) {
    const live = toLiveChase(chase({ state }));
    expect(live.open).toBe(!state.startsWith('CLOSED'));
  }
});

/* ── the money crossing ───────────────────────────────────────────────────── */

test('a chased line displays as unsigned pounds — the feed sign convention stops at the boundary', () => {
  const live = toLiveChase(chase());
  expect(live.items[0]!.amount).toBe(1299);
});

test('a pence value that is not a round pound survives exactly', () => {
  const live = toLiveChase(chase({ items: [{ ...chase().items[0]!, amountPence: -42_099 }] }));
  expect(live.items[0]!.amount).toBe(420.99);
});

test('the merchant name wins, the raw descriptor is the fallback, then a placeholder', () => {
  const base = chase().items[0]!;
  expect(toLiveChase(chase()).items[0]!.supplier).toBe('Currys');
  expect(toLiveChase(chase({ items: [{ ...base, merchantName: null }] })).items[0]!.supplier).toBe('CURRYS 1234 LONDON');
  expect(toLiveChase(chase({ items: [{ ...base, merchantName: null, descriptionRaw: null }] })).items[0]!.supplier).toBe('—');
});

/* ── the closure record ───────────────────────────────────────────────────── */

test('a closed chase carries its reason and the answering document', () => {
  const live = toLiveChase(
    chase({
      state: 'CLOSED_RECEIVED',
      closedAt: '2026-08-19T08:00:00.000Z',
      closedReason: 'Document received through the secure link',
      closedByDocumentId: 'doc_005',
    }),
  );
  expect(live.open).toBe(false);
  expect(live.closedReason).toBe('Document received through the secure link');
  expect(live.closedByDocumentId).toBe('doc_005');
});

/* ── instants render Europe/London ────────────────────────────────────────── */

test('a UTC instant renders as the Europe/London wall clock (BST in August)', () => {
  // 12:00Z on an August day is 13:00 in London.
  expect(fromIsoInstant('2026-08-09T12:00:00.000Z')).toMatch(/9 Aug.*13:00/);
  expect(fromIsoInstant(null)).toBeNull();
  expect(fromIsoInstant('not a date')).toBeNull();
});

/* ── the outbox link ──────────────────────────────────────────────────────── */

test('the portal link is re-homed under this origin from whatever the body carried', () => {
  // The real composer puts the bare signed token in the SMS.
  expect(portalPathFrom('tok.sig')).toBe('/p/tok.sig');
  // Older fixtures carried a full URL; the last path segment is the token.
  expect(portalPathFrom('https://neoting.neovogent.com/p/yyyy')).toBe('/p/yyyy');
  expect(portalPathFrom(null)).toBeNull();
  expect(portalPathFrom('')).toBeNull();
  // A trailing slash yields no token, not a link to the portal root.
  expect(portalPathFrom('https://example.test/p/')).toBeNull();
});

test('an outbox row keeps the body verbatim and derives only the tappable path', () => {
  const sms = toLiveSms({
    id: 'sms_1',
    businessId: 'biz_burger',
    toE164: '+447700900123',
    body: "American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: tok.sig",
    deliveryState: 'sent',
    chaseId: 'chase_1',
    portalUrl: 'tok.sig',
    sentAt: '2026-08-19T08:30:00.000Z',
  });
  expect(sms.body).toContain('Upload securely: tok.sig');
  expect(sms.portalPath).toBe('/p/tok.sig');
  expect(sms.to).toBe('+447700900123');
});
