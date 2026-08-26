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
import { BillingModule } from './modules/billing/billing.module.js';
import { ChaseModule } from './modules/chase/chase.module.js';
import { ChatFrameworkModule } from './modules/chat-framework/chat.module.js';
import { ClientsTeamSettingsModule } from './modules/clients-team-settings/clients-team-settings.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { CapabilityLinkModule, ExportsApiModule } from './modules/exports-public-api/index.js';
import { HealthModule } from './modules/health/health.module.js';
import { WebUploadModule } from './modules/ingestion-routing/web-upload/web-upload.module.js';
import { WhatsAppWebhookModule } from './modules/ingestion-routing/webhooks/whatsapp/whatsapp.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PortalModule } from './modules/portal/portal.module.js';
import { PublishingModule } from './modules/publishing/publishing.module.js';

@Module({
  imports: [
    EnvModule,
    ContextModule,
    ApprovalsModule,
    AuthTenancyModule,
    BankingMatchingModule,
    // ⚠ `GET /d/{code}` — the D43 capability URL, and the ONE route in this app
    // outside the session wall. It is registered here like any other module,
    // and it is deliberately the only one that resolves no `ScopeContext`:
    // the token IS the authorisation. Read
    // `exports-public-api/links/capability-link.service.ts` before changing
    // anything about it. `config/routing.ts` keeps it off the `/v1` prefix.
    CapabilityLinkModule,
    // `GET`+`POST /v1/exports` — the sole egress (D42, stage A9). It imports
    // CapabilityLinkModule for the one `DocumentLinkService`, so the two are
    // registered here in that order rather than independently.
    ExportsApiModule,
    BillingModule,
    ChaseModule,
    ChatFrameworkModule,
    ClientsTeamSettingsModule,
    DocumentsModule,
    HealthModule,
    NotificationsModule,
    PortalModule,
    PublishingModule,
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
