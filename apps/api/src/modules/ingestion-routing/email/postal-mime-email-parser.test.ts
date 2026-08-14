import { expect, test } from 'vitest';

import { FixtureIngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { processEmail } from './email-intake.js';
import { PostalMimeEmailParser } from './postal-mime-email-parser.js';

function png(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);
}

/** A real RFC 5322 multipart message with a base64 PNG attachment. */
function rawMime(attachmentBase64: string): Buffer {
  return Buffer.from(
    [
      'From: Sender <sender@acme.co>',
      'To: doc@neoting.neovogent.com',
      'Subject: Invoice 99',
      'Message-ID: <raw-1@acme.co>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="BOUNDARY"',
      '',
      '--BOUNDARY',
      'Content-Type: text/plain',
      '',
      'please find attached',
      '--BOUNDARY',
      'Content-Type: image/png; name="receipt.png"',
      'Content-Disposition: attachment; filename="receipt.png"',
      'Content-Transfer-Encoding: base64',
      '',
      attachmentBase64,
      '--BOUNDARY--',
      '',
    ].join('\r\n'),
  );
}

test('parses raw MIME and runs it through the intake end to end (offline, real parser)', async () => {
  const parsed = await new PostalMimeEmailParser().parse(rawMime(png().toString('base64')));
  expect(parsed.from).toBe('sender@acme.co');
  expect(parsed.subject).toBe('Invoice 99');
  expect(parsed.text.trim()).toBe('please find attached');
  expect(parsed.attachments).toHaveLength(1);
  expect(parsed.attachments[0]?.filename).toBe('receipt.png');
  expect(parsed.attachments[0]?.contentType).toContain('image/png');

  const queue = new FixtureIngestQueue();
  const result = await processEmail(parsed, { queue });
  expect(result.accepted).toHaveLength(1);
  expect(result.accepted[0]?.detectedType).toBe('png');
  expect(result.routing.kind).toBe('unrouted');
  expect(queue.enqueued[0]?.source).toBe('email');
});
