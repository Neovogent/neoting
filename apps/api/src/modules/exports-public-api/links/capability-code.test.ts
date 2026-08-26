import { randomBytes } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { assertVtEntryDetailsSafe } from '../emitters/vt/vt-safety.js';
import { CanonicalSourceLinkSchema } from '../canonical/canonical-row.js';

import {
  CAPABILITY_CODE_ALPHABET,
  CAPABILITY_CODE_ENTROPY_BITS,
  CAPABILITY_CODE_LENGTH,
  CapabilityCodeSchema,
  mintCapabilityCode,
  normaliseCapabilityCode,
} from './capability-code.js';

/**
 * The token is the whole authorisation on `GET /d/{code}`, so these are the
 * tests that matter most in the stage. They are written as assertions about
 * *properties* rather than about a sample: a token generator that is subtly
 * wrong produces output that looks perfectly random.
 */

describe('the arithmetic is what the file claims it is', () => {
  test('the alphabet is 32 distinct symbols — a power of two, so five bits map with no modulo bias', () => {
    expect(CAPABILITY_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(CAPABILITY_CODE_ALPHABET).size).toBe(32);
    // A power of two is the whole reason there is no rejection sampling.
    expect(Math.log2(CAPABILITY_CODE_ALPHABET.length) % 1).toBe(0);
  });

  test('entropy is length × log2(alphabet), and the constant says so', () => {
    expect(CAPABILITY_CODE_ENTROPY_BITS).toBe(CAPABILITY_CODE_LENGTH * Math.log2(CAPABILITY_CODE_ALPHABET.length));
    expect(CAPABILITY_CODE_ENTROPY_BITS).toBe(40);
  });

  test('the ambiguous characters a human mistypes are absent', () => {
    // I/1, L/1, O/0 — and U, which Crockford drops so a random code cannot
    // spell something the accountant has to read aloud to a client.
    for (const character of ['I', 'L', 'O', 'U']) {
      expect(CAPABILITY_CODE_ALPHABET).not.toContain(character);
    }
  });

  test('SoT §24.3.2 says six to eight characters, and the contract allows six to twelve', () => {
    expect(CAPABILITY_CODE_LENGTH).toBeGreaterThanOrEqual(6);
    expect(CAPABILITY_CODE_LENGTH).toBeLessThanOrEqual(8);
  });
});

describe('minting', () => {
  test('every code is the declared length and drawn only from the alphabet', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = mintCapabilityCode();
      expect(code).toHaveLength(CAPABILITY_CODE_LENGTH);
      for (const character of code) expect(CAPABILITY_CODE_ALPHABET).toContain(character);
    }
  });

  test('a thousand codes are a thousand different codes', () => {
    // Not a strength claim — at 40 bits a collision in 1000 draws would be a
    // 1-in-2-billion event, so a repeat here means the generator is not random.
    const codes = new Set(Array.from({ length: 1000 }, () => mintCapabilityCode()));
    expect(codes.size).toBe(1000);
  });

  test('every symbol in the alphabet is actually reachable', () => {
    // A bit-slicing bug that masked five bits down to four would still produce
    // plausible-looking codes — from half the alphabet, at half the entropy.
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) for (const character of mintCapabilityCode()) seen.add(character);
    expect(seen.size).toBe(CAPABILITY_CODE_ALPHABET.length);
  });

  test('the bytes are consumed as a big-endian bit stream, not truncated to 32 bits', () => {
    // All-ones in, all-Z out. A `>>` on a 40-bit value coerces to 32 bits and
    // silently drops the top byte — the first two characters would be wrong and
    // nothing else would look off.
    const code = mintCapabilityCode(() => Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(code).toBe('ZZZZZZZZ');

    // The low five bits of the last byte select the last symbol: 0x0a → index
    // 10 → 'A'. (Deliberately a letter, or the resample loop would spin: an
    // all-digit code is exactly what this generator refuses to return.)
    expect(mintCapabilityCode(() => Buffer.from([0x00, 0x00, 0x00, 0x00, 0x0a]))).toBe('0000000A');
    expect(CAPABILITY_CODE_ALPHABET[10]).toBe('A');
  });
});

