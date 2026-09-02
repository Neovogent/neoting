import { createHash } from 'node:crypto';

import { type ClaimsVerdict, signClaims, verifyClaims } from './signed-claims.js';

/**
 * The password-reset token (2 Sep 2026) — the third consumer of the shared
 * signed-claims scheme, beside A1's verification token and A14's enrolment
 * ticket. Same argument throughout: no table because `prisma/` needs no new
 * one, purpose-derived key so the token spaces stay disjoint, signed-not-
 * encrypted so nothing secret rides in it.
 *
 * **Single-use without state — the fingerprint binding.** The claims carry a
 * short hash of the password hash the token was minted AGAINST. Spending the
 * token replaces that hash, so every outstanding token (this one included)
 * stops verifying the moment one is used — and a password change by any other
 * door kills them too, which is exactly the property a reset link should have.
 * The fingerprint is 16 hex chars of SHA-256 over an scrypt output: it reveals
 * nothing recoverable about the password, and the claims are readable by the
 * token's holder anyway.
 */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

const PURPOSE = 'password-reset';

export interface PasswordResetClaims {
  readonly userId: string;
  /** Binds the token to the mailbox, exactly as the verification token does. */
  readonly email: string;
  /** Binds the token to the CURRENT password hash — the single-use mechanism. */
  readonly passwordFingerprint: string;
  readonly expiresAtMs: number;
}

export function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
}

export function signPasswordResetToken(claims: PasswordResetClaims, secret: string): string {
  return signClaims(PURPOSE, claims, secret);
}

export function verifyPasswordResetToken(
  token: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): ClaimsVerdict<PasswordResetClaims> {
  return verifyClaims(PURPOSE, token, secret, isPasswordResetClaims, nowMs);
}

function isPasswordResetClaims(candidate: unknown): candidate is PasswordResetClaims {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  return (
    typeof c['userId'] === 'string' &&
    c['userId'] !== '' &&
    typeof c['email'] === 'string' &&
    c['email'] !== '' &&
    typeof c['passwordFingerprint'] === 'string' &&
    c['passwordFingerprint'] !== '' &&
    typeof c['expiresAtMs'] === 'number'
  );
}
