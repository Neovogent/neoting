import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * The ONE password scheme in this codebase (launch stage A1).
 *
 * It is extracted from `demo-credentials.ts` rather than invented beside it, on
 * purpose: A1's brief is "password hashing follows whatever demo-credentials.ts
 * already uses — do not introduce a second scheme". Two schemes means two
 * verifiers, and the day one of them is wrong is the day nobody can log in and
 * nobody can say which half broke. The published fixture hashes in
 * `demo-credentials.ts` verify through THIS function, which is what pins the
 * format: change anything here and those fixtures stop matching, loudly.
 *
 * Format: `scrypt$<salt>$<key>`, both base64url, N/r/p at Node's defaults,
 * 32-byte key.
 *
 * ⚠ The SALT IS USED AS A STRING, not decoded to bytes. `scryptSync(password,
 * salt, len)` is handed the base64url text exactly as stored. That is what the
 * existing fixture hashes were generated with, so decoding it here would be a
 * silent format change that invalidates every hash already in the repo. It
 * costs nothing — 16 random bytes rendered as 22 base64url characters is still
 * 128 bits of salt entropy, which is the property a salt is for.
 *
 * ⚠ `scryptSync` BLOCKS THE EVENT LOOP for ~50-100 ms per call. That is
 * tolerable on the two paths that call it (one login, one signup) and it is the
 * reason `hashPassword` is deliberately called OUTSIDE the signup transaction —
 * never hold a database transaction open across a CPU burn. Argon2id, async,
 * remains the post-launch replacement; it lands as a new scheme prefix beside
 * `scrypt$` so old hashes keep verifying while new ones upgrade on next login.
 */

const SCHEME = 'scrypt';
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/**
 * Burned when there is no stored hash to check against, so "no such user" and
 * "wrong password" cost the same scrypt and a timing probe cannot enumerate the
 * user table. The password behind it is random bytes discarded at generation
 * time; nothing verifies against it, and it is therefore not a secret in the
 * diff — it is the absence of one.
 */
export const DUMMY_PASSWORD_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$JnPnyLDmgAY-Ozn4bF7BxT0ymVvSyq0Ff-Rc4z3n7dE';

/** A fresh `scrypt$salt$key` for a password nobody has hashed before. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('base64url');
  const key = scryptSync(password, salt, KEY_BYTES).toString('base64url');
  return `${SCHEME}$${salt}$${key}`;
}

/**
 * Constant-time verify. Returns false — never throws — for a malformed or
 * unknown-scheme stored value: a corrupted row is a failed login, not a 500
 * that tells the caller their address exists and the database is broken.
 */
export function verifyPasswordHash(password: string, stored: string): boolean {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== SCHEME || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Spend the same scrypt as a real verification would, and discard the answer.
 * Call this on every credential path that finds nothing to check — the login
 * lane's whole timing-equalisation argument is that the work happens whether or
 * not the account exists.
 */
export function burnPasswordHash(password: string): void {
  verifyPasswordHash(password, DUMMY_PASSWORD_HASH);
}
