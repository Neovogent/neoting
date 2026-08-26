import { createDecipheriv, createCipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * What lives in `users.totp_secret_ref`, and why it is a REF rather than a
 * secret (launch stage A2).
 *
 * The column is named `totp_secret_ref` and the name is a promise: it holds a
 * reference to the account's second-factor material, not the material itself in
 * the clear. A TOTP seed in a plain column is a second factor that a single
 * database dump defeats — and a dump is exactly the scenario a second factor
 * exists to survive, because by then the password hashes are already gone too.
 *
 * So the column holds an AES-256-GCM envelope:
 *
 * ```
 * ntotp1.<base64url iv>.<base64url authTag>.<base64url ciphertext>
 * ```
 *
 * whose plaintext is the JSON below. The key is DERIVED from `SESSION_SECRET`
 * under a fixed purpose label, the identical move `email-verification.ts` makes
 * and for the identical reason: signing/encrypting with the raw secret would put
 * session cookies, verification tokens and TOTP seeds in one key space, so a
 * value minted for one purpose becomes an input the other verifier accepts.
 * Deriving keeps the three spaces disjoint and costs one `createHmac`. It also
 * avoids a second environment variable, which would be a change to
 * `config/env.ts` — outside this stage's owned paths.
 *
 * ⚠ **ROTATING `SESSION_SECRET` INVALIDATES EVERY ENROLMENT.** That is the
 * honest cost of not having a KMS key or a `totp_keys` table (`prisma/` is LAW),
 * and it is stated here so the day it happens nobody debugs it as corruption:
 * `unwrapTotpMaterial` returns `null` — a login that fails closed, not a throw —
 * and every user re-enrols. The upgrade is a KMS data key stored as the `ref`
 * this column was named for; the envelope carries a version tag (`ntotp1`) so a
 * second scheme lands beside this one rather than replacing it.
 *
 * ⚠ **THE RECOVERY CODES ARE HASHES, AND THEY ARE INSIDE THE ENVELOPE.** No
 * recovery code is ever stored — only `sha256(code)`, and even that is
 * encrypted. See `totp.ts` for why SHA-256 rather than the scrypt in
 * `password.ts`.
 */

/** The envelope's scheme tag. A second scheme lands as `ntotp2`, beside this one. */
const SCHEME = 'ntotp1';
const PURPOSE = 'neoting.totp-secret.v1';
const IV_BYTES = 12; // GCM's standard nonce length
const KEY_BYTES = 32;

/**
 * The account's second-factor material, as it exists only in memory and inside
 * the envelope.
 */
export interface TotpMaterial {
  /** The base32 TOTP seed an authenticator app holds. */
  readonly secret: string;
  /**
   * `sha256(recovery code)`, hex, one per unused code. A consumed code is
   * REMOVED from this list — that is what makes a recovery code single-use.
   */
  readonly recoveryHashes: readonly string[];
}

/** Encrypt `material` into the string `users.totp_secret_ref` stores. */
export function wrapTotpMaterial(material: TotpMaterial, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(material), 'utf8'), cipher.final()]);
  return [SCHEME, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

/**
 * Decrypt what `users.totp_secret_ref` holds, or `null`.
 *
 * Null — never a throw — for every failure: a wrong scheme, a truncated
 * envelope, a tampered ciphertext (GCM's auth tag catches it), a key that no
 * longer matches. A corrupted or unreadable ref is a second factor that cannot
 * verify, which is a failed login; it is not a 500 that tells the caller their
 * address exists and something server-side is broken. Same stance as
 * `verifyPasswordHash` on a malformed stored hash.
 */
export function unwrapTotpMaterial(ref: string | null, secret: string): TotpMaterial | null {
  if (ref === null || ref === '') return null;
  const parts = ref.split('.');
  if (parts.length !== 4 || parts[0] !== SCHEME) return null;
  const [, ivPart, tagPart, bodyPart] = parts as [string, string, string, string];
  // ⚠ OUTSIDE the try, deliberately. An empty secret must throw, not fall into
  // the null branch below: "every login silently fails its second factor" is a
  // day of debugging, and "SESSION_SECRET is empty" is a minute.
  const key = deriveKey(secret);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(bodyPart, 'base64url')), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain) as TotpMaterial;
    // Parse, don't trust — even our own plaintext. A shape we did not write is
    // an envelope from another scheme or another product, and it must not reach
    // otplib as `secret: undefined`.
    if (typeof parsed.secret !== 'string' || parsed.secret === '') return null;
    if (!Array.isArray(parsed.recoveryHashes) || parsed.recoveryHashes.some((hash) => typeof hash !== 'string')) return null;
    return { secret: parsed.secret, recoveryHashes: parsed.recoveryHashes };
  } catch {
    return null;
  }
}

/**
 * Fail closed on an empty secret, loudly — the stance every other signer in this
 * repo takes (`email-verification.ts`, `portal-session-token.ts`). An empty
 * `SESSION_SECRET` must never quietly encrypt a seed under a key everyone knows.
 */
function deriveKey(secret: string): Buffer {
  if (secret === '') {
    throw new Error('SESSION_SECRET is empty — refusing to wrap or unwrap a TOTP secret with no key');
  }
  return createHmac('sha256', secret).update(PURPOSE).digest().subarray(0, KEY_BYTES);
}
