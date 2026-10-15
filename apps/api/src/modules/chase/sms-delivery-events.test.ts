import { expect, test } from 'vitest';

import { classify, costPenceFor, deliveryStateFor, parseDeliveryEvent } from './sms-delivery-events.js';

const v2 = {
  eventType: 'TEXT_DELIVERED',
  messageId: 'msg-1',
  eventTimestamp: 1_760_000_000_000,
  totalMessagePrice: 0.04,
  totalCarrierFee: 0.00767,
};

test('parses a raw event and one still wrapped in the SNS envelope', () => {
  expect(parseDeliveryEvent(JSON.stringify(v2))?.messageId).toBe('msg-1');
  const wrapped = JSON.stringify({ Type: 'Notification', Message: JSON.stringify(v2) });
  expect(parseDeliveryEvent(wrapped)?.eventType).toBe('TEXT_DELIVERED');
  expect(parseDeliveryEvent('not json')).toBeNull();
  expect(parseDeliveryEvent(JSON.stringify({ eventType: 'TEXT_DELIVERED' }))).toBeNull();
});

test('cost is integer pence via integer maths, from v2 USD or v1 millicents', () => {
  // $0.04767 = 4767 millicents × 0.790 = 3.766p → 4p
  const cost = costPenceFor(parseDeliveryEvent(JSON.stringify(v2))!, 790);
  expect(cost).toBe(4);
  expect(Number.isInteger(cost)).toBe(true);
  // Pinpoint v1 shape: 645 millicents × 0.790 = 0.51p → 1p
  expect(costPenceFor({ eventType: 'TEXT_DELIVERED', messageId: 'm', metrics: { price_in_millicents_usd: 645 } }, 790)).toBe(1);
  expect(costPenceFor({ eventType: 'TEXT_DELIVERED', messageId: 'm' }, 790)).toBeNull();
});

test('classification and the stored state', () => {
  expect(classify('TEXT_DELIVERED')).toBe('delivered');
  expect(classify('TEXT_SUCCESSFUL')).toBe('delivered');
  expect(classify('TEXT_PENDING')).toBe('pending');
  expect(classify('TEXT_CARRIER_UNREACHABLE')).toBe('failed');
  expect(deliveryStateFor('TEXT_TTL_EXPIRED')).toBe('failed:ttl_expired');
});
