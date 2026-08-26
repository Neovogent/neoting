import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ContextMiddleware } from './common/context/context.middleware.js';
import { ContextModule } from './common/context/context.module.js';
import { ProblemFilter } from './common/problem/problem.filter.js';
import { TraceMiddleware } from './common/trace/trace.middleware.js';
import { EnvModule } from './config/env.module.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { AuthTenancyModule } from './modules/auth-tenancy/auth-tenancy.module.js';
import { BankingMatchingModule } from './modules/banking-matching/banking-matching.module.js';
import { ChaseModule } from './modules/chase/chase.module.js';
import { ChatFrameworkModule } from './modules/chat-framework/chat.module.js';
import { ClientsTeamSettingsModule } from './modules/clients-team-settings/clients-team-settings.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { WebUploadModule } from './modules/ingestion-routing/web-upload/web-upload.module.js';
import { WhatsAppWebhookModule } from './modules/ingestion-routing/webhooks/whatsapp/whatsapp.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PortalModule } from './modules/portal/portal.module.js';
import { PublishingModule } from './modules/publishing/publishing.module.js';
import { RulesSuggestionsModule } from './modules/rules-suggestions/rules-suggestions.module.js';

@Module({
  imports: [
    EnvModule,
    ContextModule,
    ApprovalsModule,
    AuthTenancyModule,
    BankingMatchingModule,
    ChaseModule,
    ChatFrameworkModule,
    ClientsTeamSettingsModule,
    DocumentsModule,
    HealthModule,
    NotificationsModule,
    PortalModule,
    PublishingModule,
    RulesSuggestionsModule,
    WebUploadModule,
    WhatsAppWebhookModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Trace first (so every later log line carries the traceId), then the
    // request-context store — both open an AsyncLocalStorage scope per request
    // and leave resolution to the work that reads them (§13.1, #75).
    consumer.apply(TraceMiddleware, ContextMiddleware).forRoutes('*');
  }
}
