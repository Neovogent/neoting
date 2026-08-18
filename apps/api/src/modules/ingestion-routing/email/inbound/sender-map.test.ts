import { expect, test } from 'vitest';

import { buildSenderMap, EmptySenderMapLoader, type SenderMapRow } from './sender-map.js';

function row(over: Partial<SenderMapRow> = {}): SenderMapRow {
  return { email: null, mobileE164: null, businessId: 'biz_burger', ...over };
}

test('an email identity maps to its business', () => {
  const map = buildSenderMap([row({ email: 'owner@americanburger.test' })]);
  expect(map.get('owner@americanburger.test')).toEqual(['biz_burger']);
});

test('a phone identity maps to its business', () => {
  const map = buildSenderMap([row({ mobileE164: '+447700900001' })]);
  expect(map.get('+447700900001')).toEqual(['biz_burger']);
});

test('one contact with both identities is reachable by either', () => {
  const map = buildSenderMap([row({ email: 'owner@americanburger.test', mobileE164: '+447700900001' })]);
  expect(map.get('owner@americanburger.test')).toEqual(['biz_burger']);
  expect(map.get('+447700900001')).toEqual(['biz_burger']);
});

test('an unknown sender is not a key — decideRouting reads that as Unrouted', () => {
  const map = buildSenderMap([row({ email: 'owner@americanburger.test' })]);
  expect(map.get('stranger@example.test')).toBeUndefined();
  expect(map.has('stranger@example.test')).toBe(false);
});

test('email keys are lower-cased, so a differently-cased sender still matches', () => {
  // postal-mime carries the address in the case the sender wrote it; the header
  // casing is not significant and must not decide routing. Lower-casing the key
  // is what makes the match case-insensitive.
  const map = buildSenderMap([row({ email: 'Owner@AmericanBurger.TEST' })]);
  expect(map.get('owner@americanburger.test')).toEqual(['biz_burger']);
});

test('a phone is keyed both with and without the leading + (Meta sends wa_id without it)', () => {
  // A stored E164 carries the +; Meta's `from`/`wa_id` does not. Both must be keys
  // or a WhatsApp sender could never match a seeded contact.
  const map = buildSenderMap([row({ mobileE164: '+447700900001' })]);
  expect(map.get('+447700900001')).toEqual(['biz_burger']);
  expect(map.get('447700900001')).toEqual(['biz_burger']);
});

test('the same identity on the same business collapses to one businessId', () => {
  // Two contacts on one business sharing the email — a repeated businessId would
  // make decideRouting see length > 1 and raise a spurious "Which company?".
  const map = buildSenderMap([
    row({ email: 'owner@americanburger.test' }),
    row({ email: 'owner@americanburger.test' }),
  ]);
  expect(map.get('owner@americanburger.test')).toEqual(['biz_burger']);
});

test('one identity across two businesses lists both (decideRouting → multiple)', () => {
  const map = buildSenderMap([
    row({ email: 'shared@acme.test', businessId: 'biz_a' }),
    row({ email: 'shared@acme.test', businessId: 'biz_b' }),
  ]);
  expect(map.get('shared@acme.test')).toEqual(['biz_a', 'biz_b']);
});

test('a contact with neither an email nor a phone contributes no key', () => {
  const map = buildSenderMap([row()]);
  expect(map.size).toBe(0);
});

test('blank / whitespace-only identities are skipped, never keyed as empty string', () => {
  const map = buildSenderMap([row({ email: '', mobileE164: '   ' })]);
  expect(map.size).toBe(0);
});

test('EmptySenderMapLoader resolves every practice to an empty map (today’s behaviour)', async () => {
  const map = await new EmptySenderMapLoader().load('prac_ledgerline');
  expect(map.size).toBe(0);
});