describe('⚠ the at-least-one-letter guarantee — VT coerces all-digit codes', () => {
  test('an all-digit draw is RESAMPLED, not patched', () => {
    // Two draws: the first is all zeroes (a legal 40-bit value that renders as
    // "00000000"), the second is not. A generator that "fixed" the first by
    // overwriting a character would return something starting with zeroes.
    const draws = [Buffer.alloc(5, 0x00), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff])];
    let index = 0;
    const code = mintCapabilityCode(() => draws[index++] ?? Buffer.alloc(5, 0xff));

    expect(code).toBe('ZZZZZZZZ');
    expect(index).toBe(2); // it drew twice
  });

  test('an entropy source that only ever produces digits THROWS rather than minting a guessable code', () => {
    expect(() => mintCapabilityCode(() => Buffer.alloc(5, 0x00))).toThrow(/entropy source is broken/);
  });

  test('a short read from the entropy source throws rather than padding', () => {
    expect(() => mintCapabilityCode(() => Buffer.alloc(2, 0xff))).toThrow(/needed 5/);
  });

  test('every minted code survives BOTH downstream locks on the same door', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = mintCapabilityCode();
      // A7's emitter guard: it throws on a letterless Entry details cell.
      expect(() => assertVtEntryDetailsSafe(code)).not.toThrow();
      // A7's canonical schema: ≤ 20 characters, at least one letter.
      expect(
        CanonicalSourceLinkSchema.safeParse({ code, url: `https://x.test/d/${code}` }).success,
      ).toBe(true);
    }
  });

  test('the code is never long enough to trip VT’s 16-digit crash', () => {
    // Landmine 1: a run of 17+ digits crashes VT builds older than May 2025.
    // Eight characters cannot reach seventeen, but the assertion is cheap and
    // it is the property that would break if the length ever grew.
    expect(CAPABILITY_CODE_LENGTH).toBeLessThan(17);
  });
});

describe('the boundary schema is wider than what we mint, on purpose', () => {
  test('accepts the contract’s whole 6..12 range, not only this release’s length', () => {
    expect(CapabilityCodeSchema.safeParse('A7K2M9').success).toBe(true);
    expect(CapabilityCodeSchema.safeParse('A7K2M9PQ').success).toBe(true);
    expect(CapabilityCodeSchema.safeParse('A7K2M9PQR2T4').success).toBe(true);
  });

  test('refuses what could never have been minted', () => {
    expect(CapabilityCodeSchema.safeParse('A7K2M').success).toBe(false); // too short
    expect(CapabilityCodeSchema.safeParse('A7K2M9PQR2T4X').success).toBe(false); // too long
    expect(CapabilityCodeSchema.safeParse('12345678').success).toBe(false); // no letter
    expect(CapabilityCodeSchema.safeParse('A7K2M9P!').success).toBe(false); // off the alphabet
    expect(CapabilityCodeSchema.safeParse('A7K2M9PU').success).toBe(false); // U is not in the alphabet
    expect(CapabilityCodeSchema.safeParse('').success).toBe(false);
    // The shapes a scanner tries. None of them is a 400 on the route — the
    // service turns every one into the same 404.
    expect(CapabilityCodeSchema.safeParse("' OR 1=1--").success).toBe(false);
    expect(CapabilityCodeSchema.safeParse('../../etc/pw').success).toBe(false);
  });
});

describe('normalisation — the accountant is typing this off a spreadsheet', () => {
  test('lower case reaches the same document', () => {
    expect(normaliseCapabilityCode('a7k2m9pq')).toBe('A7K2M9PQ');
  });

  test('the characters a font conflates fold onto the ones we mint', () => {
    expect(normaliseCapabilityCode('AIKlM9OQ')).toBe('A1K1M90Q');
  });

  test('it is the identity on everything the generator actually produces', () => {
    for (let i = 0; i < 300; i += 1) {
      const code = mintCapabilityCode(randomBytes);
      expect(normaliseCapabilityCode(code)).toBe(code);
    }
  });
});
