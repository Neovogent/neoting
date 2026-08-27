import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless signed claims — **one implementation** of the pattern this module
 * reaches for whenever a value has to survive a round trip through a client we
 * do not trust and there is no table to hold it (launch stage A14).
 *
 * `base64url(claims).base64url(hmac)`. The claims travel inside the signature,
 * so a forged or edited token fails verification rather than asserting
 * something its holder never earned. There is no `email_verification_tokens`
 * table and no `totp_enrolment_candidates` table because `prisma/` is LAW —
 * and neither is needed: a row would buy revocation, and both of these values
 * are already short-lived and single-purpose.
 *
 * ⚠ **THE KEY IS DERIVED FROM A PURPOSE LABEL, NEVER THE RAW SECRET.** It
 * would be one line shorter to sign with `SESSION_SECRET` directly, and that
 * would make every token in this file interchangeable with every other one and
 * with the session cookie — a value minted for one purpose accepted by the
 * verifier for another. Hashing the secret under a fixed label first makes each
 * purpose its own key space, so a cross-purpose token simply does not verify.
 * `password.test.ts` pins exactly that, and `totp-secret.ts` makes the same
 * argument for the TOTP envelope's key.
 *
 * ⚠ **CLAIMS ARE SIGNED, NOT ENCRYPTED.** Anyone holding a token can read them
 * — `base64url` is an encoding, not a cipher. Never put anything in here that
 * the holder may not see. (The enrolment ticket carries the TOTP envelope,
 * which is separately AES-GCM encrypted by `totp-secret.ts`; that is what makes
 * it safe to carry, not this file.)
 *
 * **Extracted rather than copied a third time.** `email-verification.ts` (A1)
 * and `totp-enrolment-ticket.ts` (A14) are both this, and a second
 * implementation of a signing scheme is a second thing to get wrong.
 * `session-cookie.ts` deliberately stays separate: it is the request-path
 * verifier, its verdict feeds `NT-AUTH-002`, and moving it is risk with no
 * reader.
 */

/**
 * `invalid` covers missing, malformed, forged and wrong-purpose — one verdict,
 * so a caller cannot learn which. `expired` is separate because a token that
 * WAS ours and has run out is safe to name: the holder already had it, and
 * "ask for another one" is the only actionable failure on these paths.
 */
export type ClaimsVerdict<TClaims> =
  | { readonly ok: true; readonly claims: TClaims }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

/** Every token minted here expires. A signed claim with no clock on it is a standing key. */
export interface ExpiringClaims {
  readonly expiresAtMs: number;
}

export function signClaims<TClaims extends ExpiringClaims>(purpose: string, claims: TClaims, secret: string): string {
  const key = deriveKey(purpose, secret);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/**
 * Verify, then parse, then shape-check, then check the clock — in that order,
 * and the order is the point.
 *
 * `isWellFormed` is the caller's own narrowing predicate. It runs only on bytes
 * that have already authenticated, so it is a guard against our own past
 * formats rather than against an attacker.
 */
export function verifyClaims<TClaims extends ExpiringClaims>(
  purpose: string,
  token: string | undefined,
  secret: string,
  isWellFormed: (candidate: unknown) => candidate is TClaims,
  nowMs: number = Date.now(),
): ClaimsVerdict<TClaims> {
  const key = deriveKey(purpose, secret);
  if (token === undefined || token === '') return INVALID;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return INVALID;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature first: never parse attacker bytes we have not authenticated.
  if (!constantTimeEqual(signature, sign(payload, key))) return INVALID;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return INVALID;
  }
  if (!isWellFormed(claims)) return INVALID;
  if (nowMs >= claims.expiresAtMs) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

const INVALID = Object.freeze({ ok: false, reason: 'invalid' }) as ClaimsVerdict<never>;

function deriveKey(purpose: string, secret: string): Buffer {
  // Fail closed — an empty secret must never silently mint or accept a
  // forgeable token (the stance every other signer in this repo takes).
  if (secret === '') {
    throw new Error(`SESSION_SECRET is empty — refusing to sign or verify a "${purpose}" token with no secret`);
  }
  return createHmac('sha256', secret).update(purpose).digest();
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
