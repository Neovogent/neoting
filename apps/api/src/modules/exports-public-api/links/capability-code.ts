import { randomBytes } from 'node:crypto';

import { z } from 'zod';

/**
 * The D43 capability code — the short, typable token that IS the authorisation
 * on `GET /d/{code}` (SoT §24.3.2 rung 2).
 *
 * **This file is the whole of the token's security.** There is no session
 * behind that route, no RLS predicate keyed on a user, and no second factor:
 * an accountant reads the code out of a CSV column inside VT Transaction+ —
 * where no session of ours can exist — and it resolves. Everything else on the
 * route (expiry, revocation, rate limiting, the access log) bounds the damage
 * of a leaked code; only this file decides whether a code can be *guessed*.
 *
 * ## The arithmetic, stated rather than implied
 *
 * | | |
 * |---|---|
 * | Alphabet | 32 symbols — Crockford base32, `0-9` + 22 letters |
 * | Length | 8 characters |
 * | Source | `crypto.randomBytes(5)` → 40 bits, **never** `Math.random` |
 * | Entropy | **40 bits** exactly (39.99987 after the all-digit exclusion below) |
 * | Space | 1.0995 × 10¹² codes |
 *
 * 40 bits is chosen against the ceiling, not against a feeling. With the
 * route's per-IP hourly ceiling (`link-rate-limit.ts`), finding *any* live code
 * among ten thousand of them takes ~1.1 × 10⁸ expected guesses — tens of
 * thousands of years from one address, and decades spread across a thousand.
 * A longer code would buy more and cost typability, which is the property
 * §24.3.2 spends the budget on: *"designed to be retyped or copy-pasted, not
 * clicked"*.
 *
 * ## Five bits per character, so there is no modulo bias
 *
 * 32 is a power of two, so five random bits map onto one symbol with no
 * remainder and no rejection. `randomBytes(5)` is 40 bits, sliced into eight
 * 5-bit groups. A 62- or 58-symbol alphabet would need `% 62` — which is
 * biased, subtly, in a way no test notices — or rejection sampling. This is the
 * shape that has neither problem.
 *
 * ## Two constraints that come from the target, not from us
 *
 * 1. **At least one LETTER.** VT's `Entry details` column has a documented
 *    history of coercing numeric-looking strings into 2-decimal numbers, so an
 *    all-digit code arrives in the accountant's file as `12345678.00` and
 *    resolves to nothing — silently, in a file that looks correct. This is
 *    guaranteed here by **resampling** a letterless draw rather than by forcing
 *    a letter into a fixed position: a forced position is a known character in
 *    a known place, which is a real reduction in guessing work, while
 *    resampling leaves the distribution uniform over the valid set. The
 *    probability of an all-digit draw is (10/32)⁸ ≈ 9.1 × 10⁻⁵, so the loop
 *    effectively never runs twice.
 * 2. **Short.** Reference fields in the export targets truncate **without
 *    warning** — one at 30 characters, another at ~25 (SoT §21) — and a
 *    truncated link looks correct and resolves to nothing. Eight characters is
 *    the top of SoT §24.3.2's stated range ("six to eight URL-safe
 *    characters") and inside the contract's `DocumentLinkCode` bounds (6–12).
 *    `CanonicalSourceLinkSchema` caps it again at 20.
 *
 * ## Case, and the excluded letters
 *
 * Uppercase only, and `I`, `L`, `O` and `U` are absent — Crockford's set.
 * `I`/`1`, `O`/`0` and `l`/`1` are the pairs a human transcribing from a
 * spreadsheet gets wrong, and `U` is dropped because Crockford drops it (it
 * turns accidental obscenities into non-words). Resolution is
 * **case-insensitive** at the boundary (`normaliseCapabilityCode`) so an
 * accountant who types lowercase still lands on their document; the stored form
 * is always upper.
 */

/**
 * Crockford base32. Exactly 32 symbols: 10 digits and 22 letters.
 *
 * ⚠ Do not reorder or extend this string. Its length being a power of two is
 * what makes the 5-bits-per-character mapping unbiased, and the codes already
 * sitting inside customers' ledger files were minted from it.
 */
export const CAPABILITY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** SoT §24.3.2: "six to eight URL-safe characters". The contract allows 6–12. */
export const CAPABILITY_CODE_LENGTH = 8;

/**
 * Bits of entropy in a freshly minted code. Stated as a constant so a change to
 * the alphabet or the length that forgets to change this fails its own test.
 */
