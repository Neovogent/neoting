import { createHmac } from 'node:crypto';

import { expect, test } from 'vitest';

import { parseSignatureHeader, STRIPE_TIMESTAMP_TOLERANCE_SECONDS, verifyStripeSignature } from './stripe-signature.js';

const SECRET = 'whsec_test_secret';
const BODY = Buffer.from('{"id":"evt_1","type":"customer.subscription.updated"}', 'utf8');
const NOW_MS = 1_772_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function sign(body: Buffer, seconds: number, secret = SECRET): string {
  const mac = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${seconds}.`, 'utf8'), body]))
    .digest('hex');
  return `t=${seconds},v1=${mac}`;
}

test('a signature Stripe would send verifies', () => {
  expect(verifyStripeSignature(BODY, sign(BODY, NOW_S), SECRET, NOW_MS)).toBe(true);
});

test('the timestamp is inside the MAC — moving it invalidates the signature', () => {
  const header = sign(BODY, NOW_S).replace(`t=${NOW_S}`, `t=${NOW_S - 1}`);
  expect(verifyStripeSignature(BODY, header, SECRET, NOW_MS)).toBe(false);
});

test('a body altered after signing is rejected', () => {
  const header = sign(BODY, NOW_S);
  const tampered = Buffer.from('{"id":"evt_1","type":"customer.subscription.deleted"}', 'utf8');
  expect(verifyStripeSignature(tampered, header, SECRET, NOW_MS)).toBe(false);
});

test('a replay outside the tolerance is refused, and one inside it is not', () => {
  const stale = NOW_S - STRIPE_TIMESTAMP_TOLERANCE_SECONDS - 1;
  const fresh = NOW_S - STRIPE_TIMESTAMP_TOLERANCE_SECONDS + 1;
  expect(verifyStripeSignature(BODY, sign(BODY, stale), SECRET, NOW_MS)).toBe(false);
  expect(verifyStripeSignature(BODY, sign(BODY, fresh), SECRET, NOW_MS)).toBe(true);
});

test('a timestamp in the FUTURE is refused too — a clock that has run away is not a licence', () => {
  const ahead = NOW_S + STRIPE_TIMESTAMP_TOLERANCE_SECONDS + 1;
  expect(verifyStripeSignature(BODY, sign(BODY, ahead), SECRET, NOW_MS)).toBe(false);
});

test('during a secret rotation Stripe sends two v1s and either one passing is a pass', () => {
  const ours = sign(BODY, NOW_S).split(',')[1]!;
  const theirs = sign(BODY, NOW_S, 'whsec_the_other_one').split(',')[1]!;
  expect(verifyStripeSignature(BODY, `t=${NOW_S},${theirs},${ours}`, SECRET, NOW_MS)).toBe(true);
  expect(verifyStripeSignature(BODY, `t=${NOW_S},${ours},${theirs}`, SECRET, NOW_MS)).toBe(true);
});

test('an unknown scheme alongside a valid v1 is ignored, not fatal', () => {
  const header = `${sign(BODY, NOW_S)},v0=${'0'.repeat(64)},v2=whatever`;
  expect(verifyStripeSignature(BODY, header, SECRET, NOW_MS)).toBe(true);
});

test('every missing input fails CLOSED', () => {
  const good = sign(BODY, NOW_S);
  // No secret configured — this is the one that would otherwise fail OPEN.
  expect(verifyStripeSignature(BODY, good, '', NOW_MS)).toBe(false);
  expect(verifyStripeSignature(undefined, good, SECRET, NOW_MS)).toBe(false);
  expect(verifyStripeSignature(Buffer.alloc(0), good, SECRET, NOW_MS)).toBe(false);
  expect(verifyStripeSignature(BODY, undefined, SECRET, NOW_MS)).toBe(false);
  expect(verifyStripeSignature(BODY, '', SECRET, NOW_MS)).toBe(false);
});

test('a v1 that is not 64 hex characters never reaches timingSafeEqual', () => {
  for (const bad of ['deadbeef', 'g'.repeat(64), 'A'.repeat(64), `${'a'.repeat(63)}`]) {
    expect(verifyStripeSignature(BODY, `t=${NOW_S},v1=${bad}`, SECRET, NOW_MS)).toBe(false);
  }
});

test('the header parser refuses a non-integer or absent timestamp', () => {
  const mac = 'a'.repeat(64);
  expect(parseSignatureHeader(`t=1e9,v1=${mac}`)).toBeNull();
  expect(parseSignatureHeader(`t=12abc,v1=${mac}`)).toBeNull();
  expect(parseSignatureHeader(`t=-5,v1=${mac}`)).toBeNull();
  expect(parseSignatureHeader(`v1=${mac}`)).toBeNull();
  expect(parseSignatureHeader('t=1724680000')).toBeNull();
});

test('the header parser tolerates the whitespace a proxy may add', () => {
  const mac = 'b'.repeat(64);
  expect(parseSignatureHeader(`t=1724680000, v1=${mac}`)).toEqual({ timestamp: 1724680000, signatures: [mac] });
});

test('a value containing "=" is kept whole rather than truncated', () => {
  // Nothing Stripe sends looks like this; the assertion is that the parser does
  // not silently drop the tail, which is how a lenient parser becomes a bypass.
  expect(parseSignatureHeader('t=1724680000,junk=a=b,v1=' + 'c'.repeat(64))).toEqual({
    timestamp: 1724680000,
    signatures: ['c'.repeat(64)],
  });
});
