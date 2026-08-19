import { expect, test } from 'vitest';

import { composeChaseSms, formatDay, formatGbp } from './sms-copy.js';

// A booked date in early August — chosen mid-day UTC so the Europe/London day
// (BST, +1) is unambiguously the 9th.
const AUG_9 = new Date('2026-08-09T12:00:00.000Z');

test('the single-item copy is the SoT Stage 8.2 shape, verbatim', () => {
  const sms = composeChaseSms({
    businessName: 'American Burger',
    portalLink: 'https://n.to/abc',
    items: [{ transactionId: 'txn_currys', amountPence: -129900, bookedAt: AUG_9, supplierLabel: 'Currys' }],
  });
  // SoT: "American Burger Accounts: we're missing the receipt for Currys £1,299
  //       on 9 Aug. Upload securely: [link]"
  expect(sms).toBe(
    "American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: https://n.to/abc",
  );
});

test('grouped per client: many receipts become ONE text, not one per receipt', () => {
  const sms = composeChaseSms({
    businessName: 'American Burger',
    portalLink: 'https://n.to/abc',
    items: [
      { transactionId: 't1', amountPence: -129900, bookedAt: AUG_9, supplierLabel: 'Currys' },
      { transactionId: 't2', amountPence: -60000, bookedAt: new Date('2026-08-05T12:00:00.000Z'), supplierLabel: 'Google Ads' },
    ],
  });
  expect(sms).toBe(
    "American Burger Accounts: we're missing the receipts for Currys £1,299 on 9 Aug and Google Ads £600 on 5 Aug. Upload securely: https://n.to/abc",
  );
});

test('formatGbp: integer pence to pounds, string-only, no float, drops a whole .00', () => {
  expect(formatGbp(-129900)).toBe('£1,299'); // magnitude shown; whole pounds
  expect(formatGbp(60000)).toBe('£600');
  expect(formatGbp(129950)).toBe('£1,299.50'); // non-zero pence kept
  expect(formatGbp(99)).toBe('£0.99');
  expect(formatGbp(0)).toBe('£0');
  expect(formatGbp(-1234567)).toBe('£12,345.67'); // two thousands groups
});

test('formatDay renders the Europe/London day, from a UTC instant', () => {
  expect(formatDay(AUG_9)).toBe('9 Aug');
  // 30 Dec 23:30 UTC is 30 Dec in London (GMT in winter) — no rollover here.
  expect(formatDay(new Date('2026-12-30T23:30:00.000Z'))).toBe('30 Dec');
});
