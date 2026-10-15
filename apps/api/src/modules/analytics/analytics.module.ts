import { Module } from '@nestjs/common';

import { getPrismaClient } from '../../common/db/prisma.js';
import { AnalyticsController } from './analytics.controller.js';
import { ANALYTICS_SERVICE, AnalyticsService } from './analytics.service.js';

@Module({
  controllers: [AnalyticsController],
  providers: [{ provide: ANALYTICS_SERVICE, useFactory: () => new AnalyticsService(getPrismaClient()) }],
  exports: [ANALYTICS_SERVICE],
})
export class AnalyticsModule {}
