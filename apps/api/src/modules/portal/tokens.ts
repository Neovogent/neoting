/**
 * DI tokens for the portal module. Explicit symbols because the app runs under
 * tsx/vitest without emitted decorator metadata (apps/api house pattern).
 */
export const PRISMA = Symbol('PORTAL_PRISMA');
export const PORTAL_SESSION_SERVICE = Symbol('PORTAL_SESSION_SERVICE');
export const PORTAL_SESSION_CONTEXT = Symbol('PORTAL_SESSION_CONTEXT');
/** `POST /v1/portal/uploads` — the delegated upload intent (`portal-upload.service.ts`). */
export const PORTAL_UPLOAD_SERVICE = Symbol('PORTAL_UPLOAD_SERVICE');
/** The object store the portal presigns into. Config-selected, never import-selected. */
export const PORTAL_DOCUMENT_STORE = Symbol('PORTAL_DOCUMENT_STORE');
/** `Idempotency-Key` honouring for the portal's own mutations. */
export const PORTAL_IDEMPOTENCY_STORE = Symbol('PORTAL_IDEMPOTENCY_STORE');
/** `GET /v1/portal/context` — the chased items this session may see (METH Stage 9). */
export const PORTAL_CONTEXT_SERVICE = Symbol('PORTAL_CONTEXT_SERVICE');
// No token for `portal-upload-status.service.ts`: the contract publishes no
// status path, so nothing injects it (see the note in `portal.module.ts`).
/** The accountant's `portal.upload` notification (SoT §4 Stage 8.8, `portal-upload-notifier.ts`). */
export const PORTAL_UPLOAD_NOTIFIER = Symbol('PORTAL_UPLOAD_NOTIFIER');

/** The invited client's way in — the two endpoints `openapi.yaml` published and nothing implemented. */
export const PORTAL_ONBOARDING_SERVICE = Symbol('PORTAL_ONBOARDING_SERVICE');
