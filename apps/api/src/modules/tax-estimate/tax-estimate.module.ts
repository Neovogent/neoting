import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { PortalModule } from '../portal/index.js';
import { PortalTaxEstimateController, TaxEstimateController } from './tax-estimate.controller.js';
import { TaxEstimateService } from './tax-estimate.service.js';
import { PRISMA, TAX_ESTIMATE_SERVICE } from './tokens.js';

/** The tax estimate add-on (D52, SoT §25). Reads only. */
@Module({
  imports: [PortalModule],
  controllers: [TaxEstimateController, PortalTaxEstimateController],
  providers: [
    { provide: PRISMA, useFactory: (): PrismaClient => getPrismaClient() },
    {
      provide: TAX_ESTIMATE_SERVICE,
      useFactory: (prisma: PrismaClient) => new TaxEstimateService(prisma),
      inject: [PRISMA],
    },
  ],
})
export class TaxEstimateModule {}
