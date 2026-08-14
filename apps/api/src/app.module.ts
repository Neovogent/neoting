import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ProblemFilter } from './common/problem/problem.filter.js';
import { EnvModule } from './config/env.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { WhatsAppWebhookModule } from './modules/ingestion-routing/webhooks/whatsapp/whatsapp.module.js';

@Module({
  imports: [EnvModule, HealthModule, WhatsAppWebhookModule],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}
