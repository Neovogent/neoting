/**
 * auth-tenancy's public seam (the house pattern — see
 * `ingestion-routing/index.ts` for the doctrine). A name belongs here only when
 * a consumer OUTSIDE the module needs it.
 *
 * Today's consumer is `common/context/context.module.ts`, which assembles the
 * cookie verifier and the membership loader into the `SessionContextResolver`
 * (`AUTH_MODE=session`). That is composition — the resolver itself stays in
 * `common/` and receives these as functions, so `common/` never depends on this
 * module's internals.
 */
/**
 * ⚠ `AuthTenancyModule` is deliberately NOT exported here. `context.module.ts`
 * imports this seam, and the Nest module would drag `auth.controller.ts` — which
 * imports `REQUEST_CONTEXT` back out of `context.module.ts` — into a circular
 * evaluation that dies at boot with "Cannot access 'REQUEST_CONTEXT' before
 * initialization". The composition root (`app.module.ts`, exempt from the seam
 * rule) imports the module file directly.
 */
export { SESSION_COOKIE_NAME, verifySessionCookieHeader } from './session-cookie.js';
export { loadScopeForUser } from './session-scope.js';

// rush/admin — the platform support console's auth primitives.
export {
  isPlatformAdminEmail,
  loadPlatformAdmin,
  notPlatformStaff,
  type PlatformAdmin,
  resolvePlatformAdmin,
} from './platform-admin-auth.js';
export {
  IMPERSONATION_COOKIE_NAME,
  IMPERSONATION_TTL_MS,
  type ImpersonationClaims,
  impersonationRefuses,
  resolveImpersonationScope,
  signImpersonation,
  verifyImpersonation,
} from './impersonation.js';
export { isSignInLocked, unlockSignInAddress } from './sign-in-throttle.js';
export { normaliseEmail } from './practice-signup.service.js';
