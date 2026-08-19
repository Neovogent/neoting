import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The portal session BEARER (METH Stage 9, SoT §4 Stage 8.3).
 *
 * ⚠ **The contract says bearer, METH Stage 9's prose says "issue portal
 * cookie". The contract wins (G7).** `packages/contracts/openapi.yaml` declares
 * `portalSession: {type: http, scheme: bearer}` and both authenticated portal
 * operations sit under `security: [portalSession]`, so this is an
 * `Authorization: Bearer …` credential and `openapi.yaml` is not edited to
 * match the prose. The divergence is recorded in this module's CLAUDE.md.
 *
 * The format is the house one, third instance: `base64url(claims) .
 * base64url(hmacSha256(secret, payload))` — `upload-token.ts`,
 * `session-cookie.ts`, `chase/portal-link.ts`, now this. What differs is the
 * claim set and the secret.
 *
 * **Why the claims carry the business and the practice, not just the session
 * id.** `otp_sessions` is a tenant table (`otp_sessions_tenant` →
 * `app_can_access_business`), so reading the session row needs a scope context
 * — and a scope context is exactly what the row would have told us. That
 * bootstrap has to be broken by something the server itself signed, which is
 * the same move `UploadClaims` makes (it carries `businessId` + `practiceId`
 * for the same reason). These are OUR bytes under OUR HMAC: a forged or edited
 * pair fails verification before anything is parsed, so trusting them is no
 * weaker than trusting the session id in the same envelope.
 *
 * The session row remains authoritative. The token's `expiresAtMs` is a cheap
 * offline check; `portal-session-context.ts` re-reads the row and re-checks its
 * `expiresAt` and `verifiedAt`, so a session shortened or unverified after the
 * token was minted is refused by the row, not by the token.
 */

/**
 * 60 minutes. Deliberately far shorter than the 24 h LINK
 * (`PORTAL_LINK_DEFAULT_TTL_SECONDS`): the link is a public URL that has proved
 * nothing, the bearer is a credential that has already passed the OTP, and it
 * lives in a phone browser that may be handed to someone else or left open in a
 * car park. Long enough to find the receipt, photograph it and upload it; short
 * enough that an abandoned tab stops holding a grant. Re-verifying the link
 * (link + OTP again) mints a fresh one — see `portal-session.service.ts`.
 */
export const PORTAL_SESSION_TTL_MS = 60 * 60 * 1000;

export interface PortalSessionClaims {
  /** The `otp_sessions` row this bearer stands for. */
  readonly otpSessionId: string;
  /** The chase's business — the tenant every portal query is scoped to. */
  readonly businessId: string;
  /** That business's practice — the SYSTEM actor the row is read under. */
  readonly practiceId: string;
  /** Epoch millis after which verification fails as expired (`NT-OTP-002`). */
  readonly expiresAtMs: number;
}

export type PortalSessionVerdict =
  | { readonly ok: true; readonly claims: PortalSessionClaims }
  /** `invalid` covers missing, malformed AND bad-signature — one bucket, no oracle. `expired` is separate because the portal may safely say "the link lapsed". */
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

export function signPortalSessionToken(claims: PortalSessionClaims, secret: string): string {
  requireSecret(secret);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Raw `Authorization` header → verdict. One function on purpose, exactly as
 * `verifySessionCookieHeader` is: the resolver should not have to compose
 * scheme-parsing and verification correctly on every call site.
 */
export function verifyPortalSessionHeader(
  authorizationHeader: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): PortalSessionVerdict {
  return verifyPortalSessionToken(readBearer(authorizationHeader), secret, nowMs);
}

/** The bare token, for callers that already hold one (and for the round-trip tests). */
export function verifyPortalSessionToken(
  token: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): PortalSessionVerdict {
  requireSecret(secret);
  if (token === undefined) return { ok: false, reason: 'invalid' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid' };
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature first: never parse attacker bytes we have not authenticated.
  if (!constantTimeEqual(signature, sign(payload, secret))) return { ok: false, reason: 'invalid' };

  let claims: PortalSessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PortalSessionClaims;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  // A correctly-signed token of the WRONG SHAPE is still invalid — an old
  // signer or a renamed claim is a bug of ours, and a bug of ours must not
  // become an open door (the session-cookie stance).
  if (
    !isNonEmptyString(claims.otpSessionId) ||
    !isNonEmptyString(claims.businessId) ||
    !isNonEmptyString(claims.practiceId) ||
    typeof claims.expiresAtMs !== 'number'
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (nowMs >= claims.expiresAtMs) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    // Rebuilt field by field rather than passed through: whatever else was in
    // the JSON does not travel into the request as a claim.
    claims: {
      otpSessionId: claims.otpSessionId,
      businessId: claims.businessId,
      practiceId: claims.practiceId,
      expiresAtMs: claims.expiresAtMs,
    },
  };
}

/**
 * `Authorization: Bearer <token>` → the token. The scheme is compared
 * case-insensitively (RFC 7235 makes it case-insensitive, and clients do vary);
 * anything else — no header, another scheme, an empty credential — is
 * `undefined`, which the caller collapses into `invalid`.
 */
function readBearer(authorizationHeader: string | undefined): string | undefined {
  if (authorizationHeader === undefined) return undefined;
  const space = authorizationHeader.indexOf(' ');
  if (space <= 0) return undefined;
  if (authorizationHeader.slice(0, space).toLowerCase() !== 'bearer') return undefined;
  const token = authorizationHeader.slice(space + 1).trim();
  return token === '' ? undefined : token;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function requireSecret(secret: string): void {
  // Fail closed — an empty secret must never silently mint or accept a forgeable
  // portal session (the stance shared with UPLOAD_URL_SECRET, SESSION_SECRET
  // and PORTAL_LINK_SECRET).
  if (secret === '') {
    throw new Error('PORTAL_SESSION_SECRET is empty — refusing to sign or verify a portal session with no secret');
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
