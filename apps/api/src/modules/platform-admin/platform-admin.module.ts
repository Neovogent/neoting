import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { NOTIFICATIONS_SERVICE, NotificationsModule, type NotificationsService } from '../notifications/index.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { ADMIN_PRISMA, PLATFORM_ADMIN_SERVICE } from './tokens.js';

/** The platform support console (rush/admin). `ImpersonationMiddleware` is applied in `app.module.ts`. */
@Module({
  imports: [NotificationsModule],
  controllers: [PlatformAdminController],
  providers: [
    { provide: ADMIN_PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: PLATFORM_ADMIN_SERVICE,
      useFactory: (prisma: PrismaClient, notifications: NotificationsService, env: Env) =>
        new PlatformAdminService(prisma, notifications, env.APP_ORIGIN),
      inject: [ADMIN_PRISMA, NOTIFICATIONS_SERVICE, ENV],
    },
  ],
})
export class PlatformAdminModule {}
