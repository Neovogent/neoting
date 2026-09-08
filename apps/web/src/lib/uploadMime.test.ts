import { describe, expect, test } from 'vitest';

import { MIME_BY_EXTENSION, UPLOAD_ACCEPT, extensionOf, mimeTypeFor } from './uploadMime';

/**
 * The declared-MIME rule, and the one case that cost every iPhone photograph.
 *
 * The defect (pipeline test, 8 Sep 2026) was not that HEIC was missing from the
 * allowlist — it has always been on it, server and client. It was that the
 * extension fallback fired only on an EMPTY `File.type`, and the value Chrome on
 * Windows actually reports for a `.HEIC` is `application/octet-stream`, which is
 * truthy. So the guard never ran, the unaccepted type was declared verbatim, and
 * the door answered `415 NT-ING-002` on every upload surface.
 */

describe('mimeTypeFor', () => {
  test('the browser wins when it names a type the door accepts', () => {
    expect(mimeTypeFor({ name: 'x.pdf', type: 'application/pdf' })).toBe('application/pdf');
    expect(mimeTypeFor({ name: 'photo.jpg', type: 'image/jpeg' })).toBe('image/jpeg');
  });

  // iOS Safari, routinely.
  test('the extension answers an empty type', () => {
    expect(mimeTypeFor({ name: 'IMG_0001.HEIC', type: '' })).toBe('image/heic');
    expect(mimeTypeFor({ name: 'scan.pdf', type: '' })).toBe('application/pdf');
  });

  // ⚠ THE REGRESSION. Every one of these is truthy, so every one of them sailed
  // past an `if (type !== '')` guard and was declared to a door that refuses it.
  test('the extension answers a type the door does not accept', () => {
    expect(mimeTypeFor({ name: 'document (149).HEIC', type: 'application/octet-stream' })).toBe('image/heic');
    expect(mimeTypeFor({ name: 'IMG_4821.heic', type: 'image/heif' })).toBe('image/heic');
    expect(mimeTypeFor({ name: 'statement.csv', type: 'application/octet-stream' })).toBe('text/csv');
  });

  // The Windows-with-Excel case the server's DECLARED_ALIASES admits on purpose:
  // it IS one of our values (via `.xls`), so the browser keeps its opinion and
  // the byte sniff decides what the file really is.
  test('a declared alias the door admits is left alone', () => {
    expect(mimeTypeFor({ name: 'export.csv', type: 'application/vnd.ms-excel' })).toBe('application/vnd.ms-excel');
  });

  test('neither can name it', () => {
    expect(mimeTypeFor({ name: 'mystery', type: '' })).toBe('');
    expect(mimeTypeFor({ name: 'installer.exe', type: 'application/x-msdownload' })).toBe('');
  });
});

describe('extensionOf', () => {
  test('lower-cases, and a dotfile has no extension', () => {
    expect(extensionOf('receipt.HEIC')).toBe('heic');
    expect(extensionOf('a.b.PDF')).toBe('pdf');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
    expect(extensionOf('none')).toBe('');
  });
});

describe('UPLOAD_ACCEPT', () => {
  // Extensions, not MIME types: a phone handing over a `.heic` with an empty
  // type still matches, where an accept of MIME types hides the file entirely.
  test('offers every extension the table knows, dotted', () => {
    for (const extension of Object.keys(MIME_BY_EXTENSION)) {
      expect(UPLOAD_ACCEPT.split(',')).toContain(`.${extension}`);
    }
    expect(UPLOAD_ACCEPT).not.toContain('image/');
  });
});
