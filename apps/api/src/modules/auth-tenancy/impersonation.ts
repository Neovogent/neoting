import type { ImpersonationInfo } from '../../common/context/request-context.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import { type ScopeContext, systemContext } from '../../common/db/scope-context.js';
import type { Env } from '../../config/env.js';
import { loadPlatformAdmin } from './platform-admin-auth.js';
import { readCookie, verifySessionCookieHeader } from './session-cookie.js';
import { signClaims, verifyClaims } from './signed-claims.js';

/**
 * Support "view as" (rush/admin) — the cookie and the scope it resolves to.
 *
 * A platform admin opens a practice READ-ONLY for 30 minutes. The scope is the
 * practice's SYSTEM actor, so every read goes through the same RLS predicate a
 * worker's does: no policy is loosened, no new session scope exists, and the
 * admin sees exactly that one practice. Read-only is enforced by
 * `ImpersonationMiddleware` (modules/platform-admin) BEFORE any handler runs.
 *
 * The cookie is a signed claim bound to the admin's own user id: it does
 * nothing without that admin's valid session beside it, and the admin is
 * re-checked against `PLATFORM_ADMIN_EMAILS` on every request.
 */
export const IMPERSONATION_COOKIE_NAME = 'nt_impersonate';
export const IMPERSONATION_TTL_MS = 30 * 60 * 1000;
const PURPOSE = 'platform-admin-impersonation';

export interface ImpersonationClaims {
  readonly adminUserId: string;
  readonly adminEmail: string;
  readonly practiceId: string;
  readonly expiresAtMs: number;
}

function isClaims(candidate: unknown): candidate is ImpersonationClaims {
  const c = candidate as Partial<ImpersonationClaims> | null;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.adminUserId === 'string' &&
    typeof c.adminEmail === 'string' &&
    typeof c.practiceId === 'string' &&
    typeof c.expiresAtMs === 'number'
  );
}

export function signImpersonation(claims: ImpersonationClaims, secret: string): string {
  return signClaims(PURPOSE, claims, secret);
}

/**
 * The impersonation in force on a raw `Cookie` header, or null. Valid only when
 * the signed claim verifies, has not expired, AND names the user the session
 * cookie beside it belongs to — a cookie lifted into another browser does
 * nothing.
 */
export function verifyImpersonation(
  cookieHeader: string | undefined,
  secret: string,
  nowMs: number = Date.now(),
): ImpersonationClaims | null {
  const token = readCookie(cookieHeader, IMPERSONATION_COOKIE_NAME);
  if (token === undefined || secret === '') return null;
  const verdict = verifyClaims(PURPOSE, token, secret, isClaims, nowMs);
  if (!verdict.ok) return null;
  const session = verifySessionCookieHeader(cookieHeader, secret, nowMs);
  if (!session.ok || session.userId !== verdict.claims.adminUserId) return null;
  return verdict.claims;
}

/** The HTTP methods that may run while impersonating, and the paths exempt from the refusal. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_ALLOWED_PREFIXES = ['/v1/admin/', '/v1/auth/sessions/current'];

/**
 * True when this request must be refused because it would write under an
 * impersonated scope. `/v1/admin/*` is exempt because those routes never use
 * the impersonated scope (they authenticate the admin directly), and logout
 * is exempt so the admin can always leave.
 */
export function impersonationRefuses(method: string, path: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false;
  return !WRITE_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The session resolver's hook: impersonation cookie → the practice's SYSTEM
 * scope, or null to fall through to the admin's own memberships.
 */
export async function resolveImpersonationScope(
  prisma: PrismaClient,
  env: Env,
  cookieHeader: string | undefined,
  userId: string,
): Promise<{ scope: ScopeContext; info: ImpersonationInfo } | null> {
  const claims = verifyImpersonation(cookieHeader, env.SESSION_SECRET);
  if (claims === null || claims.adminUserId !== userId) return null;
  if ((await loadPlatformAdmin(prisma, env, userId)) === null) return null;
  // `memberships` carries no RLS — the resolveSystemActor exemption.
  const system = await prisma.membership.findFirst({
    where: { practiceId: claims.practiceId, user: { kind: 'SYSTEM' } },
    select: { userId: true },
  });
  if (system === null) return null;
  return {
    scope: systemContext(claims.practiceId, system.userId),
    info: {
      adminUserId: claims.adminUserId,
      adminEmail: claims.adminEmail,
      practiceId: claims.practiceId,
      expiresAtMs: claims.expiresAtMs,
    },
  };
}
