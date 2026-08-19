import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signed portal link token (SoT §4 Stage 8.3 — "signed short-lived URL").
 *
 * Stage 9's OTP portal CONSUMES this: the SMS carries the token, the client taps
 * it, and `POST /v1/portal/sessions` verifies it (then the OTP) before creating a
 * delegated session scoped to the chase's items. The format is DEFINED HERE
 * because composition (Stage 8) mints it and the portal (Stage 9) verifies it —
 * one format, one place, so the two stages cannot drift.
 *
 * It is the upload-intent / session-cookie pattern
 * (`ingestion-routing/web-upload/upload-token.ts`,
 * `auth-tenancy/session-cookie.ts`) with a chase's claim set: `{chaseId, exp}`
 * HMAC-signed with `PORTAL_LINK_SECRET`, so a forged or edited token fails
 * verification rather than resolving to a chase the holder could not have been
 * sent. The link is deliberately forwardable (SoT Stage 8.3), so the token grants
 * nothing on its own — it names the chase; the OTP and the delegated RLS scope
 * are what gate the data. Expiry is a claim on the token, checked at verify time.
 *
 * // DEMO-MOCK: the real short URL is a redirect service; this is the raw token
 * // the portal endpoint verifies. No new dependency — node:crypto only (METH §3.4).
 */

/** 24 h by default — long enough for a client to act, short enough to expire. */
export const PORTAL_LINK_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export interface PortalLinkClaims {
  readonly chaseId: string;
  /** Epoch millis after which verification fails as expired. */
  readonly expiresAtMs: number;
}

export interface SignPortalLinkInput {
  readonly chaseId: string;
  /** Seconds from now until the token expires. */
  readonly expSeconds?: number;
}

export type VerifyPortalLinkResult =
  | { readonly ok: true; readonly chaseId: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

/**
 * `base64url(claims) . base64url(hmacSha256(secret, payload))` — compact and
 * URL-safe, so it drops straight into an SMS link.
 */
export function signPortalLink(input: SignPortalLinkInput, secret: string, nowMs: number = Date.now()): string {
  requireSecret(secret);
  const claims: PortalLinkClaims = {
    chaseId: input.chaseId,
    expiresAtMs: nowMs + (input.expSeconds ?? PORTAL_LINK_DEFAULT_TTL_SECONDS) * 1000,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Token → chaseId, or a reason. `invalid` collapses missing, malformed and
 * bad-signature (the distinction is an oracle for whoever is forging, the
 * session-cookie stance); `expired` stays separate because the token was
 * genuinely ours and Stage 9 can safely tell the client the link lapsed.
 */
export function verifyPortalLink(token: string, secret: string, nowMs: number = Date.now()): VerifyPortalLinkResult {
  requireSecret(secret);
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid' };
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature first: never parse attacker bytes we have not authenticated.
  if (!constantTimeEqual(signature, sign(payload, secret))) return { ok: false, reason: 'invalid' };

  let claims: PortalLinkClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PortalLinkClaims;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof claims.chaseId !== 'string' || claims.chaseId === '' || typeof claims.expiresAtMs !== 'number') {
    return { ok: false, reason: 'invalid' };
  }
  if (nowMs >= claims.expiresAtMs) return { ok: false, reason: 'expired' };
  return { ok: true, chaseId: claims.chaseId };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function requireSecret(secret: string): void {
  // Fail closed — an empty secret must never silently mint or accept a forgeable
  // portal link (the stance shared with UPLOAD_URL_SECRET and SESSION_SECRET).
  if (secret === '') {
    throw new Error('PORTAL_LINK_SECRET is empty — refusing to sign or verify a portal link with no secret');
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
