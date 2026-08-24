/** DI tokens for the chat runtime. Symbols, so nothing collides across modules. */
export const PRISMA = Symbol('chat.prisma');
export const MODEL_PROVIDER = Symbol('chat.modelProvider');
export const CIRCUIT_BREAKER = Symbol('chat.circuitBreaker');
export const AI_BUDGET = Symbol('chat.aiBudget');
export const CHAT_SERVICE = Symbol('chat.service');
