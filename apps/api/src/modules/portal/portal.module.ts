import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { type IdempotencyStore, InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { type DocumentStore, selectDocumentStore } from '../ingestion-routing/index.js';
import { NotificationsModule, NOTIFICATIONS_SERVICE, type NotificationsService } from '../notifications/index.js';
import { PortalContextService } from './portal-context.service.js';
import { PortalOnboardingService } from './portal-onboarding.service.js';
import { PortalSessionContextResolver } from './portal-session-context.js';
import { PortalSessionService } from './portal-session.service.js';
import { PortalUploadNotifier } from './portal-upload-notifier.js';
import { PrismaPortalUploadService } from './portal-upload.service.js';
import { PortalController } from './portal.controller.js';
import {
  PORTAL_CONTEXT_SERVICE,
  PORTAL_DOCUMENT_STORE,
  PORTAL_IDEMPOTENCY_STORE,
  PORTAL_SESSION_CONTEXT,
  PORTAL_ONBOARDING_SERVICE,
  PORTAL_SESSION_SERVICE,
  PORTAL_UPLOAD_NOTIFIER,
  PORTAL_UPLOAD_SERVICE,
  PRISMA,
} from './tokens.js';

/**
 * The OTP portal module (SoT §4 Stage 8.3, METH Stage 9) — the no-app client
 * journey's server half.
 *
 * It holds the session core — mint a portal session from a link plus an OTP,
 * resolve the bearer on the way back in, hand out the two scope contexts the
 * portal's reads and writes need — and the three contracted endpoints
 * (`POST /portal/sessions`, `GET /portal/context`, `POST /portal/uploads`),
 * which are one controller because they are one surface.
 *
 * The Prisma client is the shared pooled one (Governance §5.1), received rather
 * than constructed; it connects as `nt_app`, so RLS is in force and every query
 * still goes through `scopedDb`.
 *
 * The object store is **config-selected** (`OBJECT_STORE`), never
 * import-selected, so `pnpm dev` and `pnpm test` run the portal offline while
 * staging presigns into real S3 through the same code — the house pattern,
 * mirroring `WebUploadModule`. It is reached through
 * `modules/ingestion-routing/index.ts`, that module's public seam.
 *
 * ⚠ **This module must never `imports: [WebUploadModule]`.** `WebUploadModule`
 * already imports this one, because `POST /document-uploads/{uploadId}/complete`
 * accepts the portal bearer (`openapi.yaml`); making the dependency mutual is a
 * Nest cycle. The upload path therefore reuses ingestion-routing's *mechanisms*
 * (`signUploadToken`, `uploadIntentKey`, `documentIdFor`, the cap and the
 * allowlist) rather than injecting its service.
 *
 * Secrets are read from `Env` at wiring time and passed as plain strings, so
 * neither the service nor the resolver knows what a config file is. An empty
 * `PORTAL_SESSION_SECRET` fails closed per request (`portal-session-token.ts`
 * throws) rather than at boot — the SESSION_SECRET stance, for the same reason:
 * a boot gate here would take `/healthz` down over a variable the demo path
 * does not need.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [PortalController],
  providers: [
    {
      // The invited client's way in. It needs the notifications seam because
      // the six-digit code is EMAILED — D47 names the client route as a setup
      // link plus the company address, and there is no SMS on this path.
      provide: PORTAL_ONBOARDING_SERVICE,
      useFactory: (prisma: PrismaClient, env: Env, notifications: NotificationsService) =>
        new PortalOnboardingService(
          prisma,
          { portalSessionSecret: env.PORTAL_SESSION_SECRET, otpMode: env.OTP_MODE },
          notifications,
        ),
      inject: [PRISMA, ENV, NOTIFICATIONS_SERVICE],
    },
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: PORTAL_CONTEXT_SERVICE, useFactory: (prisma: PrismaClient) => new PortalContextService(prisma), inject: [PRISMA] },
    { provide: PORTAL_DOCUMENT_STORE, useFactory: (env: Env) => selectDocumentStore(env), inject: [ENV] },
    { provide: PORTAL_IDEMPOTENCY_STORE, useFactory: (): IdempotencyStore => new InMemoryIdempotencyStore() },
    {
      provide: PORTAL_UPLOAD_SERVICE,
      useFactory: (prisma: PrismaClient, store: DocumentStore, sessions: PortalSessionService, idempotency: IdempotencyStore, env: Env) =>
        new PrismaPortalUploadService(prisma, store, sessions, idempotency, {
          // The SAME secret web upload signs with — completion is
          // `POST /document-uploads/{uploadId}/complete`, which verifies with it.
          uploadSecret: env.UPLOAD_URL_SECRET,
          uploadTtlSeconds: env.UPLOAD_URL_TTL_SECONDS,
        }),
      inject: [PRISMA, PORTAL_DOCUMENT_STORE, PORTAL_SESSION_SERVICE, PORTAL_IDEMPOTENCY_STORE, ENV],
    },
    {
      provide: PORTAL_SESSION_SERVICE,
      useFactory: (prisma: PrismaClient, env: Env) =>
        new PortalSessionService(prisma, {
          portalLinkSecret: env.PORTAL_LINK_SECRET,
          portalSessionSecret: env.PORTAL_SESSION_SECRET,
          otpMode: env.OTP_MODE,
        }),
      inject: [PRISMA, ENV],
    },
    {
      provide: PORTAL_SESSION_CONTEXT,
      useFactory: (prisma: PrismaClient, env: Env) =>
        new PortalSessionContextResolver(prisma, { portalSessionSecret: env.PORTAL_SESSION_SECRET }),
      inject: [PRISMA, ENV],
    },
    // The post-upload half (SoT §4 Stage 8.8): the accountant's notification.
    //
    // ⚠ `PortalUploadStatusService` is deliberately NOT a provider. `openapi.yaml`
    // publishes no status path (LAW, G7), so no request can reach it and no
    // controller injects it — registering it would claim a live surface that
    // does not exist. It stays an in-module library, tested, waiting for a route.
    {
      provide: PORTAL_UPLOAD_NOTIFIER,
      useFactory: (prisma: PrismaClient) => new PortalUploadNotifier(prisma),
      inject: [PRISMA],
    },
  ],
  // Exported for the cross-module consumers the contract creates:
  // `POST /document-uploads/{uploadId}/complete` accepts the portal bearer
  // alongside the workspace session (`openapi.yaml`), so web-upload needs this
  // resolver to honour it — and, because that is where the document row is
  // actually created, the notifier that tells the accountant it arrived.
  exports: [PORTAL_SESSION_CONTEXT, PORTAL_SESSION_SERVICE, PORTAL_UPLOAD_NOTIFIER],
})
export class PortalModule {}
