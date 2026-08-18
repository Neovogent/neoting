import { createHmac, timingSafeEqual } from 'node:crypto';

import type { SessionVerdict } from '../../common/context/session-context-resolver.js';

/**
 * The stateless `nt_session` cookie (METH Stage 1, issue #118).
 *
 * There is no session row: the signed token IS the session, exactly the
 * upload-intent pattern (`ingestion-routing/web-upload/upload-token.ts`) with a
 * different secret and a different claim set. `{userId, exp}` travels inside
 * the signature, so a forged or edited cookie fails verification rather than
 * resolving to a user the holder could not have logged in as. Invalidation is
 * the cleared cookie plus `expiresAtMs`; a revocation list waits until sessions
 * are rows (post-demo, contract pass 2).
 */

/** Pinned by the contract's `workspaceSession` security scheme — change both or neither. */
export const SESSION_COOKIE_NAME = 'nt_session';

/** 12 h, per METH Stage 1 — inside Governance §11.1's ≤ 24 h idle ceiling. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionClaims {
  readonly userId: string;
  /** Epoch millis after which the cookie is `NT-AUTH-002`, not a session. */
  readonly expiresAtMs: number;
}

/** `base64url(claims) . base64url(hmacSha256(secret, payload))` — compact and cookie-safe. */
export function signSessionToken(claims: SessionClaims, secret: string): string {
  requireSecret(secret);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Raw `Cookie` header → verdict. One function on purpose: the resolver seam
 * (`SessionContextDeps.verifyCookieHeader`) should not have to compose parsing
 * and verification correctly on every call site.
 *
 * Missing, malformed and bad-signature all collapse into `invalid` — the
 * distinction is an oracle for whoever is forging, and the resolver returns one
 * detail string for the lot. `expired` stays separate because the cookie was
 * genuinely ours and "log in again" is safe to say.
 */
export function verifySessionCookieHeader(
  cookieHeader: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): SessionVerdict {
  requireSecret(secret);
  const token = readCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (token === undefined) return { ok: false, reason: 'invalid' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid' };
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature first: never parse attacker bytes we have not authenticated.
  if (!constantTimeEqual(signature, sign(payload, secret))) return { ok: false, reason: 'invalid' };

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof claims.userId !== 'string' || claims.userId === '' || typeof claims.expiresAtMs !== 'number') {
    return { ok: false, reason: 'invalid' };
  }
  if (nowMs >= claims.expiresAtMs) return { ok: false, reason: 'expired' };
  return { ok: true, userId: claims.userId };
}

/**
 * Minimal `Cookie` header parse — `name=value` pairs split on `;`. No
 * dependency (METH §3: none), and no decoding: the token alphabet is base64url
 * plus `.`, none of which a cookie encodes.
 */
function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function requireSecret(secret: string): void {
  // Fail closed — an empty secret must never silently mint or accept a forgeable
  // session (same stance as UPLOAD_URL_SECRET and the Meta webhook secrets).
  if (secret === '') throw new Error('SESSION_SECRET is empty — refusing to sign or verify a session with no secret');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
