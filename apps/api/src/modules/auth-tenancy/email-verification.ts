import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The email-verification token (launch stage A1).
 *
 * Same stateless HMAC pattern as `session-cookie.ts` and the upload intent:
 * `base64url(claims).base64url(hmac)`. There is no `email_verification_tokens`
 * table because `prisma/` is LAW and A1 may not add one — and it does not need
 * one: the claims travel inside the signature, so a forged or edited token
 * fails verification rather than verifying an address the holder does not
 * control.
 *
 * ⚠ **THE KEY IS DERIVED, NOT REUSED.** It would be one line shorter to sign
 * with `SESSION_SECRET` directly, and that would make a verification token and
 * a session cookie interchangeable inputs to the same HMAC — a token minted for
 * one purpose accepted by the verifier for the other. `deriveKey` hashes the
 * secret under a fixed purpose label first, so the two key spaces are disjoint
 * and a cross-purpose token simply does not verify. This avoids a second
 * environment variable, which would be a change to `config/env.ts` — outside
 * A1's owned paths.
 *
 * ⚠ **NOTHING CONSUMES THIS TOKEN YET, AND THAT IS A CONTRACT GAP, NOT AN
 * OVERSIGHT.** `packages/contracts/openapi.yaml` declares no
 * verify-email-address operation — there is no `POST /v1/practices/…/verify`,
 * no `GET /verify/{token}`. Minting is A1's half and it is done; the endpoint
 * that flips `users.email_verified` needs a contract-change issue (G7) before
 * any route can exist. `confirmEmailVerification` below is the service half,
 * written and tested so that change is a controller and nothing else.
 */

/** 48 h. Long enough to survive a weekend and a spam folder; short enough that a leaked mailbox is not a standing key. */
export const EMAIL_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;

const PURPOSE = 'neoting.email-verification.v1';

export interface EmailVerificationClaims {
  readonly userId: string;
  /** The address being proved. Bound into the token so a changed address invalidates it. */
  readonly email: string;
  readonly expiresAtMs: number;
}

export type EmailVerificationVerdict =
  | { readonly ok: true; readonly claims: EmailVerificationClaims }
  /** `invalid` covers missing, malformed, forged and wrong-purpose — one verdict, no oracle. */
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

export function signEmailVerificationToken(claims: EmailVerificationClaims, secret: string): string {
  const key = deriveKey(secret);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

export function verifyEmailVerificationToken(
  token: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): EmailVerificationVerdict {
  const key = deriveKey(secret);
  if (token === undefined || token === '') return { ok: false, reason: 'invalid' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid' };
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature first: never parse attacker bytes we have not authenticated.
  if (!constantTimeEqual(signature, sign(payload, key))) return { ok: false, reason: 'invalid' };

  let claims: EmailVerificationClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as EmailVerificationClaims;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    typeof claims.userId !== 'string' ||
    claims.userId === '' ||
    typeof claims.email !== 'string' ||
    claims.email === '' ||
    typeof claims.expiresAtMs !== 'number'
  ) {
    return { ok: false, reason: 'invalid' };
  }
  // `expired` is distinct from `invalid` because the token was genuinely ours
  // and "that link has expired, request a new one" is safe to say — the holder
  // already had it. Same split as the session cookie's NT-AUTH-002.
  if (nowMs >= claims.expiresAtMs) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

function deriveKey(secret: string): Buffer {
  // Fail closed — an empty secret must never silently mint or accept a
  // forgeable token (the stance every other signer in this repo takes).
  if (secret === '') {
    throw new Error('SESSION_SECRET is empty — refusing to sign or verify an email-verification token with no secret');
  }
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
