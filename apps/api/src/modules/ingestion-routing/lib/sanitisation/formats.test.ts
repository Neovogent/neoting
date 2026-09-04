import { expect, test } from 'vitest';

import { extensionContradicts, extensionOf, sniff } from './formats.js';

/** Build a buffer from a byte signature plus optional trailing filler. */
function buf(head: number[], tail = ''): Buffer {
  return Buffer.concat([Buffer.from(head), Buffer.from(tail, 'latin1')]);
}

test('sniff detects each raw image and document signature', () => {
  expect(sniff(buf([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  expect(sniff(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
  expect(sniff(buf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
  expect(sniff(buf([0x42, 0x4d, 0x00]))).toBe('bmp');
  expect(sniff(buf([0x49, 0x49, 0x2a, 0x00]))).toBe('tiff'); // little-endian
  expect(sniff(buf([0x4d, 0x4d, 0x00, 0x2a]))).toBe('tiff'); // big-endian
  expect(sniff(buf([], '%PDF-1.7'))).toBe('pdf');
  expect(sniff(buf([], '{\\rtf1'))).toBe('rtf');
  expect(sniff(buf([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe('doc');
});

test('sniff recognises a HEIC ftyp box by brand', () => {
  const heic = buf([0x00, 0x00, 0x00, 0x18], 'ftypheic');
  expect(sniff(heic)).toBe('heic');
  const mp4 = buf([0x00, 0x00, 0x00, 0x18], 'ftypmp42');
  expect(sniff(mp4)).toBe('unknown');
});

test('sniff refines ZIP containers into docx / xlsx / odt / zip', () => {
  const pk = [0x50, 0x4b, 0x03, 0x04];
  expect(sniff(buf(pk, 'random-zip-body'))).toBe('zip');
  expect(sniff(buf(pk, 'xxx[Content_Types].xml'))).toBe('docx');
  expect(sniff(buf(pk, 'mimetypeapplication/vnd.oasis.opendocument.text'))).toBe('odt');
  // ⚠ An XLSX also contains [Content_Types].xml, so the xl/ test must win —
  // the old order sniffed every spreadsheet as a Word document (finding 6).
  expect(sniff(buf(pk, 'xxx[Content_Types].xml...xl/workbook.xml'))).toBe('xlsx');
  expect(sniff(buf(pk, 'xl/_rels/workbook.xml.rels'))).toBe('xlsx');
});

test('sniff recognises delimited text as csv — a CSV has no magic bytes (finding 6)', () => {
  expect(sniff(buf([], 'Date,Description,Amount\n01/08/2026,BIDFOOD,-456.72\n'))).toBe('csv');
  expect(sniff(buf([], 'Date;Description;Amount\n01/08/2026;BIDFOOD;-456,72\n'))).toBe('csv');
  // A UTF-8 BOM does not defeat the check — banks export them routinely.
  expect(sniff(buf([0xef, 0xbb, 0xbf], 'Date,Amount\n01/08/2026,-1.00\n'))).toBe('csv');
});

test('sniff returns unknown for unrecognised or empty bytes', () => {
  expect(sniff(Buffer.alloc(0))).toBe('unknown');
  expect(sniff(buf([0x00, 0x01, 0x02, 0x03]))).toBe('unknown');
  // Text with no delimiter is NOT csv — a delimiter-free file is
  // indistinguishable from any text file, and the statement lane could not
  // read it as a grid either.
  expect(sniff(buf([], 'MZ-not-an-accepted-exe'))).toBe('unknown');
  // A NUL anywhere in the head is binary, however text-like the rest looks.
  expect(sniff(buf([], 'a,b,c\n\x00d,e,f\n'))).toBe('unknown');
});

test('extensionOf lowercases and handles missing extensions', () => {
  expect(extensionOf('Invoice.PDF')).toBe('pdf');
  expect(extensionOf('scan.JPEG')).toBe('jpeg');
  expect(extensionOf('noext')).toBe('');
  expect(extensionOf('trailingdot.')).toBe('');
});

test('extensionContradicts flags a spoofed extension only on positive conflict', () => {
  expect(extensionContradicts('malware.jpg', 'pdf')).toBe(true);
  expect(extensionContradicts('invoice.pdf', 'pdf')).toBe(false);
  expect(extensionContradicts('photo.jpeg', 'jpeg')).toBe(false);
  expect(extensionContradicts('noext', 'pdf')).toBe(false);
  expect(extensionContradicts('weird.xyz', 'pdf')).toBe(false);
});