export const CAPABILITY_CODE_ENTROPY_BITS = 40;

const BITS_PER_CHARACTER = 5;
const CONTAINS_A_LETTER = /[A-Z]/;

/**
 * How many letterless draws we tolerate before giving up.
 *
 * At (10/32)⁸ per draw the chance of sixteen consecutive all-digit codes is
 * about 10⁻⁶⁴. Reaching this throw means the entropy source is broken — a
 * stubbed `randomBytes`, a seeded PRNG someone swapped in — and a broken
 * entropy source must stop the export rather than mint a guessable token.
 */
const MAX_RESAMPLES = 16;

/**
 * The boundary schema for a code arriving off the wire.
 *
 * Deliberately **wider than what we mint** (6–12, not exactly 8): the contract's
 * `DocumentLinkCode` parameter declares 6–12, older codes may be shorter, and
 * a route that 400'd a perfectly resolvable historical code because this
 * release mints eight characters would break the very links D43 exists to keep
 * working. The alphabet is pinned, though — a character outside it can never
 * have been minted, so it is a malformed request rather than a miss.
 */
export const CapabilityCodeSchema = z
  .string()
  .min(6)
  .max(12)
  .regex(new RegExp(`^[${CAPABILITY_CODE_ALPHABET}]+$`), 'A capability code is Crockford base32.')
  .regex(CONTAINS_A_LETTER, 'A capability code contains at least one letter — VT coerces all-digit codes.');

/**
 * Fold the human variants of a typed code onto the stored form.
 *
 * Upper-cases, and maps the three characters Crockford treats as aliases:
 * `I`/`i`/`l`/`L` → `1`, `O`/`o` → `0`. Someone reading `A7K2M9PQ` off a
 * spreadsheet and typing `a7k2m9pq` reaches their document; someone who sees an
 * `l` where the font drew a `1` does too. It does **not** strip hyphens or
 * spaces — a code with punctuation in it was not typed out of one of our files.
 */
export function normaliseCapabilityCode(input: string): string {
  return input.toUpperCase().replaceAll(/[IL]/g, '1').replaceAll('O', '0');
}

/**
 * A source of random bytes. Injected only so a test can prove the
 * letterless-resample branch and the exhaustion throw — production has exactly
 * one implementation and it is `node:crypto`.
 *
 * ⚠ There is no `Math.random` fallback and there must not be one. `Math.random`
 * is a seeded xorshift with observable internal state: a few outputs recover
 * the seed, and every code the process will ever mint follows. That is not a
 * weaker token, it is no token at all.
 */
export type RandomBytesSource = (byteLength: number) => Buffer;

/**
 * Mint one capability code.
 *
 * @throws when the entropy source cannot produce a code containing a letter
 *         within {@link MAX_RESAMPLES} draws — see the constant.
 */
export function mintCapabilityCode(random: RandomBytesSource = randomBytes): string {
  for (let attempt = 0; attempt < MAX_RESAMPLES; attempt += 1) {
    const candidate = draw(random);
    if (CONTAINS_A_LETTER.test(candidate)) return candidate;
  }
  throw new Error(
    'minted MAX_RESAMPLES letterless capability codes in a row — the entropy source is broken, and a broken entropy source mints guessable tokens. Refusing rather than emitting one.',
  );
}

/** One unbiased draw: 40 random bits, read five at a time. */
function draw(random: RandomBytesSource): string {
  const byteLength = (CAPABILITY_CODE_LENGTH * BITS_PER_CHARACTER) / 8;
  const bytes = random(byteLength);
  if (bytes.length < byteLength) {
    throw new Error(`entropy source returned ${bytes.length} bytes, needed ${byteLength}`);
  }

  // A 40-bit integer exceeds nothing a JS number cannot hold exactly (2^40 <
  // 2^53), but bit operators coerce to *32* bits — `bits >> 5` on a 40-bit
  // value silently drops the top byte. BigInt keeps every bit; the arithmetic
  // is eight shifts, once per exported document.
  let bits = 0n;
  for (let index = 0; index < byteLength; index += 1) {
    bits = (bits << 8n) | BigInt(bytes[index] ?? 0);
  }

  let code = '';
  for (let index = 0; index < CAPABILITY_CODE_LENGTH; index += 1) {
    const shift = BigInt((CAPABILITY_CODE_LENGTH - 1 - index) * BITS_PER_CHARACTER);
    const symbol = Number((bits >> shift) & 0x1fn);
    code += CAPABILITY_CODE_ALPHABET[symbol];
  }
  return code;
}
