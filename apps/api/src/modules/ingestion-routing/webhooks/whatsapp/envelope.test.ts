import { expect, test } from 'vitest';

import { captionOf, parseEnvelope, type WhatsAppMessage } from './envelope.js';

function envelope(messages: unknown[]): unknown {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages } }] }] };
}

function message(partial: Partial<WhatsAppMessage>): WhatsAppMessage {
  return { id: '1', from: 'a', timestamp: '1', type: 'text', ...partial };
}

test('extracts inbound messages from the envelope', () => {
  const body = envelope([{ id: 'wamid.1', from: '447700900000', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }]);
  const { messages } = parseEnvelope(body);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.id).toBe('wamid.1');
});

test('a status callback (no messages) yields no messages rather than an error', () => {
  const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 's1' }] } }] }] };
  expect(parseEnvelope(body).messages).toHaveLength(0);
});

test('garbage or null yields no messages', () => {
  expect(parseEnvelope({ nonsense: true }).messages).toHaveLength(0);
  expect(parseEnvelope(null).messages).toHaveLength(0);
});

test('captionOf reads text, image, document and video captions, else null', () => {
  expect(captionOf(message({ type: 'text', text: { body: 'T' } }))).toBe('T');
  expect(captionOf(message({ type: 'image', image: { caption: 'I' } }))).toBe('I');
  expect(captionOf(message({ type: 'document', document: { caption: 'D' } }))).toBe('D');
  expect(captionOf(message({ type: 'audio' }))).toBeNull();
});

test('captionOf normalises empty and whitespace captions to null', () => {
  expect(captionOf(message({ type: 'text', text: { body: '' } }))).toBeNull();
  expect(captionOf(message({ type: 'image', image: { caption: '   ' } }))).toBeNull();
});
