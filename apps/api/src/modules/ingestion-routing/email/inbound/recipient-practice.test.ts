import { expect, test } from 'vitest';

import { documentIntakeAddress, resolvePracticeFromRecipient } from './recipient-practice.js';

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

test('the address a practice publishes is the one this parser reads back', () => {
  // ⚠ The round trip is the point. A published intake address that the receiver
  // does not recognise is a client's receipts landing nowhere, discovered by
  // the client. `GET /v1/me` composes with one of these functions and SES
  // inbound is read with the other, so they cannot be allowed to drift.
  for (const practiceId of ['cmtnddebp0033771', 'prac_x-1', 'a', 'A1_-']) {
    const address = documentIntakeAddress(practiceId, 'no-reply@neoting.neovogent.com');
    expect(address).toBe(`doc+${practiceId}@neoting.neovogent.com`);
    expect(resolvePracticeFromRecipient(address!)).toBe(practiceId);
  }
});

test('the domain is the one the API SENDS from — that is the domain with the inbound MX', () => {
  expect(documentIntakeAddress('p1', 'no-reply@example.test')).toBe('doc+p1@example.test');
  // A display-name form is not a from-address; the last `@` wins so a quoted
  // local part cannot smuggle a second domain in.
  expect(documentIntakeAddress('p1', 'a@b@example.test')).toBe('doc+p1@example.test');
});

test('nothing composable means NO address, never a broken one', () => {
  // A screen must say nothing rather than publish something that bounces.
  expect(documentIntakeAddress('p1', 'no-reply')).toBeNull();
  expect(documentIntakeAddress('p1', '')).toBeNull();
  expect(documentIntakeAddress('p1', 'no-reply@')).toBeNull();
  // And a practice id the parser would refuse can never be composed into one,
  // so this side cannot mint an address the other side rejects.
  expect(documentIntakeAddress('prac/../etc', 'a@b.test')).toBeNull();
  expect(documentIntakeAddress('prac id', 'a@b.test')).toBeNull();
  expect(documentIntakeAddress('a'.repeat(65), 'a@b.test')).toBeNull();
});
