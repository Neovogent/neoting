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

// --- the in-app inbox (review item 12, 5 Sep 2026) --------------------------

/** The shared pooled Prisma client, received never constructed (Governance §5.1). */
export const PRISMA = Symbol('NOTIFICATIONS_PRISMA');
/** The process-wide in-memory replay store, the documents-module pattern. */
export const IDEMPOTENCY_STORE = Symbol('NOTIFICATIONS_IDEMPOTENCY_STORE');
/** The bell's read + mark-read service (`inbox.service.ts`). */
export const NOTIFICATIONS_INBOX_SERVICE = Symbol('NOTIFICATIONS_INBOX_SERVICE');
