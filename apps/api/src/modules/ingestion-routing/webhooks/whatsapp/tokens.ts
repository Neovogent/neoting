/**
 * DI tokens for the WhatsApp webhook. Explicit symbol tokens so injection never
 * depends on emitted decorator metadata — the app runs under esbuild (tsx /
 * vitest), which does not emit `design:paramtypes`. Every injected constructor
 * parameter carries an `@Inject(<token>)`.
 */
export const INGEST_QUEUE = Symbol('INGEST_QUEUE');
export const REPLAY_STORE = Symbol('REPLAY_STORE');
export const CLOCK = Symbol('CLOCK');
