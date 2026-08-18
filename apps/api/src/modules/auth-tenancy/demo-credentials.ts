import { scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * The demo credential table (METH Stage 1, issue #118).
 *
 * // DEMO-MOCK: replace with Argon2 + the `users.password_hash` column at
 * // S1-real. For the 21 Aug demo the credential set is FIXED (METH_MODE §7),
 * // so it lives in-file: no schema change, no seed coupling for verification,
 * // and the passwords below are PUBLISHED demo fixtures (METH_MODE §3.5 —
 * // documented in METH_MODE §7), not secrets in the diff.
 *
 * ⚠ COORDINATION CONTRACT WITH STAGE 5 (seed v2, Abdullah): the seed must
 * create users with EXACTLY these ids and emails, holding the §7 memberships
 * (Shakib-demo → Practice Admin, Abdullah-demo → Standard User). Login mints a
 * cookie for the userId below; a seed that picks different ids produces valid
 * logins with no memberships, which resolve to 401 on every request.
 */

export interface DemoCredential {
  readonly userId: string;
  /** `scrypt$<salt b64url>$<hash b64url>`, N/r/p at node defaults, 32-byte key. */
  readonly scryptHash: string;
}

/** Keyed by login email, lower-cased. Passwords are in METH_MODE §7. */
export const DEMO_CREDENTIALS: Readonly<Record<string, DemoCredential>> = Object.freeze({
  'shakib@neoting.test': {
    userId: 'usr_shakib_demo',
    scryptHash: 'scrypt$ZRYg8crAQo13A2H4nlyZrw$ceNFLZuBaOt9B3b2tm-9BD0vQD9SeS7p2WD3gvE25Ho',
  },
  'abdullah@neoting.test': {
    userId: 'usr_abdullah_demo',
    scryptHash: 'scrypt$k4TgCD8MvqCuz-7oTGrvoA$cs8dl8sLYaoaL8Glwe8gDfzzswpp6odHDDJQ7XUdhLk',
  },
});

/**
 * Burned for unknown emails so "no such user" and "wrong password" cost the
 * same scrypt — a timing probe cannot enumerate the credential table. The
 * password behind it is random bytes discarded at generation time; nothing
 * verifies against it.
 */
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$JnPnyLDmgAY-Ozn4bF7BxT0ymVvSyq0Ff-Rc4z3n7dE';

/**
 * Verify an email + password against the table. Returns the userId on success,
 * null on ANY failure — the caller maps every miss to the one `NT-AUTH-003`.
 *
 * `scryptSync` blocks the event loop for ~50 ms per attempt. Acceptable for a
 * two-user demo table; the S1-real replacement (Argon2, async) removes it.
 */
export function verifyDemoPassword(email: string, password: string): string | null {
  const credential = DEMO_CREDENTIALS[email.toLowerCase()];
  const matched = verifyScrypt(password, credential?.scryptHash ?? DUMMY_HASH);
  return matched && credential !== undefined ? credential.userId : null;
}

function verifyScrypt(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
