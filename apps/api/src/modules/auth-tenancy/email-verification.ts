import { type ClaimsVerdict, type ExpiringClaims, signClaims, verifyClaims } from './signed-claims.js';

/**
 * The email-verification token (launch stage A1; routed by A14).
 *
 * The signing scheme lives in `signed-claims.ts` — see that file for why the
 * key is derived from a purpose label rather than being `SESSION_SECRET`
 * itself, and why there is no table behind this. A1 wrote that scheme here;
 * A14 needed a second token of the same shape and extracted it rather than
 * copying it.
 *
 * **The door exists now.** A1's note here used to read *"nothing consumes this
 * token yet, and that is a contract gap"* — it was, and issue #195 closed it.
 * `POST /v1/auth/email-verification` (`verifyEmailAddress`) is the consumer,
 * served by `email-verification.service.ts`.
 */

/** 48 h. Long enough to survive a weekend and a spam folder; short enough that a leaked mailbox is not a standing key. */
export const EMAIL_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;

const PURPOSE = 'neoting.email-verification.v1';

export interface EmailVerificationClaims extends ExpiringClaims {
  readonly userId: string;
  /** The address being proved. Bound into the token so a changed address invalidates it. */
  readonly email: string;
  readonly expiresAtMs: number;
}

/** `invalid` covers missing, malformed, forged and wrong-purpose — one verdict, no oracle. */
export type EmailVerificationVerdict = ClaimsVerdict<EmailVerificationClaims>;

export function signEmailVerificationToken(claims: EmailVerificationClaims, secret: string): string {
  return signClaims(PURPOSE, claims, secret);
}

export function verifyEmailVerificationToken(
  token: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): EmailVerificationVerdict {
  return verifyClaims(PURPOSE, token, secret, isEmailVerificationClaims, nowMs);
}

function isEmailVerificationClaims(candidate: unknown): candidate is EmailVerificationClaims {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const claims = candidate as Partial<EmailVerificationClaims>;
  return (
    typeof claims.userId === 'string' &&
    claims.userId !== '' &&
    typeof claims.email === 'string' &&
    claims.email !== '' &&
    typeof claims.expiresAtMs === 'number'
  );
}
