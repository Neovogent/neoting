import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ProblemFilter } from './common/problem/problem.filter.js';
import { TraceMiddleware } from './common/trace/trace.middleware.js';
import { EnvModule } from './config/env.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { WhatsAppWebhookModule } from './modules/ingestion-routing/webhooks/whatsapp/whatsapp.module.js';

@Module({
  imports: [EnvModule, HealthModule, WhatsAppWebhookModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Open a trace context per request so the traceId born at the webhook
    // survives into the enqueued job (§13.1) — the controller never sees it.
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
