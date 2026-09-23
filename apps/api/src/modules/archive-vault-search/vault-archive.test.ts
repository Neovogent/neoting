import { expect, test } from 'vitest';

import { extensionFor, missingNote } from './vault.service.js';

/**
 * The note a PARTIAL archive carries inside itself (D51).
 *
 * ⚠ It exists because the headers are already sent by the time a document
 * turns out to be unreadable, so a per-file failure cannot become a status
 * code. Handing a client fourteen of their fifteen documents in silence is the
 * shape this lane keeps producing; the `503` refusal covers "none of them
 * could be read" and this covers everything in between.
 *
 * These assert the WORDS, because the words are the whole feature — a client
 * who does not work at the practice reads them.
 */
test('the note leads with the counts, because that is the question being asked', () => {
  const note = missingNote(13, ['2026-09-21 Document.pdf', '2026-09-19 Currys.jpg']);
  expect(note).toContain('Included: 13');
  expect(note).toContain('Could not be read: 2');
});

test('the note NAMES each missing document, so the client can say which', () => {
  const note = missingNote(1, ['2026-09-19 Currys.jpg']);
  expect(note).toContain('2026-09-19 Currys.jpg');
});

test('⚠ the note never says anything was deleted, because nothing was', () => {
  // The documents are still in the portal and the practice still holds them.
  // A client who reads "missing" as "lost" re-sends everything, which is the
  // expensive misunderstanding this sentence exists to prevent.
  const note = missingNote(0, ['a.pdf']);
  expect(note).toContain('Nothing has been deleted');
  expect(note).toContain('still in your portal');
});

test('the note is CRLF, because Notepad is the likeliest reader of a .txt in a ZIP', () => {
  expect(missingNote(1, ['a.pdf'])).toContain('\r\n');
});

test('extensionFor reads the RECORDED mime type and never guesses', () => {
  expect(extensionFor('application/pdf')).toBe('.pdf');
  expect(extensionFor('image/jpeg')).toBe('.jpg');
  // ⚠ No extension rather than a guessed one: an operating system opening a
  // `.pdf` that is a JPEG is worse than one asking what to open.
  expect(extensionFor('application/octet-stream')).toBe('');
  expect(extensionFor(null)).toBe('');
});
