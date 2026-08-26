/**
 * DI tokens for the notifications module. Explicit symbols because the app runs
 * under tsx/vitest without emitted decorator metadata (apps/api house pattern).
 */

/** The config-selected transport (`select-email-sender.ts`). Exported by the module. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
/** The config-selected per-address / per-IP limiter. */
export const EMAIL_RATE_LIMITER = Symbol('EMAIL_RATE_LIMITER');
/** The one door outbound email leaves by (`notifications.service.ts`). Exported by the module. */
export const NOTIFICATIONS_SERVICE = Symbol('NOTIFICATIONS_SERVICE');
