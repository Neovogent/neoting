/** DI tokens for the chat runtime. Symbols, so nothing collides across modules. */
export const PRISMA = Symbol('chat.prisma');
export const MODEL_PROVIDER = Symbol('chat.modelProvider');
export const CIRCUIT_BREAKER = Symbol('chat.circuitBreaker');
export const AI_BUDGET = Symbol('chat.aiBudget');
export const CHAT_SERVICE = Symbol('chat.service');
export const SUGGESTIONS_SERVICE = Symbol('chat.suggestionsService');
/** Saved conversations (review item 9) — CRUD over the caller's own rows, no model on its path. */
export const CHAT_CONVERSATIONS_SERVICE = Symbol('chat.conversationsService');
/** The process-wide replay store the two conversation mutations honour their Idempotency-Key with. */
export const CHAT_IDEMPOTENCY_STORE = Symbol('chat.idempotencyStore');
