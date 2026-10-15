import { HttpStatus } from '@nestjs/common';

import { sessionExpired, unauthenticated } from '../../common/context/request-context.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { normaliseEmail } from './practice-signup.service.js';
import { verifySessionCookieHeader } from './session-cookie.js';

/**
 * Platform staff (rush/admin): the support console's identity check.
 *
 * Staff are ordinary HUMAN users who signed in through the ordinary login —
 * password AND second factor — and whose address is listed in
 * `PLATFORM_ADMIN_EMAILS`. They need no membership: the console never runs
 * under their own scope, it reads each practice under that practice's SYSTEM
 * context (see `modules/platform-admin`).
 *
 * The user lookup is the same privileged, unscoped `users` read as
 * `loadScopeForUser` and for the same reason: `users` carries no RLS, and this
 * is the bootstrap that decides who the caller is.
 */
export interface PlatformAdmin {
  readonly userId: string;
  readonly email: string;
}

export function platformAdminEmails(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((part) => normaliseEmail(part))
      .filter((part) => part !== ''),
  );
}

export function isPlatformAdminEmail(raw: string | undefined, email: string | null): boolean {
  return email !== null && platformAdminEmails(raw).has(normaliseEmail(email));
}

/**
 * Is this (already-verified) user still platform staff? Re-read on EVERY call —
 * deactivation, removal from the env list or a missing second factor ends
 * access at the next request, not at cookie expiry.
 */
export async function loadPlatformAdmin(prisma: PrismaClient, env: Env, userId: string): Promise<PlatformAdmin | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, kind: true, deactivatedAt: true, totpEnabledAt: true },
  });
  if (user === null || user.kind !== 'HUMAN' || user.deactivatedAt !== null) return null;
  if (!isPlatformAdminEmail(env.PLATFORM_ADMIN_EMAILS, user.email)) return null;
  // "TOTP still required": under a real second factor an admin must hold an
  // enrolment. Login already fails closed without one; this is the belt to
  // that brace, so a session minted any other way cannot reach the console.
  if (env.OTP_MODE === 'totp' && user.totpEnabledAt === null) return null;
  return { userId: user.id, email: user.email ?? '' };
}

/** Cookie → platform admin, or throws 401 (no/expired session) / 403 (not staff). */
export async function resolvePlatformAdmin(
  prisma: PrismaClient,
  env: Env,
  cookieHeader: string | undefined,
): Promise<PlatformAdmin> {
  const verdict = verifySessionCookieHeader(cookieHeader, env.SESSION_SECRET);
  if (!verdict.ok) {
    if (verdict.reason === 'expired') throw sessionExpired('The session has expired — log in again.');
    throw unauthenticated('missing or invalid session cookie');
  }
  const admin = await loadPlatformAdmin(prisma, env, verdict.userId);
  if (admin === null) throw notPlatformStaff();
  return admin;
}

export function notPlatformStaff(): AppException {
  return new AppException('NT-PRM-001', HttpStatus.FORBIDDEN, 'Forbidden', 'This account is not platform staff.');
}
