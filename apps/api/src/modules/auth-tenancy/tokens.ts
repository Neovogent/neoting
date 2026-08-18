/**
 * DI tokens. Explicit symbols because the app runs under tsx/vitest without
 * emitted decorator metadata (apps/api house pattern since #9).
 */
export const AUTH_SERVICE = Symbol('AUTH_SERVICE');
export const PRISMA = Symbol('AUTH_TENANCY_PRISMA');
