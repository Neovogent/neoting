/**
 * DI tokens for web upload. Explicit symbols, the same reason as the WhatsApp
 * lane: the app runs under esbuild (tsx / vitest), which emits no
 * `design:paramtypes`, so every injected parameter carries an `@Inject(<token>)`.
 */
export const WEB_UPLOAD_SERVICE = Symbol('WEB_UPLOAD_SERVICE');
export const PRISMA = Symbol('PRISMA');
export const DOCUMENT_STORE = Symbol('DOCUMENT_STORE');
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');
