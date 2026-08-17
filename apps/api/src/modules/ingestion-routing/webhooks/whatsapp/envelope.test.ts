import { expect, test } from 'vitest';

import { captionOf, mediaOf, parseEnvelope, type WhatsAppMessage } from './envelope.js';

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

// ── WhatsApp media (#79) ─────────────────────────────────────────────────────

test('mediaOf returns the id and declared mime for image, document and video', () => {
  expect(mediaOf(message({ type: 'image', image: { id: 'img1', mime_type: 'image/jpeg' } }))).toEqual({
    id: 'img1',
    declaredMimeType: 'image/jpeg',
    declaredFilename: null,
  });
  expect(mediaOf(message({ type: 'video', video: { id: 'vid1', mime_type: 'video/mp4' } }))).toEqual({
    id: 'vid1',
    declaredMimeType: 'video/mp4',
    declaredFilename: null,
  });
  // Only a document carries a filename, and it is surfaced as declaredFilename.
  expect(
    mediaOf(message({ type: 'document', document: { id: 'doc1', mime_type: 'application/pdf', filename: 'invoice.pdf' } })),
  ).toEqual({ id: 'doc1', declaredMimeType: 'application/pdf', declaredFilename: 'invoice.pdf' });
});

test('mediaOf returns null for a text message and for media with no usable id', () => {
  // A client texting "sent it yesterday?" is a real thing to receive — not an
  // error and not a document. It is logged, not persisted, which is not dropped.
  expect(mediaOf(message({ type: 'text', text: { body: 'hi' } }))).toBeNull();
  expect(mediaOf(message({ type: 'image', image: { mime_type: 'image/png' } }))).toBeNull();
  expect(mediaOf(message({ type: 'image', image: { id: '' } }))).toBeNull();
});

test('parseEnvelope reads phone_number_id PER CHANGE, never per envelope', () => {
  // One delivery can batch changes from more than one of OUR numbers. Attributing
  // them all to the first would file another practice's documents under this one —
  // a cross-tenant leak. Each message must carry the number that received IT.
  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          { value: { metadata: { phone_number_id: 'pn_A' }, messages: [{ id: 'a1', from: 'x', timestamp: '1', type: 'text' }] } },
          { value: { metadata: { phone_number_id: 'pn_B' }, messages: [{ id: 'b1', from: 'y', timestamp: '1', type: 'text' }] } },
        ],
      },
    ],
  };
  const { messages } = parseEnvelope(body);
  expect(messages).toHaveLength(2);
  expect(messages.find((m) => m.id === 'a1')?.receivedByPhoneNumberId).toBe('pn_A');
  expect(messages.find((m) => m.id === 'b1')?.receivedByPhoneNumberId).toBe('pn_B');
});

test('receivedByPhoneNumberId is null when metadata or phone_number_id is absent', () => {
  const noMeta = parseEnvelope({
    object: 'x',
    entry: [{ changes: [{ value: { messages: [{ id: 'm1', from: 'x', timestamp: '1', type: 'text' }] } }] }],
  });
  expect(noMeta.messages[0]?.receivedByPhoneNumberId).toBeNull();

  const metaNoId = parseEnvelope({
    object: 'x',
    entry: [
      { changes: [{ value: { metadata: { display_phone_number: '+441234' }, messages: [{ id: 'm2', from: 'x', timestamp: '1', type: 'text' }] } }] },
    ],
  });
  expect(metaNoId.messages[0]?.receivedByPhoneNumberId).toBeNull();
});

test('an envelope with metadata but no messages yields nothing and does not throw', () => {
  const { messages } = parseEnvelope({
    object: 'x',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn_A' }, statuses: [{ id: 's1' }] } }] }],
  });
  expect(messages).toHaveLength(0);
});
