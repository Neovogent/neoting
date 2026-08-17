import { expect, test } from 'vitest';

import { resolvePracticeFromRecipient } from './recipient-practice.js';

// The recipient is sender-chosen, so this is a tenancy-adjacent parse: the tag it
// yields becomes documents.practice_id. These pin exactly what is and is not a tag.

test('reads the practice id from a doc+<practice>@ plus tag', () => {
  expect(resolvePracticeFromRecipient('doc+prac_abc@neoting.example')).toBe('prac_abc');
});

test('reads the tag from a header form with a display name and angle brackets', () => {
  expect(resolvePracticeFromRecipient('"Neoting" <doc+prac_x@neoting.example>')).toBe('prac_x');
});

test('a bare doc@ with no plus tag has no practice anchor', () => {
  expect(resolvePracticeFromRecipient('doc@neoting.example')).toBeNull();
});

test('null for an empty tag, a missing @, an empty string, or null', () => {
  expect(resolvePracticeFromRecipient('doc+@neoting.example')).toBeNull();
  expect(resolvePracticeFromRecipient('doc+prac_x')).toBeNull(); // no @ at all
  expect(resolvePracticeFromRecipient('')).toBeNull();
  expect(resolvePracticeFromRecipient(null)).toBeNull();
});

test('the tag is everything after the FIRST plus, up to the @ — and a second plus fails the shape check', () => {
  // Practice ids are cuid/uuid (no '+'). The parse does not silently truncate
  // at a second '+'; the whole tag is taken, and because '+' is outside the
  // practice-id character class, a doubled tag resolves to nothing rather than
  // to a guessed prefix.
  expect(resolvePracticeFromRecipient('doc+prac_x+extra@neoting.example')).toBeNull();
});

test('a tag that is not shaped like a practice id resolves to nothing — it is sender-chosen text', () => {
  // The tag becomes documents.practice_id and a segment of the unrouted S3 key,
  // so shape is checked before it is allowed to be either.
  expect(resolvePracticeFromRecipient('doc+prac/../../etc@neoting.test')).toBeNull();
  expect(resolvePracticeFromRecipient('doc+prac id@neoting.test')).toBeNull();
  expect(resolvePracticeFromRecipient('doc+prac"quote@neoting.test')).toBeNull();
  expect(resolvePracticeFromRecipient(`doc+${'a'.repeat(65)}@neoting.test`)).toBeNull();
  // The legitimate cuid/uuid character classes still pass.
  expect(resolvePracticeFromRecipient('doc+prac_x-1@neoting.test')).toBe('prac_x-1');
});
