import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitise } from './pipeline.js';
import { EICAR_TEST_STRING, type VirusScanner } from './virus-scan.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(): Buffer {
  return Buffer.concat([Buffer.from(PNG), Buffer.from('image-body')]);
}

test('a valid image on a client channel is accepted with a byte hash', async () => {
  const r = await sanitise({ bytes: png(), filename: 'receipt.png', channel: 'client' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.document.detectedType, 'png');
    assert.equal(r.document.byteLength, png().length);
    assert.match(r.document.sha256, /^[0-9a-f]{64}$/);
  }
});

test('an unrecognised file type is rejected as not allowed (NT-ING-002)', async () => {
  const r = await sanitise({ bytes: Buffer.from('\x00\x01\x02not-a-real-type'), filename: 'x.bin', channel: 'client' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.rejection.kind, 'type_not_allowed');
    assert.equal(r.rejection.code, 'NT-ING-002');
    assert.ok(r.rejection.message.length > 0);
  }
});

test('a spoofed extension (PDF bytes named .jpg) is rejected (NT-ING-004)', async () => {
  const r = await sanitise({ bytes: Buffer.from('%PDF-1.4 body'), filename: 'photo.jpg', channel: 'client' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.rejection.kind, 'magic_byte_mismatch');
    assert.equal(r.rejection.code, 'NT-ING-004');
  }
});

test('a file over the channel cap is rejected (NT-ING-001)', async () => {
  const oversize = Buffer.alloc(25 * 1024 * 1024 + 1);
  Buffer.from(PNG).copy(oversize, 0);
  const r = await sanitise({ bytes: oversize, filename: 'big.png', channel: 'client' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.rejection.kind, 'oversize');
    assert.equal(r.rejection.code, 'NT-ING-001');
  }
});

test('the same file is accepted on a channel with a larger cap', async () => {
  const bytes = Buffer.alloc(30 * 1024 * 1024);
  Buffer.from(PNG).copy(bytes, 0);
  const r = await sanitise({ bytes, filename: 'batch.png', channel: 'accountant_upload' });
  assert.equal(r.ok, true);
});

test('the EICAR test string is caught through the virus-scan interface (NT-ING-004)', async () => {
  const bytes = Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n`);
  const r = await sanitise({ bytes, filename: 'infected.pdf', channel: 'client' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.rejection.kind, 'virus_detected');
    assert.equal(r.rejection.code, 'NT-ING-004');
    assert.equal(r.rejection.detail?.signature, 'EICAR-Test-Signature');
  }
});

test('a password-protected PDF is rejected with a visible reason, not swallowed', async () => {
  const bytes = Buffer.from('%PDF-1.4\n...\ntrailer<< /Encrypt 12 0 R >>\n%%EOF');
  const r = await sanitise({ bytes, filename: 'locked.pdf', channel: 'client' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.rejection.kind, 'password_protected');
    assert.equal(r.rejection.code, 'NT-ING-004');
    assert.match(r.rejection.message, /password/i);
  }
});

test('an empty ZIP passes the archive caps', async () => {
  const emptyZip = Buffer.alloc(22);
  emptyZip.writeUInt32LE(0x06054b50, 0); // EOCD only, zero entries
  const r = await sanitise({ bytes: emptyZip, filename: 'empty.zip', channel: 'accountant_upload' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.document.detectedType, 'zip');
});

test('a DOCX container is detected and accepted', async () => {
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('..[Content_Types].xml..')]);
  const r = await sanitise({ bytes, filename: 'letter.docx', channel: 'client' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.document.detectedType, 'docx');
});

test('an injected scanner failure is surfaced as a virus rejection', async () => {
  const alwaysInfected: VirusScanner = { async scan() { return { infected: true, signature: 'Test.Injected' }; } };
  const r = await sanitise({ bytes: png(), filename: 'ok.png', channel: 'client' }, { scanner: alwaysInfected });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.rejection.detail?.signature, 'Test.Injected');
});
