import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extensionContradicts, extensionOf, sniff } from './formats.js';

/** Build a buffer from a byte signature plus optional trailing filler. */
function buf(head: number[], tail = ''): Buffer {
  return Buffer.concat([Buffer.from(head), Buffer.from(tail, 'latin1')]);
}

test('sniff detects each raw image and document signature', () => {
  assert.equal(sniff(buf([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniff(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(sniff(buf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'gif');
  assert.equal(sniff(buf([0x42, 0x4d, 0x00])), 'bmp');
  assert.equal(sniff(buf([0x49, 0x49, 0x2a, 0x00])), 'tiff'); // little-endian
  assert.equal(sniff(buf([0x4d, 0x4d, 0x00, 0x2a])), 'tiff'); // big-endian
  assert.equal(sniff(buf([], '%PDF-1.7')), 'pdf');
  assert.equal(sniff(buf([], '{\\rtf1')), 'rtf');
  assert.equal(sniff(buf([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'doc');
});

test('sniff recognises a HEIC ftyp box by brand', () => {
  // 4-byte box size, "ftyp", brand "heic".
  const heic = buf([0x00, 0x00, 0x00, 0x18], 'ftypheic');
  assert.equal(sniff(heic), 'heic');
  // A non-HEIC ftyp brand (e.g. mp4) is not accepted here.
  const mp4 = buf([0x00, 0x00, 0x00, 0x18], 'ftypmp42');
  assert.equal(sniff(mp4), 'unknown');
});

test('sniff refines ZIP containers into docx / odt / zip', () => {
  const pk = [0x50, 0x4b, 0x03, 0x04];
  assert.equal(sniff(buf(pk, 'random-zip-body')), 'zip');
  assert.equal(sniff(buf(pk, 'xxx[Content_Types].xml')), 'docx');
  assert.equal(sniff(buf(pk, 'mimetypeapplication/vnd.oasis.opendocument.text')), 'odt');
});

test('sniff returns unknown for unrecognised or empty bytes', () => {
  assert.equal(sniff(Buffer.alloc(0)), 'unknown');
  assert.equal(sniff(buf([0x00, 0x01, 0x02, 0x03])), 'unknown');
  assert.equal(sniff(buf([], 'MZ-not-an-accepted-exe')), 'unknown');
});

test('extensionOf lowercases and handles missing extensions', () => {
  assert.equal(extensionOf('Invoice.PDF'), 'pdf');
  assert.equal(extensionOf('scan.JPEG'), 'jpeg');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf('trailingdot.'), '');
});

test('extensionContradicts flags a spoofed extension only on positive conflict', () => {
  // A real PDF renamed to .jpg — the classic spoof.
  assert.equal(extensionContradicts('malware.jpg', 'pdf'), true);
  // Matching extension: no contradiction.
  assert.equal(extensionContradicts('invoice.pdf', 'pdf'), false);
  assert.equal(extensionContradicts('photo.jpeg', 'jpeg'), false);
  // Absent or unknown extension is not treated as a spoof.
  assert.equal(extensionContradicts('noext', 'pdf'), false);
  assert.equal(extensionContradicts('weird.xyz', 'pdf'), false);
});
