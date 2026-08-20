import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { type AiBudget, InMemoryAiBudget, RedisAiBudget } from './budget.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { CircuitBreaker } from './provider/circuit-breaker.js';
import type { ModelProvider } from './provider/model-provider.js';
import { selectModelProvider } from './provider/select-model-provider.js';
import { AI_BUDGET, CHAT_SERVICE, CIRCUIT_BREAKER, MODEL_PROVIDER, PRISMA } from './tokens.js';

/**
 * The AI runtime module (Governance §9).
 *
 * Three composition decisions worth stating, because each is the kind of thing
 * that looks arbitrary until it breaks:
 *
 * 1. **The breaker is a singleton per process.** It counts consecutive failures
 *    against the PROVIDER (§9.3), so it has to outlive a request. A
 *    request-scoped breaker would count to one, forever, and never open.
 * 2. **The budget follows the queue's storage decision, not its own.** When
 *    `INGEST_QUEUE=bullmq` there is a real Redis to keep a shared ledger in;
 *    when there is not, an in-process ledger still enforces a ceiling rather
 *    than silently having none. A missing Redis must not mean unlimited spend.
 * 3. **The provider is config-selected** (`AI_CHAT`), never import-selected —
 *    so a unit test injects the deterministic stand-in and no test in this repo
 *    can accidentally spend money.
 */
@Module({
  controllers: [ChatController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: MODEL_PROVIDER, useFactory: (env: Env) => selectModelProvider(env), inject: [ENV] },
    { provide: CIRCUIT_BREAKER, useFactory: () => new CircuitBreaker() },
    {
      provide: AI_BUDGET,
      useFactory: (env: Env): AiBudget =>
        env.INGEST_QUEUE === 'bullmq'
          ? RedisAiBudget.fromUrl(env.REDIS_URL, env.AI_DAILY_BUDGET_PENCE)
          : new InMemoryAiBudget(env.AI_DAILY_BUDGET_PENCE),
      inject: [ENV],
    },
    {
      provide: CHAT_SERVICE,
      useFactory: (prisma: PrismaClient, provider: ModelProvider, breaker: CircuitBreaker, budget: AiBudget) =>
        new ChatService(prisma, provider, breaker, budget),
      inject: [PRISMA, MODEL_PROVIDER, CIRCUIT_BREAKER, AI_BUDGET],
    },
  ],
})
export class ChatFrameworkModule {}
