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

test('the tag is everything after the FIRST plus, up to the @', () => {
  // Practice ids are cuid/uuid (no '+'), so this is only a definition of the
  // parse: we do not silently truncate at a second '+'.
  expect(resolvePracticeFromRecipient('doc+prac_x+extra@neoting.example')).toBe('prac_x+extra');
});
