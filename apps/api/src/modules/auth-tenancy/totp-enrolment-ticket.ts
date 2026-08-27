import { type ClaimsVerdict, type ExpiringClaims, signClaims, verifyClaims } from './signed-claims.js';

/**
 * The candidate second factor, in flight between the two enrolment steps
 * (launch stage A14, issue #195).
 *
 * ## ⚠ THIS FILE IS WHY THE TWO-STEP IS REAL. READ THIS BEFORE CHANGING IT.
 *
 * A2 shipped a two-step enrolment whose first step **wrote
 * `users.totp_secret_ref`** and whose second step only set
 * `totp_enabled_at`. Nothing on the login path reads `totp_enabled_at` —
 * `auth.service.ts` verifies against the ref alone — so the factor went live at
 * step one, and the split bought nothing it was built to buy:
 *
 * - Mis-scan the QR, or mistype the manual seed, and the account now has a
 *   second factor nothing can produce a code for.
 * - Start again? Issue #195 requires enrolment to refuse an account that
 *   already has a ref — so the second attempt is refused too.
 * - There is no reset flow in this release. **That is a permanent lockout, from
 *   one mis-scan, on the account that holds a practice's clients' books.**
 *
 * So the candidate may not touch the database until a code proves an
 * authenticator actually received it. `prisma/` is LAW and #195 approves no
 * migration, so there is no candidates table to hold it either. It travels: a
 * signed, short-lived, user-bound ticket the client posts back.
 *
 * ## Why carrying the envelope is safe
 *
 * `ref` is `totp-secret.ts`'s AES-256-GCM envelope, not the seed. The claims of
 * a signed token are readable by whoever holds it (`signed-claims.ts` says so
 * in capitals), and what is readable here is ciphertext under a key derived
 * from `SESSION_SECRET`. The *plaintext* seed and the recovery codes are in the
 * same HTTP response anyway — the user has to see them to enrol at all — so the
 * ticket discloses nothing new to its holder, and nothing whatsoever to anyone
 * else.
 *
 * The signature covers the whole claim set, so a caller cannot keep their own
 * ticket and swap in someone else's `userId`, nor lengthen its life.
 *
 * ## Why a ticket rather than letting the client post the seed back
 *
 * The obvious alternative — return `secret`, take `secret` back — hands the
 * caller the choice of their own seed. An attacker who knows a password could
 * then enrol a secret they generated elsewhere, which is not worse than the
 * password compromise itself but is one more thing the server would have
 * stopped controlling for no gain.
 */

/**
 * Fifteen minutes: long enough to scan a QR, copy ten recovery codes onto
 * paper, and wait out a code change; short enough that a ticket left in a
 * browser tab overnight is not a live credential. An abandoned ticket costs
 * nothing — no row was written — so the user simply starts again.
 */
export const TOTP_ENROLMENT_TICKET_TTL_MS = 15 * 60 * 1000;

const PURPOSE = 'neoting.totp-enrolment.v1';

export interface TotpEnrolmentTicketClaims extends ExpiringClaims {
  /** Whose enrolment this is. `confirm` refuses a ticket that names a different user than the credentials did. */
  readonly userId: string;
  /**
   * Bound in as well as the id, so a ticket stops verifying if the address it
   * was minted for changes — the same reason the verification token carries it.
   */
  readonly email: string;
  /** The AES-GCM envelope from `createTotpEnrolment`. Ciphertext; see the header. */
  readonly ref: string;
  readonly expiresAtMs: number;
}

export type TotpEnrolmentTicketVerdict = ClaimsVerdict<TotpEnrolmentTicketClaims>;

export function signTotpEnrolmentTicket(claims: TotpEnrolmentTicketClaims, secret: string): string {
  return signClaims(PURPOSE, claims, secret);
}

export function verifyTotpEnrolmentTicket(
  token: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): TotpEnrolmentTicketVerdict {
  return verifyClaims(PURPOSE, token, secret, isTicketClaims, nowMs);
}

function isTicketClaims(candidate: unknown): candidate is TotpEnrolmentTicketClaims {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const claims = candidate as Partial<TotpEnrolmentTicketClaims>;
  return (
    typeof claims.userId === 'string' &&
    claims.userId !== '' &&
    typeof claims.email === 'string' &&
    claims.email !== '' &&
    typeof claims.ref === 'string' &&
    claims.ref !== '' &&
    typeof claims.expiresAtMs === 'number'
  );
}
