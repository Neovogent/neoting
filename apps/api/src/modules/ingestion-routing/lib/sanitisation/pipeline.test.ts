import { expect, test } from 'vitest';

import { sanitise } from './pipeline.js';
import { EICAR_TEST_STRING, type VirusScanner } from './virus-scan.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(): Buffer {
  return Buffer.concat([Buffer.from(PNG), Buffer.from('image-body')]);
}

test('a valid image on a client channel is accepted with a byte hash', async () => {
  const r = await sanitise({ bytes: png(), filename: 'receipt.png', channel: 'client' });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.document.detectedType).toBe('png');
    expect(r.document.byteLength).toBe(png().length);
    expect(r.document.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
});

test('an unrecognised file type is rejected as not allowed (NT-ING-002)', async () => {
  const r = await sanitise({ bytes: Buffer.from('\x00\x01\x02not-a-real-type'), filename: 'x.bin', channel: 'client' });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.rejection.kind).toBe('type_not_allowed');
    expect(r.rejection.code).toBe('NT-ING-002');
    expect(r.rejection.message.length).toBeGreaterThan(0);
  }
});

test('a spoofed extension (PDF bytes named .jpg) is rejected (NT-ING-004)', async () => {
  const r = await sanitise({ bytes: Buffer.from('%PDF-1.4 body'), filename: 'photo.jpg', channel: 'client' });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.rejection.kind).toBe('magic_byte_mismatch');
    expect(r.rejection.code).toBe('NT-ING-004');
  }
});

test('a file over the channel cap is rejected (NT-ING-001)', async () => {
  const oversize = Buffer.alloc(25 * 1024 * 1024 + 1);
  Buffer.from(PNG).copy(oversize, 0);
  const r = await sanitise({ bytes: oversize, filename: 'big.png', channel: 'client' });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.rejection.kind).toBe('oversize');
    expect(r.rejection.code).toBe('NT-ING-001');
  }
});

test('the same file is accepted on a channel with a larger cap', async () => {
  const bytes = Buffer.alloc(30 * 1024 * 1024);
  Buffer.from(PNG).copy(bytes, 0);
  const r = await sanitise({ bytes, filename: 'batch.png', channel: 'accountant_upload' });
  expect(r.ok).toBe(true);
});

test('the EICAR test string is caught through the virus-scan interface (NT-ING-004)', async () => {
  const bytes = Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n`);
  const r = await sanitise({ bytes, filename: 'infected.pdf', channel: 'client' });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.rejection.kind).toBe('virus_detected');
    expect(r.rejection.code).toBe('NT-ING-004');
    expect(r.rejection.detail?.signature).toBe('EICAR-Test-Signature');
  }
});

test('a password-protected PDF is rejected with a visible reason, not swallowed', async () => {
  const bytes = Buffer.from('%PDF-1.4\n...\ntrailer<< /Encrypt 12 0 R >>\n%%EOF');
  const r = await sanitise({ bytes, filename: 'locked.pdf', channel: 'client' });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.rejection.kind).toBe('password_protected');
    expect(r.rejection.code).toBe('NT-ING-004');
    expect(r.rejection.message).toMatch(/password/i);
  }
});

test('an empty ZIP passes the archive caps', async () => {
  const emptyZip = Buffer.alloc(22);
  emptyZip.writeUInt32LE(0x06054b50, 0);
  const r = await sanitise({ bytes: emptyZip, filename: 'empty.zip', channel: 'accountant_upload' });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.document.detectedType).toBe('zip');
});

test('a DOCX container is detected and accepted', async () => {
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('..[Content_Types].xml..')]);
  const r = await sanitise({ bytes, filename: 'letter.docx', channel: 'client' });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.document.detectedType).toBe('docx');
});

test('an injected scanner failure is surfaced as a virus rejection', async () => {
  const alwaysInfected: VirusScanner = { async scan() { return { infected: true, signature: 'Test.Injected' }; } };
  const r = await sanitise({ bytes: png(), filename: 'ok.png', channel: 'client' }, { scanner: alwaysInfected });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.rejection.detail?.signature).toBe('Test.Injected');
});

/** A minimal HEIC: ISO-BMFF box with `ftyp` at offset 4 and a HEIC brand at 8. */
function heic(): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16, 0); // box size
  header.write('ftyp', 4, 'latin1');
  header.write('heic', 8, 'latin1'); // major brand
  header.write('mif1', 12, 'latin1');
  return Buffer.concat([header, Buffer.from('heic-payload')]);
}

test('a HEIC photo is refused with an actionable reason, not passed through (#21)', async () => {
  const r = await sanitise({ bytes: heic(), filename: 'IMG_4021.HEIC', channel: 'client' });

  // The whole point: it used to be ACCEPTED here and then fail in extraction
  // looking like a corrupt file, which told the accountant the wrong thing.
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.rejection.kind).toBe('format_not_processable');
    expect(r.rejection.code).toBe('NT-ING-002');
    // The message has to tell a non-technical sender what to actually do.
    expect(r.rejection.message).toMatch(/JPEG/i);
  }
});

test('HEIC is still SNIFFED as heic, so the refusal can name the fix', async () => {
  // If HEIC were simply dropped from the allowlist, this file would be refused
  // as "a type we cannot accept" and the sender would lose the one instruction
  // that solves their problem. Detection and processability are different things.
  const r = await sanitise({ bytes: heic(), filename: 'IMG_4021.HEIC', channel: 'client' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.rejection.message).not.toMatch(/not one we can accept/i);
});

test('an ordinary image is still passed through untouched', async () => {
  const r = await sanitise({ bytes: png(), filename: 'receipt.png', channel: 'client' });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.document.bytes.equals(png())).toBe(true);
});
